const state = { config: null, envKeys: {}, editingProvider: null, statsRange: "all" };

const $ = (sel) => document.querySelector(sel);

const el = {
  configPath: $("#configPath"),
  statusDot: $("#statusDot"),
  statusText: $("#statusText"),
  themeToggle: $("#themeToggle"),
  themeIcon: $("#themeIcon"),
  checkUpdateBtn: $("#checkUpdateBtn"),
  toast: $("#toast"),
  providerCount: $("#providerCount"),
  providerList: $("#providerList"),
  addProviderBtn: $("#addProviderBtn"),
  refreshBtn: $("#refreshBtn"),
  providerFormWrap: $("#providerFormWrap"),
  providerForm: $("#providerForm"),
  formTitle: $("#formTitle"),
  cancelProviderBtn: $("#cancelProviderBtn"),
  pId: $("#pId"),
  pBaseUrl: $("#pBaseUrl"),
  pProtocol: $("#pProtocol"),
  pApiKeyEnv: $("#pApiKeyEnv"),
  pApiKey: $("#pApiKey"),
  toggleProviderKey: $("#toggleProviderKey"),
  pHeaders: $("#pHeaders"),
  addModelRow: $("#addModelRow"),
  modelRows: $("#modelRows"),
  refreshStatsBtn: $("#refreshStatsBtn"),
  rangeTabs: $("#rangeTabs"),
  statTotal: $("#statTotal"),
  statSuccessRate: $("#statSuccessRate"),
  statAvgLatency: $("#statAvgLatency"),
  statFailCount: $("#statFailCount"),
  statsByModel: $("#statsByModel"),
  statsByProvider: $("#statsByProvider"),
};

// ── Theme ──
function initTheme() {
  const saved = localStorage.getItem("theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  el.themeIcon.innerHTML = saved === "dark" ? "&#9788;" : "&#9789;";
}

el.themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  el.themeIcon.innerHTML = next === "dark" ? "&#9788;" : "&#9789;";
});

el.checkUpdateBtn.addEventListener("click", async () => {
  el.checkUpdateBtn.disabled = true;
  el.checkUpdateBtn.textContent = "检查中...";
  try {
    const data = await requestJson("/admin/check-update");
    if (data.error) {
      toast("检查失败: " + data.error, "bad");
    } else if (data.hasUpdate) {
      toast(`新版本可用: ${data.localVersion} → ${data.remoteVersion}，运行 git pull 更新`);
    } else {
      toast(`已是最新版本 (${data.localVersion})`);
    }
  } catch (err) {
    toast("检查失败: " + err.message, "bad");
  } finally {
    el.checkUpdateBtn.disabled = false;
    el.checkUpdateBtn.textContent = "检查更新";
  }
});

initTheme();

// ── Toast ──
let toastTimer = null;

function toast(msg, type = "ok") {
  el.toast.textContent = msg;
  el.toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 3000);
}

// ── Model rows dynamic ──
function addModelRow(alias = "", upstream = "") {
  const row = document.createElement("div");
  row.className = "model-row";
  row.innerHTML = `
    <input class="mr-alias" autocomplete="off" placeholder="模型别名" value="${escapeHtml(alias)}" required />
    <input class="mr-upstream" autocomplete="off" placeholder="上游模型名" value="${escapeHtml(upstream)}" required />
    <button type="button" class="danger small mr-remove" title="移除">x</button>
  `;
  row.querySelector(".mr-remove").addEventListener("click", () => row.remove());
  el.modelRows.appendChild(row);
}

function getModelRows() {
  return [...el.modelRows.querySelectorAll(".model-row")].map((row) => ({
    alias: row.querySelector(".mr-alias").value.trim(),
    upstream: row.querySelector(".mr-upstream").value.trim(),
  }));
}

// ── Form events ──
el.providerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveProvider();
});

