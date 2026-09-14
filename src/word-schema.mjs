/**
 * @file word-schema.mjs
 * @description 词条数据规范化层；把不同模型返回的对象、数组和日文分类统一为稳定结构。
 */

const INVALID_TEXT = new Set(["[object Object]", "undefined", "null"]);
const VALID_JLPT = new Set(["N5", "N4", "N3", "N2", "N1"]);
const JLPT_NOT_APPLICABLE = new Set(["不适用", "不適用", "N/A", "NA", "无", "無", "なし", "該当なし"]);
const SUPPORTED_CATEGORIES = new Set(["未分类", "名词", "动词", "形容词", "副词", "语法结构", "固定搭配", "惯用语", "接续词", "感叹词", "助词", "其他"]);
const CATEGORY_RULES = [
  [/慣用|惯用/, "惯用语"],
  [/連語|连语|固定搭配|固定短语|词组|詞組/, "固定搭配"],
  [/文法|语法|句型|構文|构文|句式|文末表現|文末表现/, "语法结构"],
  [/接続詞|接续词/, "接续词"],
  [/感動詞|感叹词/, "感叹词"],
  [/助詞|助词/, "助词"],
  [/形容動詞|形容动词|形容詞|形容词|イ形容|ナ形容|い形容|な形容/, "形容词"],
  [/動詞|动词|五段|一段|サ変|カ変|不規則|不规则|自動詞|自动词|他動詞|他动词/, "动词"],
  [/名詞|名词/, "名词"],
  [/副詞|副词/, "副词"],
];

/**
 * @description 规范化词条的学习分类；未知值按“正常学习”处理，兼容既有词库。
 */
function canonicalStudyStatus(value) {
  return text(value, ["studyStatus", "status"]) === "paused" ? "paused" : "active";
}

function text(value, keys = []) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const cleaned = value.replace(/\\([<>])/g, "$1").trim();
    return INVALID_TEXT.has(cleaned) ? "" : cleaned;
  }
  if (["number", "boolean"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) return value.map((item) => text(item, keys)).filter(Boolean).join("；");
  if (typeof value === "object") {
    for (const key of [...keys, "text", "value", "name"]) {
      const candidate = text(value[key], keys);
      if (candidate) return candidate;
    }
  }
  return "";
}

function stringList(value, keys) {
  const list = Array.isArray(value) ? value : value === null || value === undefined || value === "" ? [] : [value];
  return list.map((item) => text(item, keys)).filter(Boolean);
}

function canonicalJlpt(value) {
  const raw = text(value, ["level"]).normalize("NFKC").trim();
  const compact = raw.toUpperCase().replace(/\s+/g, "").replace(/^JLPT[-：:]?/, "");
  if (VALID_JLPT.has(compact)) return compact;
  if (JLPT_NOT_APPLICABLE.has(raw) || JLPT_NOT_APPLICABLE.has(compact)) return "不适用";
  return "未定";
}

function categoryFromText(value) {
  const raw = text(value, ["category", "type", "partOfSpeech", "detail", "label"])
    .replace(/非(?:動詞|动词)|不是(?:動詞|动词)|不属于(?:動詞|动词)/g, "");
  return CATEGORY_RULES.find(([pattern]) => pattern.test(raw))?.[1] || "";
}

function canonicalCategory(value, fallbackValues = []) {
  const raw = text(value, ["category", "type", "partOfSpeech"]);
  const direct = categoryFromText(raw);
  if (direct) return direct;

  // 部分模型会漏掉 category，却在词性细分、活用类型、及物性或标签中给出答案。
  const inferred = categoryFromText(fallbackValues);
  if (inferred) return inferred;
  if (!raw || ["未分類", "未分类", "unknown", "未知"].includes(raw.toLowerCase())) return "未分类";
  return "其他";
}

function canonicalTransitivity(value) {
  const raw = text(value, ["transitivity", "type"]);
  if (/自動詞.*他動詞|自动词.*他动词|両用|两用/.test(raw)) return "自动词・他动词两用";
  if (/他動詞|他动词/.test(raw)) return "他动词";
  if (/自動詞|自动词/.test(raw)) return "自动词";
  return raw;
}

