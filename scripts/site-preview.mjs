import http from "node:http";
import { pathToFileURL } from "node:url";
import { serveLanding } from "../lib/web/landing.mjs";

// Static preview only. No HCC runtime, SQLite, hooks or workers are started.
export function createSitePreviewServer() {
  return http.createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (
        serveLanding(req, res, url.pathname === "/" ? "/welcome" : url.pathname)
      )
        return;
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      res.end("Not found");
    } catch {
      res.writeHead(400);
      res.end("Bad request");
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const flagIndex = process.argv.indexOf("--port");
  const port = Number(flagIndex === -1 ? 4173 : process.argv[flagIndex + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Use --port with a port from 0 to 65535");
  const server = createSitePreviewServer();
  server.on("error", (error) => {
    console.error(`Preview could not start: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `hello-cc product page: http://127.0.0.1:${server.address().port}/welcome`,
    ),
  );
}
