/**
 * @file app.js
 * @description 前端交互控制器；管理词库、随机学习、AI 单选试题与记忆水平反馈。
 */

const state = {
  words: [],
  collections: [],
  options: { conjugations: [] },
  quizProgress: { words: {} },
  settings: {
    aiProvider: "deepseek", exampleCount: 2, concurrency: 3, requestTimeoutSeconds: 60, quizPrefetchCount: 2, learningAutoFlipSeconds: 60,
    practiceJlptLevels: ["N5", "N4", "N3", "N2", "N1"],
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
  // 随机学习牌组只保存词条 ID，词条编辑后仍能读取最新内容。
  learning: { wordIds: [], index: 0, autoPlay: false, timer: null },
  // 单题状态保留在页面切换之间；正确答案只会在服务端判分后进入 result。
  quiz: {
    status: "idle", type: "all", question: null, result: null, selectedOptionId: "", answered: 0, correct: 0,
    reserveQuestions: [], prefetching: 0, generationEpoch: 0, prefetchError: "",
  },
};

const app = document.querySelector("#app");
const wordDialog = document.querySelector("#word-dialog");
const confirmDialog = document.querySelector("#confirm-dialog");
const collectionDialog = document.querySelector("#collection-dialog");
const pageTitles = {
  home: ["学习概览"],
  add: ["快速收录"],
  manage: ["词库管理"],
  collections: ["子词库"],
  settings: ["平台设置"],
  learn: ["随机单词"],
  quiz: ["单词试题"],
};

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const rubyHtml = (value = "") => escapeHtml(String(value).replace(/\\([<>])/g, "$1"))
  .replace(/&lt;(\/?)ruby&gt;/gi, "<$1ruby>")
  .replace(/&lt;(\/?)rt&gt;/gi, "<$1rt>");

/**
 * @description 从带 Ruby 注音的例句中提取日文原文，复制时排除 rt 内的假名。
 */
function japaneseOriginalText(value = "") {
  const container = document.createElement("div");
  container.innerHTML = rubyHtml(value);
  container.querySelectorAll("rt").forEach((annotation) => annotation.remove());
  return container.textContent.trim();
}

/**
 * @description 写入系统剪贴板，并为不支持 Clipboard API 的浏览器提供兼容方案。
 */
async function copyTextToClipboard(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // 剪贴板权限被拒绝时继续尝试传统复制方案。
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("浏览器未允许访问剪贴板");
}
const validJlpt = (value) => ["N5", "N4", "N3", "N2", "N1", "不适用"].includes(value);
const missingWordFields = (word) => [
  !word.reading && "读音",
  !word.meanings?.length && "释义",
  (!word.partOfSpeech?.category || word.partOfSpeech.category === "未分类") && "词性",
  !validJlpt(word.jlpt) && "JLPT",
  !word.examples?.length && "例句",
  (["动词", "形容词"].includes(word.partOfSpeech?.category) && !word.conjugations?.length) && "活用",
].filter(Boolean);
const wordComplete = (word) => missingWordFields(word).length === 0;
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
const wordNeedsEnrichment = (word) => !wordComplete(word);
// 随机学习与未来考核共用同一准入规则，确保设置中的等级范围始终一致生效。
const wordEligibleForPractice = (word) => word.studyStatus !== "paused"
  && (state.settings.practiceJlptLevels || []).includes(word.jlpt);
const memoryEligibleWords = () => state.words.filter(wordEligibleForPractice);
const quizEligibleWords = () => state.words.filter(wordEligibleForPractice);
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
  const { timeoutMs = (url.includes("/enrich") || url.includes("/quiz/generate")) ? enrichmentTimeoutMs : 15_000, ...fetchOptions } = options;
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
  // 离开学习页时停止计时，避免在后台继续自动翻页。
  if (state.view === "learn" && view !== "learn") stopLearningAutoPlay();
  state.view = pageTitles[view] ? view : "home";
  location.hash = state.view;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === state.view));
  const [title] = pageTitles[state.view];
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
  else if (state.view === "learn") renderLearn();
  else if (state.view === "quiz") renderQuiz();
  else renderReserved(state.view);
}

/**
 * @description 按记忆薄弱程度生成加权且无重复的随机学习顺序。
 */