function normalizePartOfSpeech(value = {}, fallbackValues = []) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : { category: value };
  return {
    category: canonicalCategory(source.category ?? source.type ?? source.partOfSpeech, [source.detail, source.conjugationClass, source.transitivity, ...fallbackValues]),
    detail: text(source.detail, ["description"]),
    conjugationClass: text(source.conjugationClass, ["conjugation", "class"]),
    transitivity: canonicalTransitivity(source.transitivity),
  };
}

function normalizeExamples(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((item) => {
    const source = item && typeof item === "object" ? item : { japanese: item };
    return {
      japanese: text(source.japanese ?? source.jp ?? source.sentence, ["japanese", "sentence", "text"]),
      chinese: text(source.chinese ?? source.zh ?? source.translation, ["chinese", "translation", "meaning"]),
    };
  }).filter((item) => item.japanese || item.chinese);
}

function normalizeConjugations(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((item) => {
    const source = item && typeof item === "object" ? item : { form: item };
    const exampleSource = source.example;
    return {
      name: text(source.name, ["type", "label"]),
      form: text(source.form, ["value"]),
      example: text(exampleSource, ["japanese", "jp", "sentence"]),
      exampleChinese: text(source.exampleChinese ?? (exampleSource && typeof exampleSource === "object" ? exampleSource.chinese ?? exampleSource.translation : ""), ["chinese", "translation"]),
    };
  }).filter((item) => item.name || item.form || item.example || item.exampleChinese);
}

export function normalizeWordPatch(input = {}) {
  const output = {};
  if (Object.hasOwn(input, "reading")) output.reading = text(input.reading, ["reading", "kana"]);
  if (Object.hasOwn(input, "partOfSpeech")) output.partOfSpeech = normalizePartOfSpeech(input.partOfSpeech, [input.tags]);
  if (Object.hasOwn(input, "meanings")) output.meanings = stringList(input.meanings, ["meaning", "definition", "chinese", "translation"]);
  if (Object.hasOwn(input, "jlpt")) output.jlpt = canonicalJlpt(input.jlpt);
  if (Object.hasOwn(input, "tags")) output.tags = stringList(input.tags, ["tag", "label"]);
  if (Object.hasOwn(input, "conjugations")) output.conjugations = normalizeConjugations(input.conjugations);
  if (Object.hasOwn(input, "examples")) output.examples = normalizeExamples(input.examples);
  if (Object.hasOwn(input, "notes")) output.notes = text(input.notes, ["note", "description"]);
  if (Object.hasOwn(input, "aiStatus")) output.aiStatus = text(input.aiStatus, ["status"]);
  if (Object.hasOwn(input, "studyStatus")) output.studyStatus = canonicalStudyStatus(input.studyStatus);
  return output;
}

export function normalizeStoredWord(word) {
  return {
    ...word,
    term: text(word.term, ["word", "term"]),
    ...normalizeWordPatch({
      reading: word.reading,
      partOfSpeech: word.partOfSpeech,
      meanings: word.meanings,
      jlpt: word.jlpt,
      tags: word.tags,
      conjugations: word.conjugations,
      examples: word.examples,
      notes: word.notes,
      aiStatus: word.aiStatus,
      studyStatus: word.studyStatus,
    }),
  };
}

/**
 * @description 记忆与考核模块共用的准入接口；暂不学习的词不会进入练习牌组。
 */
export function isWordEligibleForPractice(word) {
  return canonicalStudyStatus(word?.studyStatus) === "active";
}

export function fillMissingStoredCategory(word) {
  const current = word?.partOfSpeech?.category;
  if (current && SUPPORTED_CATEGORIES.has(current) && current !== "未分类") return word;
  return {
    ...word,
    partOfSpeech: normalizePartOfSpeech(word?.partOfSpeech, [word?.tags]),
  };
}

export function normalizeAiPayload(payload) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const aliasedPart = source.partOfSpeech ?? source.part_of_speech ?? source.pos ?? source["词性"];
  const partOfSpeech = aliasedPart && typeof aliasedPart === "object" && !Array.isArray(aliasedPart)
    ? { ...aliasedPart, category: aliasedPart.category || source.category || source["分类"] }
    : aliasedPart ?? source.category ?? source["分类"];
  const adapted = { ...source };
  if (partOfSpeech !== undefined) adapted.partOfSpeech = partOfSpeech;
  return normalizeWordPatch(adapted);
}
