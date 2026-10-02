import { defineConfig } from "tsdown";

export default defineConfig([
  // Node surface: CLI, programmatic API, pool worker, and the ./browser
  // subpath (DOM helpers usable from jsdom/happy-dom environments too).
  {
    entry: {
      index: "src/index.ts",
      cli: "src/cli.ts",
      worker: "src/runtime/worker.ts",
      browser: "src/browser/public.ts",
      config: "src/config/index.ts",
      globals: "src/globals.ts",
    },
    format: "esm",
    platform: "node",
    target: "node20",
    dts: true,
    clean: true,
    deps: { neverBundle: ["@nasti-toolchain/nasti"] },
  },
  // Browser runtime served verbatim to test pages as the virtual module behind
  // /@modules/@lightning-js/lightning. Built alone so it stays a single
  // self-contained file: shared chunks would become relative imports the dev
  // server can't serve from a virtual module URL.
  {
    entry: { "browser-runtime": "src/browser/runtime-entry.ts" },
    format: "esm",
    platform: "browser",
    target: "es2022",
    dts: false,
    clean: false,
    deps: { alwaysBundle: ["expect-type"], onlyBundle: ["expect-type"] },
    // Emit .mjs like the node config so plugin.ts can address one filename.
    fixedExtension: true,
  },
]);
