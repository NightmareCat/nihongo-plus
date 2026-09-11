/**
 * @file app.js
 * @description 前端交互控制器；管理页面路由、离线查重、词条编辑、筛选、子词库与 AI 补全。
 */

const state = {
  words: [],
  collections: [],
  options: { conjugations: [] },
  settings: {
    aiProvider: "deepseek", exampleCount: 2, concurrency: 3, requestTimeoutSeconds: 60,
    providers: { deepseek: { label: "DeepSeek 官方", model: "deepseek-v4-flash" }, "opencode-go": { label: "OpenCode Go", model: "deepseek-v4.1-flash" } },
    keyConfigured: { deepseek: false, "opencode-go": false },
  },
  view: location.hash.slice(1) || "home",
  selected: new Set(),
  batchRunning: false,
  batchAbortController: null,
  enrichingIds: new Set(),
  filters: { query: "", category: "", jlpt: "", collection: "", status: "" },
  page: 1,
  pageSize: 18,
};

const app = document.querySelector("#app");
const wordDialog = document.querySelector("#word-dialog");
const confirmDialog = document.querySelector("#confirm-dialog");
const collectionDialog = document.querySelector("#collection-dialog");
const pageTitles = {
  home: ["学习概览", "今日，从一个词开始。"],
  add: ["快速收录", "把遇见的词，留在这里。"],
  manage: ["词库管理", "整理你的语言地图。"],
  collections: ["子词库", "让词语各归其位。"],
  settings: ["平台设置", "按你的方式学习。"],
  learn: ["学习空间", "记忆练习"],
  quiz: ["学习空间", "考核测试"],
};

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const rubyHtml = (value = "") => escapeHtml(String(value).replace(/\\([<>])/g, "$1"))
  .replace(/&lt;(\/?)ruby&gt;/gi, "<$1ruby>")
  .replace(/&lt;(\/?)rt&gt;/gi, "<$1rt>");
const wordComplete = (word) => Boolean(word.reading && word.meanings?.length && word.partOfSpeech?.category !== "未分类" && word.jlpt !== "未定" && word.examples?.length);
const wordIsBlank = (word) => !word.reading
  && !word.meanings?.length
  && (!word.partOfSpeech?.category || word.partOfSpeech.category === "未分类")
  && !word.partOfSpeech?.detail
  && !word.partOfSpeech?.conjugationClass
  && !word.partOfSpeech?.transitivity
  && (!word.jlpt || word.jlpt === "未定")
  && !word.tags?.length
  && !word.conjugations?.length
  && !word.examples?.length;
const wordNeedsEnrichment = (word) => !wordComplete(word)
  || (["动词", "形容词"].includes(word.partOfSpeech?.category) && !word.conjugations?.length);
const normalize = (value = "") => String(value).normalize("NFKC").trim().replace(/^[~〜～]+|[~〜～]+$/g, "").replace(/\s+/g, "").toLocaleLowerCase("ja-JP");
const activeProvider = () => state.settings.providers[state.settings.aiProvider];
const aiConfigured = () => Boolean(state.settings.keyConfigured[state.settings.aiProvider]);

function applyTheme(preference = localStorage.theme || "system") {
  const resolved = preference === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = resolved;
  localStorage.theme = preference;
  const button = document.querySelector("#theme-toggle");
  if (button) { button.textContent = resolved === "dark" ? "☀" : "☾"; button.title = resolved === "dark" ? "切换浅色模式" : "切换深色模式"; }
}

