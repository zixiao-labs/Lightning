/**
 * Reverse-dependency graph for watch mode (ROADMAP Phase 3).
 *
 * Lightning reuses Nasti's module runner for execution, but the SSR runner keeps
 * a flat in-memory cache (`NastiModuleRunner.cache`) and does NOT expose a module
 * graph with `importers` the way Vite's server module graph does. So we build our
 * own dependency graph by attaching a `transform` plugin to the same Nasti pipeline:
 * every module the runner fetches is transformed, and we statically extract its
 * ESM import specifiers, resolve them to absolute paths via the plugin container,
 * and record `importer → imported` edges.
 *
 * When a source file changes, `getAffectedTestFiles` walks the graph *upstream*
 * (who imports the changed file, transitively) and returns the test files among
 * them — exactly Vitest's `handleFileChanged` strategy, just backed by our own
 * graph because Nasti's runner doesn't populate one.
 *
 * Over-approximation is safe here: a spurious edge only causes an extra rerun
 * (slower), never a missed rerun (wrong). So regex-based import extraction —
 * which can't distinguish comments/string literals from real imports — errs on
 * the side of correctness.
 */
import path from "node:path";
import type { NastiPlugin } from "@nasti-toolchain/nasti";
import { normalizePath } from "./path-utils.ts";

/**
 * Extract ESM import/export specifiers from source code.
 *
 * Covers `import … from`, side-effect `import "x"`, re-export `export … from`,
 * and dynamic `import("x")`. Bare specifiers (`react`, `node:fs`) are returned
 * too — the caller filters them by resolvability + project-root membership.
 */
interface ImportReference {
  spec: string;
  typeOnly: boolean;
}

function extractImportReferences(code: string): ImportReference[] {
  const specs = new Map<string, boolean>();
  const add = (spec: string, typeOnly: boolean) => {
    specs.set(spec, (specs.get(spec) ?? true) && typeOnly);
  };

  // `import … from "x"` and `export … from "x"` (re-exports are dependencies too).
  // The clause between the keyword and `from` may contain a `{ … }` binding list
  // (`import { a, b } from "x"`), so we only stop at a quote or semicolon — NOT a
  // brace, or named imports would never match. `\bfrom\s*['"]` anchors on the real
  // module specifier (a `from` *inside* the binding list isn't followed by a quote).
  const fromRe = /\b(import|export)\b([^'";]*?)\bfrom\s*(['"])([^'"]+)\3/g;
  // Side-effect import: `import "x"` (no `from`, no clause).
  const sideRe = /\bimport\s*(['"])([^'"]+)\1/g;
  // Dynamic import: `import("x")`.
  const dynRe = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code)) !== null) {
    const clause = m[2]!.trim();
    add(m[4]!, /^type(?:\s|$)/.test(clause));
  }
  for (const re of [sideRe, dynRe]) {
    while ((m = re.exec(code)) !== null) {
      add(m[2]!, false);
    }
  }
  return [...specs].map(([spec, typeOnly]) => ({ spec, typeOnly }));
}

export function extractImportSpecifiers(code: string): string[] {
  return extractImportReferences(code).map(({ spec }) => spec);
}

export class DependencyGraph {
  /** Forward edges: importer file → files it imports. */
  private imports = new Map<string, Set<string>>();
  /** Reverse edges: imported file → files that import it. */
  private importers = new Map<string, Set<string>>();

  private bucket(map: Map<string, Set<string>>, key: string): Set<string> {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    return set;
  }

  /** Record `importer` depends on `imported` (both absolute file paths). */
  registerEdge(importer: string, imported: string): void {
    const from = normalizePath(importer);
    const to = normalizePath(imported);
    this.bucket(this.imports, from).add(to);
    this.bucket(this.importers, to).add(from);
  }

  /**
   * Drop `file`'s *outgoing* edges before it is re-transformed (its imports may
   * have changed). Incoming edges (who imports `file`) are left intact — those
   * are only updated when the importers themselves are re-transformed.
   */
  invalidate(file: string): void {
    const key = normalizePath(file);
    const outs = this.imports.get(key);
    if (outs) {
      for (const dep of outs) {
        this.importers.get(dep)?.delete(key);
      }
      this.imports.delete(key);
    }
  }

  /** Has `file` ever been tracked (transformed) by the graph? */
  has(file: string): boolean {
    const key = normalizePath(file);
    return this.imports.has(key) || this.importers.has(key);
  }

