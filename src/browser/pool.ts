/**
 * Browser pool (ROADMAP Phase 5): run spec files in real browsers.
 *
 * One Nasti dev server (client pipeline — the same transform/rewrite path a
 * regular Nasti app uses in the browser) serves the specs; Playwright drives a
 * page per file to `/__lightning__/?token=…`. The in-page entry collects and
 * runs the file against the shared virtual runtime and POSTs a JSON result
 * back (see `./middleware.ts` for why POST rather than the ws hot channel).
 *
 * Isolation mapping: `isolate: true` (default) gives every file a fresh
 * Playwright context (own storage/realm); `isolate: false` shares one context
 * per browser and only pages rotate. Files run sequentially per browser, and
 * the whole file list repeats for each entry of the browser matrix.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import c from "tinyrainbow";
import { createServer } from "@nasti-toolchain/nasti";
import type {
  BrowserName,
  FileResult,
  ResolvedLightningConfig,
  TestError,
  TestResult,
} from "../types.ts";
import {
  readSnapshotData,
  snapshotPathFor,
  writeSnapshotData,
} from "../snapshot/index.ts";
import { normalizePath } from "../node/path-utils.ts";
import { BrowserTestHub, type BrowserResultMessage } from "./middleware.ts";
import { createBrowserApiPlugin } from "./plugin.ts";
import {
  loadPlaywrightModule,
  type PlaywrightBrowser,
  type PlaywrightContext,
} from "./provider.ts";

export interface BrowserPoolOptions {
  config: ResolvedLightningConfig;
  files: string[];
  hasGlobalOnly: boolean;
  onFileDone: (file: FileResult) => void | Promise<void>;
}

function specUrl(root: string, file: string): string {
  return "/" + normalizePath(path.relative(root, file));
}

function toError(value: unknown): TestError {
  if (value instanceof Error)
    return { message: value.message, stack: value.stack ?? "" };
  return { message: String(value) };
}

/** Map page-origin URLs in browser stacks back to project paths. */
function rewriteOrigin(text: string, origin: string, root: string): string {
  return text.split(`${origin}/`).join(`${root.replace(/\/$/, "")}/`);
}

function rewriteErrorOrigin(
  error: TestError,
  origin: string,
  root: string,
): TestError {
  const out: TestError = {
    ...error,
    message: rewriteOrigin(error.message, origin, root),
  };
  if (error.stack) out.stack = rewriteOrigin(error.stack, origin, root);
  return out;
}

function rewriteResultOrigins(
  results: TestResult[],
  origin: string,
  root: string,
): TestResult[] {
  return results.map((result) =>
    result.error
      ? { ...result, error: rewriteErrorOrigin(result.error, origin, root) }
      : result,
  );
}

async function safeOnFileDone(
  onFileDone: BrowserPoolOptions["onFileDone"],
  result: FileResult,
): Promise<void> {
  try {
    await onFileDone(result);
  } catch (error) {
    console.error(`[lightning] onFileDone failed for ${result.filepath}:`, error);
  }
}

interface FileRunContext {
  config: ResolvedLightningConfig;
  hub: BrowserTestHub;
  origin: string;
  browser: PlaywrightBrowser;
  sharedContext: PlaywrightContext | undefined;
  browserName: BrowserName;
  hasGlobalOnly: boolean;
}