async function api(url, options = {}) {
  // 前端比服务端多等待 10 秒，确保能够显示服务端返回的明确超时原因。
  const enrichmentTimeoutMs = ((state.settings.requestTimeoutSeconds || 60) + 10) * 1_000;
  const { timeoutMs = url.includes("/enrich") ? enrichmentTimeoutMs : 15_000, ...fetchOptions } = options;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = fetchOptions.signal
    ? AbortSignal.any([fetchOptions.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal,
      headers: { "Content-Type": "application/json", ...(fetchOptions.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || "操作失败"), { status: response.status, payload });
    return payload;
  } catch (error) {
    if (timeoutController.signal.aborted) throw new Error(`请求超过 ${Math.round(timeoutMs / 1000)} 秒，已自动停止`);
    if (fetchOptions.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function toast(message, type = "success") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  document.querySelector("#toast-region").append(node);
  setTimeout(() => node.remove(), 3200);
}

function setView(view) {
  state.view = pageTitles[view] ? view : "home";
  location.hash = state.view;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === state.view));
  const [eyebrow, title] = pageTitles[state.view];
  document.querySelector("#eyebrow").textContent = eyebrow;
  document.querySelector("#page-title").textContent = title;
  document.querySelector(".sidebar").classList.remove("open");
  render();
}

function render() {
  if (state.view === "home") renderHome();
  else if (state.view === "add") renderAdd();
  else if (state.view === "manage") renderManage();
  else if (state.view === "collections") renderCollections();
  else if (state.view === "settings") renderSettings();
  else renderReserved(state.view);
}

function getStats() {
  const complete = state.words.filter(wordComplete).length;
  const pending = state.words.length - complete;
  const recent = [...state.words].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  const levels = Object.fromEntries(["N5", "N4", "N3", "N2", "N1", "未定"].map((level) => [level, state.words.filter((word) => word.jlpt === level).length]));
  return { complete, pending, recent, levels };
}

function renderHome() {
  const stats = getStats();
  const completion = state.words.length ? Math.round(stats.complete / state.words.length * 100) : 0;
  const maxLevel = Math.max(1, ...Object.values(stats.levels));
  app.innerHTML = `
    <div class="dashboard-grid">
      <section class="stack">
        <article class="card feature-card">
          <span class="kicker">QUICK CAPTURE · 快速收录</span>
          <h2>刚刚遇到的日语，<br>趁热把它记下来。</h2>
          <p>输入后会立即在本地词库中检查重复；保存后可交给 ${escapeHtml(activeProvider().label)} · ${escapeHtml(activeProvider().model)} 补全读音、释义与例句。</p>
          <form class="quick-row" id="quick-form">
            <input id="quick-term" autocomplete="off" placeholder="例如：見惚れる / ～うちに" aria-label="日语单词或语法" required />
            <button class="primary-btn" type="submit">收录单词</button>
          </form>
        </article>

        <div class="stats-row">
          <article class="card stat-card"><small>全部词条</small><strong>${state.words.length}</strong><span>个人收集</span></article>
          <article class="card stat-card"><small>资料完整</small><strong>${stats.complete}</strong><span>${completion}% 已补全</span></article>
          <article class="card stat-card"><small>等待整理</small><strong>${stats.pending}</strong><span>可批量筛选</span></article>
        </div>

        <article class="card card-pad">
          <div class="section-head"><div><h2>最近收录</h2><p>继续完善刚遇见的表达</p></div><button class="text-link" data-go="manage">查看全部 →</button></div>
          <div class="recent-list">
            ${stats.recent.map((word) => `
              <div class="recent-item" data-edit="${word.id}" tabindex="0">
                <div class="term"><strong>${escapeHtml(word.term)}</strong><small>${escapeHtml(word.reading || "待读音")}</small></div>
                <div class="meaning">${escapeHtml(word.meanings?.join("；") || "等待补充中文释义")}</div>
                <span class="badge ${wordComplete(word) ? "green" : "accent"}">${wordComplete(word) ? "已完整" : "待补全"}</span>
              </div>`).join("") || `<div class="empty-state"><p>词库还是空的，先收录第一个词吧。</p></div>`}
          </div>
        </article>
      </section>

      <aside class="stack">
        <article class="card card-pad">
          <div class="section-head"><div><h2>资料完整度</h2><p>读音、词性、释义、等级、例句</p></div><strong>${completion}%</strong></div>
          <div class="progress"><span style="width:${completion}%"></span></div>
          <div class="progress-wrap"><div class="progress-label"><span>${stats.complete} 个完整词条</span><span>${stats.pending} 个待处理</span></div></div>
        </article>
        <article class="card card-pad">
          <div class="section-head"><div><h2>JLPT 分布</h2><p>独立于词性分类的难度标签</p></div></div>
          <div class="level-bars">
            ${Object.entries(stats.levels).map(([level, count]) => `<div class="level-row"><strong>${level}</strong><div class="level-bar"><i style="width:${count / maxLevel * 100}%"></i></div><span>${count}</span></div>`).join("")}
          </div>
        </article>
        <article class="card card-pad">
          <div class="section-head"><div><h2>AI 补全设置</h2><p>${aiConfigured() ? "服务已就绪" : "配置密钥后启用"}</p></div><span class="badge ${aiConfigured() ? "green" : ""}">${escapeHtml(activeProvider().model)}</span></div>
          <label class="field"><span>每个词的主例句数量</span><select class="select" id="example-count">${[1,2,3,4,5].map((n) => `<option value="${n}" ${state.settings.exampleCount === n ? "selected" : ""}>${n} 个</option>`).join("")}</select></label>
          <button class="text-link" data-go="settings">打开全部设置 →</button>
        </article>
      </aside>
    </div>`;

  document.querySelector("#quick-form").addEventListener("submit", quickAdd);
  document.querySelector("#example-count").addEventListener("change", async (event) => {
    try { await updateSettings({ exampleCount: Number(event.target.value) }); toast("例句数量偏好已保存"); } catch (error) { toast(error.message, "error"); }
  });
  bindCommonActions();
}

async function quickAdd(event) {
  event.preventDefault();
  const input = event.currentTarget.querySelector("input");
  const duplicate = state.words.find((word) => normalize(word.term) === normalize(input.value));
  if (duplicate) {
    toast(`“${duplicate.term}” 已在词库中`, "error");
    openWordDialog(duplicate.id);
    return;
  }
  try {
    const { word } = await api("/api/words", { method: "POST", body: JSON.stringify({ term: input.value }) });
    state.words.unshift(word);
    toast("已收录，可以继续补充资料");
    openWordDialog(word.id);
  } catch (error) { toast(error.message, "error"); }
}

function renderAdd() {
  app.innerHTML = `
    <section class="card card-pad form-card">
      <div class="form-intro"><span class="seal">新</span><div><h2>收录一个新词</h2><p>仅需填写词条即可保存。重复检查完全读取当前本地词库，不会调用 AI，也不会产生费用。</p></div></div>
      <form id="add-form">
        <div class="form-grid">
          <div class="field full"><label for="term">日语单词 / 语法结构 *</label><input class="input" id="term" name="term" autocomplete="off" placeholder="例如：受け入れる" required autofocus /><p class="duplicate-note" id="duplicate-note"></p></div>
          <div class="field"><label for="reading">假名读音</label><input class="input" id="reading" name="reading" placeholder="うけいれる" /></div>
          <div class="field"><label for="category">分类</label><select class="select" id="category" name="category">${categoryOptions()}</select></div>
          <div class="field"><label for="meaning">中文释义</label><input class="input" id="meaning" name="meaning" placeholder="接受；接纳" /></div>
          <div class="field"><label for="jlpt">JLPT 难度</label><select class="select" id="jlpt" name="jlpt">${jlptOptions()}</select></div>
          <div class="field full"><label for="notes">个人笔记</label><textarea class="textarea" id="notes" name="notes" placeholder="记录遇见这个词的语境、容易混淆的词……"></textarea></div>
        </div>
        <label class="checkbox-line"><input type="checkbox" id="open-after" checked /> 保存后打开完整编辑器</label>
        <div class="form-actions"><button class="ghost-btn" type="reset">清空</button><button class="primary-btn" id="save-new" type="submit">保存到词库</button></div>
      </form>
    </section>`;

  const form = document.querySelector("#add-form");
  const termInput = form.elements.term;
  termInput.addEventListener("input", () => showDuplicate(termInput));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const duplicate = showDuplicate(termInput);
    if (duplicate) return openWordDialog(duplicate.id);
    const data = new FormData(form);
    const payload = {
      term: data.get("term"), reading: data.get("reading"), meanings: data.get("meaning") ? [data.get("meaning")] : [],
      jlpt: data.get("jlpt"), notes: data.get("notes"), partOfSpeech: { category: data.get("category"), detail: "", conjugationClass: "", transitivity: "" },
    };
    try {
      const { word } = await api("/api/words", { method: "POST", body: JSON.stringify(payload) });
      state.words.unshift(word);
      toast("词条已保存");
      if (document.querySelector("#open-after").checked) openWordDialog(word.id);
      else form.reset();
    } catch (error) { toast(error.message, "error"); }
  });
}

function showDuplicate(input) {
  const duplicate = state.words.find((word) => normalize(word.term) === normalize(input.value));
  input.classList.toggle("invalid", Boolean(duplicate));
  const note = document.querySelector("#duplicate-note");
  note.textContent = duplicate ? `已存在：${duplicate.term}（点击保存将改为打开该词）` : "";
  return duplicate;
}

