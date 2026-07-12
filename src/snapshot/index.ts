/**
 * Node-side snapshot IO: reads/writes `.snap` files around a core session
 * (see `./core.ts`). The file-runner keeps calling `startSnapshotFile` /
 * `finishSnapshotFile`; browser mode uses `readSnapshotData` /
 * `writeSnapshotData` directly and runs the session inside the page.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { finishSnapshotSession, startSnapshotSession } from "./core.ts";

export {
  addSnapshotSerializer,
  getSerializers,
  matchSnapshot,
  serializeSnapshot,
  setCurrentSnapshotTest,
  startSnapshotSession,
  finishSnapshotSession,
  type SnapshotMatchResult,
  type SnapshotSerializer,
  type SnapshotSessionResult,
} from "./core.ts";

export function snapshotPathFor(testFile: string, snapshotDir: string): string {
  return path.join(path.dirname(testFile), snapshotDir, `${path.basename(testFile)}.snap`);
}

export function readSnapshotData(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf-8");
  const json = raw.replace(/^\/\/ Lightning Snapshot v1\n?/, "").trim();
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, string>;
  } catch (error) {
    throw new Error(
      `Failed to parse snapshot file ${file}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Delete the file or re-run with --update to regenerate it.",
    );
  }
}

export function writeSnapshotData(file: string, data: Record<string, string>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(data, null, 2);
  writeFileSync(file, `// Lightning Snapshot v1\n${body}\n`);
}

let currentSnapshotPath: string | undefined;

export function startSnapshotFile(options: {
  testFile: string;
  snapshotDir: string;
  update: boolean;
}): void {
  const snapshotPath = snapshotPathFor(options.testFile, options.snapshotDir);
  currentSnapshotPath = snapshotPath;
  startSnapshotSession({ data: readSnapshotData(snapshotPath), update: options.update });
}

export function finishSnapshotFile(): void {
  const session = finishSnapshotSession();
  const snapshotPath = currentSnapshotPath;
  currentSnapshotPath = undefined;
  if (session?.dirty && snapshotPath) writeSnapshotData(snapshotPath, session.data);
}
