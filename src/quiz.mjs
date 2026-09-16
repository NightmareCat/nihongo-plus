/**
 * @file quiz.mjs
 * @description AI 单选试题生成器；约束题型、清洗模型输出，并在返回浏览器前分离答案与解析。
 */

import crypto from "node:crypto";
import { fetchJsonWithTimeout } from "./fetch-json.mjs";
import { getActiveAiRuntime } from "./settings.mjs";

export const QUIZ_TYPES = [
  { id: "conjugation", label: "动词变形", verbsOnly: true },
  { id: "word-choice", label: "语境选词" },
  { id: "meaning", label: "词义判断" },
  { id: "particle", label: "助词搭配" },
  { id: "reading", label: "读音辨析" },
  { id: "context", label: "语境理解" },
  { id: "synonym", label: "近义辨析" },
];

const cleanText = (value) => typeof value === "string" ? value.replace(/\\([<>])/g, "$1").trim() : "";

export function compatibleQuizTypes(word) {
  return QUIZ_TYPES.filter((type) => !type.verbsOnly || word.partOfSpeech?.category === "动词");
}

export function normalizeQuizPayload(payload, requestedType, random = Math.random, sourceShouldBeCorrect) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const question = cleanText(source.question || source.prompt);
  const stem = cleanText(source.stem);
  const analysis = cleanText(source.analysis || source.explanation);
  const sourceOptions = Array.isArray(source.options) ? source.options : [];
  const distractorWords = (Array.isArray(source.distractorWords) ? source.distractorWords : [])
    .slice(0, 8)
    .map((item) => ({
      term: cleanText(item?.term),
      reading: cleanText(item?.reading),
      meaning: cleanText(item?.meaning),
      jlpt: /^N[1-5]$/.test(cleanText(item?.jlpt).toUpperCase()) ? cleanText(item.jlpt).toUpperCase() : "未定",
      origin: cleanText(item?.origin) === "题干" ? "题干" : "干扰项",
    }))
    .filter((item, index, list) => item.term && list.findIndex((candidate) => candidate.term === item.term) === index);
  const options = sourceOptions.slice(0, 4).map((option, index) => ({
    id: crypto.randomUUID(),
    text: cleanText(typeof option === "string" ? option : option?.text),
    explanation: cleanText(typeof option === "object" ? option?.explanation : ""),
    originalIndex: index,
  }));
  const correctIndex = Number(source.correctIndex);
  const sourceOptionIndex = Number(source.sourceOptionIndex);
  if (!question || options.length !== 4 || options.some((option) => !option.text) || new Set(options.map((option) => option.text)).size !== 4) {
    throw new Error("AI 返回的试题结构不完整，请重新生成");
  }
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
    throw new Error("AI 未提供有效的正确选项，请重新生成");
  }
  if (typeof sourceShouldBeCorrect === "boolean"
    && (!Number.isInteger(sourceOptionIndex) || sourceOptionIndex < 0 || sourceOptionIndex >= options.length
      || (sourceOptionIndex === correctIndex) !== sourceShouldBeCorrect)) {
    throw new Error("AI 未按要求安排核心词选项，请重新生成");
  }
  for (let index = options.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [options[index], options[target]] = [options[target], options[index]];
  }
  const correctOptionId = options.find((option) => option.originalIndex === correctIndex).id;
  return {
    id: crypto.randomUUID(),
    type: requestedType.id,
    typeLabel: requestedType.label,
    question,
    stem,
    options: options.map(({ originalIndex, ...option }) => option),
    correctOptionId,
    analysis,
    distractorWords,
  };
}

