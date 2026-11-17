const state = {
  user: null,
  pricing: null,
  providerMode: "mock",
  providerReady: false,
  wallet: null,
  assets: [],
  specs: [],
  jobs: [],
  images: [],
  selectedSpecId: null,
  previewImage: null,
  currentView: "studio",
  pollers: new Map(),
  mcpServerPath: "",
  newToken: "",
  actionHandler: null,
  activeJob: null,
  generateSubmissionInFlight: false,
  generateLockJobId: null,
  editSubmissionInFlight: false,
  editIdempotencyKey: "",
  authFeatures: { allowRegistration: false, demoAccountsEnabled: false }
};

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const icon = (name) => `<svg class="icon"><use href="#icon-${name}"></use></svg>`;
const priceLabel = (operation) => operation === "edit" ? state.pricing.edit : state.pricing.generate;
const formatDate = (value) => value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—";
const operationLabel = (operation) => operation === "edit" ? "继续调整" : "新生成";
const modeLabel = (mode) => String(mode || "mock").toUpperCase();

class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function api(path, options = {}) {
  const init = { method: options.method || "GET", headers: {}, credentials: "same-origin" };
  if (options.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.message || "请求失败", response.status, payload.error || "request_failed", payload.details);
  return payload;
}

function toast(title, message = "", type = "success") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.innerHTML = `${icon(type === "error" ? "alert-circle" : "check")}<div><strong></strong><span></span></div>`;
  qs("strong", node).textContent = title;
  qs("span", node).textContent = message;
  const region = qs("#toast-region");
  if (region.children.length >= 3) region.firstElementChild?.remove();
  region.append(node);
  setTimeout(() => node.remove(), 4200);
}

function showAuth() {
  qs("#auth-screen").hidden = false;
  qs("#app-shell").hidden = true;
  state.user = null;
}

function resetAuthenticatedUi() {
  state.pollers.forEach((timer) => clearInterval(timer));
  state.pollers.clear();
  state.activeJob = null;
  showAuth();
}

function applyAuthFeatures(features = {}) {
  state.authFeatures = {
    allowRegistration: features.allowRegistration === true,
    demoAccountsEnabled: features.demoAccountsEnabled === true
  };
  qs("#demo-account-section").hidden = !state.authFeatures.demoAccountsEnabled;
  qs("#register-details").hidden = !state.authFeatures.allowRegistration;
}

function showApp() {
  qs("#auth-screen").hidden = true;
  qs("#app-shell").hidden = false;
}

function setBusy(button, busy, busyText = "处理中") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.innerHTML = `${icon("loader")}${busyText}`;
    qs(".icon", button)?.classList.add("spin");
  } else {
    button.disabled = false;
    button.setAttribute("aria-busy", "false");
    if (button.dataset.originalText) button.innerHTML = button.dataset.originalText;
  }
}

async function login(username, password) {
  return api("/api/auth/login", { method: "POST", body: { username, password } });
}

async function enterApp() {
  const me = await api("/api/me");
  state.user = me.user;
  state.wallet = me.wallet;
  state.pricing = me.pricing;
  state.providerMode = me.providerMode;
  state.providerReady = me.providerReady !== false;
  state.mcpServerPath = me.mcpServerPath || "";
  qs("#sidebar-user-name").textContent = me.user.displayName;
  qs("#sidebar-user-role").textContent = me.user.role === "admin" ? "管理员" : "课堂成员";
  qs("#user-avatar").textContent = me.user.displayName.slice(0, 1).toUpperCase();
  qs("#settings-nav").hidden = me.user.role !== "admin";
  qs("#admin-nav").hidden = me.user.role !== "admin";
  updateStaticValues();
  showApp();
  await loadWorkspace();
  setView("studio");
}

function updateStaticValues() {
  const generate = state.pricing?.generate ?? 10;
  const edit = state.pricing?.edit ?? 4;
  qs("#generate-price").textContent = generate;
  qs("#edit-price").textContent = edit;
  qs("#ledger-generate-price").textContent = generate;
  qs("#ledger-edit-price").textContent = edit;
  qs("#connect-generate-price").textContent = generate;
  qs("#connect-edit-price").textContent = edit;
  const providerLabel = state.providerReady ? modeLabel(state.providerMode) : `${modeLabel(state.providerMode)} · 未配置`;
  qs("#provider-pill").textContent = providerLabel;
  qs("#provider-pill").className = `status-pill ${state.providerReady ? "status-pill-success" : "status-pill-muted"}`;
  qs("#connect-provider-mode").textContent = providerLabel;
  updateWalletUi();
}

function updateWalletUi() {
  const wallet = state.wallet || { available: 0, reserved: 0, spent: 0 };
  qs("#balance-value").textContent = wallet.available;
  qs("#ledger-available").textContent = wallet.available;
  qs("#ledger-reserved").textContent = wallet.reserved;
  qs("#ledger-spent").textContent = wallet.spent;
  updateGenerateButton();
}

async function refreshWallet() {
  state.wallet = await api("/api/wallet");
  updateWalletUi();
}

async function loadWorkspace() {
  const [assets, specs, jobs, images] = await Promise.all([
    api("/api/assets"),
    api("/api/drawing-specs"),
    api("/api/image-jobs"),
    api("/api/images")
  ]);
  state.assets = assets.assets;
  state.specs = specs.specs;
  state.jobs = jobs.jobs;
  state.images = images.images;
  if (!state.selectedSpecId || !state.specs.some((spec) => spec.id === state.selectedSpecId)) {
    state.selectedSpecId = state.specs[0]?.id || null;
  }
  renderAssets();
  renderSpecs();
  renderRecentImages();
  renderImageGrid();
  if (!state.previewImage && state.images[0]) showPreview(state.images[0]);
  qs("#nav-image-count").textContent = state.images.length;
  resumeOpenJobs();
}