function categoryOptions(value = "未分类") {
  return ["未分类", "名词", "动词", "形容词", "副词", "语法结构", "固定搭配", "惯用语", "接续词", "感叹词", "助词", "其他"].map((item) => `<option ${item === value ? "selected" : ""}>${item}</option>`).join("");
}
function jlptOptions(value = "未定") {
  return ["未定", "N5", "N4", "N3", "N2", "N1"].map((item) => `<option ${item === value ? "selected" : ""}>${item}</option>`).join("");
}

function filteredWords() {
  const query = normalize(state.filters.query);
  const collection = state.collections.find((item) => item.id === state.filters.collection);
  return state.words.filter((word) => {
    const haystack = normalize([word.term, word.reading, ...(word.meanings || []), ...(word.tags || [])].join(" "));
    return (!query || haystack.includes(query))
      && (!state.filters.category || word.partOfSpeech?.category === state.filters.category)
      && (!state.filters.jlpt || word.jlpt === state.filters.jlpt)
      && (!state.filters.status || (state.filters.status === "complete" ? wordComplete(word) : !wordComplete(word)))
      && (!collection || collection.wordIds.includes(word.id));
  });
}

function renderManage() {
  const filtered = filteredWords();
  const pageCount = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  state.page = Math.min(state.page, pageCount);
  const visible = filtered.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
  app.innerHTML = `
    <section class="card toolbar" aria-label="词库筛选">
      <label class="search-box"><input class="input" id="filter-query" value="${escapeHtml(state.filters.query)}" placeholder="搜索单词、读音、释义或标签" aria-label="搜索词库" /></label>
      <select class="select" id="filter-category" aria-label="按分类筛选"><option value="">全部分类</option>${categoryOptions(state.filters.category).replace('<option selected>未分类</option>', `<option value="未分类" ${state.filters.category === "未分类" ? "selected" : ""}>未分类</option>`)}</select>
      <select class="select" id="filter-jlpt" aria-label="按 JLPT 筛选"><option value="">全部难度</option>${jlptOptions(state.filters.jlpt).replace('<option selected>未定</option>', `<option value="未定" ${state.filters.jlpt === "未定" ? "selected" : ""}>未定</option>`)}</select>
      <select class="select" id="filter-status" aria-label="按完整度筛选"><option value="">全部状态</option><option value="complete" ${state.filters.status === "complete" ? "selected" : ""}>资料完整</option><option value="pending" ${state.filters.status === "pending" ? "selected" : ""}>等待补全</option></select>
      <button class="secondary-btn" id="reset-filters">重置</button>
    </section>
    <div class="manager-meta">
      <span>找到 <strong>${filtered.length}</strong> 个词条 · 已选择 ${state.selected.size} 个</span>
      <div class="bulk-bar">
        <button class="secondary-btn small-btn" id="enrich-all" ${state.batchRunning ? "disabled" : ""}>${state.batchRunning ? "正在批量补全…" : "✦ 补全全部词条"}</button>
        ${state.selected.size ? `<button class="primary-btn small-btn" id="bulk-enrich">AI 并行补全</button><button class="secondary-btn small-btn" id="make-collection">整理为子词库</button><button class="danger-btn small-btn" id="bulk-delete">删除所选</button>` : ""}
        <button class="primary-btn small-btn" data-go="add">＋ 添加</button>
      </div>
    </div>
    <section class="card table-wrap">
      <table class="word-table">
        <thead><tr><th><input class="checkbox" id="select-page" type="checkbox" aria-label="选择本页" /></th><th>词条</th><th>分类</th><th>中文释义</th><th>难度</th><th>状态</th><th></th></tr></thead>
        <tbody>${visible.map((word) => `
          <tr data-edit="${word.id}">
            <td><input class="checkbox row-check" type="checkbox" value="${word.id}" ${state.selected.has(word.id) ? "checked" : ""} aria-label="选择 ${escapeHtml(word.term)}" /></td>
            <td class="term-cell"><strong>${escapeHtml(word.term)}</strong><small>${escapeHtml(word.reading || "—")}</small></td>
            <td><span class="badge">${escapeHtml(word.partOfSpeech?.category || "未分类")}</span></td>
            <td>${escapeHtml(word.meanings?.join("；") || "—")}</td>
            <td><span class="badge ${word.jlpt !== "未定" ? "green" : ""}">${escapeHtml(word.jlpt)}</span></td>
            <td><span class="badge ${state.enrichingIds.has(word.id) ? "accent" : wordComplete(word) ? "green" : "accent"}">${state.enrichingIds.has(word.id) ? "后台生成中" : wordComplete(word) ? "完整" : "待补"}</span></td>
            <td><div class="row-actions"><button class="icon-btn delete-one" data-id="${word.id}" aria-label="删除 ${escapeHtml(word.term)}">×</button></div></td>
          </tr>`).join("")}</tbody>
      </table>
      ${visible.length ? `<div class="pagination">${Array.from({ length: Math.min(pageCount, 7) }, (_, i) => i + 1).map((page) => `<button class="page-btn ${page === state.page ? "active" : ""}" data-page="${page}">${page}</button>`).join("")}${pageCount > 7 ? `<span>… ${pageCount}</span>` : ""}</div>` : `<div class="empty-state"><div><strong>没有符合条件的词</strong><p>试试清除筛选条件，或收录一个新词。</p></div></div>`}
    </section>`;

  bindFilters();
  bindCommonActions();
  document.querySelectorAll(".row-check").forEach((box) => box.addEventListener("click", (event) => {
    event.stopPropagation();
    box.checked ? state.selected.add(box.value) : state.selected.delete(box.value);
    renderManage();
  }));
  document.querySelector("#select-page")?.addEventListener("click", (event) => {
    visible.forEach((word) => event.target.checked ? state.selected.add(word.id) : state.selected.delete(word.id));
    renderManage();
  });
  document.querySelectorAll(".delete-one").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    askDelete([button.dataset.id]);
  }));
  document.querySelector("#bulk-delete")?.addEventListener("click", () => askDelete([...state.selected]));
  document.querySelector("#enrich-all")?.addEventListener("click", askEnrichAll);
  document.querySelector("#bulk-enrich")?.addEventListener("click", () => runBatchEnrichment([...state.selected]));
  document.querySelector("#make-collection")?.addEventListener("click", () => openCollectionDialog([...state.selected]));
  document.querySelectorAll(".page-btn").forEach((button) => button.addEventListener("click", () => { state.page = Number(button.dataset.page); renderManage(); window.scrollTo({ top: 0, behavior: "smooth" }); }));
}

