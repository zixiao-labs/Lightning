/**
 * Value formatter shared by expect diffs and snapshot serialization.
 *
 * In Node this defers to `util.inspect` (via `process.getBuiltinModule`, so no
 * static `node:` import — this module also ships inside the browser runtime
 * bundle). In the browser it falls back to a small structural formatter that
 * mimics `util.inspect` for the common shapes. Exact parity is not guaranteed,
 * so snapshots written in browser mode should be compared in browser mode.
 */

export interface InspectOptions {
  colors?: boolean;
  depth?: number;
  maxArrayLength?: number;
  sorted?: boolean;
}

type NodeInspect = (value: unknown, options?: InspectOptions) => string;

function nodeInspect(): NodeInspect | undefined {
  const proc = (
    globalThis as {
      process?: { getBuiltinModule?: (id: string) => { inspect?: NodeInspect } | undefined };
    }
  ).process;
  try {
    return proc?.getBuiltinModule?.("node:util")?.inspect;
  } catch {
    return undefined;
  }
}

const QUOTE_FREE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Wrap onto multiple lines past this width (util.inspect uses breakLength 128). */
const BREAK_LENGTH = 72;

function formatKey(key: string): string {
  return QUOTE_FREE_KEY.test(key) ? key : `'${key.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function formatString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
}

function wrapEntries(prefix: string, entries: string[], open: string, close: string): string {
  if (entries.length === 0) return `${prefix}${open}${close}`;
  const single = `${prefix}${open} ${entries.join(", ")} ${close}`;
  if (single.length <= BREAK_LENGTH && !single.includes("\n")) return single;
  const indented = entries.map((entry) => `  ${entry.replace(/\n/g, "\n  ")}`);
  return `${prefix}${open}\n${indented.join(",\n")}\n${close}`;
}

function constructorPrefix(value: object): string {
  const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  if (proto === null) return "[Object: null prototype] ";
  const name = proto.constructor?.name;
  return name && name !== "Object" ? `${name} ` : "";
}

function fallbackFormat(
  value: unknown,
  options: InspectOptions,
  depth: number,
  seen: Set<object>,
): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const type = typeof value;
  if (type === "string") return formatString(value as string);
  if (type === "number") return Object.is(value, -0) ? "-0" : String(value);
  if (type === "boolean") return String(value);
  if (type === "bigint") return `${value}n`;
  if (type === "symbol") return String(value);
  if (type === "function") {
    const name = (value as { name?: string }).name;
    return name ? `[Function: ${name}]` : "[Function (anonymous)]";
  }

  const obj = value as object;
  if (seen.has(obj)) return "[Circular *1]";
  const maxDepth = options.depth ?? 2;
  if (depth > maxDepth) return Array.isArray(obj) ? "[Array]" : "[Object]";
  seen.add(obj);
  try {
    return fallbackFormatObject(obj, options, depth, seen);
  } finally {
    seen.delete(obj);
  }
}

function fallbackFormatObject(
  obj: object,
  options: InspectOptions,
  depth: number,
  seen: Set<object>,
): string {
  const next = (v: unknown) => fallbackFormat(v, options, depth + 1, seen);

  if (Array.isArray(obj)) {
    const max = options.maxArrayLength ?? 100;
    const items = obj.slice(0, max).map(next);
    if (obj.length > max) items.push(`... ${obj.length - max} more item${obj.length - max === 1 ? "" : "s"}`);
    return wrapEntries("", items, "[", "]");
  }
  if (obj instanceof Date) {
    return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
  }
  if (obj instanceof RegExp) return String(obj);
  if (obj instanceof Error) {
    return `[${obj.name}: ${obj.message}]`;
  }
  if (obj instanceof Map) {
    const entries = [...obj.entries()].map(([k, v]) => `${next(k)} => ${next(v)}`);
    return wrapEntries(`Map(${obj.size}) `, entries, "{", "}");
  }
  if (obj instanceof Set) {
    const entries = [...obj.values()].map(next);
    return wrapEntries(`Set(${obj.size}) `, entries, "{", "}");
  }
  // Real DOM nodes render as markup — far more useful in assertion output than
  // a structural dump of the element object graph.
  const ElementCtor = (globalThis as { Element?: abstract new () => object }).Element;
  if (ElementCtor && obj instanceof ElementCtor) {
    const html = (obj as { outerHTML?: string }).outerHTML ?? String(obj);
    return html.length > 500 ? `${html.slice(0, 500)}…` : html;
  }

  let keys = Object.keys(obj);
  if (options.sorted) keys = keys.sort();
  const entries = keys.map(
    (key) => `${formatKey(key)}: ${next((obj as Record<string, unknown>)[key])}`,
  );
  return wrapEntries(constructorPrefix(obj), entries, "{", "}");
}

export function inspect(value: unknown, options: InspectOptions = {}): string {
  const native = nodeInspect();
  if (native) return native(value, options);
  // util.inspect defaults depth to 2; the fallback mirrors that via `?? 2`.
  return fallbackFormat(value, options, 0, new Set());
}
