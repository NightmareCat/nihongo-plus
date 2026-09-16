/**
 * @file server.mjs
 * @description Nihongo Plus 本地服务入口；提供静态 UI、词库 REST API 与 AI 补全代理。
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./src/config.mjs";
import { conjugationOptions, enrichWord, mergeEnrichment } from "./src/deepseek.mjs";
import {
  addWord,
  deleteCollection,
  deleteWord,
  findDuplicate,
  getCollections,
  getLibrary,
  initializeRepository,
  normalizeTerm,
  saveCollection,
  updateWord,
} from "./src/repository.mjs";
import { getPublicSettings, saveSettings } from "./src/settings.mjs";
import { generateQuizQuestion, QUIZ_TYPES, compatibleQuizTypes } from "./src/quiz.mjs";
import { getQuizProgress, normalizeMemoryRecord, pickWeightedWord, updateQuizProgress } from "./src/quiz-progress.mjs";

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
const activeQuizQuestions = new Map();

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error("请求内容过大"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function handleApi(request, response, url) {
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const [library, collectionData, settings, quizProgress] = await Promise.all([getLibrary(), getCollections(), getPublicSettings(), getQuizProgress()]);
    return sendJson(response, 200, {
      library,
      collections: collectionData.collections,
      options: { conjugations: conjugationOptions, quizTypes: QUIZ_TYPES.map(({ id, label }) => ({ id, label })) },
      settings,
      quizProgress,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/quiz/generate") {
    // 丢弃长时间未提交的答案，避免本地服务长期运行时积累无效题目。
    const expiry = Date.now() - 30 * 60 * 1_000;
    for (const [id, question] of activeQuizQuestions) {
      if (question.createdAt < expiry) activeQuizQuestions.delete(id);
    }
    const body = await readBody(request);
    const [library, settings, quizProgress] = await Promise.all([getLibrary(), getPublicSettings(), getQuizProgress()]);
    const requestedType = QUIZ_TYPES.find((type) => type.id === body.type);
    const eligibleWords = library.words.filter((word) => word.studyStatus !== "paused"
      && settings.practiceJlptLevels.includes(word.jlpt)
      && (!requestedType?.verbsOnly || word.partOfSpeech?.category === "动词"));
    if (!eligibleWords.length) {
      return sendJson(response, 422, { error: requestedType?.verbsOnly ? "当前练习范围内没有可用于动词变形题的动词" : "当前练习范围内没有可出题的词条" });
    }

    // 先按记忆薄弱程度选择核心词，再选择该词兼容的题型。
    const word = pickWeightedWord(eligibleWords, quizProgress.words);
    const compatibleTypes = requestedType ? [requestedType] : compatibleQuizTypes(word);
    const type = compatibleTypes[Math.floor(Math.random() * compatibleTypes.length)];
    const distractorWords = library.words
      .filter((item) => item.id !== word.id)
      .sort(() => Math.random() - 0.5)
      .slice(0, 8)
      .map(({ term, reading, meanings, partOfSpeech, jlpt }) => ({ term, reading, meanings, partOfSpeech, jlpt }));
    const abortController = new AbortController();
    const cancelUpstream = () => { if (!response.writableEnded) abortController.abort(); };
    response.once("close", cancelUpstream);
    try {
      const generated = await generateQuizQuestion(word, type, distractorWords, abortController.signal);
      activeQuizQuestions.set(generated.id, { ...generated, wordId: word.id, wordTerm: word.term, createdAt: Date.now() });
      // 显式挑选公开题面字段，答案、解析和干扰词资料只在提交后返回。
      const publicQuestion = {
        id: generated.id,
        type: generated.type,
        typeLabel: generated.typeLabel,
        question: generated.question,
        stem: generated.stem,
        options: generated.options.map(({ id, text }) => ({ id, text })),
      };
      return sendJson(response, 200, {
        question: {
          ...publicQuestion,
          memoryLevel: normalizeMemoryRecord(quizProgress.words[word.id]).level,
        },
      });
    } finally {
      response.off("close", cancelUpstream);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/quiz/answer") {
    const body = await readBody(request);
    const stored = activeQuizQuestions.get(String(body.questionId || ""));
    if (!stored) return sendJson(response, 404, { error: "该试题已失效，请生成下一题" });
    const selectedOptionId = String(body.optionId || "");
    if (!stored.options.some((option) => option.id === selectedOptionId)) return sendJson(response, 400, { error: "请选择一个有效选项" });
    activeQuizQuestions.delete(stored.id);
    const correct = selectedOptionId === stored.correctOptionId;
    const [progress, library] = await Promise.all([updateQuizProgress(stored.wordId, correct), getLibrary()]);
    // “是否收录”始终以本地词库为准；已收录词优先展示人工维护的释义和等级。
    const distractorWords = stored.distractorWords.map((item) => {
      const existing = library.words.find((word) => normalizeTerm(word.term) === normalizeTerm(item.term));
      return {
        term: item.term,
        reading: existing?.reading || item.reading || "待读音",
        meaning: existing?.meanings?.join("；") || item.meaning || "暂无释义",
        jlpt: existing?.jlpt && existing.jlpt !== "未定" ? existing.jlpt : item.jlpt,
        origin: item.origin,
        collected: Boolean(existing),
        wordId: existing?.id || "",
      };
    });
    return sendJson(response, 200, {
      result: {
        correct,
        correctOptionId: stored.correctOptionId,
        wordId: stored.wordId,
        wordTerm: stored.wordTerm,
        analysis: stored.analysis,
        options: stored.options,
        distractorWords,
        progress,
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/settings") {
    return sendJson(response, 200, { settings: await getPublicSettings() });
  }
  if (request.method === "PATCH" && url.pathname === "/api/settings") {
    return sendJson(response, 200, { settings: await saveSettings(await readBody(request)) });
  }

  if (request.method === "GET" && url.pathname === "/api/duplicate") {
    const duplicate = await findDuplicate(url.searchParams.get("term") || "");
    return sendJson(response, 200, { duplicate });
  }

  if (request.method === "POST" && url.pathname === "/api/words") {
    const body = await readBody(request);
    if (!body.term?.trim()) return sendJson(response, 400, { error: "请输入单词或语法结构" });
    const result = await addWord(body);
    return sendJson(response, result.duplicate ? 409 : 201, result);
  }

  if (parts[0] === "api" && parts[1] === "words" && parts[2]) {
    const id = decodeURIComponent(parts[2]);
    if (request.method === "PATCH") {
      const result = await updateWord(id, await readBody(request));
      return sendJson(response, result?.duplicate ? 409 : result ? 200 : 404, result || { error: "词条不存在" });
    }
    if (request.method === "DELETE") {
      return sendJson(response, (await deleteWord(id)) ? 200 : 404, { ok: true });
    }
    if (request.method === "POST" && parts[3] === "enrich") {
      const library = await getLibrary();
      const word = library.words.find((item) => item.id === id);
      if (!word) return sendJson(response, 404, { error: "词条不存在" });
      const body = await readBody(request);
      const mode = ["missing", "replace", "fields"].includes(body.mode) ? body.mode : "missing";
      const fields = Array.isArray(body.fields) ? body.fields : [];
      const abortController = new AbortController();
      const cancelUpstream = () => { if (!response.writableEnded) abortController.abort(); };
      response.once("close", cancelUpstream);
      try {
        // 浏览器主动取消或断开时同步终止上游 AI 请求，避免后台继续消耗连接和额度。
        const enriched = await enrichWord(word, body.exampleCount, mode, fields, abortController.signal);
        // 在写入队列内部读取最新版，确保后台结果不会覆盖生成期间的手动修改。
        const result = await updateWord(id, (latestWord) => {
          if (mode !== "missing" && latestWord.updatedAt !== word.updatedAt) {
            const conflict = new Error("生成期间词条已被修改；为避免覆盖手动内容，本次结果未保存");
            conflict.statusCode = 409;
            throw conflict;
          }
          return mergeEnrichment(latestWord, enriched, mode, fields);
        });
        if (!result) return sendJson(response, 404, { error: "生成期间词条已被删除" });
        return sendJson(response, 200, result);
      } finally {
        response.off("close", cancelUpstream);
      }
    }
  }

  if (request.method === "POST" && url.pathname === "/api/collections") {
    return sendJson(response, 201, { collection: await saveCollection(await readBody(request)) });
  }
  if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "collections" && parts[2]) {
    return sendJson(response, (await deleteCollection(parts[2])) ? 200 : 404, { ok: true });
  }

  return sendJson(response, 404, { error: "接口不存在" });
}

async function serveStatic(response, url) {
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(config.publicDir, `.${decodeURIComponent(requestPath)}`);
  if (!filePath.startsWith(path.resolve(config.publicDir))) return sendJson(response, 403, { error: "拒绝访问" });
  try {
    const content = await fs.readFile(filePath);
    // 本地开发应用不缓存前端资源，避免设置逻辑更新后浏览器继续运行旧版超时规则。
    response.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      const html = await fs.readFile(path.join(config.publicDir, "index.html"));
      response.writeHead(200, { "Content-Type": MIME[".html"] });
      return response.end(html);
    }
    throw error;
  }
}

await initializeRepository();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else await serveStatic(response, url);
  } catch (error) {
    // 浏览器刷新、关闭或用户停止批处理属于预期取消，不作为服务器故障打印堆栈。
    const expectedCancellation = error.statusCode === 499 || error.code === "ECONNRESET";
    if (!expectedCancellation) console.error(error);
    if (!response.writableEnded && !response.destroyed) {
      sendJson(response, error.statusCode || 500, { error: error.message || "服务器内部错误" });
    }
  }
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Nihongo Plus 已启动：http://127.0.0.1:${config.port}`);
});
