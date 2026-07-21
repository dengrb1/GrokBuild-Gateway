/* global fetch */

const THEME_KEY = "gbg-theme";

const state = {
  config: null,
  health: null,
  grokStatus: null,
  stats: null,
  rev: 0,
  logRev: 0,
  editingProviderId: null,
  editingModelId: null,
  upstreamCache: {},
  activeTab: "dashboard",
  pollTimer: 0,
  busy: false,
  theme: "system",
};

function resolveTheme(pref) {
  if (pref === "light" || pref === "dark") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(pref) {
  const mode = pref === "light" || pref === "dark" || pref === "system" ? pref : "system";
  state.theme = mode;
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // ignore
  }
  const resolved = resolveTheme(mode);
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.dataset.themePref = mode;
  const sw = document.getElementById("theme-switch");
  if (sw) {
    sw.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.themeSet === mode);
    });
  }
}

function initTheme() {
  let pref = "system";
  try {
    pref = localStorage.getItem(THEME_KEY) || "system";
  } catch {
    pref = "system";
  }
  applyTheme(pref);
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (state.theme === "system") applyTheme("system");
  };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

initTheme();

const $cache = Object.create(null);
function $(sel) {
  return ($cache[sel] ||= document.querySelector(sel));
}

async function api(path, init) {
  const resp = await fetch(path, {
    headers: init?.body
      ? { "content-type": "application/json", ...(init.headers || {}) }
      : init?.headers,
    ...init,
  });
  if (resp.status === 204) return { __notModified: true };
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!resp.ok) {
    const msg =
      data && typeof data === "object" && data.error
        ? typeof data.error === "string"
          ? data.error
          : data.error.message || JSON.stringify(data.error)
        : `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return data;
}

function showTab(name) {
  state.activeTab = name;
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.classList.toggle("active", p.id === `tab-${name}`);
  });
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return String(ts);
  }
}

function toast(title, body = "", type = "ok") {
  const root = $("#toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div>${
    body ? `<div class="toast-body">${escapeHtml(body)}</div>` : ""
  }`;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .2s ease";
    setTimeout(() => el.remove(), 200);
  }, 2800);
}

function fillProviderSelects() {
  const cfg = state.config;
  if (!cfg) return;
  for (const selId of ["#import-provider-maps", "#import-provider-models"]) {
    const sel = $(selId);
    if (!sel) continue;
    const prev = sel.value;
    let html = "";
    for (const p of cfg.providers) {
      if (!p.enabled) continue;
      const label =
        p.id === cfg.activeProviderId
          ? `${p.name} (${p.id}) ●`
          : `${p.name} (${p.id})`;
      html += `<option value="${escapeAttr(p.id)}">${escapeHtml(label)}</option>`;
    }
    sel.innerHTML = html;
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    else sel.value = cfg.activeProviderId;
  }
}

function fillUpstreamDatalist(models) {
  const list = $("#upstream-model-list");
  if (!list) return;
  let html = "";
  for (const m of models || []) {
    html += `<option value="${escapeAttr(m.id)}" label="${escapeAttr(m.name || m.id)}"></option>`;
  }
  list.innerHTML = html;
}

