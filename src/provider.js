import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OVERLAY_SCRIPT = path.join(ROOT_DIR, "scripts", "render-image-overlay.ps1");

export class ProviderDefiniteFailure extends Error {
  constructor(message, code = "provider_definite_failure") {
    super(message);
    this.name = "ProviderDefiniteFailure";
    this.code = code;
  }
}

export class ProviderOutcomeUncertain extends Error {
  constructor(message, code = "provider_outcome_uncertain") {
    super(message);
    this.name = "ProviderOutcomeUncertain";
    this.code = code;
  }
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrapText(value, length = 28) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const chunks = [];
  for (let index = 0; index < text.length; index += length) chunks.push(text.slice(index, index + length));
  return chunks;
}

const DIMENSION_ALIASES = {
  length: ["length", "长", "长度", "总长", "全长"],
  width: ["width", "宽", "宽度"],
  height: ["height", "高", "高度", "厚", "厚度"]
};

function getDimension(spec, name, fallback = "待确认") {
  const aliases = (DIMENSION_ALIASES[name] || [name]).map((alias) => alias.toLowerCase());
  const found = (spec.dimensions || []).find((item) => {
    const key = String(item?.name ?? "").trim().toLowerCase();
    return aliases.includes(key);
  });
  const value = typeof found?.value === "number" ? String(found.value) : String(found?.value ?? "").trim();
  return value ? `${value} ${found.unit || "mm"}` : fallback;
}

function safeMimeForDataUri(mime) {
  return mime === "image/png" ? "image/png" : "image/jpeg";
}