el.addProviderBtn.addEventListener("click", () => {
  state.editingProvider = null;
  el.formTitle.textContent = "添加供应商";
  el.providerForm.reset();
  el.pProtocol.value = "chat";
  el.pApiKey.value = "";
  el.pApiKey.type = "password";
  el.pApiKey.placeholder = "sk-...";
  el.pId.readOnly = false;
  el.modelRows.innerHTML = "";
  addModelRow();
  showForm(el.providerFormWrap);
  el.pId.focus();
});

el.cancelProviderBtn.addEventListener("click", () => hideForm(el.providerFormWrap));

el.toggleProviderKey.addEventListener("click", () => {
  el.pApiKey.type = el.pApiKey.type === "password" ? "text" : "password";
});

el.addModelRow.addEventListener("click", () => addModelRow());

el.refreshBtn.addEventListener("click", loadConfig);

el.refreshStatsBtn.addEventListener("click", loadStats);

for (const tab of el.rangeTabs.querySelectorAll(".range-tab")) {
  tab.addEventListener("click", () => {
    for (const t of el.rangeTabs.querySelectorAll(".range-tab")) t.classList.remove("active");
    tab.classList.add("active");
    state.statsRange = tab.dataset.range;
    loadStats();
  });
}

function showForm(wrap) {
  wrap.classList.remove("hidden");
  wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideForm(wrap) {
  wrap.classList.add("hidden");
}

// ── Load ──
await Promise.all([loadConfig(), loadStats()]);

// Live stats via SSE — only refreshes when a request actually happens
const statsSSE = new EventSource("/admin/stats/stream");
statsSSE.onmessage = () => loadStats();

async function loadConfig() {
  setStatus("连接中", "pending");
  try {
    const [config, envStatus] = await Promise.all([
      requestJson("/admin/config"),
      requestJson("/admin/env-status"),
    ]);
    state.config = config;
    state.envKeys = envStatus.keys || {};
    render();
    setStatus("已连接", "ok");
  } catch (err) {
    setStatus(err.message, "bad");
    toast("连接失败: " + err.message, "bad");
  }
}

async function loadStats() {
  try {
    const stats = await requestJson(`/admin/stats?range=${state.statsRange}`);
    renderStats(stats);
  } catch {
    // stats endpoint may fail silently
  }
}

// ── Save ──
async function saveProvider() {
  const id = el.pId.value.trim();
  const headersRaw = el.pHeaders.value.trim();

  if (headersRaw) {
    try {
      const p = JSON.parse(headersRaw);
      if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error();
    } catch {
      toast("额外请求头必须是合法的 JSON 对象", "bad");
      return;
    }
  }

  const models = getModelRows();
  if (models.length === 0) {
    toast("至少需要添加一个模型", "bad");
    return;
  }
  for (const m of models) {
    if (!m.alias || !m.upstream) {
      toast("请填写完整的模型别名和上游模型名", "bad");
      return;
    }
  }

  try {
    // Save provider
    await requestJson("/admin/providers", {
      method: "POST",
      body: {
        id,
        baseUrl: el.pBaseUrl.value,
        protocol: el.pProtocol.value,
        apiKeyEnv: el.pApiKeyEnv.value,
        headers: headersRaw,
      },
    });

    // Save API key
    const apiKeyValue = el.pApiKey.value.trim();
    const apiKeyEnvName = el.pApiKeyEnv.value.trim();
    if (apiKeyValue && apiKeyEnvName) {
      await requestJson("/admin/env", {
        method: "POST",
        body: { key: apiKeyEnvName, value: apiKeyValue },
      });
    }

    // If editing, remove old models that are no longer in the list
    if (state.editingProvider) {
      const oldModels = Object.entries(state.config.models)
        .filter(([, m]) => m.provider === id)
        .map(([alias]) => alias);
      const newAliases = new Set(models.map((m) => m.alias));
      for (const oldAlias of oldModels) {
        if (!newAliases.has(oldAlias)) {
          await requestJson(`/admin/models/${encodeURIComponent(oldAlias)}`, { method: "DELETE" });
        }
      }
    }

    // Save all models
    for (const m of models) {
      await requestJson("/admin/models", {
        method: "POST",
        body: { alias: m.alias, provider: id, upstreamModel: m.upstream },
      });
    }

    toast(`已保存供应商 ${id} (${models.length} 个模型)`);
    hideForm(el.providerFormWrap);
    await loadConfig();
  } catch (err) {
    toast("保存失败: " + err.message, "bad");
  }
}

// ── Delete ──
async function deleteProvider(id) {
  const modelsUsing = Object.entries(state.config.models)
    .filter(([, m]) => m.provider === id)
    .map(([alias]) => alias);

  const msg = modelsUsing.length > 0
    ? `确定删除供应商 "${id}" 及其 ${modelsUsing.length} 个模型 (${modelsUsing.join(", ")})？`
    : `确定删除供应商 "${id}"？`;

  if (!confirm(msg)) return;

  try {
    await requestJson(`/admin/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast(`已删除供应商 ${id}` + (modelsUsing.length > 0 ? ` 及 ${modelsUsing.length} 个模型` : ""));
    await loadConfig();
  } catch (err) {
    toast("删除失败: " + err.message, "bad");
  }
}

// ── Edit ──
function editProvider(id) {
  const provider = state.config.providers[id];
  if (!provider) return;

  state.editingProvider = id;
  el.formTitle.textContent = `编辑供应商: ${id}`;
  el.pId.value = id;
  el.pId.readOnly = true;
  el.pBaseUrl.value = provider.baseUrl || "";
  el.pProtocol.value = provider.protocol || "chat";
  el.pApiKeyEnv.value = provider.apiKeyEnv || "";
  el.pHeaders.value = provider.headers ? JSON.stringify(provider.headers, null, 2) : "";
  el.pApiKey.value = "";
  el.pApiKey.type = "password";
  const envKey = provider.apiKeyEnv || "";
  const keyExists = envKey && state.envKeys[envKey];
  el.pApiKey.placeholder = keyExists ? "已设置，留空保持不变" : "sk-...";

  // Fill models
  el.modelRows.innerHTML = "";
  const models = Object.entries(state.config.models).filter(([, m]) => m.provider === id);
  if (models.length === 0) {
    addModelRow();
  } else {
    for (const [alias, model] of models) {
      addModelRow(alias, model.upstreamModel || alias);
    }
  }

  showForm(el.providerFormWrap);
  el.pBaseUrl.focus();
}

// ── Render ──
function render() {
  const config = state.config;
  el.configPath.textContent = config.configPath
    ? `配置文件: ${config.configPath}`
    : "配置文件: 当前运行配置";

  renderProviders(config);
}

function renderProviders(config) {
  const entries = Object.entries(config.providers);
  el.providerCount.textContent = entries.length;

  if (entries.length === 0) {
    el.providerList.innerHTML = '<div class="empty">还没有供应商，点击上方"添加供应商"开始。</div>';
    return;
  }

  el.providerList.innerHTML = entries
    .map(([id, provider]) => {
      const envKey = provider.apiKeyEnv || "";
      const keySet = envKey && state.envKeys[envKey];
      const keyLabel = envKey
        ? `${escapeHtml(envKey)} <span class="keyStatus ${keySet ? "set" : "unset"}">${keySet ? "已设置" : "未设置"}</span>`
        : "无需";

      const models = Object.entries(config.models).filter(([, m]) => m.provider === id);

      const modelsHtml = models.length > 0
        ? `<div class="model-table">
            <div class="model-table-head">
              <span>模型别名</span>
              <span></span>
              <span>上游模型名</span>
            </div>
            ${models.map(([alias, model]) => {
              const isDefault = config.defaultModel === alias;
              return `
                <div class="model-table-row">
                  <span class="model-table-alias">${escapeHtml(alias)} ${isDefault ? '<span class="default-tag">默认</span>' : ""}</span>
                  <span class="model-table-arrow">&rarr;</span>
                  <span class="model-table-upstream">${escapeHtml(model.upstreamModel || alias)}</span>
                </div>
              `;
            }).join("")}
          </div>`
        : '<div class="sub-empty">暂无模型</div>';

      return `
        <article class="provider-card">
          <div class="card-top">
            <div>
              <h3>${escapeHtml(id)}</h3>
              <div class="card-desc">${escapeHtml(truncate(provider.baseUrl || "", 50))}</div>
            </div>
            <div class="card-actions">
              <button class="ghost small" type="button" data-edit="${escapeHtml(id)}">编辑</button>
              <button class="danger small" type="button" data-delete="${escapeHtml(id)}">删除</button>
            </div>
          </div>
          <div class="card-meta">
            <span class="route-tag">协议 <code>${escapeHtml(provider.protocol || "chat")}</code></span>
            <span class="route-tag">Key <code>${keyLabel}</code></span>
            <span class="route-tag">模型 <code>${models.length}</code></span>
          </div>
          <div class="sub-models">${modelsHtml}</div>
        </article>
      `;
    })
    .join("");

  for (const btn of el.providerList.querySelectorAll("[data-edit]")) {
    btn.addEventListener("click", () => editProvider(btn.dataset.edit));
  }
  for (const btn of el.providerList.querySelectorAll("[data-delete]")) {
    btn.addEventListener("click", () => deleteProvider(btn.dataset.delete));
  }
}

// ── Stats ──
function formatLatency(ms) {
  if (ms >= 60000) return (ms / 60000).toFixed(1) + " min";
  if (ms >= 1000) return (ms / 1000).toFixed(2) + " s";
  return ms + " ms";
}

function renderStats(stats) {
  const { overall, byModel, byProvider } = stats;

  el.statTotal.textContent = overall.total.toLocaleString();
  el.statSuccessRate.textContent = overall.total > 0
    ? ((overall.success / overall.total) * 100).toFixed(1) + "%"
    : "-";
  el.statAvgLatency.textContent = overall.total > 0
    ? formatLatency(overall.avgLatency)
    : "-";
  el.statFailCount.textContent = overall.fail.toLocaleString();

  el.statsByModel.innerHTML = renderStatsTable(byModel, ["模型", "调用次数", "成功率", "平均耗时", "最近使用"]);
  el.statsByProvider.innerHTML = renderStatsTable(byProvider, ["供应商", "调用次数", "成功率", "平均耗时"]);
}

function renderStatsTable(data, headers) {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return '<div class="stats-empty">暂无数据，发起代理请求后将自动记录。</div>';
  }

  const hasLastUsed = headers.length === 5;
  const ths = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");

  const rows = entries
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([name, s]) => {
      const rate = s.total > 0 ? ((s.success / s.total) * 100) : 0;
      const rateClass = rate >= 95 ? "rate-high" : rate < 80 ? "rate-low" : "";
      const lastUsed = hasLastUsed && s.lastUsed
        ? new Date(s.lastUsed).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        : "";

      return `<tr>
        <td>${escapeHtml(name)}</td>
        <td>${s.total.toLocaleString()}</td>
        <td class="${rateClass}">${rate.toFixed(1)}%</td>
        <td>${formatLatency(s.avgLatency)}</td>
        ${hasLastUsed ? `<td>${lastUsed}</td>` : ""}
      </tr>`;
    })
    .join("");

  return `<table class="stats-table"><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
}

// ── Utils ──
async function requestJson(url, options = {}) {
  const resp = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);
  return data;
}

function setStatus(text, status) {
  el.statusText.textContent = text;
  el.statusDot.className = `dot ${status === "ok" ? "ok" : status === "bad" ? "bad" : ""}`;
}

function escapeHtml(v) {
  return String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