function renderAssets() {
  const container = qs("#asset-list");
  container.replaceChildren();
  if (!state.assets.length) {
    const empty = document.createElement("div");
    empty.className = "empty-inline";
    empty.textContent = "还没有资料";
    container.append(empty);
    return;
  }
  for (const asset of state.assets.slice(0, 5)) {
    const row = document.createElement("div");
    row.className = "asset-item";
    row.innerHTML = `<img class="asset-thumb" alt=""><div class="asset-copy"><strong></strong><span></span></div>`;
    qs("img", row).src = asset.contentUrl;
    qs("strong", row).textContent = asset.originalName;
    qs("span", row).textContent = `${asset.kind === "product_source" ? "产品资料" : asset.kind === "style_reference" ? "版式参考" : "上传资料"} · ${Math.max(1, Math.round(asset.sizeBytes / 1024))} KB`;
    container.append(row);
  }
}

function renderSpecs() {
  const container = qs("#saved-spec-list");
  container.replaceChildren();
  if (!state.specs.length) {
    container.innerHTML = '<div class="empty-inline">保存后可开始生成</div>';
    qs("#spec-version-label").textContent = "—";
    qs("#spec-save-state").textContent = "未保存";
    qs("#preview-spec-name").textContent = "尚未保存";
    updateGenerateButton();
    return;
  }
  for (const spec of state.specs.slice(0, 5)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `saved-spec${spec.id === state.selectedSpecId ? " selected" : ""}`;
    button.innerHTML = `<div class="saved-spec-copy"><strong></strong><span></span></div><span class="saved-spec-badge"></span>`;
    qs("strong", button).textContent = spec.productName;
    qs("span", button).textContent = `${formatDate(spec.createdAt)} · ${spec.unknowns?.length || 0} 个待确认项`;
    qs(".saved-spec-badge", button).textContent = `v${spec.version}`;
    button.addEventListener("click", () => selectSpec(spec.id));
    container.append(button);
  }
  const selected = state.specs.find((spec) => spec.id === state.selectedSpecId) || state.specs[0];
  state.selectedSpecId = selected.id;
  qs("#spec-version-label").textContent = `v${selected.version}`;
  qs("#spec-save-state").textContent = "已保存";
  qs("#preview-spec-name").textContent = `${selected.productName} · v${selected.version}`;
  updateGenerateButton();
}

function selectSpec(specId) {
  state.selectedSpecId = specId;
  renderSpecs();
}

function updateGenerateButton() {
  const button = qs("#generate-button");
  if (!button) return;
  const missingPrice = state.pricing?.generate ?? 10;
  const activeTask = state.activeJob && ["queued", "running"].includes(state.activeJob.status)
    ? state.activeJob
    : state.jobs.find((job) => job.status === "queued" || job.status === "running");
  const uncertainTask = state.jobs.find((job) => job.status === "reconciling");
  const taskLocked = state.generateSubmissionInFlight || Boolean(state.generateLockJobId) || state.pollers.size > 0 || Boolean(activeTask) || Boolean(uncertainTask);
  const missingPrerequisite = !state.providerReady || !state.selectedSpecId || !state.wallet || state.wallet.available < missingPrice;
  button.disabled = taskLocked || missingPrerequisite;
  button.classList.toggle("is-task-locked", taskLocked);
  button.setAttribute("aria-busy", String(taskLocked));

  if (state.generateSubmissionInFlight) {
    button.innerHTML = `${icon("loader")}<span>正在提交</span>`;
    qs(".icon", button)?.classList.add("spin");
  } else if (activeTask) {
    button.innerHTML = `${icon("lock")}<span>生成中，已锁定</span>`;
  } else if (uncertainTask) {
    button.innerHTML = `${icon("alert-circle")}<span>等待结果核查</span>`;
  } else {
    button.innerHTML = `${icon("sparkles")}<span>生成一张</span>`;
  }

  button.title = taskLocked ? "当前任务完成前不可重复提交"
    : !state.providerReady ? "真实图像服务尚未配置"
      : !state.selectedSpecId ? "先保存绘图需求"
        : state.wallet && state.wallet.available < missingPrice ? "Credits 不足"
          : "按固定价格生成一张";

  const notice = qs("#generate-lock-notice");
  notice.hidden = !taskLocked;
  if (taskLocked) {
    const title = qs("strong", notice);
    const detail = qs(":scope > div > span", notice);
    const badge = qs("#generate-lock-badge");
    if (state.generateSubmissionInFlight) {
      title.textContent = "正在创建生成任务";
      detail.textContent = "正在校验需求、余额并预留 Credits，请稍候。";
      badge.textContent = "提交中";
    } else if (uncertainTask) {
      title.textContent = "结果待核查，按钮保持锁定";
      detail.textContent = "不会自动重新提交付费任务，确认原任务结果后再操作。";
      badge.textContent = "HOLD";
    } else {
      title.textContent = activeTask?.status === "queued" ? "任务正在排队" : "图像正在生成";
      detail.textContent = "提交按钮已锁定，生图完成后自动开放下一次生成。";
      badge.textContent = "LOCKED";
    }
  }

  updateWorkflowState(activeTask, uncertainTask);
}

function updateWorkflowState(activeTask, uncertainTask) {
  const node = qs("#preview-workflow-state");
  const label = qs("#preview-workflow-label");
  if (!node || !label) return;
  let stateName = "is-idle";
  let text = "待生成";
  if (state.generateSubmissionInFlight) {
    stateName = "is-running";
    text = "提交中";
  } else if (activeTask) {
    stateName = "is-running";
    text = activeTask.status === "queued" ? "排队中" : "生成中";
  } else if (uncertainTask) {
    stateName = "is-warning";
    text = "待核查";
  } else if (state.activeJob?.status === "succeeded") {
    stateName = "is-success";
    text = "已完成";
  } else if (state.activeJob?.status === "failed") {
    stateName = "is-error";
    text = "生成失败";
  } else if (state.previewImage) {
    stateName = "is-ready";
    text = "已就绪";
  }
  node.className = `workflow-state ${stateName}`;
  label.textContent = text;
}