function bindFilters() {
  let timer;
  document.querySelector("#filter-query").addEventListener("input", (event) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.filters.query = event.target.value; state.page = 1; renderManage(); document.querySelector("#filter-query")?.focus(); }, 180);
  });
  [["#filter-category", "category"], ["#filter-jlpt", "jlpt"], ["#filter-status", "status"]].forEach(([selector, key]) => {
    document.querySelector(selector).addEventListener("change", (event) => { state.filters[key] = event.target.value; state.page = 1; renderManage(); });
  });
  document.querySelector("#reset-filters").addEventListener("click", () => { state.filters = { query: "", category: "", jlpt: "", collection: "", status: "" }; state.page = 1; renderManage(); });
}

function renderCollections() {
  app.innerHTML = `
    <div class="section-head"><div><h2>我的子词库</h2><p>子词库只保存词条引用，同一个词可以同时属于多个主题。</p></div><button class="primary-btn" id="new-collection">＋ 新建子词库</button></div>
    <section class="collection-grid">
      ${state.collections.map((collection) => `
        <article class="card collection-card" data-collection="${collection.id}">
          <div class="collection-top"><span class="collection-dot" style="background:${escapeHtml(collection.color)}"></span><button class="icon-btn delete-collection" data-id="${collection.id}" aria-label="删除子词库">×</button></div>
          <h3>${escapeHtml(collection.name)}</h3><p>${escapeHtml(collection.description || "没有描述")}</p>
          <footer><span>${collection.wordIds.length} 个词</span><span>打开 →</span></footer>
        </article>`).join("")}
      <button class="card new-collection" id="new-collection-card"><div><strong>＋</strong><span>创建主题词库</span></div></button>
    </section>`;
  document.querySelectorAll("[data-collection]").forEach((card) => card.addEventListener("click", () => { state.filters.collection = card.dataset.collection; state.view = "manage"; setView("manage"); }));
  document.querySelectorAll(".delete-collection").forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation();
    try { await api(`/api/collections/${button.dataset.id}`, { method: "DELETE" }); state.collections = state.collections.filter((item) => item.id !== button.dataset.id); renderCollections(); toast("子词库已删除，原词条不受影响"); } catch (error) { toast(error.message, "error"); }
  }));
  document.querySelector("#new-collection").addEventListener("click", () => openCollectionDialog([]));
  document.querySelector("#new-collection-card").addEventListener("click", () => openCollectionDialog([]));
}

function renderSettings() {
  const settings = state.settings;
  const active = settings.aiProvider;
  const deepseek = settings.providers.deepseek;
  const opencode = settings.providers["opencode-go"];
  const theme = localStorage.theme || "system";
  app.innerHTML = `
    <div class="settings-layout">
      <section class="card card-pad">
        <form id="settings-form" data-provider="${active}">
          <div class="settings-section">
            <div class="section-head"><div><h2>AI 提供方</h2><p>切换后，单词补全与批处理都会使用所选服务。</p></div><span class="badge ${aiConfigured() ? "green" : "accent"}">${aiConfigured() ? "密钥已配置" : "需要密钥"}</span></div>
            <div class="provider-tabs">
              <button type="button" class="provider-option ${active === "deepseek" ? "active" : ""}" data-provider="deepseek"><strong>DeepSeek 官方</strong><small>deepseek-v4-flash</small></button>
              <button type="button" class="provider-option ${active === "opencode-go" ? "active" : ""}" data-provider="opencode-go"><strong>OpenCode Go</strong><small>DeepSeek V4.1 Flash</small></button>
            </div>
            <div class="provider-fields" data-provider-fields="deepseek" ${active === "deepseek" ? "" : "hidden"}>
              <div class="form-grid">
                <div class="field full"><label>API Base URL</label><input class="input" name="deepseekBaseUrl" value="${escapeHtml(deepseek.baseUrl)}" /></div>
                <div class="field"><label>模型 ID</label><input class="input" name="deepseekModel" value="${escapeHtml(deepseek.model)}" /></div>
                <div class="field"><label>API Key <span class="key-state">${settings.keyConfigured.deepseek ? "已保存；留空不修改" : "尚未保存"}</span></label><input class="input" type="password" name="deepseekKey" autocomplete="new-password" placeholder="sk-…" /></div>
                ${settings.keyConfigured.deepseek ? `<label class="checkbox-line full"><input type="checkbox" name="clearDeepseekKey" /> 清除已保存的 DeepSeek 密钥</label>` : ""}
              </div>
            </div>
            <div class="provider-fields" data-provider-fields="opencode-go" ${active === "opencode-go" ? "" : "hidden"}>
              <div class="form-grid">
                <div class="field full"><label>API Base URL</label><input class="input" name="opencodeBaseUrl" value="${escapeHtml(opencode.baseUrl)}" /></div>
                <div class="field"><label>模型 ID</label><input class="input" name="opencodeModel" value="${escapeHtml(opencode.model)}" /></div>
                <div class="field"><label>OpenCode Go API Key <span class="key-state">${settings.keyConfigured["opencode-go"] ? "已保存；留空不修改" : "尚未保存"}</span></label><input class="input" type="password" name="opencodeKey" autocomplete="new-password" placeholder="OpenCode Zen 密钥" /></div>
                ${settings.keyConfigured["opencode-go"] ? `<label class="checkbox-line full"><input type="checkbox" name="clearOpencodeKey" /> 清除已保存的 OpenCode Go 密钥</label>` : ""}
              </div>
              <div class="settings-note" style="margin-top:14px"><strong>OpenCode Go 使用提醒</strong>其官方手册说明 Go 面向 OpenCode 与编程 Agent，并要求自定义 User-Agent 和 x-opencode-session。本平台已为每个单词生成独立会话 ID，但词典补全是否符合你的订阅使用范围，请以 OpenCode 当前条款为准。</div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-head"><div><h2>生成偏好</h2><p>控制单词请求的内容量与同时运行数量。</p></div></div>
            <div class="form-grid">
              <div class="field"><label>主例句数量</label><select class="select" name="exampleCount">${[1,2,3,4,5].map((n) => `<option value="${n}" ${settings.exampleCount === n ? "selected" : ""}>${n} 个</option>`).join("")}</select></div>
              <div class="field"><label>并发处理数</label><input class="input" type="number" name="concurrency" value="${settings.concurrency}" min="1" max="50" step="1" inputmode="numeric" required /><small>可直接输入 1～50；OpenCode Go 未公布固定并发上限，建议先使用 3～5。</small></div>
              <div class="field"><label>单次生成超时（秒）</label><input class="input" type="number" name="requestTimeoutSeconds" value="${settings.requestTimeoutSeconds}" min="10" max="600" step="1" inputmode="numeric" required /><small>可输入 10～600 秒；复杂词条开启思考时建议 120 秒。</small></div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-head"><div><h2>外观</h2><p>主题偏好只保存在当前浏览器。</p></div></div>
            <label class="field"><span>颜色模式</span><select class="select" name="theme"><option value="system" ${theme === "system" ? "selected" : ""}>跟随系统</option><option value="light" ${theme === "light" ? "selected" : ""}>浅色</option><option value="dark" ${theme === "dark" ? "selected" : ""}>深色</option></select></label>
          </div>
          <div class="form-actions"><button class="primary-btn" type="submit">保存全部设置</button></div>
        </form>
      </section>

      <aside class="stack">
        <article class="card card-pad"><div class="section-head"><div><h2>当前运行配置</h2><p>所有 AI 功能共享这一配置</p></div></div><p><span class="badge accent">提供方</span> ${escapeHtml(activeProvider().label)}</p><p><span class="badge">模型</span> ${escapeHtml(activeProvider().model)}</p><p><span class="badge">并发</span> ${settings.concurrency} 个独立会话</p><p><span class="badge">超时</span> 每个词 ${settings.requestTimeoutSeconds} 秒</p></article>
        <div class="settings-note"><strong>密钥不会同步到 GitHub</strong>在设置页保存的密钥写入 <code>data/.secrets.json</code>，该文件已被 Git 忽略。另一台电脑需要单独配置。</div>
      </aside>
    </div>`;

  document.querySelectorAll(".provider-option").forEach((button) => button.addEventListener("click", () => {
    document.querySelector("#settings-form").dataset.provider = button.dataset.provider;
    document.querySelectorAll(".provider-option").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll("[data-provider-fields]").forEach((item) => { item.hidden = item.dataset.providerFields !== button.dataset.provider; });
  }));
  document.querySelector("[name=theme]").addEventListener("change", (event) => applyTheme(event.target.value));
  document.querySelector("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await updateSettings({
        aiProvider: form.dataset.provider,
        exampleCount: Number(data.get("exampleCount")),
        concurrency: Number(data.get("concurrency")),
        requestTimeoutSeconds: Number(data.get("requestTimeoutSeconds")),
        providers: {
          deepseek: { baseUrl: data.get("deepseekBaseUrl"), model: data.get("deepseekModel") },
          "opencode-go": { baseUrl: data.get("opencodeBaseUrl"), model: data.get("opencodeModel") },
        },
        apiKeys: { deepseek: data.get("deepseekKey"), "opencode-go": data.get("opencodeKey") },
        clearKeys: { deepseek: data.get("clearDeepseekKey") === "on", "opencode-go": data.get("clearOpencodeKey") === "on" },
      });
      applyTheme(data.get("theme"));
      updateAiIndicator();
      toast("设置已保存");
      renderSettings();
    } catch (error) { toast(error.message, "error"); }
  });
}

