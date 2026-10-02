import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { FileResult, ResolvedLightningConfig } from "../types.ts";

export const TYPECHECK_INCLUDE = ["**/*.test-d.ts", "**/*.spec-d.ts"];
export function isTypeTestFile(file: string): boolean {
  return /\.(?:test|spec)-d\.[cm]?ts$/.test(file);
}

export interface TypecheckOptions {
  tsconfig?: string;
}

/** Compile declarations without loading, transforming, or evaluating any module. */
export async function runTypechecks(
  files: string[],
  config: ResolvedLightningConfig,
  options: TypecheckOptions = {},
): Promise<FileResult[]> {
  if (!files.length) return [];
  const configPath = options.tsconfig
    ? path.resolve(config.root, options.tsconfig)
    : ts.findConfigFile(config.root, ts.sys.fileExists);
  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    strict: true,
    skipLibCheck: true,
  };
  const configErrors: ts.Diagnostic[] = [];
  if (configPath) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) configErrors.push(read.error);
    else {
      const parsed = ts.parseJsonConfigFileContent(
        read.config, ts.sys, path.dirname(configPath), {}, configPath,
      );
      compilerOptions = parsed.options;
      configErrors.push(...parsed.errors.filter((error) => error.code !== 18003));
    }
  }
  const resolvedOptions = {
    ...compilerOptions,
    noEmit: true,
    emitDeclarationOnly: false,
    incremental: false,
    composite: false,
    paths: {
      ...compatibilityTypePaths(),
      ...compilerOptions.paths,
    },
  };
  const format = (diagnostic: ts.Diagnostic): string => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (!diagnostic.file) return `TS${diagnostic.code}: ${message}`;
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} TS${diagnostic.code}: ${message}`;
  };
  return files.map((filepath) => {
    const start = performance.now();
    // A program per entry attributes dependency diagnostics to precisely the
    // entries that import them, without failing unrelated type-test files.
    const program = ts.createProgram([filepath, ...(config.globals ? [packageTypes("./globals")] : [])], resolvedOptions);
    const errors = [...configErrors, ...ts.getPreEmitDiagnostics(program)]
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    return {
      filepath,
      results: [{
        fullName: "typecheck",
        state: errors.length ? "fail" : "pass",
        durationMs: performance.now() - start,
        ...(errors.length ? { error: { message: errors.map(format).join("\n") } } : {}),
      }],
      durationMs: performance.now() - start,
      ...(config.projectName ? { projectName: config.projectName } : {}),
    };
  });
}

function packageTypes(subpath: string): string {
  const packageFile = createRequire(import.meta.url).resolve("@lightning-js/lightning/package.json");
  const packageJSON = JSON.parse(ts.sys.readFile(packageFile)!);
  return path.resolve(path.dirname(packageFile), packageJSON.exports[subpath].types);
}

function compatibilityTypePaths(): Record<string, string[]> {
  return {
    vitest: [packageTypes(".")],
    "vitest/config": [packageTypes("./config")],
    "@jest/globals": [packageTypes(".")],
    "vitest/globals": [packageTypes("./globals")],
  };
}
