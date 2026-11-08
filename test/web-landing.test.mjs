import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createHttpRoutes } from "../lib/web/http-routes.mjs";

async function fixture(t, { token = "landing-fixture-token" } = {}) {
  let projectAccesses = 0;
  const { handleWebRequest } = createHttpRoutes({
    token,
    webAuthMode: () => "",
    cookieSessionOk: () => false,
    projectFromRequest() {
      projectAccesses++;
      throw new Error("Unexpected project access");
    },
    renderWebLogin: () => "<h1>Existing login</h1>",
    sendWebHtml: (res, render) => {
      res.writeHead(200);
      res.end(render());
    },
    webErrorStatus: () => 500,
  });
  const server = http.createServer(handleWebRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    projectAccesses: () => projectAccesses,
  };
}

test("public product page and its assets do not require a session or access a project", async (t) => {
  const f = await fixture(t);
  for (const path of ["/welcome", "/welcome/"]) {
    const response = await fetch(f.base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(
      response.headers.get("content-security-policy"),
      /connect-src 'none'/,
    );
    assert.equal(response.headers.get("set-cookie"), null);
    const html = await response.text();
    assert.match(html, /<html lang="zh-CN">/);
    assert.match(html, /让 AI 各展所长/);
    for (const [, asset] of html.matchAll(
      /(?:src|href)="(\/assets\/site\/[^"#]+)"/g,
    )) {
      const result = await fetch(f.base + asset);
      assert.equal(result.status, 200, asset);
      assert.ok((await result.arrayBuffer()).byteLength > 0, asset);
    }
  }
  const head = await fetch(f.base + "/welcome", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(f.projectAccesses(), 0);
});

test("landing route preserves login and API authentication and only exposes known assets", async (t) => {
  const f = await fixture(t);
  const root = await fetch(f.base + "/", { headers: { accept: "text/html" } });
  assert.match(await root.text(), /Existing login/);
  for (const path of [
    "/api/state",
    "/api/projects",
    "/assets/web/browser/core.mjs",
    "/assets/site/not-public.mjs",
    "/assets/site/../../lib/web/http-routes.mjs",
    "/assets/site/%2e%2e/package.json",
    "/assets/site/index.html/",
  ]) {
    const result = await fetch(f.base + path, {
      headers: { "X-HCC-API-Version": "2" },
    });
    assert.equal(result.status, 401, path);
  }
  const write = await fetch(f.base + "/welcome", { method: "POST" });
  assert.equal(write.status, 405);
  assert.equal(write.headers.get("allow"), "GET, HEAD");
  assert.equal(f.projectAccesses(), 0);
});

test("public page retains the tokenless Host trust boundary", async (t) => {
  const f = await fixture(t, { token: "" });
  // Node fetch rewrites Host; use an actual HTTP request for this boundary.
  const denied = await new Promise((resolve, reject) => {
    const req = http.get(
      f.base + "/welcome",
      { headers: { host: "untrusted.example" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(body) }),
        );
      },
    );
    req.on("error", reject);
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "UNTRUSTED_HOST");
});