function showPreview(image) {
  state.previewImage = image;
  const preview = qs("#preview-image");
  preview.src = `${image.contentUrl}?v=${encodeURIComponent(image.createdAt)}`;
  preview.hidden = false;
  qs(".preview-empty").hidden = true;
  qs("#preview-version").hidden = false;
  qs("#preview-version").textContent = `V${image.versionNumber}`;
  qs("#preview-version-copy").textContent = `V${image.versionNumber}`;
  qs("#preview-mode").textContent = modeLabel(image.providerMode);
  const download = qs("#preview-download");
  download.hidden = false;
  download.onclick = () => {
    const anchor = document.createElement("a");
    anchor.href = image.downloadUrl;
    anchor.click();
  };
  updateWorkflowState();
}

function renderRecentImages() {
  const container = qs("#recent-images");
  container.replaceChildren();
  if (!state.images.length) {
    container.innerHTML = '<div class="empty-inline">生成后在这里保留版本</div>';
    return;
  }
  for (const image of state.images.slice(0, 3)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-image";
    button.innerHTML = `<img alt=""><span><b></b><em></em></span>`;
    qs("img", button).src = image.contentUrl;
    qs("b", button).textContent = `V${image.versionNumber}`;
    qs("em", button).textContent = image.operation === "edit" ? "调整" : "生成";
    button.addEventListener("click", () => showPreview(image));
    container.append(button);
  }
}

function openEditModal(image) {
  if (hasBlockingImageTask()) {
    toast("当前任务尚未结束", "请等待当前生图任务完成后再创建新版本。", "error");
    return;
  }
  if (!state.providerReady) {
    toast("图像服务尚未配置", "请先在服务端 .env 配置真实图像 API。", "error");
    return;
  }
  state.editIdempotencyKey = `edit-${crypto.randomUUID()}`;
  state.editSubmissionInFlight = false;
  qs("#edit-parent-id").value = image.id;
  qs("#edit-parent-label").textContent = `V${image.versionNumber}`;
  qs("#edit-parent-preview").innerHTML = `<img alt="父图 V${image.versionNumber}">`;
  qs("#edit-parent-preview img").src = image.contentUrl;
  qs("#edit-price").textContent = state.pricing.edit;
  qs("#edit-modal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  qs("#edit-modal").hidden = true;
  state.editIdempotencyKey = "";
  state.editSubmissionInFlight = false;
  document.body.style.overflow = "";
}

function openActionModal({ kicker = "ACTION", title, copy, inputLabel = "", defaultValue = "", confirmLabel, onConfirm }) {
  qs("#action-modal-kicker").textContent = kicker;
  qs("#action-modal-title").textContent = title;
  qs("#action-modal-copy").textContent = copy;
  const inputWrap = qs("#action-input-wrap");
  inputWrap.hidden = !inputLabel;
  qs("#action-input-label").textContent = inputLabel;
  qs("#action-input").value = defaultValue;
  qs("#action-confirm").textContent = confirmLabel;
  state.actionHandler = onConfirm;
  qs("#action-modal").hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => (inputLabel ? qs("#action-input") : qs("#action-confirm")).focus(), 0);
}

function closeActionModal() {
  qs("#action-modal").hidden = true;
  state.actionHandler = null;
  document.body.style.overflow = "";
}

function renderImageGrid() {
  const grid = qs("#image-grid");
  grid.replaceChildren();
  if (!state.images.length) {
    grid.innerHTML = '<div class="library-empty"><span class="empty-illustration"><svg class="icon"><use href="#icon-image"/></svg></span><strong>还没有图稿</strong><span>从创作台完成一次新生成后，版本会出现在这里。</span></div>';
    return;
  }
  for (const image of state.images) {
    const card = document.createElement("article");
    card.className = "image-card";
    card.innerHTML = `
      <img class="image-card-visual" alt="">
      <div class="image-card-body">
        <div class="image-card-head"><div><h3></h3><p></p></div><span class="version-badge"></span></div>
        <div class="image-card-actions">
          <button class="button button-secondary edit-version">${icon("pencil")}继续调整</button>
          <button class="icon-button download-version" title="下载图稿">${icon("download")}</button>
        </div>
        <div class="version-chain">${icon("history")}<span></span></div>
      </div>`;
    const visual = qs(".image-card-visual", card);
    visual.src = image.contentUrl;
    visual.alt = `V${image.versionNumber} 产品说明图`;
    visual.addEventListener("click", () => {
      showPreview(image);
      setView("studio");
    });
    qs("h3", card).textContent = `图稿 V${image.versionNumber}`;
    qs("p", card).textContent = `${operationLabel(image.operation)} · ${modeLabel(image.providerMode)} · ${formatDate(image.createdAt)}`;
    qs(".version-badge", card).textContent = `V${image.versionNumber}`;
    qs(".version-chain span", card).textContent = image.parentImageId ? `基于父图创建 · 消费 ${state.pricing.edit}` : `新生成 · 消费 ${state.pricing.generate}`;
    qs(".edit-version", card).addEventListener("click", () => openEditModal(image));
    qs(".download-version", card).addEventListener("click", () => {
      const anchor = document.createElement("a");
      anchor.href = image.downloadUrl;
      anchor.click();
    });
    grid.append(card);
  }
}