function renderDashboard() {
  const health = state.health;
  const config = state.config;
  const stats = state.stats;
  if (!health || !config) return;

  $("#stat-active").textContent = health.activeProviderId || "—";
  $("#stat-active-sub").textContent = health.activeProviderName || "当前供应商";
  const publicBase =
    health.publicBase || `http://127.0.0.1:${health.port}`;
  $("#stat-listen").textContent = `:${health.port}`;
  $("#stat-counts").textContent = `${config.modelMaps.length} / ${config.virtualModels.length}`;
  if (stats) {
    $("#stat-requests").textContent = String(stats.total ?? 0);
    $("#stat-requests-sub").textContent = `错误 ${stats.errors ?? 0} · 平均 ${stats.avgLatencyMs ?? 0}ms`;
  }

  const ps = health.proxyShield;
  const globalOn =
    typeof ps?.enabled === "boolean"
      ? ps.enabled
      : config.server?.proxyShield !== false &&
        (config.server?.proxyMode ?? "direct") !== "env";
  const proxyMode = ps?.mode || (globalOn ? "direct" : "env");
  $("#dash-status").innerHTML = `
    <dt>Active</dt><dd>${escapeHtml(health.activeProviderId)}</dd>
    <dt>Listen</dt><dd>${escapeHtml(publicBase)}</dd>
    <dt>Proxy</dt><dd>全局防护 ${globalOn ? "开" : "关"} · mode=${escapeHtml(proxyMode)} · 本机 127.0.0.1 始终直连</dd>
    <dt>Config</dt><dd>${escapeHtml(health.configPath || "")}</dd>
    <dt>Providers</dt><dd>${config.providers.length}</dd>`;

  const pb = $("#proxy-badge");
  if (pb) {
    pb.textContent = globalOn ? "代理盾 · 开" : "代理盾 · 关";
    pb.className = globalOn ? "badge ok" : "badge";
    pb.title = ps?.noProxy
      ? `NO_PROXY: ${ps.noProxy}`
      : "本机网关地址不走系统代理";
  }

  const gToggle = $("#toggle-global-proxy-shield");
  const gLabel = $("#global-proxy-shield-label");
  const gDetail = $("#proxy-shield-detail");
  if (gToggle && gToggle !== document.activeElement) {
    gToggle.checked = globalOn;
  }
  if (gLabel) gLabel.textContent = globalOn ? "开" : "关";
  if (gDetail) {
    const n = (config.providers || []).filter((p) => p.proxyShield === false).length;
    gDetail.textContent = globalOn
      ? `上游默认直连。有 ${n} 个供应商单独关闭了防护（仍可走系统代理）。`
      : "全局已关闭：所有供应商上游将跟随系统/环境代理（本机 127.0.0.1 仍受保护）。";
  }

  const gs = $("#grok-status-line");
  const g = state.grokStatus;
  if (g) {
    if (g.pointedAtGateway) {
      gs.innerHTML = `<span class="pill ok">已接入网关</span> <span class="mono">${escapeHtml(g.path)}</span>`;
    } else if (g.exists) {
      gs.innerHTML = `<span class="pill err">尚未指向网关</span> <span class="mono">${escapeHtml(g.path)}</span>`;
    } else {
      gs.innerHTML = `<span class="pill err">配置不存在</span> 将创建 <span class="mono">${escapeHtml(g.path)}</span>`;
    }
  }
}

/** One request replaces 5 — uses rev to get 204 when idle. */
async function refreshAll(force = false) {
  if (state.busy) return;
  state.busy = true;
  try {
    const wantLogs = state.activeTab === "logs" || force;
    const qs = new URLSearchParams();
    if (!force && state.rev > 0) {
      qs.set("rev", String(state.rev));
      qs.set("logRev", String(state.logRev));
    }
    qs.set("logs", wantLogs ? "1" : "0");
    if (wantLogs) qs.set("limit", "40");

    const data = await api(`/api/snapshot?${qs}`);
    if (data?.__notModified) return;

    state.rev = data.rev;
    state.logRev = data.logRev;
    state.health = data.health;
    state.config = data.config;
    state.stats = data.stats;
    state.grokStatus = data.grokStatus;

    const badge = $("#health-badge");
    badge.textContent = `${data.health.activeProviderName || data.health.activeProviderId} · :${data.health.port}`;
    badge.className = "badge ok";

    $("#bootstrap-snippet").textContent = data.bootstrap?.snippet || "";
    $("#dash-stats").textContent = JSON.stringify(data.stats, null, 2);

    renderDashboard();
    fillProviderSelects();
    renderProviders();
    renderMaps();
    renderVirtualModels();
    if (wantLogs && data.logs) renderLogs(data.logs);
  } catch (err) {
    const badge = $("#health-badge");
    badge.textContent = `离线 · ${err.message}`;
    badge.className = "badge err";
  } finally {
    state.busy = false;
  }
}

function schedulePoll() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  // Hidden tab: almost no work. Visible: one cheap snapshot (often 204).
  const ms = document.hidden ? 30000 : 12000;
  state.pollTimer = setInterval(() => {
    if (!document.hidden) void refreshAll(false);
  }, ms);
}