async function escapeThumbnail(referenceFiles = []) {
  const first = referenceFiles[0];
  if (!first) return null;
  try {
    const buffer = await fs.readFile(first);
    const extension = path.extname(first).toLowerCase();
    const mime = extension === ".png" ? "image/png" : "image/jpeg";
    return `data:${safeMimeForDataUri(mime)};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

function buildMockSvg(request, thumbnailData) {
  const spec = request.spec || {};
  const product = escapeXml(spec.productName || "产品说明图");
  const material = escapeXml(spec.material || "资料未明确");
  const mounting = escapeXml(spec.mounting || "资料未明确");
  const materialLines = wrapText(material, 12).slice(0, 2);
  if (wrapText(material, 12).length > 2) materialLines[1] = `${materialLines[1].slice(0, 11)}…`;
  const labels = Array.isArray(spec.labels) ? spec.labels.filter(Boolean) : [];
  const unknowns = Array.isArray(spec.unknowns) ? spec.unknowns.filter(Boolean) : [];
  const allNotes = [
    "示意图，尺寸与用途需人工复核",
    unknowns.length ? `待确认：${unknowns.join("；")}` : "无待确认参数",
    `参数来源：${spec.sourceNote || "用户输入与已上传资料"}`
  ].flatMap((note) => wrapText(note, 74));
  const noteLines = allNotes.slice(0, 3);
  if (allNotes.length > 3) noteLines[2] = `${noteLines[2].slice(0, 72)}…`;
  const mountingLines = wrapText(mounting, 26).slice(0, 2);
  if (wrapText(mounting, 26).length > 2) mountingLines[1] = `${mountingLines[1].slice(0, 25)}…`;
  const unknownLines = wrapText(unknowns.length ? unknowns.join("；") : "无已知缺项", 30).slice(0, 3);
  const labelRows = labels.slice(0, 4).map((label, index) => {
    const y = index * 40;
    return `
      <g transform="translate(0 ${y})">
        <circle cx="0" cy="0" r="11" fill="#171f1e"/>
        <text x="0" y="5" text-anchor="middle" fill="#DDF45B" font-size="12" font-weight="800">${index + 1}</text>
        <text x="26" y="5" fill="#29302f" font-size="18" font-weight="650">${escapeXml(label).slice(0, 18)}</text>
      </g>`;
  }).join("");
  const noteRows = noteLines.map((note, index) => `
    <text id="note-${index + 1}" x="70" y="${912 + index * 24}" fill="#626964" font-size="16">${escapeXml(note)}</text>`).join("");
  const thumbnail = thumbnailData
    ? `<g id="source-thumbnail">
        <rect x="1070" y="410" width="460" height="215" rx="12" fill="#f7f4ea" stroke="#d8d2c4"/>
        <image href="${thumbnailData}" x="1082" y="422" width="436" height="164" preserveAspectRatio="xMidYMid meet"/>
        <text x="1300" y="606" text-anchor="middle" fill="#7a817c" font-size="14">上传资料</text>
      </g>`
    : `<g id="source-thumbnail">
        <rect x="1070" y="410" width="460" height="215" rx="12" fill="#f7f4ea" stroke="#d8d2c4" stroke-dasharray="8 8"/>
        <text x="1300" y="524" text-anchor="middle" fill="#8a8f8b" font-size="17">未附资料来源</text>
      </g>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
  <title>${product} - 挡车器安装示意图</title>
  <rect width="1600" height="1000" fill="#F4F0E6"/>
  <rect x="0" y="0" width="1600" height="158" fill="#18201F"/>
  <rect x="0" y="158" width="1600" height="8" fill="#DDF45B"/>
  <text x="84" y="70" fill="#DDF45B" font-size="20" font-weight="800" letter-spacing="3">PRODUCT FIELD GUIDE</text>
  <text x="84" y="124" fill="#FFFFFF" font-size="44" font-weight="800">${product} · 安装示意图</text>
  <text x="1516" y="76" text-anchor="end" fill="#AEB6B2" font-size="18">MOCK / 教学演示</text>
  <text x="1516" y="112" text-anchor="end" fill="#8F9A96" font-size="16">三栏：图例 · 侧面图 · 安装平面图</text>

  <g id="panel-legend" transform="translate(70 196)">
    <rect x="0" y="0" width="310" height="444" rx="16" fill="#FFFDF8" stroke="#D8D2C4"/>
    <text x="20" y="38" fill="#7A817C" font-size="15" font-weight="700">挡车器图例</text>
    <g transform="translate(12 190) scale(0.36)">
      <path d="M70 88 L712 88 L795 242 L0 242 Z" fill="#232B2A"/>
      <path d="M84 106 L698 106 L756 205 L27 205 Z" fill="#151B1B"/>
      <g id="warning-strips" fill="#F4C747">
        <path d="M121 124 L238 124 L206 184 L86 184 Z"/>
        <path d="M293 124 L474 124 L459 184 L274 184 Z"/>
        <path d="M530 124 L647 124 L675 184 L546 184 Z"/>
      </g>
      <g fill="#77807D">
        <circle cx="182" cy="226" r="13" stroke="#D9E0DD" stroke-width="5"/>
        <circle cx="620" cy="226" r="13" stroke="#D9E0DD" stroke-width="5"/>
      </g>
    </g>
    <path d="M40 318 H262" stroke="#8E9692" stroke-width="2.5"/>
    <path d="M40 310 V326 M262 310 V326" stroke="#8E9692" stroke-width="2.5"/>
    <text x="151" y="352" text-anchor="middle" fill="#39413F" font-size="22" font-weight="800">长 ${escapeXml(getDimension(spec, "length"))}</text>
    <text x="20" y="404" fill="#7A817C" font-size="12">轴测示意，不代表透视比例</text>
  </g>

  <g id="panel-side" transform="translate(398 196)">
    <rect x="0" y="0" width="310" height="444" rx="16" fill="#FFFDF8" stroke="#D8D2C4"/>
    <text x="20" y="38" fill="#7A817C" font-size="15" font-weight="700">橡胶挡车器侧面图</text>
    <rect x="58" y="180" width="190" height="109" rx="6" fill="#232B2A"/>
    <rect x="58" y="212" width="190" height="26" fill="#F4C747"/>
    <path d="M58 320 H248" stroke="#8E9692" stroke-width="2.5"/>
    <path d="M58 312 V328 M248 312 V328" stroke="#8E9692" stroke-width="2.5"/>
    <text x="153" y="354" text-anchor="middle" fill="#39413F" font-size="20" font-weight="800">宽 ${escapeXml(getDimension(spec, "width"))}</text>
    <path d="M262 180 V289" stroke="#8E9692" stroke-width="2.5"/>
    <path d="M254 180 H270 M254 289 H270" stroke="#8E9692" stroke-width="2.5"/>
    <text x="153" y="388" text-anchor="middle" fill="#39413F" font-size="20" font-weight="800">高 ${escapeXml(getDimension(spec, "height"))}</text>
    <text x="20" y="418" fill="#7A817C" font-size="12">外形轮廓，警示条位置按资料示意</text>
  </g>

  <g id="panel-plan" transform="translate(726 196)">
    <rect x="0" y="0" width="310" height="444" rx="16" fill="#FFFDF8" stroke="#D8D2C4"/>
    <text x="20" y="38" fill="#7A817C" font-size="15" font-weight="700">挡车器安装平面图</text>
    <text x="28" y="150" fill="#27302E" font-size="14" font-weight="700">M10 膨胀螺栓 ×2</text>
    <text x="28" y="174" fill="#8B6A58" font-size="13">孔位未给定，示意不定位</text>
    <rect x="28" y="200" width="254" height="67" rx="6" fill="#232B2A"/>
    <circle cx="84" cy="234" r="7" fill="#232B2A" stroke="#D9E0DD" stroke-width="3"/>
    <circle cx="226" cy="234" r="7" fill="#232B2A" stroke="#D9E0DD" stroke-width="3"/>
    <path d="M84 226 V196" stroke="#8E9692" stroke-width="1.5" stroke-dasharray="4 4"/>
    <path d="M226 226 V196" stroke="#8E9692" stroke-width="1.5" stroke-dasharray="4 4"/>
    <path d="M28 310 H282" stroke="#8E9692" stroke-width="2.5"/>
    <path d="M28 302 V318 M282 302 V318" stroke="#8E9692" stroke-width="2.5"/>
    <text x="155" y="344" text-anchor="middle" fill="#39413F" font-size="20" font-weight="800">长 ${escapeXml(getDimension(spec, "length"))}</text>
    <text x="28" y="384" fill="#7A817C" font-size="12">地面固定；安装间距资料未给出</text>
  </g>

  <g id="info-material" transform="translate(70 660)">
    <rect x="0" y="0" width="470" height="110" rx="12" fill="#EFF3E9"/>
    <text x="20" y="28" fill="#767D78" font-size="13" font-weight="700">本体材质</text>
    ${materialLines.map((line, index) => `<text x="20" y="${54 + index * 22}" fill="#27302E" font-size="15" font-weight="700">${line}</text>`).join("")}
  </g>
  <g id="info-mounting" transform="translate(556 660)">
    <rect x="0" y="0" width="480" height="110" rx="12" fill="#FFF1E8"/>
    <text x="20" y="28" fill="#8B6A58" font-size="13" font-weight="700">固定方式</text>
    ${mountingLines.map((line, index) => `<text x="20" y="${54 + index * 22}" fill="#27302E" font-size="14" font-weight="700">${line}</text>`).join("")}
  </g>

  <g id="annotation-panel" transform="translate(1070 226)">
    <text x="0" y="0" fill="#18201F" font-size="20" font-weight="800">资料要点</text>
    <g transform="translate(0 40)">${labelRows}</g>
  </g>
  ${thumbnail}

  <g id="unknown-panel" transform="translate(1070 645)">
    <rect x="0" y="0" width="460" height="152" rx="12" fill="#FFF2DF" stroke="#E3C6A2"/>
    <text x="22" y="32" fill="#9C5C22" font-size="16" font-weight="800">待确认项</text>
    ${unknownLines.map((line, index) => `<text x="22" y="${62 + index * 26}" fill="#4A4036" font-size="15">${escapeXml(line)}</text>`).join("")}
    <text x="22" y="132" fill="#7B6B5C" font-size="13">未确认参数不会自动补写</text>
  </g>

  <line x1="70" y1="856" x2="1530" y2="856" stroke="#D6D0C2"/>
  <text x="70" y="884" fill="#18201F" font-size="18" font-weight="800">核对记录</text>
  ${noteRows}
  <g id="revision-note">
    <text x="1530" y="984" text-anchor="end" fill="#6C736F" font-size="15">请复核文字、结构与用途</text>
  </g>
</svg>`;
}

function normalizeEditInstruction(instruction) {
  const text = String(instruction || "").trim();
  if (!text) throw new ProviderDefiniteFailure("编辑指令为空", "invalid_edit_instruction");
  return text;
}

function stripIdempotentMockMarkers(request) {
  const instruction = normalizeEditInstruction(request.instruction);
  if (instruction.includes("FORCE_DEFINITE_FAILURE")) {
    throw new ProviderDefiniteFailure("模拟供应商明确拒绝请求；预留点数已释放", "mock_definite_failure");
  }
  if (instruction.includes("FORCE_UNCERTAIN_OUTCOME")) {
    throw new ProviderOutcomeUncertain("模拟供应商超时，调用结果待核查", "mock_uncertain_timeout");
  }
  return instruction;
}

export class MockImageProvider {
  mode = "mock";

  async generate(request) {
    stripIdempotentMockMarkers(request);
    const thumbnail = await escapeThumbnail(request.referenceFiles);
    const svg = buildMockSvg(request, thumbnail);
    await fs.writeFile(request.outputPath, svg, "utf8");
    return {
      providerRequestId: `mock-gen-${request.jobId}`,
      outputPath: request.outputPath,
      mimeType: "image/svg+xml",
      mode: "mock"
    };
  }

  async edit(request) {
    const instruction = stripIdempotentMockMarkers(request);
    const source = await fs.readFile(request.parentImagePath, "utf8");
    if (!source.includes('id="warning-strips"')) {
      throw new ProviderDefiniteFailure("父图不是本服务可编辑的图稿", "unsupported_parent_image");
    }
    let fill = "#F4C747";
    if (/橙|orange/i.test(instruction)) fill = "#F47732";
    if (/红|red/i.test(instruction)) fill = "#D94A3D";
    if (/蓝|blue/i.test(instruction)) fill = "#3B76F6";
    if (/绿|green/i.test(instruction)) fill = "#48A868";
    let edited = source.replace(
      /<g id="warning-strips" fill="[^"]+">([\s\S]*?)<\/g>/,
      `<g id="warning-strips" fill="${fill}">$1</g>`
    );
    const shortInstruction = escapeXml(wrapText(instruction, 36)[0] || "按要求调整");
    const revision = `<text x="1530" y="972" text-anchor="end" fill="#6C736F" font-size="15">已调整：${shortInstruction}</text>`;
    edited = edited.replace(/<g id="revision-note">[\s\S]*?<\/g>/, `<g id="revision-note">${revision}</g>`);
    await fs.writeFile(request.outputPath, edited, "utf8");
    return {
      providerRequestId: `mock-edit-${request.jobId}`,
      outputPath: request.outputPath,
      mimeType: "image/svg+xml",
      mode: "mock"
    };
  }
}

function extensionForMime(mime) {
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("svg")) return ".svg";
  return ".jpg";
}

function mimeForOutputFormat(value) {
  if (value === "jpeg" || value === "jpg") return "image/jpeg";
  if (value === "webp") return "image/webp";
  return "image/png";
}

function responseImagePayload(json, fallbackMime = "image/png") {
  const data = json?.data?.[0] ?? json?.output?.[0] ?? json?.images?.[0] ?? json;
  if (typeof data?.b64_json === "string" && data.b64_json) {
    return { buffer: Buffer.from(data.b64_json, "base64"), mimeType: data.mime_type || fallbackMime, url: null };
  }
  if (typeof data?.base64 === "string" && data.base64) {
    return { buffer: Buffer.from(data.base64, "base64"), mimeType: data.mime_type || fallbackMime, url: null };
  }
  if (typeof data?.url === "string" && data.url) {
    return { buffer: null, mimeType: data.mime_type || "image/png", url: data.url };
  }
  if (typeof data?.image === "string" && data.image) {
    if (data.image.startsWith("data:")) {
      const match = data.image.match(/^data:([^;]+);base64,(.*)$/s);
      if (match) return { buffer: Buffer.from(match[2], "base64"), mimeType: match[1], url: null };
    }
    return { buffer: null, mimeType: data.mime_type || "image/png", url: data.image };
  }
  throw new ProviderOutcomeUncertain("供应商返回 2xx，但响应中没有可识别图片", "provider_response_unrecognized");
}

function imageMimeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".svg") return "image/svg+xml";
  return null;
}

function runPowerShellOverlay(requestPath) {
  return new Promise((resolve, reject) => {
    if (!process.env.SystemRoot) {
      reject(new Error("本地排版层需要 Windows SystemRoot"));
      return;
    }
    const powershell = path.join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const child = spawn(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", OVERLAY_SCRIPT, "-RequestPath", requestPath],
      { windowsHide: true }
    );
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("本地排版层执行超时"));
    }, 30_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `本地排版层退出码 ${code}`));
    });
  });
}

async function renderLiveTextOverlay(request, downloaded) {
  if (process.platform !== "win32" || !request.spec?.productName) {
    return { ...downloaded, textOverlay: "skipped" };
  }

  const spec = request.spec;
  const outputPath = `${request.outputPath}-overlay.png`;
  const requestPath = `${request.outputPath}-overlay.json`;
  const dimensionLabels = {
    length: "长",
    width: "宽",
    height: "高",
    长: "长",
    长度: "长",
    总长: "长",
    宽: "宽",
    宽度: "宽",
    高: "高",
    高度: "高",
    厚: "厚",
    厚度: "厚"
  };
  const dimensionLines = (spec.dimensions || [])
    .slice(0, 3)
    .map((item) => `${dimensionLabels[item.name] || item.name} ${item.value} ${item.unit}`);
  const labelsText = (spec.labels || []).join(" / ");
  const unknowns = (spec.unknowns || []).filter(Boolean);
  const unknownsText = unknowns.length ? `待确认：${unknowns.join(" / ")}` : "无已知待确认项";
  const payload = {
    inputPath: downloaded.outputPath,
    outputPath,
    productName: spec.productName,
    layout: spec.layout || "横向中文产品说明示意图",
    dimensionLines: dimensionLines.length ? dimensionLines : ["尺寸待确认"],
    material: spec.material || "材质待确认",
    mounting: spec.mounting || "安装方式待确认",
    labelsText: labelsText || "无资料要点",
    unknownsText,
    sourceNote: spec.sourceNote || "参数来自用户输入与已上载资料"
  };

  try {
    await fs.writeFile(requestPath, JSON.stringify(payload, null, 2), "utf8");
    await runPowerShellOverlay(requestPath);
    const stats = await fs.stat(outputPath);
    if (!stats.isFile() || stats.size === 0) throw new Error("本地排版层未生成图片");
    if (downloaded.outputPath !== outputPath) await fs.rm(downloaded.outputPath, { force: true });
    return { outputPath, mimeType: "image/png", textOverlay: "applied" };
  } catch (error) {
    console.warn("local text overlay failed", error.message);
    return { ...downloaded, textOverlay: "failed" };
  } finally {
    await fs.rm(requestPath, { force: true });
  }
}

function applyImageParameters(target, config, operation) {
  target.model = operation === "edit" ? config.imageEditModel : config.imageGenerateModel;
  target.n = 1;
  target.size = config.imageSize;
  if (config.imageQuality) target.quality = config.imageQuality;
  if (config.imageOutputFormat) target.output_format = config.imageOutputFormat;
  if (config.imageResponseFormat) target.response_format = config.imageResponseFormat;
  return target;
}

export class GenericLiveImageProvider {
  mode = "live";

  constructor(config) {
    this.config = config;
  }

  assertConfigured(operation) {
    if (!this.config.imageApiBaseUrl || !this.config.imageApiKey) {
      throw new ProviderDefiniteFailure("真实 Image API 尚未配置", "provider_not_configured");
    }
    const model = operation === "edit" ? this.config.imageEditModel : this.config.imageGenerateModel;
    if (!model) throw new ProviderDefiniteFailure("真实 Image 模型尚未配置", "model_not_configured");
  }

  async downloadResult(payload, outputPath) {
    let buffer = payload.buffer;
    let mimeType = payload.mimeType;
    if (!buffer && payload.url) {
      let response;
      try {
        response = await fetch(payload.url, { signal: AbortSignal.timeout(45_000) });
      } catch (error) {
        throw new ProviderOutcomeUncertain(`图片下载结果未知：${error.message}`, "provider_download_uncertain");
      }
      if (!response.ok) throw new ProviderDefiniteFailure(`图片下载失败：HTTP ${response.status}`, "provider_download_failed");
      buffer = Buffer.from(await response.arrayBuffer());
      mimeType = response.headers.get("content-type")?.split(";")[0] || mimeType;
    }
    if (!buffer?.length) throw new ProviderOutcomeUncertain("供应商返回空图片内容", "provider_empty_image");
    if (!String(mimeType).startsWith("image/")) {
      throw new ProviderOutcomeUncertain(`供应商返回了非图片内容：${mimeType}`, "provider_non_image_response");
    }
    const finalPath = `${outputPath}${extensionForMime(mimeType)}`;
    await fs.writeFile(finalPath, buffer);
    return { outputPath: finalPath, mimeType };
  }

  async requestJson(url, init) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new ProviderOutcomeUncertain(`供应商连接中断，结果待核查：${error.message}`, "provider_connection_uncertain");
    }
    const requestId = response.headers.get("x-request-id") || response.headers.get("request-id") || null;
    if (response.status === 408 || response.status >= 500) {
      throw new ProviderOutcomeUncertain(`供应商返回 HTTP ${response.status}，结果待核查`, "provider_status_uncertain");
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ProviderDefiniteFailure(`供应商拒绝请求：HTTP ${response.status} ${body.slice(0, 300)}`, "provider_rejected");
    }
    try {
      return { json: await response.json(), requestId };
    } catch {
      throw new ProviderOutcomeUncertain("供应商响应无法解析，结果待核查", "provider_json_uncertain");
    }
  }

  headers(request) {
    return {
      authorization: `Bearer ${this.config.imageApiKey}`,
      "idempotency-key": request.jobId
    };
  }

  async finalizeGeneratedImage(request, result) {
    if (!this.config.imageTextOverlay) return { ...result, textOverlay: "disabled" };
    return renderLiveTextOverlay(request, result);
  }

  async requestWithReferences(request, files, operation) {
    const form = new FormData();
    const parameters = applyImageParameters({ prompt: request.prompt }, this.config, operation);
    for (const [key, value] of Object.entries(parameters)) form.set(key, String(value));
    for (const filePath of files) {
      const mimeType = imageMimeForPath(filePath);
      if (!mimeType || mimeType === "image/svg+xml") {
        throw new ProviderDefiniteFailure("真实 Provider 不接受 SVG 输入，请上传 PNG、JPG 或 WebP", "unsupported_reference_image");
      }
      const buffer = await fs.readFile(filePath);
      const field = files.length === 1 ? "image" : "image[]";
      form.append(field, new Blob([buffer], { type: mimeType }), path.basename(filePath));
    }
    const { json, requestId } = await this.requestJson(`${this.config.imageApiBaseUrl}/images/edits`, {
      method: "POST",
      headers: this.headers(request),
      body: form,
      signal: AbortSignal.timeout(this.config.imageApiTimeoutMs || 120_000)
    });
    const downloaded = await this.downloadResult(
      responseImagePayload(json, mimeForOutputFormat(this.config.imageOutputFormat)),
      request.outputPath
    );
    return {
      ...downloaded,
      providerRequestId: requestId || json?.id || `live-${operation}-${request.jobId}`,
      mode: "live"
    };
  }

  async generate(request) {
    this.assertConfigured("generate");
    if (request.referenceFiles?.length) {
      const result = await this.requestWithReferences(request, request.referenceFiles.slice(0, 4), "generate");
      return this.finalizeGeneratedImage(request, result);
    }
    const body = applyImageParameters({ prompt: request.prompt }, this.config, "generate");
    const { json, requestId } = await this.requestJson(`${this.config.imageApiBaseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.headers(request)
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.imageApiTimeoutMs || 120_000)
    });
    const downloaded = await this.downloadResult(
      responseImagePayload(json, mimeForOutputFormat(this.config.imageOutputFormat)),
      request.outputPath
    );
    return this.finalizeGeneratedImage(request, {
      ...downloaded,
      providerRequestId: requestId || json?.id || `live-gen-${request.jobId}`,
      mode: "live"
    });
  }

  async edit(request) {
    this.assertConfigured("edit");
    if (!request.parentImagePath) throw new ProviderDefiniteFailure("编辑任务缺少父图", "parent_image_missing");
    return this.requestWithReferences(request, [request.parentImagePath], "edit");
  }
}