  /**
   * Find the test files affected by a change to `changedFile`.
   *
   * - If `changedFile` is itself a known test file, rerun just it.
   * - Otherwise walk upstream via the reverse graph, collecting every transitive
   *   importer that is a test file.
   * - A file not present in the graph (e.g. a brand-new untested source file)
   *   affects nothing.
   */
  getAffectedTestFiles(changedFile: string, testFiles: Set<string>): string[] {
    const changed = normalizePath(changedFile);
    const tests = new Set([...testFiles].map(normalizePath));
    if (tests.has(changed)) return [changed];

    const affected = new Set<string>();
    const queue = [changed];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (tests.has(current)) {
        affected.add(current);
        continue;
      }
      const parents = this.importers.get(current);
      if (parents) {
        for (const p of parents) queue.push(p);
      }
    }
    return [...affected];
  }

  /**
   * Every module that transitively imports `changedFile` (not including
   * `changedFile` itself). Watch mode invalidates these in the SSR runner so a
   * re-executed test re-imports down to the changed leaf: the runner skips a
   * cached module's body on a hit, so an importer that isn't invalidated never
   * re-runs its `import` of the file that actually changed.
   *
   * Unlike {@link getAffectedTestFiles}, this returns *all* importers (test and
   * non-test), since any module on a path from a test to the change must be
   * refreshed. Over-approximation is safe — a spurious entry only re-transforms
   * one extra module.
   */
  getTransitiveImporters(changedFile: string): string[] {
    const result = new Set<string>();
    const queue = [normalizePath(changedFile)];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const parents = this.importers.get(current);
      if (!parents) continue;
      for (const p of parents) {
        result.add(p);
        queue.push(p);
      }
    }
    return [...result];
  }
}

function normalizeFile(id: string): string {
  return normalizePath(id.split("?")[0]!);
}

function isProjectSource(file: string, root: string): boolean {
  if (!file) return false;
  const rel = path.relative(normalizePath(root), normalizePath(file));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  // node_modules lives under root but is never user source we should track.
  return !normalizePath(rel).split("/").includes("node_modules");
}

const FALLBACK_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  "/index.ts",
  "/index.tsx",
  "/index.mts",
  "/index.cts",
  "/index.js",
  "/index.jsx",
  "/index.mjs",
  "/index.cjs",
  "/index.json",
];

function isRelativeSpecifier(spec: string): boolean {
  return spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
}

function fallbackBase(spec: string, importer: string, root: string): string | undefined {
  if (isRelativeSpecifier(spec)) return path.resolve(path.dirname(importer), spec);

  if (path.isAbsolute(spec)) {
    const absolute = normalizePath(spec);
    if (isProjectSource(absolute, root)) return absolute;
  }

  // Vite-style absolute imports are project-root relative (`/src/foo`).
  if (spec.startsWith("/")) return path.resolve(root, `.${spec}`);

  return undefined;
}

function unresolvedProjectTargets(spec: string, importer: string, root: string): string[] {
  const base = fallbackBase(spec, importer, root);
  if (!base) return [];

  const normalizedBase = normalizePath(base);
  if (!isProjectSource(normalizedBase, root)) return [];

  const suffixes = path.extname(normalizedBase) ? [""] : FALLBACK_SUFFIXES;
  const targets = new Set<string>();
  for (const suffix of suffixes) {
    const target = normalizePath(`${normalizedBase}${suffix}`);
    if (target !== importer && isProjectSource(target, root)) targets.add(target);
  }
  return [...targets];
}

function registerUnresolvedProjectEdges(
  graph: DependencyGraph,
  importer: string,
  spec: string,
  root: string,
): void {
  for (const target of unresolvedProjectTargets(spec, importer, root)) {
    graph.registerEdge(importer, target);
  }
}

/**
 * A `pre`-enforce plugin that records importer→imported edges into `graph` as
 * each module flows through the SSR transform pipeline. Pass an empty graph for
 * a fresh run; the same graph instance must be reused across reruns to keep the
 * reverse-dependency index warm.
 *
 * The plugin is a no-op transform (returns `null`) — it only observes. Because
 * it is `pre` and ordered before the mock-hoist plugin, it sees the original
 * ESM `import` statements before they are rewritten into `__lightning_vi__`
 * calls.
 */
export function createDepTrackerPlugin(graph: DependencyGraph, root: string): NastiPlugin {
  const projectRoot = normalizePath(root);
  return {
    name: "lightning:dep-tracker",
    enforce: "pre",
    async transform(code, id) {
      const importer = normalizeFile(id);
      if (!isProjectSource(importer, projectRoot)) return null;

      // Clear stale outgoing edges before re-registering from the current code.
      graph.invalidate(importer);

      for (const { spec, typeOnly } of extractImportReferences(code)) {
        // Skip type-only, `node:` builtins, and data/URL specifiers outright.
        if (typeOnly || spec.startsWith("node:") || spec.startsWith("data:")) continue;
        // Bare specifiers (`react`, `@lightning-js/lightning`) resolve into
        // node_modules and are filtered by `isProjectSource` after resolution.
        try {
          const resolved = await this.resolve(spec, importer);
          if (resolved == null) {
            registerUnresolvedProjectEdges(graph, importer, spec, projectRoot);
            continue;
          }
          const resolvedId = typeof resolved === "string" ? resolved : resolved.id;
          const target = normalizeFile(resolvedId);
          if (target !== importer && isProjectSource(target, projectRoot)) {
            graph.registerEdge(importer, target);
          }
        } catch {
          // Unresolvable local imports still need graph edges so adding the missing
          // file can rerun importers; virtual/external specifiers produce no fallback.
          registerUnresolvedProjectEdges(graph, importer, spec, projectRoot);
        }
      }
      return null;
    },
  };
}