function setView(view) {
  state.currentView = view;
  qsa(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  qsa(".view").forEach((section) => section.classList.toggle("active", section.id === `view-${view}`));
  const titles = { studio: ["CREATE", "创作台"], library: ["LIBRARY", "图稿库"], ledger: ["LEDGER", "账本"], connect: ["CONNECT", "WorkBuddy"], account: ["ACCOUNT", "账户安全"], settings: ["SYSTEM", "系统设置"], admin: ["ADMIN", "成员与额度"] };
  qs("#topbar-kicker").textContent = titles[view]?.[0] || "";
  qs("#topbar-title").textContent = titles[view]?.[1] || "";
  qs("#sidebar").classList.remove("open");
  if (view === "library") renderImageGrid();
  if (view === "ledger") loadLedger();
  if (view === "connect") loadConnect();
  if (view === "settings") loadProviderSettings();
  if (view === "admin") loadAdmin();
}

async function loadLedger() {
  const [wallet, transactions] = await Promise.all([api("/api/wallet"), api("/api/wallet/transactions")]);
  state.wallet = wallet;
  updateWalletUi();
  renderTransactions(transactions.transactions);
}

function renderTransactions(transactions) {
  const body = qs("#transaction-body");
  body.replaceChildren();
  if (!transactions.length) {
    body.innerHTML = '<tr><td colspan="5">还没有账务流水</td></tr>';
    return;
  }
  const labels = { grant: "发放", compensation: "调账发放", reserve: "预留", consume: "消费", release: "释放" };
  for (const transaction of transactions) {
    const row = document.createElement("tr");
    row.innerHTML = `<td></td><td><span class="tx-type"></span></td><td></td><td></td><td></td>`;
    qs("td:nth-child(1)", row).textContent = formatDate(transaction.createdAt);
    const type = qs(".tx-type", row);
    type.classList.add(`tx-${transaction.type}`);
    type.textContent = labels[transaction.type] || transaction.type;
    qs("td:nth-child(3)", row).textContent = transaction.description;
    qs("td:nth-child(4)", row).textContent = transaction.availableDelta ? `${transaction.availableDelta > 0 ? "+" : ""}${transaction.availableDelta} → ${transaction.availableAfter}` : `${transaction.availableAfter}`;
    qs("td:nth-child(5)", row).textContent = transaction.spentDelta ? `+${transaction.spentDelta} → ${transaction.spentAfter}` : `${transaction.spentAfter}`;
    body.append(row);
  }
}

async function loadConnect() {
  const tokens = await api("/api/tokens");
  renderTokens(tokens.tokens);
  const serverPath = state.mcpServerPath || "mcp/server.js";
  const config = {
    mcpServers: {
      "fdex-image": {
        command: "node",
        args: [serverPath],
        env: {
          IMAGE_SERVICE_URL: window.location.origin,
          IMAGE_SERVICE_TOKEN: state.newToken || "<在这里粘贴刚创建的令牌>"
        }
      }
    }
  };
  qs("#api-base-url").textContent = window.location.origin;
  qs("#mcp-config-code").textContent = JSON.stringify(config, null, 2);
}

function renderTokens(tokens) {
  const container = qs("#token-list");
  container.replaceChildren();
  if (!tokens.length) {
    container.innerHTML = '<div class="empty-inline">还没有 WorkBuddy 访问令牌</div>';
    return;
  }
  for (const token of tokens) {
    const row = document.createElement("div");
    row.className = "token-row";
    row.innerHTML = `${icon("key")}<div><strong></strong><span></span></div><button class="icon-button" title="撤销令牌">${icon("x")}</button>`;
    qs("strong", row).textContent = token.name;
    qs("span", row).textContent = `${token.id}… · ${token.lastUsedAt ? `最近使用 ${formatDate(token.lastUsedAt)}` : "尚未使用"}`;
    qs("button", row).addEventListener("click", () => {
      openActionModal({
        kicker: "ACCESS TOKEN",
        title: `撤销“${token.name}”？`,
        copy: "使用该令牌的 WorkBuddy 配置将立即失效，网页登录不受影响。",
        confirmLabel: "撤销令牌",
        onConfirm: async () => {
          await api(`/api/tokens/${token.id}`, { method: "DELETE" });
          toast("令牌已撤销");
          await loadConnect();
        }
      });
    });
    container.append(row);
  }
}

async function loadAdmin() {
  if (state.user?.role !== "admin") return;
  const payload = await api("/api/admin/users");
  renderAdminUsers(payload.users);
}

async function loadProviderSettings() {
  if (state.user?.role !== "admin") return;
  const { settings } = await api("/api/admin/provider-settings");
  const form = qs("#provider-settings-form");
  form.providerMode.value = settings.providerMode || "mock";
  form.imageApiStyle.value = settings.imageApiStyle === "openai" ? "openai" : "dashscope";
  form.imageApiBaseUrl.value = settings.imageApiBaseUrl || "";
  form.imageGenerateModel.value = settings.imageGenerateModel || "";
  form.imageEditModel.value = settings.imageEditModel || "";
  form.imageSize.value = settings.imageSize || "1536x1024";
  form.imageOutputFormat.value = ["png", "jpeg", "webp"].includes(settings.imageOutputFormat) ? settings.imageOutputFormat : "png";
  form.imageNegativePrompt.value = settings.imageNegativePrompt || "";
  form.imagePromptExtend.checked = Boolean(settings.imagePromptExtend);
  form.imageWatermark.checked = Boolean(settings.imageWatermark);
  form.imageApiKey.value = "";
  form.imageApiKey.disabled = false;
  form.clearApiKey.checked = false;
  form.imageApiKey.placeholder = settings.hasApiKey ? `已配置 ${settings.apiKeyHint} · 留空保持不变` : "输入 API Key";
  qs("#settings-key-hint").textContent = settings.hasApiKey
    ? `当前密钥 ${settings.apiKeyHint}，不会在页面中显示完整内容`
    : "尚未配置 API Key";
  qs("#settings-updated-at").textContent = settings.updatedAt
    ? `最近保存 ${formatDate(settings.updatedAt)}`
    : "当前使用环境变量配置";
  state.providerMode = settings.providerMode;
  state.providerReady = Boolean(settings.providerMode === "mock" || (settings.hasApiKey && settings.imageApiBaseUrl && settings.imageGenerateModel && settings.imageEditModel));
  updateStaticValues();
  const status = qs("#settings-provider-status");
  status.textContent = state.providerReady ? `${modeLabel(state.providerMode)} · 已就绪` : `${modeLabel(state.providerMode)} · 配置不完整`;
  status.className = `status-pill ${state.providerReady ? "status-pill-success" : "status-pill-muted"}`;
}

function providerSettingsPayload(form) {
  const data = new FormData(form);
  return {
    providerMode: data.get("providerMode"),
    imageApiStyle: data.get("imageApiStyle"),
    imageApiBaseUrl: data.get("imageApiBaseUrl"),
    imageGenerateModel: data.get("imageGenerateModel"),
    imageEditModel: data.get("imageEditModel"),
    imageApiKey: data.get("imageApiKey"),
    clearApiKey: data.get("clearApiKey") === "on",
    imageSize: data.get("imageSize"),
    imageOutputFormat: data.get("imageOutputFormat"),
    imageNegativePrompt: data.get("imageNegativePrompt"),
    imagePromptExtend: data.get("imagePromptExtend") === "on",
    imageWatermark: data.get("imageWatermark") === "on"
  };
}

function renderAdminUsers(users) {
  const body = qs("#admin-user-body");
  body.replaceChildren();
  for (const user of users) {
    const row = document.createElement("tr");
    row.innerHTML = `<td><strong></strong><br><small></small></td><td></td><td></td><td></td><td></td><td><form class="admin-grant-form"><input type="number" min="1" max="100000" value="50" aria-label="发放额度"><button class="icon-button" title="发放额度">${icon("plus")}</button></form></td><td><button class="icon-button reset-password-button" type="button" title="重置密码">${icon("key")}</button></td>`;
    qs("strong", row).textContent = user.displayName;
    qs("small", row).textContent = `@${user.username}`;
    qs("td:nth-child(2)", row).textContent = user.role === "admin" ? "管理员" : "成员";
    qs("td:nth-child(3)", row).textContent = user.wallet.available;
    qs("td:nth-child(4)", row).textContent = user.wallet.reserved;
    qs("td:nth-child(5)", row).textContent = user.wallet.spent;
    qs(".reset-password-button", row).addEventListener("click", () => openResetPasswordModal(user));
    qs("form", row).addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = qs("input", event.currentTarget);
      const button = qs("button", event.currentTarget);
      setBusy(button, true, "");
      try {
        await api("/api/admin/credits", { method: "POST", body: { userId: user.id, amount: Number(input.value), reason: `管理员为 ${user.displayName} 发放课堂额度` } });
        toast("额度已发放", `${user.displayName} +${input.value} Credits`);
        await loadAdmin();
        if (user.id === state.user.id) await refreshWallet();
      } catch (error) {
        toast("发放失败", error.message, "error");
        setBusy(button, false);
      }
    });
    body.append(row);
  }
}