function shuffleLearningWords() {
  // 加权无放回排序：薄弱和未练习词更可能排在牌组前方，同时保证每轮不重复。
  state.learning.wordIds = memoryEligibleWords()
    .map((word) => {
      const progress = state.quizProgress.words[word.id] || {};
      const level = Number.isFinite(Number(progress.level)) ? Number(progress.level) : 50;
      const weakness = (100 - level) / 100;
      const weight = 1 + weakness * weakness * 5 + (!progress.attempts ? 2 : 0);
      return { id: word.id, key: Math.pow(Math.random(), 1 / weight) };
    })
    .sort((left, right) => right.key - left.key)
    .map((item) => item.id);
  state.learning.index = 0;
}

function renderLearn() {
  clearTimeout(state.learning.timer);
  state.learning.timer = null;
  const learnableWords = memoryEligibleWords();
  const availableIds = new Set(learnableWords.map((word) => word.id));
  const deckIsCurrent = state.learning.wordIds.length === learnableWords.length
    && state.learning.wordIds.every((id) => availableIds.has(id));
  if (!deckIsCurrent) shuffleLearningWords();

  const { wordIds, index } = state.learning;
  const word = state.words.find((item) => item.id === wordIds[index]);
  if (!word) {
    const hasWords = state.words.length > 0;
    const noLevelSelected = !(state.settings.practiceJlptLevels || []).length;
    const emptyReason = noLevelSelected
      ? "当前没有勾选任何练习等级，请先到设置中选择至少一个 JLPT 等级。"
      : "当前等级范围内没有可学习的词条；你可以调整等级设置，或在词条编辑器中恢复暂停的词条。";
    app.innerHTML = `<section class="card empty-state"><div><strong>还没有可学习的单词</strong><p>${hasWords ? emptyReason : "先向个人词库添加词条，再回到这里开始随机学习。"}</p>${hasWords ? `<button class="primary-btn" data-go="settings">调整等级设置</button>` : `<button class="primary-btn" data-go="add">添加第一个单词</button>`}</div></section>`;
    bindCommonActions();
    return;
  }

  const partDetails = [word.partOfSpeech?.category, word.partOfSpeech?.detail, word.partOfSpeech?.conjugationClass, word.partOfSpeech?.transitivity].filter(Boolean);
  app.innerHTML = `
    <section class="learn-shell">
      <div class="learn-toolbar">
        <div><strong>本轮进度 ${index + 1} / ${wordIds.length}</strong><span>本轮每个词只出现一次</span></div>
        <div class="learn-progress" aria-label="学习进度"><i style="width:${(index + 1) / wordIds.length * 100}%"></i></div>
        <div class="learn-toolbar-actions"><button class="secondary-btn small-btn" id="toggle-autoplay">${state.learning.autoPlay ? "Ⅱ 暂停自动翻页" : `▶ 自动翻页（${state.settings.learningAutoFlipSeconds || 60} 秒）`}</button><button class="secondary-btn small-btn" id="reshuffle-learn">↻ 重新洗牌</button></div>
      </div>

      <article class="card learn-card">
        <header class="learn-word-head">
          <div>
            <div class="learn-badges"><span class="badge accent">${escapeHtml(word.jlpt || "未定")}</span>${(word.tags || []).map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join("")}</div>
            <h2>${escapeHtml(word.term)}</h2>
            <p class="learn-reading">${escapeHtml(word.reading || "暂无读音")}</p>
          </div>
          <button class="pronounce-btn" id="pronounce-word" aria-label="朗读${escapeHtml(word.term)}" title="日语朗读">♪<span>发音</span></button>
        </header>

        <div class="learn-detail-grid">
          <section class="learn-section learn-meanings"><h3>含义</h3>${word.meanings?.length ? `<ol>${word.meanings.map((meaning) => `<li>${escapeHtml(meaning)}</li>`).join("")}</ol>` : `<p class="learn-empty">暂无释义</p>`}</section>
          <section class="learn-section"><h3>词条信息</h3>${partDetails.length ? `<dl class="word-facts"><div><dt>词性</dt><dd>${escapeHtml(word.partOfSpeech?.category || "未分类")}</dd></div><div><dt>细分</dt><dd>${escapeHtml(word.partOfSpeech?.detail || "—")}</dd></div><div><dt>活用类型</dt><dd>${escapeHtml(word.partOfSpeech?.conjugationClass || "—")}</dd></div><div><dt>自他动</dt><dd>${escapeHtml(word.partOfSpeech?.transitivity || "—")}</dd></div></dl>` : `<p class="learn-empty">暂无词性信息</p>`}</section>
        </div>

        <section class="learn-section"><h3>例句</h3><div class="learn-example-list">${word.examples?.length ? word.examples.map((example, exampleIndex) => `<article><span>${String(exampleIndex + 1).padStart(2, "0")}</span><div class="learn-example-content"><div class="learn-example-japanese"><p class="ruby-preview">${rubyHtml(example.japanese)}</p><button class="copy-example-btn" type="button" data-copy-example="${exampleIndex}" aria-label="复制第 ${exampleIndex + 1} 条例句的日文原文" title="复制不含注音的日文原文">复制原文</button></div><small>${escapeHtml(example.chinese || "暂无翻译")}</small></div></article>`).join("") : `<p class="learn-empty">暂无例句</p>`}</div></section>

        <section class="learn-section"><h3>活用</h3>${word.conjugations?.length ? `<div class="learn-conjugations">${word.conjugations.map((item, conjugationIndex) => `<article><div><strong>${escapeHtml(item.name || "活用")}</strong><b>${escapeHtml(item.form || "—")}</b></div>${item.example || item.exampleChinese ? `<div class="learn-example-japanese"><p class="ruby-preview">${rubyHtml(item.example)}</p>${item.example ? `<button class="copy-example-btn" type="button" data-copy-conjugation="${conjugationIndex}" aria-label="复制${escapeHtml(item.name || "该活用")}例句的日文原文" title="复制不含注音的日文原文">复制原文</button>` : ""}</div><small>${escapeHtml(item.exampleChinese || "")}</small>` : ""}</article>`).join("")}</div>` : `<p class="learn-empty">此词条暂无活用信息</p>`}</section>

        ${word.notes ? `<section class="learn-section learn-notes"><h3>个人笔记</h3><p>${escapeHtml(word.notes)}</p></section>` : ""}
      </article>

      <footer class="learn-actions">
        <button class="secondary-btn" id="learn-prev" ${index === 0 ? "disabled" : ""}>← 上一个</button>
        <button class="ghost-btn" data-edit="${word.id}">编辑此词条</button>
        <button class="primary-btn" id="learn-next">${index === wordIds.length - 1 ? "完成并重新洗牌" : "下一个 →"}</button>
      </footer>
    </section>`;

  document.querySelector("#reshuffle-learn").addEventListener("click", () => { shuffleLearningWords(); renderLearn(); });
  document.querySelector("#toggle-autoplay").addEventListener("click", () => {
    state.learning.autoPlay = !state.learning.autoPlay;
    renderLearn();
  });
  document.querySelector("#learn-prev").addEventListener("click", () => { state.learning.index -= 1; renderLearn(); scrollTo({ top: 0, behavior: "smooth" }); });
  document.querySelector("#learn-next").addEventListener("click", () => advanceLearningWord(true));
  document.querySelector("#pronounce-word").addEventListener("click", () => pronounceJapanese(word.term, word.reading));
  document.querySelectorAll("[data-copy-example]").forEach((button) => button.addEventListener("click", async () => {
    const example = word.examples[Number(button.dataset.copyExample)];
    const originalText = japaneseOriginalText(example?.japanese);
    if (!originalText) return toast("这条例句没有可复制的日文原文", "error");
    try {
      await copyTextToClipboard(originalText);
      toast("已复制日文原文");
    } catch (error) {
      toast(error.message || "复制失败", "error");
    }
  }));
  document.querySelectorAll("[data-copy-conjugation]").forEach((button) => button.addEventListener("click", async () => {
    const conjugation = word.conjugations[Number(button.dataset.copyConjugation)];
    const originalText = japaneseOriginalText(conjugation?.example);
    if (!originalText) return toast("这条例句没有可复制的日文原文", "error");
    try {
      await copyTextToClipboard(originalText);
      toast("已复制日文原文");
    } catch (error) {
      toast(error.message || "复制失败", "error");
    }
  }));
  bindCommonActions();
  scheduleLearningAutoPlay();
}

