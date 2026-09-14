/**
 * @file word-completeness.mjs
 * @description 词条完整度规则；统一判断必填字段，并据此生成可靠的 AI 补全状态。
 */

export const JLPT_OPTIONS = ["N5", "N4", "N3", "N2", "N1", "不适用"];

export function getMissingWordFields(word = {}) {
  const missing = [];
  if (!word.reading) missing.push("reading");
  if (!word.meanings?.length) missing.push("meanings");
  if (!word.partOfSpeech?.category || word.partOfSpeech.category === "未分类") missing.push("partOfSpeech");
  if (!JLPT_OPTIONS.includes(word.jlpt)) missing.push("jlpt");
  if (!word.examples?.length) missing.push("examples");
  if (["动词", "形容词"].includes(word.partOfSpeech?.category) && !word.conjugations?.length) missing.push("conjugations");
  return missing;
}

export function enrichmentStatus(word = {}) {
  return getMissingWordFields(word).length ? "pending" : "complete";
}
