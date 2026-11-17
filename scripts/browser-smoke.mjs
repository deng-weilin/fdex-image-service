import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveSmokeBrowser, smokeCredentials } from "./browser-smoke-env.mjs";

const root = path.resolve(import.meta.dirname, "..");
const edge = resolveSmokeBrowser(root);
const credentials = smokeCredentials("student_a");
const port = 9200 + Math.floor(Math.random() * 300);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "fdex-edge-"));
const serviceUrl = process.env.IMAGE_SERVICE_URL || "http://127.0.0.1:4310";
const screenshotPrefix = process.env.SMOKE_SCREENSHOT_PREFIX || "ui";

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

async function waitFor(client, expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.value) return result.value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
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
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function screenshot(client, name) {
  const { data } = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  await fs.writeFile(path.join(root, "runtime", `${screenshotPrefix}-${name}`), Buffer.from(data, "base64"));
}

async function layout(client) {
  return evaluate(client, `(() => {
    const overflow = [...document.querySelectorAll("body *")]
      .filter((node) => {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.position === "fixed") return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 1 && (rect.right > innerWidth + 1 || rect.left < -1);
      })
      .slice(0, 12)
      .map((node) => ({
        tag: node.tagName,
        id: node.id,
        className: String(node.className || ""),
        left: Math.round(node.getBoundingClientRect().left),
        right: Math.round(node.getBoundingClientRect().right)
      }));
    return {
      innerWidth,
      innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      overflow
    };
  })()`);
}

