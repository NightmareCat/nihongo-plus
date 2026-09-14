/**
 * @file repository.mjs
 * @description JSON 模块化词库仓储；负责无损迁移、查重、筛选与持久化。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.mjs";
import { fillMissingStoredCategory, normalizeStoredWord, normalizeWordPatch } from "./word-schema.mjs";

const EMPTY_META = { schemaVersion: 1, name: "个人收集", updatedAt: "", words: [] };
let libraryMutationTail = Promise.resolve();

function queueLibraryMutation(operation) {
  const result = libraryMutationTail.then(operation, operation);
  libraryMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

export function normalizeTerm(value = "") {
  return String(value)
    .normalize("NFKC")
    .trim()
    .replace(/^[~〜～]+|[~〜～]+$/g, "")
    .replace(/\s+/g, "")
    .toLocaleLowerCase("ja-JP");
}

function createRecord(term, overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id || crypto.randomUUID(),
    term: String(term).trim(),
    reading: "",
    partOfSpeech: { category: "未分类", detail: "", conjugationClass: "", transitivity: "" },
    meanings: [],
    jlpt: "未定",
    tags: [],
    conjugations: [],
    examples: [],
    notes: "",
    aiStatus: "pending",
    // 学习分类独立于词性；paused 词条仍保留在词库，但不进入记忆和考核。
    studyStatus: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tempFile, file);
}

export async function initializeRepository() {
  const existing = await readJson(config.libraryFile, null);
  if (existing) return existing;

  const legacy = await readJson(config.legacyLibraryFile, { name: "个人收集", words: [] });
  const seen = new Set();
  const words = [];

  // 首次启动时将旧字符串数组迁移为结构化记录，并保留原文件作为只读来源。
  for (const term of legacy.words || []) {
    const key = normalizeTerm(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    words.push(createRecord(term));
  }

  const library = { ...EMPTY_META, name: legacy.name || "个人收集", updatedAt: new Date().toISOString(), words };
  await writeJson(config.libraryFile, library);
  await writeJson(config.collectionsFile, { schemaVersion: 1, collections: [] });
  return library;
}

export async function getLibrary() {
  const library = await readJson(config.libraryFile, EMPTY_META);
  // 兼容此前已补全但 category 漏填的数据，读取时从词性细分和标签恢复分类。
  return { ...library, words: library.words.map((word) => normalizeStoredWord(fillMissingStoredCategory(word))) };
}

export async function getCollections() {
  return readJson(config.collectionsFile, { schemaVersion: 1, collections: [] });
}

export async function findDuplicate(term, exceptId = "") {
  const key = normalizeTerm(term);
  if (!key) return null;
  const library = await getLibrary();
  return library.words.find((word) => word.id !== exceptId && normalizeTerm(word.term) === key) || null;
}

export function addWord(input) {
  return queueLibraryMutation(async () => {
    const duplicate = await findDuplicate(input.term);
    if (duplicate) return { duplicate };

    const library = await getLibrary();
    const record = createRecord(input.term, sanitizeWordInput(input));
    library.words.unshift(record);
    library.updatedAt = new Date().toISOString();
    await writeJson(config.libraryFile, library);
    return { word: record };
  });
}

function sanitizeWordInput(input) {
  const allowed = ["reading", "partOfSpeech", "meanings", "jlpt", "tags", "conjugations", "examples", "notes", "aiStatus", "studyStatus"];
  const selected = Object.fromEntries(allowed.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
  return normalizeWordPatch(selected);
}

export function updateWord(id, patch) {
  return queueLibraryMutation(async () => {
    const library = await getLibrary();
    const index = library.words.findIndex((word) => word.id === id);
    if (index < 0) return null;
    const previous = library.words[index];
    const resolvedPatch = typeof patch === "function" ? await patch(previous) : patch;
    if (resolvedPatch.term) {
      const duplicate = await findDuplicate(resolvedPatch.term, id);
      if (duplicate) return { duplicate };
    }
    library.words[index] = {
      ...previous,
      ...sanitizeWordInput(resolvedPatch),
      term: resolvedPatch.term?.trim() || previous.term,
      id: previous.id,
      createdAt: previous.createdAt,
      updatedAt: new Date().toISOString(),
    };
    library.updatedAt = new Date().toISOString();
    await writeJson(config.libraryFile, library);
    return { word: library.words[index] };
  });
}

export function deleteWord(id) {
  return queueLibraryMutation(async () => {
    const library = await getLibrary();
    const before = library.words.length;
    library.words = library.words.filter((word) => word.id !== id);
    if (library.words.length === before) return false;
    library.updatedAt = new Date().toISOString();
    await writeJson(config.libraryFile, library);

    // 同步清理子词库中的失效引用。
    const collectionData = await getCollections();
    collectionData.collections = collectionData.collections.map((collection) => ({
      ...collection,
      wordIds: collection.wordIds.filter((wordId) => wordId !== id),
    }));
    await writeJson(config.collectionsFile, collectionData);
    return true;
  });
}

export async function saveCollection(input) {
  const data = await getCollections();
  const now = new Date().toISOString();
  const existingIndex = input.id ? data.collections.findIndex((item) => item.id === input.id) : -1;
  const collection = {
    id: input.id || crypto.randomUUID(),
    name: String(input.name || "新子词库").trim(),
    description: String(input.description || "").trim(),
    color: input.color || "#d85b36",
    wordIds: [...new Set(input.wordIds || [])],
    updatedAt: now,
  };
  if (existingIndex >= 0) data.collections[existingIndex] = collection;
  else data.collections.push(collection);
  await writeJson(config.collectionsFile, data);
  return collection;
}

export async function deleteCollection(id) {
  const data = await getCollections();
  const before = data.collections.length;
  data.collections = data.collections.filter((item) => item.id !== id);
  await writeJson(config.collectionsFile, data);
  return data.collections.length !== before;
}