function openCreateUserModal() {
  const form = qs("#create-user-form");
  form.reset();
  form.elements.namedItem("initialCredits").value = "100";
  qs("#create-user-modal").hidden = false;
  form.elements.namedItem("username").focus();
}

function closeCreateUserModal() {
  qs("#create-user-modal").hidden = true;
}

function openResetPasswordModal(user) {
  const form = qs("#reset-password-form");
  form.reset();
  qs("#reset-password-user-id").value = user.id;
  qs("#reset-password-copy").textContent = `为 ${user.displayName}（@${user.username}）设置新密码。该账户的所有网页会话和 WorkBuddy 令牌会立即失效。`;
  qs("#reset-password-modal").hidden = false;
  form.elements.namedItem("newPassword").focus();
}

function closeResetPasswordModal() {
  qs("#reset-password-modal").hidden = true;
}

function specFormPayload() {
  const form = new FormData(qs("#spec-form"));
  const dimensions = ["length", "width", "height"]
    .filter((name) => String(form.get(name) || "").trim())
    .map((name) => ({ name, value: String(form.get(name)).trim(), unit: "mm", sourceRef: "课堂资料 D01 / 用户确认" }));
  const splitLines = (value) => String(value || "").split(/\n|[,，]/).map((item) => item.trim()).filter(Boolean);
  return {
    productName: form.get("productName"),
    dimensions,
    material: form.get("material"),
    mounting: form.get("mounting"),
    labels: splitLines(form.get("labels")),
    unknowns: splitLines(form.get("unknowns")),
    layout: form.get("layout"),
    rawInput: form.get("rawInput"),
    sourceNote: qs("#source-note-text").textContent,
    inputAssetIds: state.assets.map((asset) => asset.id),
    unknownPolicy: "未确认项省略，并在图稿中标记待确认"
  };
}

async function createSpec() {
  return api("/api/drawing-specs", { method: "POST", body: specFormPayload() });
}

async function generateFromSelectedSpec() {
  if (state.generateSubmissionInFlight) return;
  if (hasBlockingImageTask()) {
    toast("当前任务尚未结束", "生成按钮会在任务完成后自动开放。", "error");
    updateGenerateButton();
    return;
  }
  if (!state.selectedSpecId) {
    toast("还没有绘图需求", "先保存资料与需求，再生成图稿。", "error");
    return;
  }
  if (state.wallet.available < state.pricing.generate) {
    toast("Credits 不足", "本次操作未提交给 Image Provider。", "error");
    return;
  }
  state.generateSubmissionInFlight = true;
  updateGenerateButton();
  try {
    const result = await api("/api/image-jobs", {
      method: "POST",
      body: {
        operation: "generate",
        specId: state.selectedSpecId,
        instruction: new FormData(qs("#spec-form")).get("rawInput") || "按已保存绘图需求生成。",
        idempotencyKey: `generate-${crypto.randomUUID()}`
      }
    });
    state.generateLockJobId = result.job.id;
    trackJob(result.job.id, result.job);
    await refreshWallet().catch(() => {});
    toast(
      result.duplicate ? "重复提交已合并" : "生成任务已提交",
      result.duplicate ? `沿用任务 ${result.job.id.slice(0, 8)}…，本次未重复扣费。` : `预留 ${state.pricing.generate} Credits；任务 ${result.job.id.slice(0, 8)}…`
    );
  } catch (error) {
    toast("无法提交生成", error.message, "error");
  } finally {
    state.generateSubmissionInFlight = false;
    updateGenerateButton();
  }
}