function renderProviders() {
  const cfg = state.config;
  if (!cfg) return;
  const root = $("#provider-list");
  if (!cfg.providers.length) {
    root.innerHTML = `<div class="empty">还没有供应商，点击右上角添加</div>`;
    return;
  }
  const globalOn =
    cfg.server?.proxyShield !== false &&
    (cfg.server?.proxyMode ?? "direct") !== "env";
  let html = "";
  for (const p of cfg.providers) {
    const active = p.id === cfg.activeProviderId;
    const pShield = p.proxyShield !== false;
    const effective = globalOn && pShield;
    html += `<div class="provider-item${active ? " active" : ""}">
      <div class="provider-meta">
        <div class="name">${escapeHtml(p.name)}
          ${active ? '<span class="pill ok">active</span>' : ""}
          ${!p.enabled ? '<span class="pill err">disabled</span>' : ""}
          <span class="pill accent">${escapeHtml(p.apiBackend || "chat_completions")}</span>
          <span class="pill ${effective ? "ok" : ""}" title="代理防护：全局 ${globalOn ? "开" : "关"} · 本供应商 ${pShield ? "开" : "关"}">
            代理${effective ? "直连" : "可走代理"}
          </span>
        </div>
        <div class="id">${escapeHtml(p.id)} · key ${escapeHtml(p.apiKey || "(empty)")}</div>
        <div class="url">${escapeHtml(p.baseUrl)}</div>
      </div>
      <div class="provider-actions">
        <label class="switch" title="本供应商代理防护">
          <input type="checkbox" data-act="proxy-shield" data-id="${escapeAttr(p.id)}" ${pShield ? "checked" : ""} />
          <span class="switch-slider"></span>
          <span class="switch-label">防护</span>
        </label>
        <button class="btn sm primary" data-act="use" data-id="${escapeAttr(p.id)}" ${active ? "disabled" : ""}>使用</button>
        <button class="btn sm" data-act="test" data-id="${escapeAttr(p.id)}">测试</button>
        <button class="btn sm" data-act="fetch" data-id="${escapeAttr(p.id)}">模型</button>
        <button class="btn sm" data-act="edit" data-id="${escapeAttr(p.id)}">编辑</button>
        <button class="btn sm danger" data-act="del" data-id="${escapeAttr(p.id)}">删除</button>
      </div>
    </div>`;
  }
  root.innerHTML = html;
}

function openProviderForm(provider) {
  const card = $("#provider-form-card");
  const form = $("#provider-form");
  card.classList.remove("hidden");
  state.editingProviderId = provider?.id || null;
  $("#provider-form-title").textContent = provider
    ? `编辑 ${provider.id}`
    : "添加供应商";
  form.id.value = provider?.id || "";
  form.id.disabled = Boolean(provider);
  form.name.value = provider?.name || "";
  form.baseUrl.value = provider?.baseUrl || "";
  form.apiKey.value = provider?.apiKey || "";
  form.apiBackend.value = provider?.apiBackend || "chat_completions";
  form.enabled.checked = provider?.enabled !== false;
  if (form.proxyShield) {
    form.proxyShield.checked = provider?.proxyShield !== false;
  }
}

function closeProviderForm() {
  $("#provider-form-card").classList.add("hidden");
  state.editingProviderId = null;
  $("#provider-form").reset();
  $("#provider-form").id.disabled = false;
}

function renderMaps() {
  const cfg = state.config;
  if (!cfg) return;
  const body = $("#map-body");
  if (!cfg.modelMaps.length) {
    body.innerHTML = `<tr><td colspan="4"><div class="empty">暂无映射，可手动添加或从上游导入</div></td></tr>`;
    return;
  }
  let html = "";
  for (const m of cfg.modelMaps) {
    html += `<tr>
      <td><code>${escapeHtml(m.from)}</code></td>
      <td><code>${escapeHtml(m.to)}</code></td>
      <td>${m.providerId ? `<span class="pill accent">${escapeHtml(m.providerId)}</span>` : '<span class="pill">active</span>'}</td>
      <td><div class="row">
        <button class="btn sm" data-act="edit" data-from="${escapeAttr(m.from)}">编辑</button>
        <button class="btn sm danger" data-act="del" data-from="${escapeAttr(m.from)}">删除</button>
      </div></td>
    </tr>`;
  }
  body.innerHTML = html;
}

