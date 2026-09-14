/**
 * @file deepseek.mjs
 * @description DeepSeek JSON 补全服务；仅生成缺失字段，不覆盖人工维护内容。
 */

import crypto from "node:crypto";
import { fetchJsonWithTimeout } from "./fetch-json.mjs";
import { getActiveAiRuntime } from "./settings.mjs";
import { normalizeAiPayload } from "./word-schema.mjs";
import { enrichmentStatus } from "./word-completeness.mjs";

const CONJUGATION_OPTIONS = [
  "辞書形", "ます形", "て形", "た形", "ない形", "なかった形", "意向形", "命令形", "可能形", "被动形", "使役形", "使役被动形", "条件形（ば）", "条件形（たら）",
];
const CATEGORY_OPTIONS = ["名词", "动词", "形容词", "副词", "语法结构", "固定搭配", "惯用语", "接续词", "感叹词", "助词", "其他"];
const JLPT_INFERENCE_GUIDANCE = `JLPT 评级规则：
- 优先参考通行的 JLPT 教材、词表和考试用法，但不要因为缺少明确收录记录就放弃评级。
- 查不到明确等级时，必须自行推断“JLPT 相当难度”：综合常用频率、学习者通常接触阶段、汉字与构词复杂度、语义抽象度、语域（生活口语、一般书面语、商务、新闻、文学）以及理解所需的语法和语用知识。
- 活用形、复合表达和固定搭配应先识别辞书形及组成语法，再按理解整个表达所需的最高难度评级；普通口语、惯用语、复合词和书面表达仍应尽量给出 N1～N5。
- 大致尺度：N5 为最基础日常词和定型表达；N4 为常见生活词和初级表达；N3 为较广泛的日常交流、常用抽象词和中级表达；N2 为正式书面语、商务/新闻常用词及复杂表达；N1 为低频高级词、文学性表达和依赖细微语感的表达。
- 只有专有名词、明显错误或无法还原的残缺片段、极端领域术语等确实无法用一般日语学习难度衡量的项目，才填写“不适用”。`;

export function buildPrompt(word, exampleCount, mode, fields) {
  const action = mode === "replace"
    ? "重新生成除词条本身和个人笔记之外的全部词典信息。"
    : mode === "fields"
      ? `重点重新生成这些字段：${fields.join("、")}；其余字段仍需原样返回。`
      : "只补充现有缺失的字段，已有有效内容原样返回。注意：空字符串、空数组、‘未分类’和 JLPT 的‘未定’都属于缺失值，必须补充，不能原样返回。";
  return `请处理这个日语词条：${word.term}\n现有数据：${JSON.stringify(word)}\n要求：\n1. 返回严格 JSON，不要 Markdown。\n2. 中文释义简洁准确。\n3. 日语例句自然，并用 HTML ruby 标签给例句中的汉字注音，例如 <ruby>勉強<rt>べんきょう</rt></ruby>；标签前不要添加反斜杠。\n4. partOfSpeech.category 必须填写且只能是以下之一：${CATEGORY_OPTIONS.join("、")}。若为动词，指出一段/五段/不规则以及自动词/他动词；若为形容词，指出い形容词或な形容词。\n5. jlpt 必须且只能填写 N1、N2、N3、N4、N5、不适用之一，绝对不能填写‘未定’或留空。这里的等级既可以是明确的 JLPT 归属，也可以是依据下列规则推断出的 JLPT 相当难度。\n${JLPT_INFERENCE_GUIDANCE}\n6. 动词优先维护这些活用：${CONJUGATION_OPTIONS.join("、")}。形容词维护现在肯定、现在否定、过去肯定、过去否定、て形、条件形。每个活用提供一个带 ruby 注音的例句。\n7. 主例句数量为 ${exampleCount}。\n8. ${action}`;
}

function cleanGenerated(value) {
  if (typeof value === "string") return value.replace(/\\([<>])/g, "$1");
  if (Array.isArray(value)) return value.map(cleanGenerated);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanGenerated(item)]));
  return value;
}

