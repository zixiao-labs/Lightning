import { parseSync } from "rolldown/utils";
import MagicString from "magic-string";
import type { NastiPlugin } from "@nasti-toolchain/nasti";

export const COMPATIBILITY_ALIASES: Record<string, string> = {
  vitest: "@lightning-js/lightning",
  "vitest/config": "@lightning-js/lightning/config",
  "@vitest/browser/context": "@lightning-js/lightning/browser",
  "@jest/globals": "@lightning-js/lightning",
};

/** Rewrite only import/export sources, not comments or ordinary string values. */
export function rewriteCompatibilityImports(code: string, id: string): string {
  return rewriteImportSources(code, id).code;
}

export function rewriteImportSources(code: string, id: string, aliases: Record<string, string> = COMPATIBILITY_ALIASES) {
  const source = new MagicString(code);
  if (!Object.keys(aliases).some((alias) => code.includes(alias))) return { code, map: null };
  const result = parseSync(id, code);
  if (result.errors.length) throw new Error(`Cannot parse ${id}: ${result.errors[0]?.message}`);
  const edits: Array<{ start: number; end: number; value: string }> = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Record<string, unknown>;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(String(node.type))) {
      const source = node.source as { value?: unknown; start?: number; end?: number } | undefined;
      const replacement = typeof source?.value === "string" ? aliases[source.value] : undefined;
      if (replacement && source?.start !== undefined && source.end !== undefined) {
        edits.push({ start: source.start, end: source.end, value: JSON.stringify(replacement) });
      }
    }
    Object.values(node).forEach(visit);
  }
  visit(result.program);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source.overwrite(edit.start, edit.end, edit.value);
  }
  return {
    code: source.toString(),
    map: edits.length ? JSON.parse(source.generateMap({ source: id, includeContent: true, hires: true }).toString()) : null,
  };
}

export function createCompatibilityPlugin(): NastiPlugin {
  return {
    name: "lightning:compatibility",
    enforce: "pre",
    transform(code, id) {
      if (!/\.[cm]?[jt]sx?$/.test(id.split("?")[0] ?? id)) return null;
      const next = rewriteImportSources(code, id);
      return next.code === code ? null : next;
    },
  };
}