function renderVirtualModels() {
  const cfg = state.config;
  if (!cfg) return;
  const body = $("#vmodel-body");
  if (!cfg.virtualModels.length) {
    body.innerHTML = `<tr><td colspan="5"><div class="empty">暂无虚拟模型，可手动添加或从上游导入</div></td></tr>`;
    return;
  }
  let html = "";
  for (const m of cfg.virtualModels) {
    html += `<tr>
      <td><code>${escapeHtml(m.id)}</code></td>
      <td>${escapeHtml(m.name)}</td>
      <td>${m.contextWindow ?? "—"}</td>
      <td>${m.ownedBy ? `<span class="pill">${escapeHtml(m.ownedBy)}</span>` : "—"}</td>
      <td><div class="row">
        <button class="btn sm" data-act="edit" data-id="${escapeAttr(m.id)}">编辑</button>
        <button class="btn sm danger" data-act="del" data-id="${escapeAttr(m.id)}">删除</button>
      </div></td>
    </tr>`;
  }
  body.innerHTML = html;
}

function openVirtualModelForm(model) {
  const form = $("#vmodel-form");
  state.editingModelId = model?.id || null;
  form.previousId.value = model?.id || "";
  form.id.value = model?.id || "";
  form.name.value = model?.name || "";
  form.contextWindow.value = model?.contextWindow ?? "";
  form.ownedBy.value = model?.ownedBy || "";
  $("#btn-vmodel-submit").textContent = model ? "保存修改" : "添加";
  $("#btn-vmodel-cancel").classList.toggle("hidden", !model);
  form.id.focus();
}

function resetVirtualModelForm() {
  const form = $("#vmodel-form");
  form.reset();
  form.previousId.value = "";
  state.editingModelId = null;
  $("#btn-vmodel-submit").textContent = "添加";
  $("#btn-vmodel-cancel").classList.add("hidden");
}

async function importFromProvider(providerId, target) {
  const r = await api("/api/import-models", {
    method: "POST",
    body: JSON.stringify({
      id: providerId,
      mode: "merge",
      target,
      pinProvider: false,
    }),
  });
  if (!r.ok) throw new Error(r.error || "import failed");
  toast("导入完成", `${r.imported} 个模型 → ${target}`, "ok");
  await refreshAll(true);
}

function renderLogs(logs) {
  const body = $("#log-body");
  if (!logs?.length) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty">暂无请求日志</div></td></tr>`;
    return;
  }
  let html = "";
  for (const e of logs) {
    const statusClass =
      e.status >= 400 ? "status-err" : e.status ? "status-ok" : "";
    html += `<tr>
      <td>${fmtTime(e.ts)}</td>
      <td>${escapeHtml(e.method)}</td>
      <td><code>${escapeHtml(e.path)}</code></td>
      <td><code>${escapeHtml(e.modelIn || "—")} → ${escapeHtml(e.modelOut || "—")}</code></td>
      <td>${escapeHtml(e.providerId || "—")}</td>
      <td class="${statusClass}">${e.status}${e.stream ? " ƒ" : ""}${
        e.error ? ` (${escapeHtml(e.error)})` : ""
      }</td>
      <td>${e.latencyMs}</td>
    </tr>`;
  }
  body.innerHTML = html;
}

async function refreshLogs() {
  try {
    const data = await api("/api/logs?limit=40");
    renderLogs(data.logs || []);
  } catch (err) {
    console.error(err);
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", "&#39;");
}

function onDelegatedClick(rootSel, handler) {
  const root = $(rootSel);
  if (!root) return;
  root.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (!btn || !root.contains(btn)) return;
    handler(btn);
  });
}

