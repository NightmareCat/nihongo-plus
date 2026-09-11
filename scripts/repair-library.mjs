/**
 * @file repair-library.mjs
 * @description 一次性修复旧模型输出造成的字段类型漂移，并为修复前词库创建本地备份。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { normalizeStoredWord } from "../src/word-schema.mjs";

const root = path.resolve(import.meta.dirname, "..");
const libraryFile = path.join(root, "data", "词库", "个人收集.json");
const backupDir = path.join(root, "data", "备份");
const originalText = await fs.readFile(libraryFile, "utf8");
const library = JSON.parse(originalText);
const before = JSON.stringify(library);

library.words = library.words.map((word) => {
  const normalized = normalizeStoredWord(word);
  // 这些释义在旧版中已不可逆地变成字面量，依据现有例句和笔记确定性恢复。
  if (normalized.term === "事実" && !normalized.meanings.length) {
    normalized.meanings = ["事实；实际发生的事情", "真实情况；实际情况"];
    normalized.partOfSpeech.category = "名词";
  }
  if (normalized.term === "姿" && !normalized.meanings.length) {
    normalized.meanings = ["姿态；样子；外形", "身影；身姿"];
    normalized.partOfSpeech.category = "名词";
  }
  return normalized;
});

const after = JSON.stringify(library);
if (before === after) {
  console.log("词库结构已经规范，无需修复。");
  process.exit(0);
}

await fs.mkdir(backupDir, { recursive: true });
const backupFile = path.join(backupDir, `个人收集.before-schema-repair-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await fs.writeFile(backupFile, originalText, "utf8");
const tempFile = `${libraryFile}.tmp`;
library.updatedAt = new Date().toISOString();
await fs.writeFile(tempFile, `${JSON.stringify(library, null, 2)}\n`, "utf8");
await fs.rename(tempFile, libraryFile);
console.log(`已修复 ${library.words.length} 个词条的结构；备份：${backupFile}`);
