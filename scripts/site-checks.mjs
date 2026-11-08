import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { createSitePreviewServer } from "./site-preview.mjs";

const server = createSitePreviewServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const screenshots = process.env.HCC_SITE_SCREENSHOTS;
let browser;
let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks++;
}

try {
  browser = await chromium.launch(
    process.env.HCC_SITE_BROWSER_CHANNEL
      ? { channel: process.env.HCC_SITE_BROWSER_CHANNEL }
      : {},
  );
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => requests.push(request.url()));
  if (screenshots) await mkdir(screenshots, { recursive: true });

  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const response = await page.goto(base + "/welcome");
    check(response.status() === 200, `${width}: public page loads`);
    check(
      (await page.title()).startsWith("hello-cc"),
      `${width}: page identity`,
    );
    check(await page.locator("h1").isVisible(), `${width}: meaningful content`);
    check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `${width}: no horizontal overflow`,
    );
    check(
      await page.evaluate(() =>
        [...document.images]
          .filter((img) => !img.closest("dialog"))
          .every((img) => img.complete && img.naturalWidth > 0),
      ),
      `${width}: brand assets load`,
    );
    await page.getByRole("tab", { name: "共享任务", exact: true }).click();
    check(
      await page
        .getByRole("heading", { name: "谁在做什么，一目了然。" })
        .isVisible(),
      `${width}: tasks tab updates`,
    );
    await page.keyboard.press("ArrowRight");
    check(
      await page
        .getByRole("heading", { name: "把工作交出去，把上下文留下。" })
        .isVisible(),
      `${width}: keyboard selects handoff`,
    );
    await page.keyboard.press("Home");
    check(
      await page
        .getByRole("heading", { name: "各司其职，也彼此知情。" })
        .isVisible(),
      `${width}: Home restores first tab`,
    );
    check(
      await page
        .getByRole("tab", { name: "Agent 工作台", exact: true })
        .evaluate((element) => element === document.activeElement),
      `${width}: keyboard focus follows selection`,
    );
    if (width <= 640) {
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
      await page
        .getByRole("navigation")
        .getByRole("link", { name: "产品能力", exact: true })
        .click();
      check(
        new URL(page.url()).hash === "#capabilities",
        `${width}: mobile anchor navigates`,
      );
      check(
        (await page.locator(".menu-toggle").getAttribute("aria-expanded")) ===
          "false",
        `${width}: mobile menu closes after navigation`,
      );
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
      await page.keyboard.press("Escape");
      check(
        (await page.locator(".menu-toggle").getAttribute("aria-expanded")) ===
          "false",
        `${width}: Escape closes navigation`,
      );
    }
    await page.getByRole("button", { name: "查看实际控制台" }).click();
    check(
      await page.getByRole("dialog").isVisible(),
      `${width}: screenshot dialog opens`,
    );
    await page.locator("dialog img").evaluate((image) => image.decode());
    check(
      await page
        .locator("dialog img")
        .evaluate((image) => image.naturalWidth === 1440),
      `${width}: actual screenshot loads`,
    );
    await page.keyboard.press("Escape");
    check(
      !(await page.getByRole("dialog").isVisible()),
      `${width}: Escape closes dialog`,
    );
    check(
      await page
        .getByRole("button", { name: "查看实际控制台" })
        .evaluate((element) => element === document.activeElement),
      `${width}: dialog restores focus`,
    );
    await page
      .getByRole("button", { name: "复制安装命令", exact: true })
      .click();
    check(
      (await page.evaluate(() => navigator.clipboard.readText())) ===
        "npm install -g @logicseek/hello-cc",
      `${width}: install copy contains exact command`,
    );
    await page
      .getByRole("button", { name: "复制启动命令", exact: true })
      .click();
    check(
      (await page.evaluate(() => navigator.clipboard.readText())).replace(
        /\r\n/g,
        "\n",
      ) === "cd /path/to/your-project\nhcc web --local",
      `${width}: startup copy preserves newline`,
    );
    check(
      (await page.getByRole("status").textContent()) ===
        "命令已复制，可以粘贴到终端。",
      `${width}: accessible copy confirmation`,
    );
    if (screenshots && [1440, 390].includes(width)) {
      // Reload to remove transient toast/focus states from visual evidence.
      await page.goto(base + "/welcome");
      await page.screenshot({
        path: path.join(screenshots, `hello-cc-${width}.png`),
        fullPage: true,
      });
      if (width === 1440)
        await page.screenshot({
          path: path.join(screenshots, "hello-cc-desktop.png"),
        });
    }
  }
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Denied");
        },
      },
    });
  });
  await page.getByRole("button", { name: "复制安装命令", exact: true }).click();
  check(
    (await page.evaluate(() => window.getSelection().toString())) ===
      "npm install -g @logicseek/hello-cc",
    "clipboard denial selects the command",
  );
  check(
    (await page.getByRole("status").textContent()).includes("请手动复制"),
    "clipboard denial is explained",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  check(
    (await page.evaluate(
      () => getComputedStyle(document.documentElement).scrollBehavior,
    )) === "auto",
    "reduced motion disables smooth scrolling",
  );
  check(
    requests.every(
      (url) =>
        new URL(url).origin === base &&
        !new URL(url).pathname.startsWith("/api/"),
    ),
    "no external or project API requests",
  );
  check(errors.length === 0, `no console or page errors: ${errors.join("; ")}`);
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await noJs.newPage();
  await staticPage.goto(base + "/welcome");
  check(
    await staticPage.locator("#install-command").isVisible(),
    "installation content works without JavaScript",
  );
  check(
    await staticPage.locator("#capability-title").isVisible(),
    "capabilities work without JavaScript",
  );
  await noJs.close();
  console.log(
    `Product page: ${checks} checks passed at 1440, 1024, 768, 390 and 320px. No API requests or browser errors.`,
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
}
