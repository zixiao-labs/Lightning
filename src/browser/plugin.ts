/**
 * Nasti plugin for browser mode: intercepts the framework's bare imports in the
 * client (browser) pipeline and serves the prebuilt, self-contained browser
 * runtime instead of the Node package.
 *
 * Nasti's built-in pre resolver wins over user resolveId hooks for installed
 * packages. Rewrite framework imports to one dedicated URL before Nasti's
 * import rewrite and serve the runtime there. The tester and specs therefore
 * share one collector regardless of package layout or project aliases.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NastiPlugin } from "@nasti-toolchain/nasti";
import { rewriteImportSources } from "../node/compatibility.ts";

export const LIGHTNING_API_URL = "/__lightning__/runtime.js";

let runtimeCache: string | undefined;

function loadRuntimeBundle(): string {
  if (runtimeCache === undefined) {
    // This module ships as a flat chunk in dist/, next to browser-runtime.mjs.
    const bundleUrl = new URL("./browser-runtime.mjs", import.meta.url);
    try {
      runtimeCache = readFileSync(bundleUrl, "utf-8");
    } catch (error) {
      throw new Error(
        `Lightning browser runtime bundle not found at ${bundleUrl.pathname}. ` +
          "Rebuild @lightning-js/lightning (pnpm build) — browser mode serves dist/browser-runtime.mjs to the page.\n" +
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return runtimeCache;
}

export function createBrowserApiPlugin(): NastiPlugin {
  return {
    name: "lightning:browser-api",
    // After instrumentation/compatibility, before Nasti's client import rewrite.
    enforce: "post",
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => {
        if (req.url?.split("?")[0] !== LIGHTNING_API_URL) return next();
        try {
          res.setHeader("Content-Type", "application/javascript");
          res.setHeader("Cache-Control", "no-cache");
          res.end(loadRuntimeBundle());
        } catch (error) {
          next(error);
        }
      });
    },
    transform(code, id) {
      // Keep the exact URL identical even when Lightning is installed beneath
      // the project root (where Nasti would otherwise choose a root-relative
      // alias URL and create a second collector instance).
      if (!/\.[cm]?[jt]sx?$/.test(id.split("?")[0] ?? id)) return null;
      const rewritten = rewriteImportSources(code, id, {
        "@lightning-js/lightning": LIGHTNING_API_URL,
        "@lightning-js/lightning/browser": LIGHTNING_API_URL,
        vitest: LIGHTNING_API_URL,
        "vitest/config": LIGHTNING_API_URL,
        "@lightning-js/lightning/config": LIGHTNING_API_URL,
        "@vitest/browser/context": LIGHTNING_API_URL,
        "@jest/globals": LIGHTNING_API_URL,
      });
      return rewritten.code === code ? null : rewritten;
    },
  };
}
