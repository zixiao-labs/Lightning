import type { ShardOptions } from "../types.ts";

/** Deterministically select files for `--shard=N/M` after discovery sorting. */
export function applyShard(files: string[], shard: ShardOptions | undefined): string[] {
  if (!shard) return files;
  return files.filter((_, index) => index % shard.count === shard.index - 1);
}
