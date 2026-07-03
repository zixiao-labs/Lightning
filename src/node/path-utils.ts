import path from "node:path";

/** Normalize paths for cross-platform map/set comparisons. */
export function normalizePath(file: string): string {
  return path.normalize(file).replace(/\\/g, "/");
}
