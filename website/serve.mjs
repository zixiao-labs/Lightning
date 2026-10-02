import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

// This preview serves one self-contained page, never the project filesystem.
const page = new URL("./index.html", import.meta.url);
const port = Number(process.env.PORT ?? 5174);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer from 0 to 65535");
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method !== "GET" || !["/", "/index.html"].includes(pathname)) {
    res.writeHead(404).end("Not found");
    return;
  }
  try {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(await readFile(page));
  } catch {
    res.writeHead(500).end("Documentation page unavailable");
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Lightning docs: http://127.0.0.1:${server.address().port}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
