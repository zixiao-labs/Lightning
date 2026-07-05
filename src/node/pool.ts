import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createServer } from "@nasti-toolchain/nasti";
import type { ConfigOverrides } from "../config/resolve.ts";
import type {
  FileResult,
  ResolvedLightningConfig,
  TestError,
} from "../types.ts";
import { runTestFile } from "../runtime/file-runner.ts";
import type { WorkerRequest, WorkerResponse } from "./rpc.ts";

function toError(value: unknown): TestError {
  if (value instanceof Error)
    return { message: value.message, stack: value.stack ?? "" };
  if (typeof value === "object" && value && "message" in value) {
    const error = value as { message: string; stack?: string };
    return {
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(value) };
}

function errorFileResult(file: string, error: unknown): FileResult {
  return { filepath: file, results: [], error: toError(error), durationMs: 0 };
}

const workerUrl = new URL("./worker.mjs", import.meta.url);
let requestId = 1;

async function runThread(
  file: string,
  overrides: ConfigOverrides,
  hasGlobalOnly: boolean,
): Promise<FileResult> {
  const worker = new Worker(workerUrl, { stdout: true, stderr: true });
  worker.stdout?.pipe(process.stdout);
  worker.stderr?.pipe(process.stderr);

  try {
    const id = requestId++;
    const response = await new Promise<WorkerResponse>((resolve, reject) => {
      const onMessage = (message: WorkerResponse) => {
        if (message.id !== id) return;
        cleanup();
        resolve(message);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number) => {
        cleanup();
        if (code !== 0) reject(new Error(`worker exited with code ${code}`));
      };
      const cleanup = () => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      const request: WorkerRequest = {
        type: "run",
        id,
        file,
        overrides,
        hasGlobalOnly,
      };
      worker.postMessage(request);
    });
    if (response.type === "error") return errorFileResult(file, response.error);
    return response.result;
  } finally {
    worker.stdout?.unpipe(process.stdout);
    worker.stderr?.unpipe(process.stderr);
    await worker.terminate().catch(() => undefined);
  }
}

async function runFork(
  file: string,
  overrides: ConfigOverrides,
  hasGlobalOnly: boolean,
): Promise<FileResult> {
  const child = fork(fileURLToPath(workerUrl), [], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: process.env,
  });
  try {
    const id = requestId++;
    const response = await new Promise<WorkerResponse>((resolve, reject) => {
      const onMessage = (message: WorkerResponse) => {
        if (message.id !== id) return;
        cleanup();
        resolve(message);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null) => {
        cleanup();
        if (code !== 0)
          reject(new Error(`forked worker exited with code ${code}`));
      };
      const cleanup = () => {
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      child.on("message", onMessage);
      child.on("error", onError);
      child.on("exit", onExit);
      const request: WorkerRequest = {
        type: "run",
        id,
        file,
        overrides,
        hasGlobalOnly,
      };
      child.send(request);
    });
    if (response.type === "error") return errorFileResult(file, response.error);
    return response.result;
  } finally {
    // Attach the "exit" listener *before* killing. Calling `disconnect()` then
    // `kill()` can make the child exit before we start awaiting, so a late
    // `once(child, "close")` would miss the event and hang forever — leaving this
    // promise (and the whole run) pending, which makes the process exit silently
    // with no reported results. SIGTERM reliably emits "exit".
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit").catch(() => undefined);
      child.kill();
      await exited;
    }
  }
}

async function runInline(
  config: ResolvedLightningConfig,
  files: string[],
  hasGlobalOnly: boolean,
  onFileDone: (file: FileResult) => void | Promise<void>,
): Promise<FileResult[]> {
  const results: FileResult[] = [];
  const sharedServer = config.isolate
    ? undefined
    : await createServer(config.nasti);
  try {
    for (const file of files) {
      let server: Awaited<ReturnType<typeof createServer>> | undefined =
        sharedServer;
      let result: FileResult;
      try {
        server ??= await createServer(config.nasti);
        result = await runTestFile({
          config,
          file,
          server,
          hasGlobalOnly,
        });
      } catch (error) {
        result = errorFileResult(file, error);
      } finally {
        if (!sharedServer) await server?.close();
      }
      results.push(result);
      await safeOnFileDone(onFileDone, result);
    }
  } finally {
    await sharedServer?.close();
  }
  return results;
}

async function safeOnFileDone(
  onFileDone: (file: FileResult) => void | Promise<void>,
  result: FileResult,
): Promise<void> {
  try {
    await onFileDone(result);
  } catch (error) {
    console.error(`[lightning] onFileDone failed for ${result.filepath}:`, error);
  }
}

export interface RunPoolOptions {
  config: ResolvedLightningConfig;
  overrides: ConfigOverrides;
  files: string[];
  hasGlobalOnly: boolean;
  onFileDone: (file: FileResult) => void | Promise<void>;
}

export async function runFilesInPool(
  options: RunPoolOptions,
): Promise<FileResult[]> {
  const { config, overrides, files, hasGlobalOnly, onFileDone } = options;
  if (config.pool === "inline" || files.length <= 1 || !config.isolate) {
    return runInline(config, files, hasGlobalOnly, onFileDone);
  }

  const results = new Array<FileResult>(files.length);
  let next = 0;
  const workers = Math.min(config.poolOptions.maxWorkers, files.length);
  const runOne = config.pool === "forks" ? runFork : runThread;

  async function loop(): Promise<void> {
    while (true) {
      const index = next++;
      const file = files[index];
      if (file === undefined) return;
      const result = await runOne(file, overrides, hasGlobalOnly).catch(
        (error) => errorFileResult(file, error),
      );
      results[index] = result;
      await safeOnFileDone(onFileDone, result);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => loop()));
  return results.filter((result): result is FileResult => Boolean(result));
}
