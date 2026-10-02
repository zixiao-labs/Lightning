import { createServer, NastiEnvironment } from "@nasti-toolchain/nasti";
import type { ResolvedLightningConfig, V8CoverageScript } from "../types.ts";
import { createCoverageSourceLoader, type CoverageSourceLoader } from "../coverage/nasti.ts";
import { createCoverageReport } from "../coverage/index.ts";
import { createOneShotServer } from "./one-shot-server.ts";

type TestServer = Awaited<ReturnType<typeof createServer>>;
const loaders = new WeakMap<TestServer, CoverageSourceLoader>();

export async function createTestServer(config: ResolvedLightningConfig, watch = false): Promise<TestServer> {
  const loader = config.coverage.enabled && config.coverage.provider === "v8" ? createCoverageSourceLoader(config) : undefined;
  const nasti = loader
    ? { ...config.nasti, plugins: [...(config.nasti.plugins ?? []), loader.plugin] }
    : config.nasti;
  const server = await (watch ? createServer : createOneShotServer)(nasti);
  if (loader) {
    try {
      const environment = server.environments.ssr;
      if (!(environment instanceof NastiEnvironment)) throw new Error("Nasti SSR environment is unavailable for coverage.");
      await environment.init();
      loaders.set(server, loader);
    } catch (error) {
      await server.close();
      throw error;
    }
  }
  return server;
}

export function enrichCoverage(server: TestServer, scripts: V8CoverageScript[]): Promise<V8CoverageScript[]> {
  return loaders.get(server)?.enrichScripts(scripts) ?? Promise.resolve(scripts);
}

/** Keep the transform server alive until all unexecuted include files are mapped. */
export async function reportCoverage(config: ResolvedLightningConfig, scripts: V8CoverageScript[]) {
  const server = await createTestServer(config);
  try {
    const loader = loaders.get(server);
    return await createCoverageReport(config, scripts, loader ? { loadSource: loader.loadSource } : {});
  } finally {
    await server.close();
  }
}