function hasBlockingImageTask() {
  return state.generateSubmissionInFlight || state.pollers.size > 0 ||
    state.jobs.some((job) => job.status === "queued" || job.status === "running" || job.status === "reconciling");
}

function trackJob(jobId, submittedJob = null) {
  if (state.pollers.has(jobId)) return;
  const knownJob = submittedJob || state.jobs.find((job) => job.id === jobId);
  const container = qs("#active-job");
  container.hidden = false;
  container.className = "active-job is-queued";
  container.innerHTML = `${icon("loader")}<div><strong>任务排队中</strong><span>${knownJob ? `${operationLabel(knownJob.operation)} · ${knownJob.price} Credits` : `${jobId.slice(0, 12)}…`}</span><div class="active-job-track"><i style="width:18%"></i></div></div><em>处理中</em>`;
  qs(".icon", container).classList.add("spin");
  state.activeJob = knownJob || { id: jobId, status: "queued", operation: "generate", price: state.pricing?.generate ?? 10 };
  updateGenerateButton();
  let consecutiveErrors = 0;
  const poll = async () => {
    try {
      const { job } = await api(`/api/image-jobs/${jobId}`);
      consecutiveErrors = 0;
      renderActiveJob(job);
      if (job.status === "succeeded") {
        clearInterval(state.pollers.get(jobId));
        state.pollers.delete(jobId);
        if (state.generateLockJobId === jobId) state.generateLockJobId = null;
        await refreshWallet();
        await loadWorkspace();
        if (job.image) showPreview(job.image);
        qs("#job-overlay").hidden = true;
        updateGenerateButton();
        toast("图稿已生成", `V${job.image.versionNumber} 已完成并保存。`);
      } else if (job.status === "failed") {
        clearInterval(state.pollers.get(jobId));
        state.pollers.delete(jobId);
        if (state.generateLockJobId === jobId) state.generateLockJobId = null;
        await refreshWallet();
        qs("#job-overlay").hidden = true;
        updateGenerateButton();
        toast("任务明确失败", `${job.errorMessage || "预留 Credits 已释放"}`, "error");
      } else if (job.status === "reconciling") {
        clearInterval(state.pollers.get(jobId));
        state.pollers.delete(jobId);
        await refreshWallet();
        qs("#job-overlay").hidden = true;
        updateGenerateButton();
        toast("结果待核查", job.errorMessage || "不会自动重新提交付费任务。", "error");
      }
    } catch (error) {
      consecutiveErrors += 1;
      const detail = qs("span", container);
      if (detail) detail.textContent = `状态读取暂时中断，按钮保持锁定 · ${error.message}`;
      if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
        toast("任务仍可能在处理中", "查询暂时失败，不会重复提交；服务恢复后将继续更新。", "error");
      }
      updateGenerateButton();
    }
  };
  const timer = setInterval(poll, 700);
  state.pollers.set(jobId, timer);
  updateGenerateButton();
  poll();
}

function renderActiveJob(job) {
  const container = qs("#active-job");
  const labels = { queued: "任务排队中", running: "正在调用 Image Provider", succeeded: "任务已完成", failed: "任务明确失败", reconciling: "结果待核查" };
  state.activeJob = job;
  const jobIndex = state.jobs.findIndex((item) => item.id === job.id);
  if (jobIndex >= 0) state.jobs[jobIndex] = job;
  else state.jobs.unshift(job);
  container.hidden = false;
  const progress = job.status === "queued" ? 18 : job.status === "running" ? 68 : 100;
  container.className = `active-job is-${job.status}`;
  container.innerHTML = `${icon(job.status === "succeeded" ? "check" : job.status === "failed" || job.status === "reconciling" ? "alert-circle" : "loader")}<div><strong></strong><span></span><div class="active-job-track"><i></i></div></div><em></em>`;
  if (job.status !== "succeeded" && job.status !== "failed" && job.status !== "reconciling") qs(".icon", container).classList.add("spin");
  qs("strong", container).textContent = labels[job.status] || job.status;
  qs("span", container).textContent = job.errorMessage || `${job.operation === "generate" ? "新生成" : "继续调整"} · ${job.price} Credits · ${job.id.slice(0, 12)}…`;
  qs(".active-job-track i", container).style.width = `${progress}%`;
  qs("em", container).textContent = job.status === "succeeded" || job.status === "failed" || job.status === "reconciling" ? "已结束" : "处理中";
  if (job.status === "queued" || job.status === "running") {
    qs("#job-overlay").hidden = false;
    qs("#job-overlay-title").textContent = labels[job.status];
    qs("#job-overlay-detail").textContent = job.status === "queued" ? "任务已进入队列，提交按钮保持锁定。" : "图像服务正在生成，请勿重复提交。";
    qs("#job-overlay-progress").style.width = `${progress}%`;
    const phases = qsa(".job-overlay-steps span");
    phases.forEach((phase, index) => {
      phase.classList.toggle("is-complete", index === 0 || (job.status === "running" && index === 1));
    });
  }
  updateGenerateButton();
}

function resumeOpenJobs() {
  const open = state.jobs.find((job) => job.status === "queued" || job.status === "running" || job.status === "reconciling");
  if (open) trackJob(open.id);
}

