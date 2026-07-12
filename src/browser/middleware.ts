/**
 * The `/__lightning__` HTTP surface browser mode adds to the Nasti dev server.
 *
 * Nasti's `createWsHotChannel` is send-only in 2.0.2 (incoming ws messages are
 * never dispatched and `setInvokeHandler` is a no-op), so results come back
 * over a plain POST instead of the hot channel. The handler is appended to the
 * server's connect stack: the transform middleware only touches GET module
 * requests and sirv only GET/HEAD files, so these routes fall through cleanly.
 *
 * Routes (relative to the `/__lightning__` mount):
 *   GET  /?token=…       → tester page (inline entry script)
 *   GET  /config?token=… → the pending run's payload (file URL, timeouts, snapshot seed)
 *   POST /result         → test results + updated snapshot data for a token
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TestResult } from "../types.ts";
import { testerHtml } from "./client.ts";

/** What the in-page entry needs to run one spec file. */
export interface BrowserRunPayload {
  testUrl: string;
  testTimeout: number;
  retry: number;
  repeats: number;
  hasGlobalOnly: boolean;
  globals: boolean;
  namePattern?: { source: string; flags: string };
  snapshot: { data: Record<string, string>; update: boolean };
}

/** What the page posts back when the file finishes (or fails to start). */
export interface BrowserResultMessage {
  token: string;
  durationMs: number;
  results?: TestResult[];
  error?: { message: string; stack?: string };
  snapshot?: { data: Record<string, string>; dirty: boolean };
}

interface PendingRun {
  payload: BrowserRunPayload;
  resolve: (message: BrowserResultMessage) => void;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export class BrowserTestHub {
  private readonly pending = new Map<string, PendingRun>();

  /** Register a run and get the promise its result POST will resolve. */
  register(token: string, payload: BrowserRunPayload): Promise<BrowserResultMessage> {
    return new Promise((resolve) => {
      this.pending.set(token, { payload, resolve });
    });
  }

  /** Drop a run (watchdog fired or page crashed); late POSTs 404 harmlessly. */
  unregister(token: string): void {
    this.pending.delete(token);
  }

  /** Connect-style handler; mount with `middlewares.use("/__lightning__", …)`. */
  readonly handler = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): void => {
    void this.handle(req, res, next);
  };

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://lightning.invalid");

    if (req.method === "GET" && url.pathname === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end(testerHtml());
      return;
    }

    if (req.method === "GET" && url.pathname === "/config") {
      const token = url.searchParams.get("token") ?? "";
      const run = this.pending.get(token);
      if (!run) {
        sendJson(res, 404, { message: `unknown run token: ${token}` });
        return;
      }
      sendJson(res, 200, run.payload);
      return;
    }

    if (req.method === "POST" && url.pathname === "/result") {
      try {
        const message = JSON.parse(await readBody(req)) as BrowserResultMessage;
        const run = this.pending.get(message.token);
        if (!run) {
          sendJson(res, 404, { message: `unknown run token: ${message.token}` });
          return;
        }
        this.pending.delete(message.token);
        sendJson(res, 200, { ok: true });
        run.resolve(message);
      } catch (error) {
        sendJson(res, 400, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    next();
  }
}