function wire() {
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      showTab(t.dataset.tab);
      if (t.dataset.tab === "logs") void refreshAll(true);
    });
  });

  const themeSw = $("#theme-switch");
  if (themeSw) {
    themeSw.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-theme-set]");
      if (!btn) return;
      applyTheme(btn.dataset.themeSet);
    });
  }

  $("#btn-refresh").addEventListener("click", () => void refreshAll(true));
  $("#btn-refresh-logs").addEventListener("click", () => void refreshLogs());

  const globalShield = $("#toggle-global-proxy-shield");
  if (globalShield) {
    globalShield.addEventListener("change", async () => {
      const enabled = globalShield.checked;
      try {
        await api("/api/proxy-shield", {
          method: "POST",
          body: JSON.stringify({ enabled }),
        });
        toast(
          enabled ? "全局代理防护已开启" : "全局代理防护已关闭",
          enabled
            ? "上游默认直连；各供应商仍可单独关闭"
            : "上游将跟随系统/环境代理",
          "ok",
        );
        await refreshAll(true);
      } catch (err) {
        toast("切换失败", err.message, "err");
        globalShield.checked = !enabled;
      }
    });
  }

  document.addEventListener("visibilitychange", () => {
    schedulePoll();
    if (!document.hidden) void refreshAll(false);
  });

  $("#btn-copy-bootstrap").addEventListener("click", async () => {
    const text = $("#bootstrap-snippet").textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制", "Bootstrap 片段已在剪贴板", "ok");
    } catch {
      prompt("复制以下内容:", text);
    }
  });

  $("#btn-apply-grok").addEventListener("click", async () => {
    const path = state.grokStatus?.path || "(~/.grok/config.toml)";
    if (
      !confirm(
        `将自动备份并写入 Grok 配置：\n${path}\n\n写入后需要重启一次 Grok。继续？`,
      )
    ) {
      return;
    }
    try {
      const r = await api("/api/apply-grok", {
        method: "POST",
        body: "{}",
      });
      if (!r.ok) throw new Error(r.error || "apply failed");
      toast(
        "Grok 配置已写入",
        `${r.message || ""}${r.backupPath ? `\n备份: ${r.backupPath}` : ""}`,
        "ok",
      );
      await refreshAll(true);
    } catch (err) {
      toast("写入失败", err.message, "err");
    }
  });

  $("#btn-add-provider").addEventListener("click", () => openProviderForm(null));
  $("#btn-cancel-provider").addEventListener("click", () => closeProviderForm());

  // Provider list: buttons + per-provider proxy shield checkbox
  $("#provider-list")?.addEventListener("change", async (ev) => {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.dataset.act !== "proxy-shield") return;
    const id = input.dataset.id;
    if (!id) return;
    try {
      await api(`/api/providers/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ proxyShield: input.checked }),
      });
      toast(
        input.checked ? "供应商代理防护已开" : "供应商代理防护已关",
        id,
        "ok",
      );
      await refreshAll(true);
    } catch (err) {
      toast("切换失败", err.message, "err");
      input.checked = !input.checked;
    }
  });

  onDelegatedClick("#provider-list", async (btn) => {
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    const cfg = state.config;
    try {
      if (act === "use") {
        await api("/api/active-provider", {
          method: "POST",
          body: JSON.stringify({ id }),
        });
        toast("已切换供应商", id, "ok");
        await refreshAll(true);
      } else if (act === "test") {
        const r = await api("/api/test-provider", {
          method: "POST",
          body: JSON.stringify({ id }),
        });
        if (r.ok) {
          toast(
            `连通正常 · ${r.latencyMs}ms`,
            `${r.modelCount ?? 0} models\n${(r.sampleModels || []).slice(0, 8).join("\n")}`,
            "ok",
          );
        } else {
          toast("连通失败", r.error || `HTTP ${r.status}`, "err");
        }
      } else if (act === "fetch") {
        const r = await api("/api/fetch-models", {
          method: "POST",
          body: JSON.stringify({ id }),
        });
        if (!r.ok) throw new Error(r.error || "fetch failed");
        state.upstreamCache[id] = r.models || [];
        fillUpstreamDatalist(r.models);
        const names = (r.models || []).slice(0, 16).map((m) => m.id).join("\n");
        if (
          confirm(
            `上游 ${id} 共 ${r.models.length} 个模型\n\n${names}${r.models.length > 16 ? "\n…" : ""}\n\n导入到 Virtual Models + Maps？`,
          )
        ) {
          await importFromProvider(id, "both");
        }
      } else if (act === "edit") {
        openProviderForm(cfg.providers.find((x) => x.id === id));
      } else if (act === "del") {
        if (!confirm(`删除供应商 ${id}？`)) return;
        await api(`/api/providers/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        toast("已删除供应商", id, "ok");
        await refreshAll(true);
      }
    } catch (err) {
      toast("操作失败", err.message, "err");
    }
  });

  onDelegatedClick("#map-body", async (btn) => {
    const from = btn.dataset.from;
    try {
      if (btn.dataset.act === "del") {
        await api(`/api/model-maps/${encodeURIComponent(from)}`, {
          method: "DELETE",
        });
        toast("已删除映射", from, "ok");
        await refreshAll(true);
      } else if (btn.dataset.act === "edit") {
        const m = state.config.modelMaps.find((x) => x.from === from);
        if (!m) return;
        const form = $("#map-form");
        form.from.value = m.from;
        form.to.value = m.to;
        form.providerId.value = m.providerId || "";
        form.from.focus();
      }
    } catch (err) {
      toast("操作失败", err.message, "err");
    }
  });

  onDelegatedClick("#vmodel-body", async (btn) => {
    const id = btn.dataset.id;
    try {
      if (btn.dataset.act === "del") {
        if (!confirm(`删除虚拟模型 ${id}？`)) return;
        await api(`/api/virtual-models/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        toast("已删除模型", id, "ok");
        await refreshAll(true);
      } else if (btn.dataset.act === "edit") {
        const m = state.config.virtualModels.find((x) => x.id === id);
        if (m) openVirtualModelForm(m);
      }
    } catch (err) {
      toast("操作失败", err.message, "err");
    }
  });

  $("#provider-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const apiBackend = form.apiBackend.value || "chat_completions";
    const extraHeaders = {};
    if (apiBackend === "messages") {
      extraHeaders["anthropic-version"] = "2023-06-01";
    }
    const payload = {
      id: form.id.value.trim(),
      name: form.name.value.trim(),
      baseUrl: form.baseUrl.value.trim(),
      apiKey: form.apiKey.value.trim(),
      enabled: form.enabled.checked,
      proxyShield: form.proxyShield ? form.proxyShield.checked : true,
      apiBackend,
      extraHeaders,
    };
    try {
      if (state.editingProviderId) {
        await api(`/api/providers/${encodeURIComponent(payload.id)}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        toast("供应商已更新", payload.id, "ok");
      } else {
        await api("/api/providers", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        toast("供应商已添加", payload.id, "ok");
      }
      closeProviderForm();
      await refreshAll(true);
    } catch (err) {
      toast("保存失败", err.message, "err");
    }
  });

  $("#map-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const entry = {
      from: form.from.value.trim(),
      to: form.to.value.trim(),
      providerId: form.providerId.value.trim() || null,
    };
    try {
      await api("/api/model-maps", {
        method: "POST",
        body: JSON.stringify(entry),
      });
      form.reset();
      toast("映射已保存", `${entry.from} → ${entry.to}`, "ok");
      await refreshAll(true);
    } catch (err) {
      toast("保存失败", err.message, "err");
    }
  });

  $("#btn-import-maps").addEventListener("click", async () => {
    const id = $("#import-provider-maps").value;
    if (!id) return;
    try {
      await importFromProvider(id, "maps");
    } catch (err) {
      toast("导入失败", err.message, "err");
    }
  });

  $("#btn-import-models").addEventListener("click", async () => {
    const id = $("#import-provider-models").value;
    if (!id) return;
    try {
      await importFromProvider(id, "virtual");
    } catch (err) {
      toast("导入失败", err.message, "err");
    }
  });

  $("#vmodel-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const previousId = form.previousId.value.trim() || undefined;
    const ctxRaw = form.contextWindow.value;
    const entry = {
      id: form.id.value.trim(),
      name: form.name.value.trim(),
      ownedBy: form.ownedBy.value.trim() || "gbg",
      previousId,
    };
    if (ctxRaw) entry.contextWindow = Number(ctxRaw);
    try {
      await api("/api/virtual-models", {
        method: "POST",
        body: JSON.stringify(entry),
      });
      toast(previousId ? "模型已更新" : "模型已添加", entry.id, "ok");
      resetVirtualModelForm();
      await refreshAll(true);
    } catch (err) {
      toast("保存失败", err.message, "err");
    }
  });

  $("#btn-vmodel-cancel").addEventListener("click", () => resetVirtualModelForm());
}

wire();
void refreshAll(true);
schedulePoll();