async function loadSample() {
  const button = qs("#load-sample-button");
  setBusy(button, true, "载入中");
  try {
    await api("/api/assets/load-sample", { method: "POST" });
    const form = qs("#spec-form");
    form.productName.value = "挡车器";
    form.length.value = "530";
    form.width.value = "140";
    form.height.value = "80";
    form.material.value = "橡胶（丁苯橡胶）本体与反光黄色警示条";
    form.mounting.value = "地面 M10 膨胀螺栓固定，每件两颗";
    form.labels.value = "橡胶主体\n反光警示条\nM10 膨胀螺栓，每件两颗";
    form.unknowns.value = "安装位置 1000 mm 是否适用\n精确孔位";
    form.layout.value = "横向、中文、白底、清晰说明书风格";
    form.rawInput.value = "按资料生成产品说明图，突出外观、侧面与安装方式。只使用已有依据的参数；1000 mm 未确认则省略。";
    qs("#source-note-text").textContent = "课堂资料 D01/D02 的课堂预设，不是视觉模型识别记录。";
    await loadWorkspace();
    toast("课堂案例已载入", "资料已保存到当前账户；确认需求后即可生成。");
  } catch (error) {
    toast("载入失败", error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function setupEvents() {
  qs("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = qs("button[type=submit]", event.currentTarget);
    setBusy(button, true, "登录中");
    try {
      await login(qs("#login-username").value, qs("#login-password").value);
      await enterApp();
    } catch (error) {
      toast("登录失败", error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });

  qsa(".demo-account").forEach((button) => {
    button.addEventListener("click", () => {
      qs("#login-username").value = button.dataset.user;
      qs("#login-password").value = "";
      qs("#login-password").focus();
      toast("账号已填入", "请输入该账户密码后登录。");
    });
  });

  qs("#register-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const button = qs("button", event.currentTarget);
    setBusy(button, true, "创建中");
    try {
      await api("/api/auth/register", { method: "POST", body: { username: data.get("username"), displayName: data.get("displayName"), password: data.get("password") } });
      await enterApp();
    } catch (error) {
      toast("创建失败", error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });

  qs("#logout-button").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    resetAuthenticatedUi();
  });

  qsa("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  document.addEventListener("click", (event) => {
    const link = event.target.closest("[data-view-link]");
    if (link) setView(link.dataset.viewLink);
  });
  qs("#balance-button").addEventListener("click", () => setView("ledger"));
  qs("#mobile-menu").addEventListener("click", () => qs("#sidebar").classList.toggle("open"));

  qs("#load-sample-button").addEventListener("click", loadSample);
  qs("#upload-trigger").addEventListener("click", () => qs("#file-input").click());
  qs("#file-input").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast("文件过大", "单个文件不能超过 8 MB。", "error");
      return;
    }
    try {
      const dataBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api("/api/assets", { method: "POST", body: { name: file.name, mimeType: file.type, dataBase64, kind: "reference" } });
      await loadWorkspace();
      toast("资料已上传", file.name);
    } catch (error) {
      toast("上传失败", error.message, "error");
    } finally {
      event.target.value = "";
    }
  });

  qs("#spec-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = qs("#save-spec-button");
    qs("#spec-save-state").textContent = "保存中";
    setBusy(button, true, "保存中");
    try {
      const { spec } = await createSpec();
      state.selectedSpecId = spec.id;
      state.specs.unshift(spec);
      renderSpecs();
      toast("绘图需求已保存", `${spec.productName} · v${spec.version}`);
    } catch (error) {
      qs("#spec-save-state").textContent = "保存失败";
      toast("需求保存失败", error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });

  qs("#generate-button").addEventListener("click", generateFromSelectedSpec);
  qs("#library-refresh").addEventListener("click", loadWorkspace);
  qs("#ledger-refresh").addEventListener("click", loadLedger);
  qs("#admin-refresh").addEventListener("click", loadAdmin);
  qs("#admin-create-user-button").addEventListener("click", openCreateUserModal);
  qs("#settings-refresh").addEventListener("click", loadProviderSettings);

  qs("#change-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const button = qs("button[type=submit]", form);
    if (data.get("newPassword") !== data.get("confirmPassword")) {
      toast("两次密码不一致", "请重新确认新密码。", "error");
      form.elements.namedItem("confirmPassword").focus();
      return;
    }
    setBusy(button, true, "更新中");
    try {
      await api("/api/account/password", {
        method: "POST",
        body: {
          currentPassword: data.get("currentPassword"),
          newPassword: data.get("newPassword")
        }
      });
      resetAuthenticatedUi();
      toast("密码已更新", "旧会话和令牌已撤销，请使用新密码重新登录。");
    } catch (error) {
      toast("密码更新失败", error.message, "error");
      setBusy(button, false);
    }
  });

  qs("#create-user-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const button = qs("button[type=submit]", form);
    if (data.get("password") !== data.get("confirmPassword")) {
      toast("两次密码不一致", "请重新确认初始密码。", "error");
      form.elements.namedItem("confirmPassword").focus();
      return;
    }
    setBusy(button, true, "创建中");
    try {
      const { user } = await api("/api/admin/users", {
        method: "POST",
        body: {
          username: data.get("username"),
          displayName: data.get("displayName"),
          password: data.get("password"),
          role: data.get("role"),
          initialCredits: Number(data.get("initialCredits"))
        }
      });
      closeCreateUserModal();
      await loadAdmin();
      toast("成员账户已开通", `${user.displayName} · ${user.wallet.available} Credits`);
    } catch (error) {
      toast("账户创建失败", error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });

  qs("#reset-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const button = qs("button[type=submit]", form);
    if (data.get("newPassword") !== data.get("confirmPassword")) {
      toast("两次密码不一致", "请重新确认新密码。", "error");
      form.elements.namedItem("confirmPassword").focus();
      return;
    }
    setBusy(button, true, "重置中");
    try {
      const userId = qs("#reset-password-user-id").value;
      const result = await api(`/api/admin/users/${userId}/password`, {
        method: "POST",
        body: { newPassword: data.get("newPassword") }
      });
      closeResetPasswordModal();
      if (result.reauthRequired) {
        resetAuthenticatedUi();
        toast("密码已重置", "当前管理员会话已撤销，请重新登录。");
      } else {
        toast("成员密码已重置", "旧会话与 WorkBuddy 令牌已撤销。");
      }
    } catch (error) {
      toast("密码重置失败", error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });

  qsa("[data-close-create-user-modal]").forEach((node) => node.addEventListener("click", closeCreateUserModal));
  qsa("[data-close-reset-password-modal]").forEach((node) => node.addEventListener("click", closeResetPasswordModal));
  qs("#toggle-api-key").addEventListener("click", () => {
    const input = qs("#settings-api-key");
    input.type = input.type === "password" ? "text" : "password";
    qs("#toggle-api-key").title = input.type === "password" ? "显示密钥" : "隐藏密钥";
  });
  qs("#settings-clear-key").addEventListener("change", (event) => {
    qs("#settings-api-key").disabled = event.currentTarget.checked;
  });
  qs("#provider-settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = qs("#save-provider-settings");
    setBusy(button, true, "保存中");
    try {
      const result = await api("/api/admin/provider-settings", {
        method: "POST",
        body: providerSettingsPayload(form)
      });
      state.providerMode = result.settings.providerMode;
      state.providerReady = result.providerStatus.ready;
      updateStaticValues();
      await loadProviderSettings();
      setBusy(button, false);
      toast("系统设置已保存", state.providerReady ? "新配置已启用，可立即提交生成任务。" : "配置尚未完整，真实服务暂不可用。");
    } catch (error) {
      toast("设置保存失败", error.message, "error");
      setBusy(button, false);
    }
  });
  qs("#test-provider-settings").addEventListener("click", async () => {
    const form = qs("#provider-settings-form");
    const button = qs("#test-provider-settings");
    const resultNode = qs("#settings-test-result");
    setBusy(button, true, "测试中");
    resultNode.hidden = true;
    resultNode.className = "settings-test-result";
    try {
      const { result } = await api("/api/admin/provider-settings/test", {
        method: "POST",
        body: providerSettingsPayload(form)
      });
      const list = qs("#provider-model-options");
      list.replaceChildren(...result.models.map((model) => {
        const option = document.createElement("option");
        option.value = model;
        return option;
      }));
      if (!form.imageGenerateModel.value && result.models[0]) form.imageGenerateModel.value = result.models[0];
      if (!form.imageEditModel.value && result.models[0]) form.imageEditModel.value = result.models[0];
      const missing = result.missingModels.length ? ` 当前填写但未返回的模型：${result.missingModels.join("、")}。` : "";
      resultNode.textContent = `连接成功，可用模型：${result.models.join("、")}。${missing}`;
      resultNode.className = "settings-test-result success";
      resultNode.hidden = false;
    } catch (error) {
      resultNode.textContent = error.message;
      resultNode.className = "settings-test-result error";
      resultNode.hidden = false;
      toast("连接测试失败", error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });

  qsa("[data-close-modal]").forEach((node) => node.addEventListener("click", closeModal));
  qsa("[data-close-action-modal]").forEach((node) => node.addEventListener("click", closeActionModal));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeModal();
      closeActionModal();
    }
  });
  qs("#action-confirm").addEventListener("click", async () => {
    if (!state.actionHandler) return;
    const button = qs("#action-confirm");
    const input = qs("#action-input").value.trim();
    setBusy(button, true, "处理中");
    try {
      await state.actionHandler(input);
      closeActionModal();
    } catch (error) {
      toast("操作失败", error.message, "error");
    } finally {
      setBusy(button, false);
    }
  });

  qs("#edit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.editSubmissionInFlight) return;
    if (hasBlockingImageTask()) {
      toast("当前任务尚未结束", "请等待当前生图任务完成后再提交新版本。", "error");
      return;
    }
    const button = qs("button[type=submit]", event.currentTarget);
    state.editSubmissionInFlight = true;
    if (!state.editIdempotencyKey) state.editIdempotencyKey = `edit-${crypto.randomUUID()}`;
    setBusy(button, true, "创建版本");
    try {
      const result = await api("/api/image-jobs", {
        method: "POST",
        body: {
          operation: "edit",
          parentImageId: qs("#edit-parent-id").value,
          instruction: qs("#edit-instruction").value,
          preserveInstructions: qs("#edit-preserve").value,
          idempotencyKey: state.editIdempotencyKey
        }
      });
      closeModal();
      trackJob(result.job.id, result.job);
      await refreshWallet().catch(() => {});
      toast(
        result.duplicate ? "重复提交已合并" : "调整任务已提交",
        result.duplicate ? `沿用任务 ${result.job.id.slice(0, 8)}…，本次未重复扣费。` : `按编辑档预留 ${state.pricing.edit} Credits。`
      );
    } catch (error) {
      toast("无法提交调整", error.message, "error");
    } finally {
      state.editSubmissionInFlight = false;
      setBusy(button, false);
    }
  });

  qs("#create-token-button").addEventListener("click", () => {
    openActionModal({
      kicker: "ACCESS TOKEN",
      title: "创建 WorkBuddy 令牌",
      copy: "令牌使用当前账户和服务端价格。创建后只显示一次。",
      inputLabel: "令牌名称",
      defaultValue: "我的 WorkBuddy",
      confirmLabel: "创建令牌",
      onConfirm: async (name) => {
        if (!name) throw new Error("令牌名称不能为空");
        const payload = await api("/api/tokens", { method: "POST", body: { name } });
        state.newToken = payload.token;
        qs("#new-token").hidden = false;
        qs("#new-token-value").textContent = payload.token;
        await loadConnect();
        toast("令牌已创建", "令牌只显示一次，请放入 MCP 配置。");
      }
    });
  });
  qs("#copy-token-button").addEventListener("click", async () => {
    await navigator.clipboard.writeText(state.newToken);
    toast("令牌已复制");
  });
  qs("#copy-config-button").addEventListener("click", async () => {
    await navigator.clipboard.writeText(qs("#mcp-config-code").textContent);
    toast("MCP 配置已复制");
  });
}

async function boot() {
  setupEvents();
  try {
    const session = await api("/api/auth/session");
    applyAuthFeatures(session.features);
    if (session.authenticated) await enterApp();
    else showAuth();
  } catch (error) {
    if (error.status !== 401) toast("服务连接失败", error.message, "error");
    applyAuthFeatures();
    showAuth();
  }
}

boot();
