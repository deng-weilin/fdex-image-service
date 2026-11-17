import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveSmokeBrowser, smokeCredentials } from "./browser-smoke-env.mjs";

const root = path.resolve(import.meta.dirname, "..");
const edge = resolveSmokeBrowser(root);
const credentials = smokeCredentials("instructor");
const port = 9500 + Math.floor(Math.random() * 300);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "fdex-settings-edge-"));
const serviceUrl = process.env.IMAGE_SERVICE_URL || "http://127.0.0.1:4310";

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression) {
  const { result, exceptionDetails } = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text || "Browser evaluation failed");
  return result.value;
}

async function waitFor(client, expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function pageTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const target = targets.find((item) => item.type === "page");
      if (target?.webSocketDebuggerUrl) return target;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Edge DevTools endpoint did not start");
}

async function setViewport(client, width, height) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 680
  });
}

async function navigate(client, url) {
  await client.send("Page.navigate", { url });
  await waitFor(client, "document.readyState === 'complete'");
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function screenshot(client, filename) {
  const { data } = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  await fs.writeFile(path.join(root, "runtime", filename), Buffer.from(data, "base64"));
}

async function layout(client) {
  return evaluate(client, `(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    overflowing: [...document.querySelectorAll("body *")]
      .filter((node) => {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.position === "fixed") return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 1 && (rect.right > innerWidth + 1 || rect.left < -1);
      })
      .slice(0, 12)
      .map((node) => ({ tag: node.tagName, id: node.id, className: String(node.className || "") }))
  }))()`);
}

const browser = spawn(edge, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--no-first-run",
  "--disable-extensions",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank"
], { stdio: ["ignore", "ignore", "ignore"] });

let client;
try {
  const target = await pageTarget();
  client = new Cdp(target.webSocketDebuggerUrl);
  await client.open();
  await client.send("Page.enable");
  await client.send("Runtime.enable");

  await setViewport(client, 1440, 1000);
  await navigate(client, serviceUrl);
  await evaluate(client, `(() => {
    document.querySelector("#login-username").value = ${JSON.stringify(credentials.username)};
    document.querySelector("#login-password").value = ${JSON.stringify(credentials.password)};
    document.querySelector("#login-form").requestSubmit();
  })()`);
  await waitFor(client, "!document.querySelector('#app-shell').hidden && !document.querySelector('#settings-nav').hidden");
  await evaluate(client, "document.querySelector('#settings-nav').click()");
  await waitFor(client, "document.querySelector('#view-settings').classList.contains('active') && document.querySelector('#provider-settings-form').providerMode.value");
  await new Promise((resolve) => setTimeout(resolve, 350));

  let connectionTest = null;
  if (process.env.SMOKE_PROVIDER_TEST === "1") {
    await evaluate(client, "document.querySelector('#test-provider-settings').click()");
    await waitFor(client, "!document.querySelector('#settings-test-result').hidden", 25000);
    connectionTest = await evaluate(client, `(() => ({
      className: document.querySelector("#settings-test-result").className,
      text: document.querySelector("#settings-test-result").textContent
    }))()`);
  }

  const desktop = await layout(client);
  await screenshot(client, "ui-settings-desktop.png");
  const details = await evaluate(client, `(() => ({
    keyInputEmpty: document.querySelector("#settings-api-key").value === "",
    keyInputType: document.querySelector("#settings-api-key").type,
    keyHint: document.querySelector("#settings-key-hint").textContent,
    providerMode: document.querySelector("#provider-settings-form").providerMode.value,
    status: document.querySelector("#settings-provider-status").textContent
  }))()`);

  await setViewport(client, 390, 844);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const mobile = await layout(client);
  await screenshot(client, "ui-settings-mobile.png");

  console.log(JSON.stringify({ desktop, mobile, details, connectionTest }, null, 2));
} finally {
  try {
    await client?.send("Browser.close");
  } catch {}
  await new Promise((resolve) => {
    if (browser.exitCode !== null) return resolve();
    browser.once("exit", resolve);
    setTimeout(resolve, 2500);
  });
  client?.close();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