async function runFileInBrowser(
  ctx: FileRunContext,
  file: string,
): Promise<FileResult> {
  const { config, hub, origin, browserName } = ctx;
  const start = performance.now();
  const snapshotPath = snapshotPathFor(file, config.snapshotDir);
  // May throw on a corrupt .snap — surfaced as this file's load error below.
  const snapshotData = readSnapshotData(snapshotPath);

  const token = randomUUID();
  const pendingResult = hub.register(token, {
    testUrl: specUrl(config.root, file),
    testTimeout: config.testTimeout,
    retry: config.retry,
    repeats: config.repeats,
    hasGlobalOnly: ctx.hasGlobalOnly,
    globals: config.globals,
    ...(config.testNamePattern
      ? {
          namePattern: {
            source: config.testNamePattern.source,
            flags: config.testNamePattern.flags,
          },
        }
      : {}),
    snapshot: { data: snapshotData, update: config.updateSnapshots },
  });

  const context = ctx.sharedContext ?? (await ctx.browser.newContext());
  const page = await context.newPage();
  const relFile = normalizePath(path.relative(config.root, file));
  let lastPageError: Error | undefined;

  page.on("console", (message) => {
    const text = message.text();
    // CSS modules pull in Nasti's HMR client, which chats on connect; that's
    // dev-pipeline noise, not test output.
    if (text.startsWith("[nasti]")) return;
    const type = message.type();
    const line = `${c.dim(`[${browserName}]`)} ${text}`;
    if (type === "error") console.error(line);
    else if (type === "warning") console.warn(line);
    else console.log(line);
  });
  page.on("pageerror", (error) => {
    lastPageError = error;
    console.error(
      `${c.dim(`[${browserName}]`)} ${c.red(`uncaught error in ${relFile}:`)} ${error.message}`,
    );
  });

  // Per-test timeouts run inside the page, so a healthy page always posts a
  // result; the watchdog only catches a hung page (sync infinite loop, crash).
  const watchdogMs = Math.max(60_000, config.testTimeout * 10);
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    watchdogTimer = setTimeout(() => {
      const detail = lastPageError ? `; last page error: ${lastPageError.message}` : "";
      reject(
        new Error(
          `browser did not report a result for ${relFile} within ${watchdogMs}ms${detail}`,
        ),
      );
    }, watchdogMs);
  });
  const crashed = new Promise<never>((_, reject) => {
    page.on("crash", () => reject(new Error(`browser page crashed while running ${relFile}`)));
  });
  // A crash landing after the race settles (e.g. during teardown) must not
  // become an unhandled rejection; the race itself still sees the original.
  crashed.catch(() => undefined);

  try {
    await page.goto(`${origin}/__lightning__/?token=${encodeURIComponent(token)}`);
    const message: BrowserResultMessage = await Promise.race([
      pendingResult,
      watchdog,
      crashed,
    ]);

    if (message.snapshot?.dirty) {
      writeSnapshotData(snapshotPath, message.snapshot.data);
    }

    return {
      filepath: file,
      results: rewriteResultOrigins(message.results ?? [], origin, config.root),
      ...(message.error
        ? { error: rewriteErrorOrigin(message.error, origin, config.root) }
        : {}),
      durationMs: performance.now() - start,
      browser: browserName,
      ...(config.projectName ? { projectName: config.projectName } : {}),
    };
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    hub.unregister(token);
    await page.close().catch(() => undefined);
    if (!ctx.sharedContext) await context.close().catch(() => undefined);
  }
}

export async function runFilesInBrowser(
  options: BrowserPoolOptions,
): Promise<FileResult[]> {
  const { config, files, hasGlobalOnly, onFileDone } = options;

  if (config.coverage.enabled) {
    console.warn(
      c.yellow("⚡️ coverage is not supported in browser mode yet — skipping collection"),
    );
  }

  const hub = new BrowserTestHub();
  const results: FileResult[] = [];
  const server = await createServer({
    ...config.nasti,
    plugins: [createBrowserApiPlugin(), ...(config.nasti.plugins ?? [])],
  });

  try {
    // Port 0 → OS-assigned; Nasti records the actual port on its config.
    await server.listen(0);
    const port = server.config.server.port;
    const origin = `http://localhost:${port}`;
    server.middlewares.use("/__lightning__", hub.handler);

    const playwright = await loadPlaywrightModule(config.root);

    for (const browserName of config.browser.browsers) {
      const browserType = playwright[browserName];
      if (!browserType) {
        throw new Error(`Playwright does not expose a "${browserName}" browser`);
      }
      const browser = await browserType.launch({ headless: config.browser.headless });
      try {
        const sharedContext = config.isolate ? undefined : await browser.newContext();
        const ctx: FileRunContext = {
          config,
          hub,
          origin,
          browser,
          sharedContext,
          browserName,
          hasGlobalOnly,
        };
        try {
          for (const file of files) {
            const result = await runFileInBrowser(ctx, file).catch(
              (error): FileResult => ({
                filepath: file,
                results: [],
                error: toError(error),
                durationMs: 0,
                browser: browserName,
                ...(config.projectName ? { projectName: config.projectName } : {}),
              }),
            );
            results.push(result);
            await safeOnFileDone(onFileDone, result);
          }
        } finally {
          await sharedContext?.close().catch(() => undefined);
        }
      } finally {
        await browser.close().catch(() => undefined);
      }
    }
  } finally {
    await server.close().catch(() => undefined);
  }

  return results;
}
