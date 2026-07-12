import { createServer } from "@nasti-toolchain/nasti";

/**
 * Create a Nasti server for a finite operation such as config loading or a test
 * run. Nasti starts a recursive project watcher for every server, but one-shot
 * callers never consume file-change events. Closing it immediately avoids
 * exhausting file descriptors when multiple isolated workers start together.
 */
export async function createOneShotServer(
  config: Parameters<typeof createServer>[0],
): Promise<Awaited<ReturnType<typeof createServer>>> {
  const server = await createServer(config);
  try {
    await server.watcher.close();
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
  return server;
}
