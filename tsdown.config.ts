import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: "esm",
  platform: "node",
  target: "node20",
  dts: true,
  clean: true,
  // Nasti is a peer-ish runtime dep resolved from the consumer; never bundle it.
  external: ["@nasti-toolchain/nasti"],
});