function dashscopeSize(value) {
  const match = String(value || "").trim().match(/^(\d+)\s*[x*]\s*(\d+)$/i);
  if (!match) throw new ProviderDefiniteFailure("IMAGE_SIZE 必须为“宽x高”或“宽*高”", "invalid_image_size");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  if (width < 1 || height < 1 || pixels < 512 * 512 || pixels > 2048 * 2048) {
    throw new ProviderDefiniteFailure("DashScope 输出像素需在 512*512 至 2048*2048 之间", "image_size_out_of_range");
  }
  return `${width}*${height}`;
}

async function imageDataUri(filePath) {
  const mimeType = imageMimeForPath(filePath);
  if (!mimeType || mimeType === "image/svg+xml") {
    throw new ProviderDefiniteFailure("DashScope 不接受 SVG 输入，请使用 PNG、JPG 或 WebP", "unsupported_reference_image");
  }
  const buffer = await fs.readFile(filePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function dashscopeImagePayload(json) {
  const choices = json?.output?.choices || [];
  for (const choice of choices) {
    const content = Array.isArray(choice?.message?.content) ? choice.message.content : [];
    const image = content.find((item) => typeof item?.image === "string" && item.image)?.image;
    if (image) {
      if (image.startsWith("data:")) {
        const match = image.match(/^data:([^;]+);base64,(.*)$/s);
        if (match) return { buffer: Buffer.from(match[2], "base64"), mimeType: match[1], url: null };
      }
      return { buffer: null, mimeType: "image/png", url: image };
    }
  }
  const legacyImage = json?.output?.results?.[0]?.url || json?.output?.image_url;
  if (legacyImage) return { buffer: null, mimeType: "image/png", url: legacyImage };
  throw new ProviderOutcomeUncertain("DashScope 返回 2xx，但没有可识别图片 URL", "provider_response_unrecognized");
}

export class DashScopeImageProvider extends GenericLiveImageProvider {
  async invoke(request, imageFiles) {
    this.assertConfigured(request.operation);
    const content = [];
    for (const filePath of imageFiles.slice(0, request.operation === "edit" ? 1 : 3)) {
      content.push({ image: await imageDataUri(filePath) });
    }
    content.push({ text: request.prompt });
    const parameters = {
      n: 1,
      prompt_extend: Boolean(this.config.imagePromptExtend),
      watermark: Boolean(this.config.imageWatermark),
      size: dashscopeSize(this.config.imageSize)
    };
    if (this.config.imageNegativePrompt) parameters.negative_prompt = this.config.imageNegativePrompt;
    const { json, requestId } = await this.requestJson(
      `${this.config.imageApiBaseUrl}/api/v1/services/aigc/multimodal-generation/generation`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.headers(request)
        },
        body: JSON.stringify({
          model: request.operation === "edit" ? this.config.imageEditModel : this.config.imageGenerateModel,
          input: {
            messages: [{ role: "user", content }]
          },
          parameters
        }),
        signal: AbortSignal.timeout(this.config.imageApiTimeoutMs || 180_000)
      }
    );
    const downloaded = await this.downloadResult(dashscopeImagePayload(json), request.outputPath);
    return {
      ...downloaded,
      providerRequestId: requestId || json?.request_id || `dashscope-${request.operation}-${request.jobId}`,
      mode: "live"
    };
  }

  async generate(request) {
    const result = await this.invoke(request, request.referenceFiles || []);
    return this.finalizeGeneratedImage(request, result);
  }

  async edit(request) {
    if (!request.parentImagePath) throw new ProviderDefiniteFailure("编辑任务缺少父图", "parent_image_missing");
    return this.invoke(request, [request.parentImagePath]);
  }
}

