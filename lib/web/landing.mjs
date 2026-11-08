import { readFileSync } from "node:fs";

// Deliberately independent of project state and runtime authentication. Only
// this exact map is public; never resolve a requested path against the repo.
const assets = new Map([
  ["/welcome", ["../../assets/site/index.html", "text/html; charset=utf-8"]],
  ["/welcome/", ["../../assets/site/index.html", "text/html; charset=utf-8"]],
  [
    "/assets/site/site.css",
    ["../../assets/site/site.css", "text/css; charset=utf-8"],
  ],
  [
    "/assets/site/site.mjs",
    ["../../assets/site/site.mjs", "application/javascript; charset=utf-8"],
  ],
  ["/assets/site/logo.svg", ["../../assets/logo.svg", "image/svg+xml"]],
  [
    "/assets/site/web-console.png",
    ["../../assets/screenshots/web-console.png", "image/png"],
  ],
]);

export function serveLanding(req, res, pathname) {
  const asset = assets.get(pathname);
  if (!asset) return false;
  const headers = {
    "Content-Type": asset[1],
    "Cache-Control": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405, {
      ...headers,
      "Content-Type": "text/plain; charset=utf-8",
      Allow: "GET, HEAD",
    });
    res.end("Method not allowed");
    return true;
  }
  try {
    const body = readFileSync(new URL(asset[0], import.meta.url));
    res.writeHead(200, { ...headers, "Content-Length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, {
      ...headers,
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end(req.method === "HEAD" ? undefined : "Asset not found");
  }
  return true;
}
