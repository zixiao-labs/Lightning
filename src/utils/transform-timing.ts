import { NastiEnvironment, type DevServer } from "@nasti-toolchain/nasti";

interface TransformTiming {
  durationMs: number;
}

const timings = new WeakMap<NastiEnvironment, TransformTiming>();
const instrumented = new WeakSet<NastiEnvironment>();

/**
 * Track Nasti's plugin transform pipeline for one environment. SSR module
 * imports do not go through server.transformRequest, so measure the
 * environment's plugin container directly.
 */
export async function prepareTransformTiming(
  server: DevServer,
  environmentName: string,
): Promise<void> {
  const environment = server.environments[environmentName];
  if (!(environment instanceof NastiEnvironment)) return;
  await environment.init();
  const container = environment.pluginContainer;
  if (!container || instrumented.has(environment)) return;

  const timing = { durationMs: 0 };
  const transform = container.transform.bind(container);
  container.transform = async (code, id) => {
    const start = performance.now();
    try {
      return await transform(code, id);
    } finally {
      timing.durationMs += performance.now() - start;
    }
  };
  timings.set(environment, timing);
  instrumented.add(environment);
}

export function getTransformDuration(
  server: DevServer,
  environmentName: string,
): number {
  const environment = server.environments[environmentName];
  return environment instanceof NastiEnvironment
    ? timings.get(environment)?.durationMs ?? 0
    : 0;
}
