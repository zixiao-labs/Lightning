/**
 * The browser tester page: minimal HTML plus an inline module script that
 * drives one spec file inside the page.
 *
 * The entry is authored as a template string (the same way Nasti serves its
 * HMR client) rather than a built artifact: it's glue code whose only jobs are
 * to fetch its run payload, import the shared runtime by URL, dynamically
 * import the spec, run the collected tree, and POST the JSON-safe result back.
 * Keeping it inline avoids a second build target and can't drift from the
 * middleware routes it talks to.
 */
import { LIGHTNING_API_URL } from "./plugin.ts";

const ENTRY_JS = `
const token = new URLSearchParams(location.search).get("token");

function post(path, body) {
  return fetch("/__lightning__/" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Results travel as JSON: pre-flatten diff payloads the structured clone of a
// worker would otherwise carry (DOM nodes, functions, circular graphs, ...).
function jsonSafe(value, depth = 0, seen = new Set()) {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return value;
  if (type === "bigint") return String(value) + "n";
  if (type === "symbol") return String(value);
  if (type === "function") return value.name ? "[Function: " + value.name + "]" : "[Function]";
  if (typeof Element !== "undefined" && value instanceof Element) {
    const html = value.outerHTML;
    return html.length > 500 ? html.slice(0, 500) + "…" : html;
  }
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (depth >= 6) return "[MaxDepth]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => jsonSafe(item, depth + 1, seen));
    if (value instanceof Map) {
      return { __type: "Map", entries: [...value.entries()].map((e) => jsonSafe(e, depth + 1, seen)) };
    }
    if (value instanceof Set) {
      return { __type: "Set", values: [...value.values()].map((v) => jsonSafe(v, depth + 1, seen)) };
    }
    const out = {};
    for (const key of Object.keys(value)) out[key] = jsonSafe(value[key], depth + 1, seen);
    return out;
  } finally {
    seen.delete(value);
  }
}

function safeError(error) {
  if (!error || typeof error !== "object") return { message: String(error) };
  const out = { message: String(error.message ?? error) };
  if (error.stack) out.stack = String(error.stack);
  if (error.diff) {
    out.diff = { actual: jsonSafe(error.diff.actual), expected: jsonSafe(error.diff.expected) };
  }
  return out;
}

function safeResults(results) {
  return results.map((r) => ({ ...r, ...(r.error ? { error: safeError(r.error) } : {}) }));
}

async function importErrorDetail(testUrl, error) {
  // A failed dynamic import only says "failed to fetch module"; the dev
  // server's 500 body carries the actual transform error — surface it.
  let message = String((error && error.message) || error);
  try {
    const resp = await fetch(testUrl);
    if (!resp.ok) message += "\\n" + (await resp.text());
  } catch {}
  const out = new Error(message);
  if (error && error.stack) out.stack = error.stack;
  return out;
}

async function main() {
  const start = performance.now();
  const durationBreakdown = {
    transformMs: 0,
    setupMs: 0,
    importMs: 0,
    testsMs: 0,
    environmentMs: 0,
  };
  let unhandled;
  let restoreGlobals;
  let runner;
  try {
    const configResponse = await fetch("/__lightning__/config?token=" + encodeURIComponent(token));
    if (!configResponse.ok) throw new Error("failed to fetch run config: HTTP " + configResponse.status);
    const cfg = await configResponse.json();

    const api = await import("${LIGHTNING_API_URL}");
    runner = api.__lightning_browser__;
    unhandled = runner.captureBrowserErrors();
    if (cfg.coverageProvider === "istanbul") runner.startIstanbulCoverage();

    runner.startSnapshotSession({ data: cfg.snapshot.data, update: cfg.snapshot.update });
    if (cfg.globals) restoreGlobals = runner.installGlobals();
    runner.startCollection();

    let collected;
    const importStart = performance.now();
    try {
      await import(cfg.testUrl);
      collected = runner.finishCollection();
    } catch (error) {
      throw await importErrorDetail(cfg.testUrl, error);
    } finally {
      durationBreakdown.importMs += performance.now() - importStart;
    }

    let results;
    const testsStart = performance.now();
    try {
      results = await runner.runSuiteTree(collected.root, {
        hasOnly: collected.hasOnly || cfg.hasGlobalOnly,
        defaultTimeout: cfg.testTimeout,
        retry: cfg.retry,
        repeats: cfg.repeats,
        ...(cfg.namePattern ? { namePattern: new RegExp(cfg.namePattern.source, cfg.namePattern.flags) } : {}),
        onTestStart: (name) => runner.setCurrentSnapshotTest(name),
        onTestEnd: () => {
          runner.setCurrentSnapshotTest(undefined);
          runner.cleanupContainers();
        },
      });
    } finally {
      durationBreakdown.testsMs += performance.now() - testsStart;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const [index, error] of unhandled.errors.entries()) {
      results.push({ fullName: "Unhandled error " + (index + 1), state: "fail", durationMs: 0, error });
    }
    const snapshot = runner.finishSnapshotSession();
    runner.cleanupViState();

    await post("result", {
      token,
      durationMs: performance.now() - start,
      durationBreakdown,
      results: safeResults(results),
      ...(cfg.coverageProvider === "istanbul" ? { istanbulCoverage: runner.finishIstanbulCoverage() } : {}),
      ...(snapshot ? { snapshot } : {}),
    });
  } catch (error) {
    await post("result", {
      token,
      durationMs: performance.now() - start,
      durationBreakdown,
      error: safeError(error),
    });
  } finally {
    unhandled?.close();
    restoreGlobals?.();
    runner?.cleanupViState();
    runner?.cleanupContainers();
  }
}

main();
`;

export function testerHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>⚡️ Lightning Browser Tester</title>
</head>
<body>
<script type="module">${ENTRY_JS}</script>
</body>
</html>
`;
}