function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function chatCompletionImagePayload(json) {
  const message = json?.choices?.[0]?.message;
  // 部分中转（如 chaozhipai / Vertex 代理）把 base64 图片放在 message.audio.data，
  // 真实 mime 在 extra_content.google.mime_type，content 里只有模型思考文本。
  const mimeHint =
    message?.audio?.extra_content?.google?.mime_type ||
    message?.extra_content?.google?.mime_type ||
    null;
  const audioB64 = typeof message?.audio?.data === "string" ? message.audio.data : null;
  if (audioB64 && audioB64.length > 512) {
    const buffer = Buffer.from(audioB64, "base64");
    const sniffed = sniffImageMime(buffer);
    if (sniffed) return { buffer, mimeType: sniffed, url: null };
    if (/^image\//i.test(String(mimeHint || ""))) return { buffer, mimeType: mimeHint, url: null };
  }
  const content = Array.isArray(message?.content) ? message.content : [message?.content];
  const candidates = [...content, ...(Array.isArray(message?.images) ? message.images : [])];
  for (const item of candidates) {
    if (!item) continue;
    const imageUrl = typeof item === "string"
      ? item
      : item?.image_url?.url || item?.image?.url || item?.url || null;
    if (!imageUrl) continue;
    if (imageUrl.startsWith("data:")) {
      const match = imageUrl.match(/^data:([^;]+);base64,(.*)$/s);
      if (match) return { buffer: Buffer.from(match[2], "base64"), mimeType: match[1], url: null };
    }
    if (/^https?:\/\//i.test(imageUrl)) return { buffer: null, mimeType: "image/png", url: imageUrl };
  }
  throw new ProviderOutcomeUncertain("聊天接口返回 2xx，但没有可识别图片", "provider_response_unrecognized");
}

export class ChatCompletionsImageProvider extends GenericLiveImageProvider {
  async invoke(request, imageFiles) {
    this.assertConfigured(request.operation);
    const content = [{ type: "text", text: request.prompt }];
    for (const filePath of imageFiles.slice(0, request.operation === "edit" ? 1 : 3)) {
      content.push({ type: "image_url", image_url: { url: await imageDataUri(filePath) } });
    }
    const { json, requestId } = await this.requestJson(`${this.config.imageApiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.headers(request)
      },
      body: JSON.stringify({
        model: request.operation === "edit" ? this.config.imageEditModel : this.config.imageGenerateModel,
        messages: [{
          role: "user",
          content: content.length === 1 ? request.prompt : content
        }],
        stream: false
      }),
      signal: AbortSignal.timeout(this.config.imageApiTimeoutMs || 180_000)
    });
    const downloaded = await this.downloadResult(chatCompletionImagePayload(json), request.outputPath);
    return {
      ...downloaded,
      providerRequestId: requestId || json?.id || `chat-${request.operation}-${request.jobId}`,
      mode: "live"
    };
  }

  async generate(request) {
    return this.invoke(request, request.referenceFiles || []);
  }

  async edit(request) {
    if (!request.parentImagePath) throw new ProviderDefiniteFailure("编辑任务缺少父图", "parent_image_missing");
    return this.invoke(request, [request.parentImagePath]);
  }
}

export function createProvider(config) {
  if (config.providerMode !== "live") return new MockImageProvider();
  if (["chat", "chat-completions", "openai-chat"].includes(String(config.imageApiStyle).toLowerCase())) {
    return new ChatCompletionsImageProvider(config);
  }
  if (["dashscope", "aliyun", "qwen"].includes(String(config.imageApiStyle).toLowerCase())) {
    return new DashScopeImageProvider(config);
  }
  return new GenericLiveImageProvider(config);
}