function advanceLearningWord(smoothScroll = false) {
  if (state.learning.index === state.learning.wordIds.length - 1) shuffleLearningWords();
  else state.learning.index += 1;
  renderLearn();
  scrollTo({ top: 0, behavior: smoothScroll ? "smooth" : "auto" });
}

function scheduleLearningAutoPlay() {
  if (!state.learning.autoPlay || state.view !== "learn" || !state.learning.wordIds.length) return;
  state.learning.timer = setTimeout(() => advanceLearningWord(), (state.settings.learningAutoFlipSeconds || 60) * 1_000);
}

function stopLearningAutoPlay() {
  state.learning.autoPlay = false;
  clearTimeout(state.learning.timer);
  state.learning.timer = null;
}

function pronounceJapanese(term, reading) {
  if (!("speechSynthesis" in window)) return toast("当前浏览器不支持语音朗读", "error");
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(reading || term);
  utterance.lang = "ja-JP";
  utterance.rate = 0.82;
  const japaneseVoice = speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith("ja"));
  if (japaneseVoice) utterance.voice = japaneseVoice;
  speechSynthesis.speak(utterance);
}

function getStats() {
  const complete = state.words.filter(wordComplete).length;
  const pending = state.words.length - complete;
  const recent = [...state.words].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  const levels = Object.fromEntries(["N5", "N4", "N3", "N2", "N1", "不适用", "未定"].map((level) => [level, state.words.filter((word) => word.jlpt === level).length]));
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
          <h2>快速收录</h2>
          <p>自动检查重复，保存后可补全读音、释义与例句。</p>
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
          <div class="section-head"><div><h2>最近收录</h2></div><button class="text-link" data-go="manage">查看全部 →</button></div>
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
  return ["未定", "N5", "N4", "N3", "N2", "N1", "不适用"].map((item) => `<option ${item === value ? "selected" : ""}>${item}</option>`).join("");
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
        <thead><tr><th><input class="checkbox" id="select-page" type="checkbox" aria-label="选择本页" /></th><th>词条</th><th>分类</th><th>中文释义</th><th>难度</th><th>记忆</th><th>状态</th><th></th></tr></thead>
        <tbody>${visible.map((word) => `
          <tr data-edit="${word.id}">
            <td><input class="checkbox row-check" type="checkbox" value="${word.id}" ${state.selected.has(word.id) ? "checked" : ""} aria-label="选择 ${escapeHtml(word.term)}" /></td>
            <td class="term-cell"><strong>${escapeHtml(word.term)}</strong><small>${escapeHtml(word.reading || "—")}</small></td>
            <td><span class="badge">${escapeHtml(word.partOfSpeech?.category || "未分类")}</span></td>
            <td>${escapeHtml(word.meanings?.join("；") || "—")}</td>
            <td><span class="badge ${word.jlpt !== "未定" ? "green" : ""}">${escapeHtml(word.jlpt)}</span></td>
            <td><span class="badge ${state.quizProgress.words[word.id]?.attempts ? "green" : ""}" title="${state.quizProgress.words[word.id]?.attempts || 0} 次作答">${state.quizProgress.words[word.id]?.level ?? 50}</span></td>
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
              <div class="field"><label>试题储备数量</label><select class="select" name="quizPrefetchCount">${[1,2,3].map((n) => `<option value="${n}" ${settings.quizPrefetchCount === n ? "selected" : ""}>${n} 道</option>`).join("")}</select><small>当前题显示后并行预生成，数量越多切题越快，也会更早消耗 API 请求。</small></div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-head"><div><h2>学习与测试范围</h2><p>控制随机单词与 AI 单词试题使用的词条范围。</p></div></div>
            <div class="form-grid">
              <div class="field"><label>自动翻页间隔（秒）</label><input class="input" type="number" name="learningAutoFlipSeconds" value="${settings.learningAutoFlipSeconds || 60}" min="10" max="600" step="1" inputmode="numeric" required /><small>默认 60 秒，可设置为 10～600 秒；手动翻页后会重新计时。</small></div>
              <fieldset class="field full practice-level-field">
                <legend>练习等级（可多选）</legend>
                <div class="practice-level-options">
                  ${["N5", "N4", "N3", "N2", "N1"].map((level) => `<label class="check-chip"><input type="checkbox" name="practiceJlptLevels" value="${level}" ${(settings.practiceJlptLevels || []).includes(level) ? "checked" : ""} /> ${level}</label>`).join("")}
                </div>
                <small>默认全部勾选；未勾选的等级不会出现在随机单词和考核测试中。</small>
              </fieldset>
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
        quizPrefetchCount: Number(data.get("quizPrefetchCount")),
        learningAutoFlipSeconds: Number(data.get("learningAutoFlipSeconds")),
        practiceJlptLevels: data.getAll("practiceJlptLevels"),
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
  const previousProvider = state.settings.aiProvider;
  const previousModel = activeProvider()?.model;
  const { settings } = await api("/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
  state.settings = settings;
  const quiz = state.quiz;
  const providerChanged = previousProvider !== settings.aiProvider || previousModel !== activeProvider()?.model;
  if (providerChanged) {
    quiz.generationEpoch += 1;
    quiz.reserveQuestions = [];
    quiz.prefetching = 0;
    quiz.prefetchError = "";
  } else {
    quiz.reserveQuestions = quiz.reserveQuestions.slice(0, settings.quizPrefetchCount);
  }
  return settings;
}

/**
 * @description 渲染 AI 单选试题；作答前不接收答案与解析，提交后再标记各选项。
 */
function renderQuiz() {
  const quiz = state.quiz;
  const eligibleCount = quizEligibleWords().length;
  const reserveTarget = Math.min(3, Math.max(1, Number(state.settings.quizPrefetchCount) || 2));
  const types = state.options.quizTypes || [];
  const question = quiz.question;
  const result = quiz.result;
  // 先于模板构造完成初始化，避免结果页引用处触发暂时性死区错误。
  const resultDistractorWords = Array.isArray(result?.distractorWords) ? result.distractorWords : [];
  const accuracy = quiz.answered ? Math.round(quiz.correct / quiz.answered * 100) : 0;
  const optionDetails = new Map((result?.options || []).map((option) => [option.id, option]));

  let body = "";
  if (quiz.status === "loading") {
    body = `<section class="card quiz-loading"><span class="quiz-spinner" aria-hidden="true"></span><h2>AI 正在编写试题</h2><p>正在校验四个选项与唯一答案，请稍候。</p></section>`;
  } else if (!question) {
    body = `<section class="card quiz-welcome">
      <div class="orb">試</div><span class="badge accent">JLPT N3</span>
      <h2>AI 单词试题</h2>
      <p>每题都会实时生成题干、四个选项和解析。核心词有时是正确答案，有时会成为干扰项；作答结果将调整它的记忆水平与后续出现概率。</p>
      <button class="primary-btn" id="generate-quiz" ${!eligibleCount || !aiConfigured() ? "disabled" : ""}>生成第一题</button>
      ${!aiConfigured() ? `<p class="quiz-hint">请先在 <button class="text-link" data-go="settings">设置</button> 中配置当前 AI 的 API Key。</p>` : ""}
      ${!eligibleCount ? `<p class="quiz-hint">当前学习等级范围内没有可出题的词条。</p>` : ""}
    </section>`;
  } else {
    body = `<section class="card quiz-card">
      <header class="quiz-card-head">
        <div><span class="badge accent">${escapeHtml(question.typeLabel)}</span><span class="badge">N3 难度</span></div>
        <div class="quiz-memory"><span>本题词记忆水平</span><strong>${result?.progress.level ?? question.memoryLevel}</strong><small>/ 100</small></div>
      </header>
      <div class="quiz-question">
        <p class="quiz-instruction">${escapeHtml(question.question)}</p>
        ${question.stem ? `<div class="quiz-stem">${rubyHtml(question.stem)}</div>` : ""}
        <div class="quiz-options" role="radiogroup" aria-label="答案选项">
          ${question.options.map((option, index) => {
            const selected = quiz.selectedOptionId === option.id;
            const correctOption = result?.correctOptionId === option.id;
            const wrongSelection = Boolean(result && selected && !correctOption);
            const detail = optionDetails.get(option.id);
            return `<button type="button" class="quiz-option ${selected ? "selected" : ""} ${correctOption ? "correct" : ""} ${wrongSelection ? "wrong" : ""}" data-option-id="${option.id}" role="radio" aria-checked="${selected}" ${result ? "disabled" : ""}>
              <span class="quiz-option-letter">${String.fromCharCode(65 + index)}</span>
              <span class="quiz-option-copy"><strong>${rubyHtml(option.text)}</strong>${result && detail?.explanation ? `<small>${escapeHtml(detail.explanation)}</small>` : ""}</span>
            </button>`;
          }).join("")}
        </div>
        ${result ? `<div class="quiz-result ${result.correct ? "is-correct" : "is-wrong"}"><strong>${result.correct ? "回答正确" : "回答错误"}</strong><p>${escapeHtml(result.analysis || "本题暂无补充解析。")}</p><small>“${escapeHtml(result.wordTerm || "本题核心词")}”的记忆水平${result.correct ? "上升" : "下降"}至 ${result.progress.level}；后续抽取概率已同步调整。</small></div>
        <section class="quiz-distractors">
          <div class="quiz-distractor-head"><div><h3>题干生词与干扰词速查</h3><p>包含题干中的可能生词和错误选项中的干扰词；收录状态来自本地词库实时检索。</p></div><span class="badge">${resultDistractorWords.length} 个</span></div>
          ${resultDistractorWords.length ? `<div class="quiz-distractor-list">${resultDistractorWords.map((item, index) => `<article>
            <div class="quiz-distractor-word"><div><strong>${rubyHtml(item.term)}</strong><small>${escapeHtml(item.reading || "待读音")}</small></div><div><span class="badge">${escapeHtml(item.origin || "干扰项")}</span><span class="badge ${item.jlpt !== "未定" ? "accent" : ""}">${escapeHtml(item.jlpt || "未定")}</span></div></div>
            <p>${escapeHtml(item.meaning || "暂无释义")}</p>
            <div class="quiz-distractor-state"><span class="badge ${item.collected ? "green" : ""}">${item.collected ? "已收录" : "未收录"}</span>${item.collected ? "" : `<button type="button" class="secondary-btn small-btn" data-add-distractor="${index}">＋ 添加到词库</button>`}</div>
          </article>`).join("")}</div>` : `<p class="learn-empty">本题题干和错误选项中没有需要单独列出的词。</p>`}
        </section>` : ""}
      </div>
      <footer class="quiz-actions">
        ${result ? `<button class="primary-btn" id="next-quiz">生成下一题</button>` : `<button class="primary-btn" id="submit-quiz" ${quiz.selectedOptionId ? "" : "disabled"}>提交答案</button>`}
      </footer>
    </section>`;
  }

  app.innerHTML = `<div class="quiz-shell">
    <section class="card quiz-toolbar">
      <label><span>题型</span><select class="select" id="quiz-type" ${quiz.status === "loading" ? "disabled" : ""}><option value="all">智能混合</option>${types.map((type) => `<option value="${type.id}" ${quiz.type === type.id ? "selected" : ""}>${escapeHtml(type.label)}</option>`).join("")}</select></label>
      <div class="quiz-session-stat"><span>本轮答题</span><strong>${quiz.answered}</strong><small>正确率 ${accuracy}%</small></div>
      <div class="quiz-session-stat"><span>可用词条</span><strong>${eligibleCount}</strong><small>按记忆水平加权</small></div>
      <div class="quiz-session-stat" id="quiz-reserve-status"><span>储备题</span><strong>${quiz.reserveQuestions.length}/${reserveTarget}</strong><small>${quiz.prefetching ? `正在生成 ${quiz.prefetching} 道` : quiz.prefetchError ? "后台补充失败" : "后台自动补充"}</small></div>
    </section>
    ${body}
  </div>`;

  document.querySelector("#quiz-type")?.addEventListener("change", (event) => {
    quiz.type = event.target.value;
    // 已储备题属于旧题型；递增代次后，仍在途的旧请求也不会进入新队列。
    quiz.generationEpoch += 1;
    quiz.reserveQuestions = [];
    quiz.prefetching = 0;
    quiz.prefetchError = "";
    if (quiz.question) prefillQuizReserve();
    updateQuizReserveIndicator();
  });
  document.querySelector("#generate-quiz")?.addEventListener("click", generateQuizQuestion);
  document.querySelector("#next-quiz")?.addEventListener("click", generateQuizQuestion);
  document.querySelectorAll("[data-option-id]").forEach((button) => button.addEventListener("click", () => {
    quiz.selectedOptionId = button.dataset.optionId;
    renderQuiz();
  }));
  document.querySelector("#submit-quiz")?.addEventListener("click", submitQuizAnswer);
  document.querySelectorAll("[data-add-distractor]").forEach((button) => button.addEventListener("click", () => addQuizDistractorWord(Number(button.dataset.addDistractor), button)));
  bindCommonActions();
  if (question && quiz.status === "ready") queueMicrotask(prefillQuizReserve);
}

/**
 * @description 一键收录只提交日语词条，不采纳 AI 生成的释义和 JLPT，留待人工或后续补全。
 */
async function addQuizDistractorWord(index, button) {
  const item = state.quiz.result?.distractorWords?.[index];
  if (!item || item.collected) return;
  const existing = state.words.find((word) => normalize(word.term) === normalize(item.term));
  if (existing) {
    item.collected = true;
    item.wordId = existing.id;
    renderQuiz();
    return;
  }
  button.disabled = true;
  button.textContent = "添加中…";
  try {
    const { word } = await api("/api/words", { method: "POST", body: JSON.stringify({ term: item.term }) });
    state.words.unshift(word);
    item.collected = true;
    item.wordId = word.id;
    renderQuiz();
    toast(`已收录“${word.term}”，详细资料可稍后补充`);
  } catch (error) {
    button.disabled = false;
    button.textContent = "＋ 添加到词库";
    toast(error.message, "error");
  }
}

async function requestQuizQuestion(type = state.quiz.type) {
  const { question } = await api("/api/quiz/generate", {
    method: "POST",
    body: JSON.stringify({ type: type === "all" ? "" : type }),
  });
  return question;
}

/**
 * @description 在用户阅读当前题时并行补齐储备队列，不阻塞选项交互。
 */
function prefillQuizReserve() {
  const quiz = state.quiz;
  if (!quiz.question || !aiConfigured()) return;
  const target = Math.min(3, Math.max(1, Number(state.settings.quizPrefetchCount) || 2));
  const needed = target - quiz.reserveQuestions.length - quiz.prefetching;
  if (needed <= 0) return;
  const epoch = quiz.generationEpoch;
  const requestedType = quiz.type;
  quiz.prefetching += needed;
  quiz.prefetchError = "";
  updateQuizReserveIndicator();

  for (let index = 0; index < needed; index += 1) {
    requestQuizQuestion(requestedType)
      .then((question) => {
        if (quiz.generationEpoch !== epoch) return;
        quiz.reserveQuestions.push(question);
        quiz.prefetchError = "";
      })
      .catch((error) => {
        if (quiz.generationEpoch === epoch) quiz.prefetchError = error.message || "预生成失败";
      })
      .finally(() => {
        if (quiz.generationEpoch !== epoch) return;
        quiz.prefetching = Math.max(0, quiz.prefetching - 1);
        updateQuizReserveIndicator();
      });
  }
}

function updateQuizReserveIndicator() {
  const panel = document.querySelector("#quiz-reserve-status");
  if (!panel) return;
  const quiz = state.quiz;
  const target = Math.min(3, Math.max(1, Number(state.settings.quizPrefetchCount) || 2));
  panel.querySelector("strong").textContent = `${quiz.reserveQuestions.length}/${target}`;
  const detail = panel.querySelector("small");
  detail.textContent = quiz.prefetching ? `正在生成 ${quiz.prefetching} 道` : quiz.prefetchError ? "后台补充失败" : "后台自动补充";
  detail.title = quiz.prefetchError;
}

async function generateQuizQuestion() {
  const quiz = state.quiz;
  quiz.result = null;
  quiz.selectedOptionId = "";
  if (quiz.reserveQuestions.length) {
    quiz.question = quiz.reserveQuestions.shift();
    quiz.status = "ready";
    quiz.prefetchError = "";
    renderQuiz();
    return;
  }

  quiz.status = "loading";
  quiz.question = null;
  renderQuiz();
  try {
    quiz.question = await requestQuizQuestion();
    quiz.status = "ready";
  } catch (error) {
    quiz.status = "idle";
    toast(error.message, "error");
  }
  if (state.view === "quiz") renderQuiz();
}

async function submitQuizAnswer() {
  const quiz = state.quiz;
  if (!quiz.question || !quiz.selectedOptionId || quiz.result) return;
  const button = document.querySelector("#submit-quiz");
  if (button) { button.disabled = true; button.textContent = "判分中…"; }
  try {
    const { result } = await api("/api/quiz/answer", {
      method: "POST",
      body: JSON.stringify({ questionId: quiz.question.id, optionId: quiz.selectedOptionId }),
    });
    quiz.result = result;
    quiz.answered += 1;
    quiz.correct += result.correct ? 1 : 0;
    state.quizProgress.words[result.wordId] = result.progress;
    state.learning.wordIds = [];
    renderQuiz();
  } catch (error) {
    toast(error.message, "error");
    if (button) { button.disabled = false; button.textContent = "提交答案"; }
  }
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
          <div class="field"><label>学习分类</label><select class="select" name="studyStatus"><option value="active" ${word.studyStatus !== "paused" ? "selected" : ""}>正常学习</option><option value="paused" ${word.studyStatus === "paused" ? "selected" : ""}>暂不学习（不进入记忆与考核）</option></select></div>
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
    term: data.get("term"), reading: data.get("reading"), jlpt: data.get("jlpt"), notes: data.get("notes"), studyStatus: data.get("studyStatus"),
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
    const remaining = missingWordFields(updated);
    toast(remaining.length ? `生成结束，仍缺：${remaining.join("、")}` : mode === "missing" ? "后台补全已完成" : "后台重新生成已完成", remaining.length ? "error" : "success");
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
  panel.innerHTML = `<div class="batch-progress-head"><strong>正在并行处理</strong><span id="batch-count">0 / ${ids.length}</span></div><div class="progress"><span id="batch-bar" style="width:0"></span></div><div class="progress-label"><span>${escapeHtml(activeProvider().label)} · ${escapeHtml(activeProvider().model)} · 最多尝试 3 次</span><span id="batch-retries">重试 0 次</span><span>并发 ${state.settings.concurrency} <button class="ghost-btn small-btn" id="stop-batch" type="button">停止</button></span></div><div class="batch-detail" id="batch-detail" hidden></div>`;
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
  let retryCount = 0;
  const failures = [];
  const maxAttempts = 3;
  const waitForRetry = (delayMs) => new Promise((resolve, reject) => {
    if (batchController.signal.aborted) {
      reject(new DOMException("请求已取消", "AbortError"));
      return;
    }
    const timer = setTimeout(() => { batchController.signal.removeEventListener("abort", cancel); resolve(); }, delayMs);
    const cancel = () => { clearTimeout(timer); reject(new DOMException("请求已取消", "AbortError")); };
    batchController.signal.addEventListener("abort", cancel, { once: true });
  });
  const runWithRetry = async (id) => {
    let lastError;
    let attempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      try {
        const { word } = await api(`/api/words/${id}/enrich`, { method: "POST", signal: batchController.signal, body: JSON.stringify({ exampleCount: state.settings.exampleCount, mode: "missing", fields: [] }) });
        replaceWord(word);
        const remaining = missingWordFields(word);
        if (!remaining.length) return;
        const incompleteError = new Error(`补全后仍缺：${remaining.join("、")}`);
        incompleteError.retryable = true;
        throw incompleteError;
      } catch (error) {
        if (error.name === "AbortError") throw error;
        lastError = error;
        const retryable = error.retryable || !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
        if (!retryable || attempt === maxAttempts) break;
        retryCount += 1;
        panel.querySelector("#batch-retries").textContent = `重试 ${retryCount} 次`;
        // 指数退避并加入少量随机抖动，避免并发请求在同一时刻再次冲击上游服务。
        await waitForRetry((2 ** (attempt - 1) * 1_500) + Math.floor(Math.random() * 500));
      }
    }
    throw Object.assign(lastError || new Error("未知错误"), { attempts });
  };
  const runWorker = async () => {
    while (!stopped && cursor < ids.length) {
      const id = ids[cursor++];
      try {
        // 每个词单独调用后端；后端又为 OpenCode Go 分配独立 x-opencode-session。
        await runWithRetry(id);
      } catch (error) {
        if (error.name !== "AbortError") {
          const word = state.words.find((item) => item.id === id);
          failures.push({ term: word?.term || id, reason: error.message || "未知错误", attempts: error.attempts || 1 });
        }
      }
      completed += 1;
      panel.querySelector("#batch-count").textContent = `${completed} / ${ids.length}`;
      panel.querySelector("#batch-bar").style.width = `${completed / ids.length * 100}%`;
    }
  };
  const workerCount = Math.min(state.settings.concurrency, ids.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  state.batchRunning = false;
  state.batchAbortController = null;
  if (state.view === "manage") renderManage(); else render();
  if (stopped) {
    panel.remove();
    toast(`批处理已停止：已处理 ${completed} / ${ids.length}`, "error");
  } else if (failures.length) {
    panel.querySelector(".batch-progress-head strong").textContent = `批处理完成：成功 ${ids.length - failures.length}，失败 ${failures.length}`;
    const detail = panel.querySelector("#batch-detail");
    detail.hidden = false;
    detail.innerHTML = `<div class="batch-failure-list">${failures.map((item) => `<p><strong>${escapeHtml(item.term)}</strong><span>${escapeHtml(item.reason)}（尝试 ${item.attempts} 次）</span></p>`).join("")}</div><button class="secondary-btn small-btn" id="close-batch-result" type="button">关闭结果</button>`;
    panel.querySelector("#stop-batch").remove();
    panel.querySelector("#close-batch-result").addEventListener("click", () => panel.remove());
    toast(`批处理完成：${failures.length} 条仍需处理，失败明细已保留`, "error");
  } else {
    panel.remove();
    toast(`已完整补全 ${ids.length} 个词条`);
  }
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
    state.quizProgress = payload.quizProgress || { words: {} };
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
