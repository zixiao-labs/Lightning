import process from "node:process";
import { parentPort } from "node:worker_threads";
import { resolveLightningConfig } from "../config/resolve.ts";
import { createOneShotServer } from "../node/one-shot-server.ts";
import type { WorkerRequest, WorkerResponse } from "../node/rpc.ts";
import { runTestFile } from "./file-runner.ts";

function toError(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) return { message: value.message, stack: value.stack ?? "" };
  return { message: String(value) };
}

function post(message: WorkerResponse): void {
  if (parentPort) parentPort.postMessage(message);
  else if (typeof process.send === "function") process.send(message);
}

async function handle(message: WorkerRequest): Promise<void> {
  if (message.type !== "run") return;
  let server: Awaited<ReturnType<typeof createOneShotServer>> | undefined;
  try {
    const config = await resolveLightningConfig(message.overrides);
    server = await createOneShotServer(config.nasti);
    const result = await runTestFile({
      config,
      file: message.file,
      server,
      hasGlobalOnly: message.hasGlobalOnly,
    });
    post({ type: "result", id: message.id, result });
  } catch (error) {
    post({ type: "error", id: message.id, error: toError(error) });
  } finally {
    await server?.close();
  }
}

if (parentPort) {
  parentPort.on("message", (message: WorkerRequest) => {
    void handle(message);
  });
} else {
  process.on("message", (message: WorkerRequest) => {
    void handle(message);
  });
}
