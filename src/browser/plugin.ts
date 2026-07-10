/**
 * Nasti plugin for browser mode: intercepts the framework's bare imports in the
 * client (browser) pipeline and serves the prebuilt, self-contained browser
 * runtime instead of the Node package.
 *
 * Flow: a spec's `import ... from "@lightning-js/lightning"` is rewritten by
 * Nasti's client pipeline to `/@modules/@lightning-js/lightning`; the dev
 * server's virtual-module path asks plugins to `resolveId` that specifier, and
 * this plugin claims it with a `\0`-prefixed id and `load`s the bundle text.
 * The tester page's entry imports the exact same URL, so both share one module
 * instance (the collector singleton) — the same trick the Node side plays with
 * the module runner externalizing bare imports.
 */
import { readFileSync } from "node:fs";
import type { NastiPlugin } from "@nasti-toolchain/nasti";

export const LIGHTNING_API_URL = "/@modules/@lightning-js/lightning";

const VIRTUAL_API_ID = "\0lightning:browser-api";
const VIRTUAL_HELPERS_ID = "\0lightning:browser-helpers";

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
    enforce: "pre",
    resolveId(source) {
      if (source === "@lightning-js/lightning") return VIRTUAL_API_ID;
      if (source === "@lightning-js/lightning/browser") return VIRTUAL_HELPERS_ID;
      return null;
    },
    load(id) {
      if (id === VIRTUAL_API_ID) return loadRuntimeBundle();
      if (id === VIRTUAL_HELPERS_ID) {
        // Thin re-export so both import paths hit one runtime instance.
        return `export { render, cleanup, userEvent } from "${LIGHTNING_API_URL}";\n`;
      }
      return null;
    },
  };
}