async function updateSettings(patch) {
  const { settings } = await api("/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
  state.settings = settings;
  return settings;
}

function renderReserved(view) {
  const isLearn = view === "learn";
  app.innerHTML = `<section class="reserved"><div class="orb">${isLearn ? "憶" : "試"}</div><span class="badge accent">开发接口已预留</span><h2>${isLearn ? "记忆练习" : "考核测试"}</h2><p>${isLearn ? "后续可在这里接入间隔重复、抽认卡、听音选词等学习模式。现有词条 ID 与字段结构保持稳定，可直接复用。" : "后续可按词性、JLPT、子词库生成选择题、拼写题与活用题，并把成绩独立记录，不污染词库内容。"}</p><button class="secondary-btn" data-go="home">返回概览</button></section>`;
  bindCommonActions();
}

function bindCommonActions() {
  document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.go)));
  document.querySelectorAll("[data-edit]").forEach((node) => node.addEventListener("click", (event) => { if (!event.target.closest("button,input")) openWordDialog(node.dataset.edit); }));
}

function openWordDialog(id) {
  const word = state.words.find((item) => item.id === id);
  if (!word) return;
  const conjugations = word.conjugations || [];
  const examples = word.examples || [];
  const isBlank = wordIsBlank(word);
  const isEnriching = state.enrichingIds.has(id);
  wordDialog.innerHTML = `
    <form method="dialog" id="word-form">
      <div class="dialog-head"><div><h2>${escapeHtml(word.term)}</h2><p>${isEnriching ? "AI 正在后台补全；仍可查看和保存手动修改" : "编辑词条详情 · 保存后写入 JSON 词库"}</p></div><button class="icon-btn" value="cancel" aria-label="关闭">×</button></div>
      <div class="dialog-body">
        <div class="form-grid">
          <div class="field"><label>词条</label><input class="input" name="term" value="${escapeHtml(word.term)}" required /></div>
          <div class="field"><div class="field-title"><label>假名读音</label><button class="clear-link" type="button" data-clear="reading">清空</button></div><input class="input" name="reading" value="${escapeHtml(word.reading)}" /></div>
          <div class="field"><label>分类</label><select class="select" name="category">${categoryOptions(word.partOfSpeech?.category)}</select></div>
          <div class="field"><label>词性细分</label><input class="input" name="detail" value="${escapeHtml(word.partOfSpeech?.detail)}" placeholder="例如：五段动词 / い形容词" /></div>
          <div class="field"><label>活用类型</label><input class="input" name="conjugationClass" value="${escapeHtml(word.partOfSpeech?.conjugationClass)}" placeholder="一段、五段、不规则" /></div>
          <div class="field"><label>自他动</label><select class="select" name="transitivity"><option value="">不适用 / 未定</option>${["自动词", "他动词", "自动词・他动词两用"].map((item) => `<option ${word.partOfSpeech?.transitivity === item ? "selected" : ""}>${item}</option>`).join("")}</select></div>
          <div class="field"><div class="field-title"><label>JLPT 难度</label><button class="clear-link" type="button" data-reset="jlpt">重置</button></div><select class="select" name="jlpt">${jlptOptions(word.jlpt)}</select></div>
          <div class="field"><div class="field-title"><label>标签</label><button class="clear-link" type="button" data-clear="tags">清空</button></div><input class="input" name="tags" value="${escapeHtml((word.tags || []).join("、"))}" placeholder="口语、书面语、易混淆" /></div>
          <div class="field full"><div class="field-title"><label>中文释义（每行一个）</label><button class="clear-link" type="button" data-clear="meanings">清空</button></div><textarea class="textarea" name="meanings">${escapeHtml((word.meanings || []).join("\n"))}</textarea></div>
          <div class="field full"><label>个人笔记</label><textarea class="textarea" name="notes">${escapeHtml(word.notes)}</textarea></div>
        </div>
        <div class="ai-field-panel"><p>选择需要重新生成的部分。生成前会先保存当前编辑和清空操作。</p><div class="check-grid">${[["reading","读音"],["partOfSpeech","词性"],["meanings","释义"],["jlpt","JLPT"],["tags","标签"],["examples","主例句"],["conjugations","活用"]].map(([value,label]) => `<label class="check-chip"><input class="checkbox regen-field" type="checkbox" value="${value}" />${label}</label>`).join("")}</div></div>
        <div class="subhead"><h3>主例句 · 建议 ${state.settings.exampleCount} 个</h3><div><button type="button" class="clear-link" id="clear-examples">清空全部</button> <button type="button" class="secondary-btn small-btn" id="add-example">＋ 例句</button></div></div>
        <div class="example-list" id="example-list">${examples.map(exampleRow).join("")}</div>
        <div class="subhead"><h3>活用与例句</h3><div><button type="button" class="clear-link" id="clear-conjugations">清空全部</button> <button type="button" class="secondary-btn small-btn" id="add-conjugation">＋ 活用</button></div></div>
        <div class="conj-list" id="conj-list">${conjugations.map(conjugationRow).join("")}</div>
      </div>
      <div class="dialog-footer"><button type="button" class="ghost-btn" id="delete-current">删除词条</button><div><button type="button" class="secondary-btn" id="enrich-selected" ${isEnriching ? "disabled" : ""}>重生成所选</button><button type="button" class="secondary-btn" id="enrich-current" ${isEnriching ? "disabled" : ""}>${isEnriching ? "后台生成中…" : "补全缺失项"}</button><button type="button" class="${isBlank ? "primary-btn" : "danger-btn"}" id="regenerate-all" ${isEnriching ? "disabled" : ""}>${isBlank ? "开始生成词条" : "全部重生成"}</button><button type="submit" class="primary-btn">保存修改</button></div></div>
    </form>`;
  wordDialog.showModal();

  document.querySelector("#add-example").addEventListener("click", () => { document.querySelector("#example-list").insertAdjacentHTML("beforeend", exampleRow({ japanese: "", chinese: "" })); bindRubyPreviews(); });
  document.querySelector("#add-conjugation").addEventListener("click", () => { document.querySelector("#conj-list").insertAdjacentHTML("beforeend", conjugationRow({ name: "", form: "", example: "", exampleChinese: "" })); bindRubyPreviews(); });
  document.querySelector("#clear-examples").addEventListener("click", () => { document.querySelector("#example-list").innerHTML = ""; });
  document.querySelector("#clear-conjugations").addEventListener("click", () => { document.querySelector("#conj-list").innerHTML = ""; });
  document.querySelectorAll("[data-clear]").forEach((button) => button.addEventListener("click", () => { document.querySelector(`[name=${button.dataset.clear}]`).value = ""; }));
  document.querySelectorAll("[data-reset]").forEach((button) => button.addEventListener("click", () => { document.querySelector(`[name=${button.dataset.reset}]`).value = "未定"; }));
  wordDialog.addEventListener("click", removeRowHandler);
  bindRubyPreviews();
  document.querySelector("#delete-current").addEventListener("click", () => { wordDialog.close(); askDelete([id]); });
  document.querySelector("#enrich-current").addEventListener("click", (event) => runWordEnrichment(id, "missing", [], event.target));
  document.querySelector("#enrich-selected").addEventListener("click", (event) => {
    const fields = [...document.querySelectorAll(".regen-field:checked")].map((input) => input.value);
    if (!fields.length) return toast("请先选择至少一个要重新生成的项目", "error");
    runWordEnrichment(id, "fields", fields, event.target);
  });
  document.querySelector("#regenerate-all").addEventListener("click", (event) => {
    if (isBlank) runWordEnrichment(id, "replace", [], event.target);
    else askRegenerateAll(id);
  });
  document.querySelector("#word-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveDialogForm(id, true);
  });
}