let client;
try {
  const target = await pageTarget();
  client = new Cdp(target.webSocketDebuggerUrl);
  await client.open();
  await client.send("Page.enable");
  await client.send("Runtime.enable");

  await setViewport(client, 1440, 1000);
  await navigate(client, serviceUrl);
  const desktopLogin = await layout(client);
  await screenshot(client, "login-desktop.png");

  await setViewport(client, 390, 844);
  await navigate(client, serviceUrl);
  const mobileLogin = await layout(client);
  await screenshot(client, "login-mobile.png");

  await setViewport(client, 1440, 1000);
  await navigate(client, serviceUrl);
  await evaluate(client, `(() => {
    document.querySelector("#login-username").value = ${JSON.stringify(credentials.username)};
    document.querySelector("#login-password").value = ${JSON.stringify(credentials.password)};
    document.querySelector("#login-form").requestSubmit();
  })()`);
  await waitFor(client, "!document.querySelector('#app-shell').hidden && document.querySelector('#load-sample-button')");
  await new Promise((resolve) => setTimeout(resolve, 500));

  await evaluate(client, "document.querySelector('#load-sample-button').click()");
  await waitFor(client, "document.querySelectorAll('#asset-list .asset-item').length > 0");
  await evaluate(client, "document.querySelector('#spec-form').requestSubmit()");
  await waitFor(client, "!document.querySelector('#generate-button').disabled");
  await screenshot(client, "studio-ready.png");
  const generateLock = await evaluate(client, `(() => {
    window.__smokeBeforeGenerate = document.querySelector("#preview-image").src;
    const button = document.querySelector("#generate-button");
    button.click();
    button.click();
    return {
      disabled: button.disabled,
      text: button.textContent.replace(/\\s+/g, " ").trim(),
      noticeVisible: !document.querySelector("#generate-lock-notice").hidden,
      workflow: document.querySelector("#preview-workflow-label").textContent
    };
  })()`);
  await waitFor(client, `(() => {
    const button = document.querySelector("#generate-button");
    const notice = document.querySelector("#generate-lock-notice");
    const detail = notice.querySelector(":scope > div > span");
    return button.disabled && !notice.hidden && detail.getBoundingClientRect().width > 200 &&
      /正在创建|排队|生成|核查/.test(notice.innerText);
  })()`);
  const generateLocked = await evaluate(client, `(() => ({
    disabled: document.querySelector("#generate-button").disabled,
    buttonText: document.querySelector("#generate-button").textContent.replace(/\\s+/g, " ").trim(),
    noticeTitle: document.querySelector("#generate-lock-notice strong").textContent,
    noticeDetail: document.querySelector("#generate-lock-notice > div > span").textContent,
    workflow: document.querySelector("#preview-workflow-label").textContent,
    noticeLayout: (() => {
      const notice = document.querySelector("#generate-lock-notice");
      const title = notice.querySelector("strong");
      const detail = notice.querySelector(":scope > div > span");
      const badge = notice.querySelector("#generate-lock-badge");
      return {
        noticeWidth: Math.round(notice.getBoundingClientRect().width),
        titleWidth: Math.round(title.getBoundingClientRect().width),
        detailWidth: Math.round(detail.getBoundingClientRect().width),
        badgeWidth: Math.round(badge.getBoundingClientRect().width),
        titleHeight: Math.round(title.getBoundingClientRect().height)
      };
    })()
  }))()`);
  await screenshot(client, "studio-locked.png");
  await waitFor(client, `(() => {
    const job = document.querySelector("#active-job");
    const image = document.querySelector("#preview-image");
    return image.src && image.src !== window.__smokeBeforeGenerate &&
      String(job.innerText || "").includes("新生成") &&
      String(job.innerText || "").includes("任务已完成");
  })()`, 15000);
  await waitFor(client, `(() => {
    const button = document.querySelector("#generate-button");
    return !button.disabled && button.textContent.includes("生成一张") &&
      document.querySelector("#generate-lock-notice").hidden;
  })()`);
  const generateReleased = await evaluate(client, `(() => ({
    disabled: document.querySelector("#generate-button").disabled,
    text: document.querySelector("#generate-button").textContent.replace(/\\s+/g, " ").trim(),
    noticeHidden: document.querySelector("#generate-lock-notice").hidden,
    workflow: document.querySelector("#preview-workflow-label").textContent
  }))()`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const desktopApp = await layout(client);
  await screenshot(client, "studio-desktop.png");

  const generatedImage = await evaluate(client, `(() => ({
    src: document.querySelector("#preview-image").src,
    version: document.querySelector("#preview-version").textContent,
    provider: document.querySelector("#provider-pill").textContent,
    balance: document.querySelector("#balance-value").textContent,
    spec: document.querySelector("#preview-spec-name").textContent,
    activeJob: String(document.querySelector("#active-job").innerText || "").replace(/\\s+/g, " ").trim()
  }))()`);

  await evaluate(client, "document.querySelector('[data-view=library]').click()");
  await waitFor(client, "document.querySelectorAll('.image-card').length > 0");
  await evaluate(client, "document.querySelector('.image-card .edit-version').click()");
  await waitFor(client, "!document.querySelector('#edit-modal').hidden");
  await evaluate(client, `(() => {
    window.__smokeBeforeEdit = document.querySelector("#preview-image").src;
    document.querySelector("#edit-instruction").value = "把黄色警示条改为橙色，并保持现有轮廓、尺寸和其他文字不变。";
    document.querySelector("#edit-form").requestSubmit();
  })()`);
  await waitFor(client, `(() => {
    const job = document.querySelector("#active-job");
    const image = document.querySelector("#preview-image");
    return image.src && image.src !== window.__smokeBeforeEdit &&
      String(job.innerText || "").includes("继续调整") &&
      String(job.innerText || "").includes("任务已完成");
  })()`, 15000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const desktopEdit = await layout(client);
  await screenshot(client, "edit-desktop.png");
  const editedImage = await evaluate(client, `(() => ({
    src: document.querySelector("#preview-image").src,
    version: document.querySelector("#preview-version").textContent,
    provider: document.querySelector("#provider-pill").textContent,
    balance: document.querySelector("#balance-value").textContent,
    spec: document.querySelector("#preview-spec-name").textContent,
    activeJob: String(document.querySelector("#active-job").innerText || "").replace(/\\s+/g, " ").trim()
  }))()`);

  await setViewport(client, 390, 844);
  await navigate(client, serviceUrl);
  await waitFor(client, "!document.querySelector('#app-shell').hidden && !document.querySelector('#preview-image').hidden");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const mobileApp = await layout(client);
  await screenshot(client, "studio-mobile.png");
  await evaluate(client, "document.querySelector('.preview-panel').scrollIntoView({ block: 'start' })");
  await new Promise((resolve) => setTimeout(resolve, 250));
  await screenshot(client, "preview-mobile.png");

  await setViewport(client, 360, 800);
  await navigate(client, serviceUrl);
  await waitFor(client, "!document.querySelector('#app-shell').hidden");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const narrowApp = await layout(client);
  await screenshot(client, "studio-360.png");

  console.log(JSON.stringify({
    desktopLogin,
    mobileLogin,
    desktopApp,
    desktopEdit,
    lockBehavior: { generateLock, generateLocked, generateReleased },
    mobileApp,
    narrowApp,
    generatedImage,
    editedImage
  }, null, 2));
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
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.rm(profile, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