export async function enrichWord(word, exampleCount = 2, mode = "missing", fields = [], signal) {
  const runtime = await getActiveAiRuntime();
  if (!runtime.apiKey) {
    const error = new Error(`尚未配置 ${runtime.label} API Key`);
    error.statusCode = 503;
    throw error;
  }

  const headers = {
    Authorization: `Bearer ${runtime.apiKey}`,
    "Content-Type": "application/json",
  };
  if (runtime.provider === "opencode-go") {
    // OpenCode Go 要求客户端标识和稳定会话头；每个词使用独立 ID，保证并行任务不共享会话。
    headers["User-Agent"] = "nihongo-plus/0.2";
    headers["x-opencode-session"] = crypto.randomUUID();
  }

  const { response, payload } = await fetchJsonWithTimeout(`${runtime.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: runtime.model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `你是严谨的日语词典编辑。输出一个 JSON 对象，字段为 reading、partOfSpeech、meanings、jlpt、tags、conjugations、examples、notes。所有末端字段必须是字符串，不得用对象代替字符串。partOfSpeech 包含字符串 category、detail、conjugationClass、transitivity，其中 category 必填且只能是：${CATEGORY_OPTIONS.join("、")}。jlpt 必填且只能是 N1、N2、N3、N4、N5、不适用之一；没有明确词表依据时，应结合语言特征给出 JLPT 相当难度，不得仅因缺少官方归属而填写不适用。meanings 和 tags 是字符串数组；conjugations 每项包含字符串 name、form、example（日文）、exampleChinese（中文）；examples 每项包含字符串 japanese、chinese。`,
        },
        { role: "user", content: buildPrompt(word, Math.min(5, Math.max(1, Number(exampleCount) || 2)), mode, fields) },
      ],
    }),
  }, runtime.requestTimeoutSeconds * 1_000);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `DeepSeek 请求失败（${response.status}）`);
    error.statusCode = response.status;
    throw error;
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek 未返回可用内容");
  const json = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  return normalizeAiPayload(cleanGenerated(JSON.parse(json)));
}

export function mergeEnrichment(word, generated, mode = "missing", fields = []) {
  const currentPart = word.partOfSpeech || {};
  const aiPart = generated.partOfSpeech || {};
  const missing = {
    reading: word.reading || generated.reading || "",
    partOfSpeech: {
      category: currentPart.category && currentPart.category !== "未分类" ? currentPart.category : aiPart.category || "未分类",
      detail: currentPart.detail || aiPart.detail || "",
      conjugationClass: currentPart.conjugationClass || aiPart.conjugationClass || "",
      transitivity: currentPart.transitivity || aiPart.transitivity || "",
    },
    meanings: word.meanings?.length ? word.meanings : generated.meanings || [],
    jlpt: word.jlpt && word.jlpt !== "未定" ? word.jlpt : generated.jlpt || "未定",
    tags: word.tags?.length ? word.tags : generated.tags || [],
    conjugations: word.conjugations?.length ? word.conjugations : generated.conjugations || [],
    examples: word.examples?.length ? word.examples : generated.examples || [],
    notes: word.notes || generated.notes || "",
  };
  if (mode === "replace") {
    const replaced = {
    reading: generated.reading || "",
    partOfSpeech: generated.partOfSpeech || { category: "未分类", detail: "", conjugationClass: "", transitivity: "" },
    meanings: generated.meanings || [],
    jlpt: generated.jlpt || "未定",
    tags: generated.tags || [],
    conjugations: generated.conjugations || [],
    examples: generated.examples || [],
    notes: word.notes || generated.notes || "",
    };
    return { ...replaced, aiStatus: enrichmentStatus(replaced) };
  }
  if (mode === "fields") {
    const selected = new Set(fields);
    const regenerated = {
      ...word,
      reading: selected.has("reading") ? generated.reading || "" : word.reading,
      partOfSpeech: selected.has("partOfSpeech") ? generated.partOfSpeech || word.partOfSpeech : word.partOfSpeech,
      meanings: selected.has("meanings") ? generated.meanings || [] : word.meanings,
      jlpt: selected.has("jlpt") ? generated.jlpt || "未定" : word.jlpt,
      tags: selected.has("tags") ? generated.tags || [] : word.tags,
      conjugations: selected.has("conjugations") ? generated.conjugations || [] : word.conjugations,
      examples: selected.has("examples") ? generated.examples || [] : word.examples,
      notes: word.notes,
    };
    return { ...regenerated, aiStatus: enrichmentStatus(regenerated) };
  }
  return { ...missing, aiStatus: enrichmentStatus(missing) };
}

export const conjugationOptions = CONJUGATION_OPTIONS;