function lines(value) { return String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
function exampleRow(item = {}) {
  return `<div class="example-row"><textarea class="textarea ruby-source" name="exampleJapanese" placeholder="日语例句（可含 ruby 注音）">${escapeHtml(item.japanese)}</textarea><textarea class="textarea" name="exampleChinese" placeholder="中文翻译">${escapeHtml(item.chinese)}</textarea><button class="icon-btn remove-row" type="button" aria-label="删除例句">×</button><div class="ruby-render">${rubyHtml(item.japanese)}</div></div>`;
}
function conjugationRow(item = {}) {
  return `<div class="conj-row"><select class="select" name="conjName"><option value="">活用名称</option>${state.options.conjugations.map((name) => `<option ${name === item.name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select><input class="input" name="conjForm" value="${escapeHtml(item.form)}" placeholder="变形结果" /><textarea class="textarea ruby-source" name="conjExample" placeholder="日语例句（带 ruby 注音）">${escapeHtml(item.example)}</textarea><textarea class="textarea" name="conjExampleChinese" placeholder="例句中文翻译">${escapeHtml(item.exampleChinese)}</textarea><button class="icon-btn remove-row" type="button" aria-label="删除活用">×</button><div class="ruby-render">${rubyHtml(item.example)}</div></div>`;
}
function removeRowHandler(event) { if (event.target.closest(".remove-row")) event.target.closest(".example-row,.conj-row").remove(); }
function replaceWord(word) { const index = state.words.findIndex((item) => item.id === word.id); if (index >= 0) state.words[index] = word; }

function bindRubyPreviews() {
  document.querySelectorAll(".ruby-source").forEach((source) => {
    if (source.dataset.previewBound) return;
    source.dataset.previewBound = "true";
    const preview = source.closest(".example-row,.conj-row").querySelector(".ruby-render");
    source.addEventListener("input", () => { preview.innerHTML = rubyHtml(source.value); });
  });
}

function collectWordForm() {
  const data = new FormData(document.querySelector("#word-form"));
  return {
    term: data.get("term"), reading: data.get("reading"), jlpt: data.get("jlpt"), notes: data.get("notes"),
    meanings: lines(data.get("meanings")), tags: String(data.get("tags") || "").split(/[、,，]/).map((item) => item.trim()).filter(Boolean),
    partOfSpeech: { category: data.get("category"), detail: data.get("detail"), conjugationClass: data.get("conjugationClass"), transitivity: data.get("transitivity") },
    examples: [...document.querySelectorAll(".example-row")].map((row) => ({ japanese: row.querySelector("[name=exampleJapanese]").value.replace(/\\([<>])/g, "$1"), chinese: row.querySelector("[name=exampleChinese]").value })).filter((item) => item.japanese || item.chinese),
    conjugations: [...document.querySelectorAll(".conj-row")].map((row) => ({ name: row.querySelector("[name=conjName]").value, form: row.querySelector("[name=conjForm]").value, example: row.querySelector("[name=conjExample]").value.replace(/\\([<>])/g, "$1"), exampleChinese: row.querySelector("[name=conjExampleChinese]").value })).filter((item) => item.name || item.form || item.example || item.exampleChinese),
  };
}

async function saveDialogForm(id, close = false) {
  try {
    const { word: updated } = await api(`/api/words/${id}`, { method: "PATCH", body: JSON.stringify(collectWordForm()) });
    replaceWord(updated);
    if (close) { wordDialog.close(); toast("词条已更新"); render(); }
    return updated;
  } catch (error) { if (close) toast(error.message, "error"); throw error; }
}

async function runWordEnrichment(id, mode, fields, button) {
  if (!aiConfigured()) return toast(`请先在设置页配置 ${activeProvider().label} API Key`, "error");
  if (state.enrichingIds.has(id)) return toast("这个词条已在后台生成，请稍候", "error");
  const oldText = button.textContent;
  button.disabled = true; button.textContent = "正在生成…";
  try {
    await saveDialogForm(id, false);
    state.enrichingIds.add(id);
    wordDialog.close();
    render();
    toast("已转入后台生成，可以继续查看或修改其他词条");
    const { word: updated } = await api(`/api/words/${id}/enrich`, { method: "POST", body: JSON.stringify({ exampleCount: state.settings.exampleCount, mode, fields }) });
    replaceWord(updated);
    toast(mode === "missing" ? "后台补全已完成" : "后台重新生成已完成");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.enrichingIds.delete(id);
    if (wordDialog.open && button.isConnected) { button.disabled = false; button.textContent = oldText; }
    render();
  }
}

function askRegenerateAll(id) {
  confirmDialog.innerHTML = `<div class="dialog-body"><h2>重新生成全部词典信息？</h2><p>读音、词性、释义、JLPT、标签、主例句和活用将被新结果替换。词条名称与个人笔记会保留。</p></div><div class="dialog-footer"><span></span><div><button class="secondary-btn" id="cancel-regenerate">取消</button><button class="danger-btn" id="confirm-regenerate">确认重生成</button></div></div>`;
  confirmDialog.showModal();
  document.querySelector("#cancel-regenerate").addEventListener("click", () => confirmDialog.close());
  document.querySelector("#confirm-regenerate").addEventListener("click", () => {
    confirmDialog.close();
    runWordEnrichment(id, "replace", [], document.querySelector("#regenerate-all"));
  });
}

async function runBatchEnrichment(ids) {
  if (!ids.length) return;
  if (state.batchRunning) return toast("已有批量补全任务正在运行", "error");
  if (!aiConfigured()) return toast(`请先在设置页配置 ${activeProvider().label} API Key`, "error");
  state.batchRunning = true;
  const batchController = new AbortController();
  state.batchAbortController = batchController;
  document.querySelector(".batch-progress")?.remove();
  const panel = document.createElement("div");
  panel.className = "batch-progress";
  panel.innerHTML = `<div class="batch-progress-head"><strong>正在并行处理</strong><span id="batch-count">0 / ${ids.length}</span></div><div class="progress"><span id="batch-bar" style="width:0"></span></div><div class="progress-label"><span>${escapeHtml(activeProvider().label)} · ${escapeHtml(activeProvider().model)} · 单次最长 ${state.settings.requestTimeoutSeconds} 秒</span><span>并发 ${state.settings.concurrency} <button class="ghost-btn small-btn" id="stop-batch" type="button">停止</button></span></div>`;
  document.body.append(panel);
  let stopped = false;
  panel.querySelector("#stop-batch").addEventListener("click", () => {
    stopped = true;
    batchController.abort();
    panel.querySelector("#stop-batch").disabled = true;
    panel.querySelector("#stop-batch").textContent = "正在停止…";
  });

  let cursor = 0;
  let completed = 0;
  let failed = 0;
  const runWorker = async () => {
    while (!stopped && cursor < ids.length) {
      const id = ids[cursor++];
      try {
        // 每个词单独调用后端；后端又为 OpenCode Go 分配独立 x-opencode-session。
        const { word } = await api(`/api/words/${id}/enrich`, { method: "POST", signal: batchController.signal, body: JSON.stringify({ exampleCount: state.settings.exampleCount, mode: "missing", fields: [] }) });
        replaceWord(word);
      } catch (error) { if (error.name !== "AbortError") failed += 1; }
      completed += 1;
      panel.querySelector("#batch-count").textContent = `${completed} / ${ids.length}`;
      panel.querySelector("#batch-bar").style.width = `${completed / ids.length * 100}%`;
    }
  };
  const workerCount = Math.min(state.settings.concurrency, ids.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  state.batchRunning = false;
  state.batchAbortController = null;
  panel.remove();
  if (state.view === "manage") renderManage(); else render();
  if (stopped) toast(`批处理已停止：已处理 ${completed} / ${ids.length}`, "error");
  else toast(failed ? `批处理完成：成功 ${ids.length - failed}，失败 ${failed}` : `已完成 ${ids.length} 个独立单词请求`, failed ? "error" : "success");
}

function askEnrichAll() {
  if (!aiConfigured()) return toast(`请先在设置页配置 ${activeProvider().label} API Key`, "error");
  const pendingIds = state.words.filter(wordNeedsEnrichment).map((word) => word.id);
  const skipped = state.words.length - pendingIds.length;
  if (!pendingIds.length) return toast("全部词条都已完整，无需补全");
  confirmDialog.innerHTML = `<div class="dialog-body"><h2>补全全部词条？</h2><p>将使用 ${escapeHtml(activeProvider().label)} · ${escapeHtml(activeProvider().model)}，以 ${state.settings.concurrency} 路并发处理 ${pendingIds.length} 个存在缺失项的词条。${skipped ? `另有 ${skipped} 个完整词条会自动跳过。` : ""}</p><p>每个词条都是独立模型请求，会分别消耗额度；普通补全不会覆盖已有人工内容。</p></div><div class="dialog-footer"><span></span><div><button class="secondary-btn" id="cancel-enrich-all">取消</button><button class="primary-btn" id="confirm-enrich-all">开始补全</button></div></div>`;
  confirmDialog.showModal();
  document.querySelector("#cancel-enrich-all").addEventListener("click", () => confirmDialog.close());
  document.querySelector("#confirm-enrich-all").addEventListener("click", () => {
    confirmDialog.close();
    runBatchEnrichment(pendingIds);
  });
}

function askDelete(ids) {
  const names = state.words.filter((word) => ids.includes(word.id)).slice(0, 3).map((word) => word.term).join("、");
  confirmDialog.innerHTML = `<div class="dialog-body"><h2>确认删除 ${ids.length} 个词条？</h2><p>${escapeHtml(names)}${ids.length > 3 ? " 等" : ""} 将从主词库和所有子词库移除。此操作会写入 JSON 文件，提交 Git 前仍可通过版本控制恢复。</p></div><div class="dialog-footer"><span></span><div><button class="secondary-btn" id="cancel-delete">取消</button><button class="danger-btn" id="confirm-delete">确认删除</button></div></div>`;
  confirmDialog.showModal();
  document.querySelector("#cancel-delete").addEventListener("click", () => confirmDialog.close());
  document.querySelector("#confirm-delete").addEventListener("click", async () => {
    try {
      await Promise.all(ids.map((id) => api(`/api/words/${id}`, { method: "DELETE" })));
      state.words = state.words.filter((word) => !ids.includes(word.id));
      state.collections = state.collections.map((collection) => ({ ...collection, wordIds: collection.wordIds.filter((id) => !ids.includes(id)) }));
      ids.forEach((id) => state.selected.delete(id)); confirmDialog.close(); render(); toast("词条已删除");
    } catch (error) { toast(error.message, "error"); }
  });
}

function openCollectionDialog(wordIds) {
  collectionDialog.innerHTML = `<form id="collection-form"><div class="dialog-head"><div><h2>新建子词库</h2><p>已选择 ${wordIds.length} 个词条，可稍后继续添加</p></div><button class="icon-btn" type="button" id="close-collection">×</button></div><div class="dialog-body"><div class="form-grid"><div class="field full"><label>名称 *</label><input class="input" name="name" placeholder="例如：动画常用表达" required autofocus /></div><div class="field full"><label>说明</label><textarea class="textarea" name="description" placeholder="这个词库的学习目标或来源"></textarea></div><div class="field"><label>标记颜色</label><input class="input" name="color" type="color" value="#d65432" /></div></div></div><div class="dialog-footer"><span></span><div><button class="secondary-btn" type="button" id="cancel-collection">取消</button><button class="primary-btn" type="submit">创建词库</button></div></div></form>`;
  collectionDialog.showModal();
  ["#close-collection", "#cancel-collection"].forEach((selector) => document.querySelector(selector).addEventListener("click", () => collectionDialog.close()));
  document.querySelector("#collection-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    try {
      const { collection } = await api("/api/collections", { method: "POST", body: JSON.stringify({ name: data.get("name"), description: data.get("description"), color: data.get("color"), wordIds }) });
      state.collections.push(collection); state.selected.clear(); collectionDialog.close(); toast("子词库已创建"); if (state.view === "collections") renderCollections(); else renderManage();
    } catch (error) { toast(error.message, "error"); }
  });
}

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const tools = [
    {
      name: "search_vocabulary", title: "搜索日语词库", description: "按日语词、读音、中文释义或标签搜索当前个人词库。",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: ({ query }) => state.words.filter((word) => normalize([word.term, word.reading, ...(word.meanings || [])].join(" ")).includes(normalize(query))).slice(0, 20).map(({ id, term, reading, meanings, jlpt }) => ({ id, term, reading, meanings, jlpt })),
    },
    {
      name: "add_vocabulary_word", title: "添加日语词条", description: "检查重复后，把一个新日语词或语法结构写入个人词库。",
      inputSchema: { type: "object", properties: { term: { type: "string" }, reading: { type: "string" }, meaning: { type: "string" } }, required: ["term"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute({ term, reading = "", meaning = "" }) {
        const duplicate = state.words.find((word) => normalize(word.term) === normalize(term));
        if (duplicate) return { created: false, reason: "duplicate", word: { id: duplicate.id, term: duplicate.term } };
        const { word } = await api("/api/words", { method: "POST", body: JSON.stringify({ term, reading, meanings: meaning ? [meaning] : [] }) });
        state.words.unshift(word); render(); return { created: true, word: { id: word.id, term: word.term } };
      },
    },
  ];
  tools.forEach((tool) => { try { Promise.resolve(context.registerTool(tool)).catch(() => {}); } catch {} });
}

async function init() {
  try {
    const payload = await api("/api/bootstrap");
    state.words = payload.library.words;
    state.collections = payload.collections;
    state.options = payload.options;
    state.settings = payload.settings;
    updateAiIndicator();
    setView(state.view);
    registerWebMcpTools();
  } catch (error) {
    app.innerHTML = `<div class="card empty-state"><div><strong>词库暂时无法读取</strong><p>${escapeHtml(error.message)}。请确认本地服务已经启动。</p></div></div>`;
  }
}

function updateAiIndicator() {
  const ai = document.querySelector("#ai-state");
  const provider = activeProvider();
  ai.classList.toggle("online", aiConfigured());
  ai.title = aiConfigured() ? `${provider.label} · ${provider.model} 已配置` : `${provider.label} 尚未配置密钥`;
  ai.querySelector("span").textContent = provider.label;
}

document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
document.querySelector(".mobile-menu").addEventListener("click", () => document.querySelector(".sidebar").classList.toggle("open"));
document.querySelector("#theme-toggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
window.addEventListener("hashchange", () => { const next = location.hash.slice(1); if (next && next !== state.view) setView(next); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if ((localStorage.theme || "system") === "system") applyTheme("system"); });
applyTheme();
init();
