import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rolldown } from "rolldown";
import { transform } from "rolldown/experimental";

/** Load TS configs as native ESM so package exports use the `import` condition. */
export async function importConfig(file: string): Promise<Record<string, unknown>> {
  if (/\.(mjs|js)$/.test(file)) {
    return import(pathToFileURL(file).href);
  }

  const bundle = await rolldown({
    input: file,
    platform: "node",
    // Bundle local TS helpers, leaving packages to Node's native ESM loader.
    external: (id) => !id.startsWith(".") && !path.isAbsolute(id),
    treeshake: false,
    plugins: [{
      name: "lightning:config-file-scope",
      async transform(code, id) {
        if (!/\.[cm]?[jt]sx?$/.test(id)) return;
        const result = await transform(id, code, {
          define: {
            "import.meta.url": JSON.stringify(pathToFileURL(id).href),
            "import.meta.dirname": JSON.stringify(path.dirname(id)),
            "import.meta.filename": JSON.stringify(id),
          },
          sourcemap: true,
        });
        if (result.errors.length) throw result.errors[0];
        return { code: result.code, map: result.map ?? null };
      },
    }],
  });

  // Keep the generated module beside the config for project-local package
  // resolution. Unique filenames also avoid Node's module cache on reload.
  const temporaryFile = `${file}.lightning-${randomUUID()}.mjs`;
  try {
    const { output } = await bundle.generate({
      format: "esm",
      codeSplitting: false,
      sourcemap: "inline",
    });
    const chunk = output.find((entry) => entry.type === "chunk" && entry.isEntry);
    if (!chunk || chunk.type !== "chunk") {
      throw new Error(`Failed to compile config: ${file}`);
    }
    await writeFile(temporaryFile, chunk.code, { flag: "wx" });
    return await import(pathToFileURL(temporaryFile).href);
  } finally {
    try {
      await rm(temporaryFile, { force: true });
    } finally {
      await bundle.close();
    }
  }
}
