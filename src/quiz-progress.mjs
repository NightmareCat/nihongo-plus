/**
 * @file quiz-progress.mjs
 * @description 单词记忆水平仓储；持久化答题表现，并为随机学习与出题提供抽取权重。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.mjs";

const EMPTY_PROGRESS = { schemaVersion: 1, updatedAt: "", words: {} };
let progressMutationTail = Promise.resolve();

function queueProgressMutation(operation) {
  const result = progressMutationTail.then(operation, operation);
  progressMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

async function readProgressFile() {
  try {
    const saved = JSON.parse(await fs.readFile(config.quizProgressFile, "utf8"));
    return { ...EMPTY_PROGRESS, ...saved, words: saved.words || {} };
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(EMPTY_PROGRESS);
    throw error;
  }
}

async function writeProgressFile(data) {
  await fs.mkdir(path.dirname(config.quizProgressFile), { recursive: true });
  const temporaryFile = `${config.quizProgressFile}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(temporaryFile, config.quizProgressFile);
}

export function normalizeMemoryRecord(record = {}) {
  const attempts = Math.max(0, Math.trunc(Number(record.attempts) || 0));
  const correct = Math.min(attempts, Math.max(0, Math.trunc(Number(record.correct) || 0)));
  const rawLevel = record.level;
  // 新词从中性水平开始，确保首次答对和答错都能产生可见变化。
  const initialLevel = rawLevel === undefined || rawLevel === null || rawLevel === "" ? 50 : Number(rawLevel);
  return {
    level: Math.min(100, Math.max(0, Math.round(Number.isFinite(initialLevel) ? initialLevel : 50))),
    attempts,
    correct,
    streak: Math.max(0, Math.trunc(Number(record.streak) || 0)),
    lastReviewedAt: typeof record.lastReviewedAt === "string" ? record.lastReviewedAt : "",
  };
}

export async function getQuizProgress() {
  const data = await readProgressFile();
  return {
    ...data,
    words: Object.fromEntries(Object.entries(data.words).map(([id, record]) => [id, normalizeMemoryRecord(record)])),
  };
}

/**
 * @description 正确答案按当前水平递减增益，错误答案给予更明显回退，避免熟词一次答对涨幅过大。
 */
export function applyQuizResult(record = {}, isCorrect, now = new Date().toISOString()) {
  const current = normalizeMemoryRecord(record);
  const delta = isCorrect ? Math.max(3, Math.round((100 - current.level) * 0.12)) : -Math.max(8, Math.round(current.level * 0.18));
  return {
    level: Math.min(100, Math.max(0, current.level + delta)),
    attempts: current.attempts + 1,
    correct: current.correct + (isCorrect ? 1 : 0),
    streak: isCorrect ? current.streak + 1 : 0,
    lastReviewedAt: now,
  };
}

export function updateQuizProgress(wordId, isCorrect) {
  return queueProgressMutation(async () => {
    const data = await readProgressFile();
    const record = applyQuizResult(data.words[wordId], isCorrect);
    data.words[wordId] = record;
    data.updatedAt = new Date().toISOString();
    await writeProgressFile(data);
    return record;
  });
}

/**
 * @description 记忆越薄弱权重越高；未答过的词拥有额外探索权重。
 */
export function memoryWeight(record = {}) {
  const normalized = normalizeMemoryRecord(record);
  const weakness = (100 - normalized.level) / 100;
  return 1 + weakness * weakness * 5 + (normalized.attempts === 0 ? 2 : 0);
}

export function pickWeightedWord(words, progressWords = {}, random = Math.random) {
  if (!words.length) return null;
  const weighted = words.map((word) => ({ word, weight: memoryWeight(progressWords[word.id]) }));
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let cursor = random() * total;
  for (const item of weighted) {
    cursor -= item.weight;
    if (cursor < 0) return item.word;
  }
  return weighted.at(-1).word;
}
