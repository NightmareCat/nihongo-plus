/**
 * @file normalize-headwords.mjs
 * @description 规范化主词库中的日语见出词，并清空被修正词条的派生内容以便重新补全。
 */

import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const libraryFile = path.join(root, "data", "词库", "个人收集.json");
const backupDir = path.join(root, "data", "备份");

// 只收录能够确定的原形、标准写法或完整语法形式；不根据猜测修正含义不明的输入。
const HEADWORD_FIXES = new Map([
  // 「やめておけ」由「やめる」与既有语法词条「～ておく」组成，因此拆分后只补入缺少的原形。
  ["やめておけ", "やめる"],
  ["やめておく", "やめる"],
  ["構いません", "構う"],
  ["渡される", "渡す"],
  ["及びません", "及ぶ"],
  ["される", "する"],
  ["凛とした", "凛とする"],
  ["要らぬ", "要る"],
  ["置いて", "置く"],
  ["くつろげる", "くつろぐ"],
  ["抜けている", "抜ける"],
  ["嚙みしめる", "噛みしめる"],
  ["～としては～", "～としては"],
  ["っぶり", "～っぷり"],
  ["納得のいかない", "納得がいかない"],
  ["限られた", "限られる"],
  ["低く", "低い"],
  ["もしろ", "むしろ"],
  ["～なとこる", "～なところ"],
  ["～ついて", "～について"],
  ["浮かんだ", "浮かぶ"],
  ["語られる", "語る"],
]);

// 明显错误且无法从上下文可靠还原的项目直接删除，避免不可靠内容继续进入词库。
const DELETE_TERMS = new Set(["いくかき"]);

function clearedWord(word, term = word.term) {
  return {
    ...word,
    term,
    reading: "",
    partOfSpeech: { category: "未分类", detail: "", conjugationClass: "", transitivity: "" },
    meanings: [],
    jlpt: "未定",
    tags: [],
    conjugations: [],
    examples: [],
    notes: "",
    aiStatus: "pending",
    updatedAt: new Date().toISOString(),
  };
}

const originalText = await fs.readFile(libraryFile, "utf8");
const library = JSON.parse(originalText);
const existingTerms = new Set(library.words.map((word) => word.term));
const removedIds = new Set();
const changes = [];

library.words = library.words.flatMap((word) => {
  if (DELETE_TERMS.has(word.term)) {
    removedIds.add(word.id);
    changes.push(`${word.term}（无法可靠确认，删除）`);
    return [];
  }

  const correctedTerm = HEADWORD_FIXES.get(word.term);
  if (!correctedTerm) return [word];

  // 若标准词形已存在，则保留原有标准词条并移除错误的重复项。
  if (existingTerms.has(correctedTerm)) {
    removedIds.add(word.id);
    changes.push(`${word.term} → ${correctedTerm}（合并重复项）`);
    return [];
  }

  existingTerms.delete(word.term);
  existingTerms.add(correctedTerm);
  changes.push(`${word.term} → ${correctedTerm}`);
  return [clearedWord(word, correctedTerm)];
});

if (!changes.length) {
  console.log("词库见出词已经规范，无需修改。");
  process.exit(0);
}

await fs.mkdir(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupFile = path.join(backupDir, `个人收集.before-headword-normalize-${stamp}.json`);
await fs.writeFile(backupFile, originalText, "utf8");

library.updatedAt = new Date().toISOString();
const tempFile = `${libraryFile}.tmp`;
await fs.writeFile(tempFile, `${JSON.stringify(library, null, 2)}\n`, "utf8");
await fs.rename(tempFile, libraryFile);

// 同步移除子词库里指向重复错误词条的引用。
if (removedIds.size) {
  const collectionsFile = path.join(root, "data", "子词库.json");
  const collections = JSON.parse(await fs.readFile(collectionsFile, "utf8"));
  collections.collections = (collections.collections || []).map((collection) => ({
    ...collection,
    wordIds: (collection.wordIds || []).filter((id) => !removedIds.has(id)),
  }));
  await fs.writeFile(collectionsFile, `${JSON.stringify(collections, null, 2)}\n`, "utf8");
}

console.log(`已处理 ${changes.length} 个问题词条，当前共 ${library.words.length} 个词条。`);
console.log(changes.join("\n"));
console.log(`备份：${backupFile}`);