export function buildQuizPrompt(word, type, distractorWords, sourceShouldBeCorrect) {
  const sourceRole = sourceShouldBeCorrect
    ? "本题必须让核心考查词（或其正确活用形）成为正确答案。"
    : "本题必须让核心考查词（或与其直接对应的形式）出现在选项中，但作为错误答案；正确答案使用另一个自然表达。";
  return `请为日语学习者生成一道四选一单选题。\n题型：${type.label}\n核心考查词：${JSON.stringify(word)}\n可参考的其他词条：${JSON.stringify(distractorWords)}\n要求：\n1. 返回严格 JSON，不要 Markdown，字段为 question、stem、options、correctIndex、sourceOptionIndex、analysis、distractorWords。\n2. options 必须恰好 4 项，每项为 {"text":"选项文字","explanation":"该选项为何正确或错误的简短中文说明"}；correctIndex 和 sourceOptionIndex 都是从 0 开始的整数，后者必须指向核心词对应的选项。\n3. distractorWords 是“题干生词与干扰词”数组：既列出错误选项中值得学习的日语单词，也列出 stem 题干中 N3 学习者可能不熟悉、但有助于理解题意的单词。每项严格使用 {"term":"辞书形词条","reading":"完整假名读音","meaning":"简体中文含义","jlpt":"N1至N5或未定","origin":"题干或干扰项"}。term 必须使用辞书形，reading 必须填写；只列独立单词，不列助词、整句、中文选项、核心考查词或单纯活用词尾；没有时返回空数组。\n4. question 使用简体中文给出作答指令，stem 是实际题干或带空格的自然日语语境。\n5. analysis、每个 options[i].explanation 以及 distractorWords 中的 meaning 必须使用自然、易懂的简体中文。严禁只写纯日语解释或用日语句子代替中文解析；如需提到日语词、活用或例句，应先引用日语内容，再立即用中文说明其含义、语法作用以及正确或错误的原因。\n6. 每个选项都必须提供 explanation，包括正确选项和三个错误选项；不要只复述选项文字。\n7. ${sourceRole}\n8. 题干和干扰项可以使用词库之外的自然日语，不要把“核心考查词”字样或答案提示写进题面。\n9. 四个选项必须互不相同，且只能有一个无歧义的正确答案；助词题需给出足够语境，读音题需明确考查哪个词。\n10. 无论核心词自身属于哪个 JLPT 等级，都将题干语法、语境信息、词汇搭配和辨析难度严格控制在 JLPT N3 水平；必要时对超纲词提供足够线索。`;
}

export async function generateQuizQuestion(word, type, distractorWords = [], signal) {
  const runtime = await getActiveAiRuntime();
  if (!runtime.apiKey) {
    const error = new Error(`尚未配置 ${runtime.label} API Key`);
    error.statusCode = 503;
    throw error;
  }
  const headers = { Authorization: `Bearer ${runtime.apiKey}`, "Content-Type": "application/json" };
  if (runtime.provider === "opencode-go") {
    headers["User-Agent"] = "nihongo-plus/0.2";
    headers["x-opencode-session"] = crypto.randomUUID();
  }
  const sourceShouldBeCorrect = Math.random() >= 0.35;
  const { response, payload } = await fetchJsonWithTimeout(`${runtime.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: runtime.model,
      response_format: { type: "json_object" },
      temperature: 0.55,
      messages: [
        { role: "system", content: "你是面向中文母语学习者的严谨日语教师，擅长生成答案唯一、干扰项合理的单选题。所有教学解释和选项解析必须使用简体中文，日语只能作为被解释的引用内容。只输出一个 JSON 对象。" },
        // 约三分之一题目把核心词作为干扰项，训练学习者排除“看起来熟悉”的错误答案。
        { role: "user", content: buildQuizPrompt(word, type, distractorWords, sourceShouldBeCorrect) },
      ],
    }),
  }, runtime.requestTimeoutSeconds * 1_000);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `AI 请求失败（${response.status}）`);
    error.statusCode = response.status;
    throw error;
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI 未返回可用试题");
  const json = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  return normalizeQuizPayload(JSON.parse(json), type, Math.random, sourceShouldBeCorrect);
}
