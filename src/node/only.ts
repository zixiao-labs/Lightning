import { readFile } from "node:fs/promises";
import { parseSync } from "rolldown/utils";

/** Static focus detection must ignore comments and strings, and honor import aliases. */
export async function detectGlobalOnly(files: string[], kind: "test" | "bench" = "test"): Promise<boolean> {
  for (const file of files) {
    try {
      const { program, errors } = parseSync(file, await readFile(file, "utf8"));
      if (errors.length) continue; // The normal collector reports syntax errors.
      const names = new Map<string, string>(["test", "it", "describe", ...(kind === "bench" ? ["bench", "describeBench"] : [])].map((name) => [name, name]));
      const importedNames = new Set(names.keys());
      for (const node of program.body) {
        if (node.type !== "ImportDeclaration" || !["vitest", "@lightning-js/lightning", "@jest/globals"].includes(String(node.source.value))) continue;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && "name" in specifier.imported &&
            importedNames.has(specifier.imported.name)) names.set(specifier.local.name, specifier.imported.name);
        }
      }
      let focused = false;
      function calleeInfo(value: unknown): { api: boolean; only: boolean; name?: string } {
        if (!value || typeof value !== "object") return { api: false, only: false };
        const node = value as Record<string, any>;
        if (node.type === "Identifier") return { api: names.has(node.name), only: false, ...(names.has(node.name) ? { name: names.get(node.name)! } : {}) };
        if (node.type === "CallExpression") return calleeInfo(node.callee);
        if (node.type === "MemberExpression") {
          const parent = calleeInfo(node.object);
          if (!node.computed && node.property?.name === "bench" && parent.name === "describe") {
            return { api: kind === "bench", only: parent.only, name: "bench" };
          }
          return { ...parent, only: parent.only || (!node.computed && node.property?.name === "only") };
        }
        return { api: false, only: false };
      }
      function visit(value: unknown): void {
        if (!value || typeof value !== "object" || focused) return;
        if (Array.isArray(value)) { value.forEach(visit); return; }
        const node = value as Record<string, any>;
        if (node.type === "CallExpression") {
          const info = calleeInfo(node.callee);
          const options = node.arguments?.[1];
          if (info.api && (info.only || (options?.type === "ObjectExpression" && options.properties.some((property: any) =>
            (property.key?.name ?? property.key?.value) === "only" && property.value?.value === true)))) focused = true;
          // Test/benchmark bodies execute later, not during collection. Focus
          // calls used inside those bodies cannot focus the outer test run.
          if (info.api && ["test", "it", "bench"].includes(info.name ?? "")) {
            visit(node.callee);
            for (const argument of node.arguments ?? []) {
              if (!["ArrowFunctionExpression", "FunctionExpression"].includes(argument.type)) visit(argument);
            }
            return;
          }
        }
        Object.values(node).forEach(visit);
      }
      visit(program);
      if (focused) return true;
    } catch {
      // Read/import failures belong to the file runner, not the focus scan.
    }
  }
  return false;
}
