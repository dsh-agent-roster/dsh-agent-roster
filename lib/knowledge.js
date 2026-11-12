/**
 * 共享知识（`knowledge/`）：**概要进提示词，正文按需打开**。
 *
 * 为什么不是「整篇内联」：知识文档是项目级材料，同一份会被多个成员用到；
 * 全文拼进每个人的 executionPrompt，既吃 12000 的预算，又让「档案改了/文件改了」
 * 无法区分——正文一旦复制进产物，漂移就再也核不出来。
 *
 * 为什么也不是「只给路径」：只有路径，模型不知道该不该打开、打开哪一份；
 * 它需要一行「这是什么」。
 *
 * 所以格式就定成：标题 + 一行概要 + 路径。概要有两种来源——
 * 文件 frontmatter 的 `summary`，或正文第一个非标题段落（截断到 200 字符）。
 *
 * 想把正文整段放进人设，仍然走 `{{> knowledge/…}}`——那是显式引用，与这里的声明不同。
 *
 * @module dsh-agent-roster/knowledge
 */
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { sha256Hex } from "./digest.js";
import { KNOWLEDGE_DIR, LIMITS2 } from "./format-v2.js";
import { diagnostic } from "./parse.js";

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const HEADING = /^#{1,6}\s+(.+?)\s*$/;

/**
 * 把声明值归一成库根相对路径。
 *
 * 接受 `knowledge/x.md`（完整）或 `x` / `x.md`（简写，补 `knowledge/`）。
 * 只做字符串规范化，不碰磁盘；是否越界由 `safeResolve` 那一层管。
 *
 * @param {unknown} value
 * @returns {string} 归一后的路径；无法归一返回 ""
 */
export function normalizeKnowledgeRef(value) {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (raw === "") return "";
  if (raw.startsWith(`${KNOWLEDGE_DIR}/`)) return raw;
  if (raw.includes("/")) return raw;
  return `${KNOWLEDGE_DIR}/${raw.endsWith(".md") ? raw : `${raw}.md`}`;
}

/** 从正文里取第一段（跳过标题、空行与引用符），压成一行。 */
function firstParagraph(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const collected = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || HEADING.test(trimmed)) {
      if (started) break;
      continue;
    }
    if (/^(```|~~~)/.test(trimmed)) break;
    started = true;
    collected.push(trimmed.replace(/^>\s*/, ""));
    if (collected.join(" ").length >= LIMITS2.knowledgeSummaryChars) break;
  }
  return collected.join(" ").replace(/\s+/g, " ").trim();
}

/** 从正文里取第一个标题。 */
function firstHeading(body) {
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const match = HEADING.exec(line.trim());
    if (match !== null) return match[1].trim();
  }
  return "";
}

/**
 * 解析一份知识文件的文本（纯函数）：frontmatter 可选。
 *
 * @param {string} text
 * @param {{ file?: string }} [options]
 * @returns {{ title: string, summary: string, body: string, chars: number, sha256: string }}
 */
export function parseKnowledgeText(text, options = {}) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  let meta = {};
  let body = source;

  const match = FRONTMATTER.exec(source);
  if (match !== null) {
    // 知识文件不引入完整的 YAML 依赖：只认 `title:` / `summary:` 两行，
    // 其余一律忽略——它不是一个有 schema 的文档，只是一段带标题的材料。
    for (const line of match[1].split(/\r?\n/)) {
      const pair = /^(title|summary)\s*:\s*(.*)$/.exec(line.trim());
      if (pair === null) continue;
      meta[pair[1]] = pair[2].replace(/^["']|["']$/g, "").trim();
    }
    body = source.slice(match[0].length);
  }

  const title = (typeof meta.title === "string" && meta.title !== "" ? meta.title : firstHeading(body)) || "";
  let summary = typeof meta.summary === "string" ? meta.summary.trim() : "";
  if (summary === "") summary = firstParagraph(body);
  summary = summary.slice(0, LIMITS2.knowledgeSummaryChars).trim();

  return {
    title: title.slice(0, LIMITS2.knowledgeTitleChars),
    summary,
    body,
    chars: body.length,
    sha256: sha256Hex(source),
  };
}

/**
 * 读一份知识条目：路径相对库根。
 *
 * @param {string} libraryRoot
 * @param {string} reference 声明值（`knowledge/x.md` 或 `x`）
 * @param {{ file?: string, field?: string }} [options]
 * @returns {{ ok: boolean, entry: object | null, diagnostics: object[] }}
 */
export function loadKnowledgeEntry(libraryRoot, reference, options = {}) {
  const file = String(options.file ?? "");
  const field = String(options.field ?? "knowledge");
  const diagnostics = [];
  const relative = normalizeKnowledgeRef(reference);

  if (relative === "" || !relative.startsWith(`${KNOWLEDGE_DIR}/`) || relative.includes("..")) {
    diagnostics.push(
      diagnostic("error", "invalid-knowledge", field, `知识引用必须是 ${KNOWLEDGE_DIR}/<name>.md：${String(reference)}`, file),
    );
    return { ok: false, entry: null, diagnostics };
  }

  const abs = nodePath.join(libraryRoot, relative);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    diagnostics.push(
      diagnostic("error", "missing-knowledge", field, `知识文件不存在：${relative}（相对库根 ${libraryRoot}）`, file),
    );
    return { ok: false, entry: null, diagnostics };
  }

  const parsed = parseKnowledgeText(text, { file: relative });
  return {
    ok: true,
    entry: { path: relative, title: parsed.title, summary: parsed.summary, sha256: parsed.sha256, chars: parsed.chars },
    diagnostics,
  };
}

/**
 * 把一组知识条目渲染成提示词里的一段。
 *
 * 只要条目为空就返回 ""（调用方据此决定是否追加），不产生空标题。
 *
 * @param {Array<{path: string, title?: string, summary?: string}>} entries
 * @returns {string}
 */
export function formatKnowledgeBlock(entries) {
  const list = Array.isArray(entries) ? entries.filter((item) => typeof item?.path === "string" && item.path !== "") : [];
  if (list.length === 0) return "";
  const lines = list.slice(0, LIMITS2.knowledgePerPrompt).map((item) => {
    const title = typeof item.title === "string" && item.title !== "" ? item.title : nodePath.basename(item.path, ".md");
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    return summary === "" ? `- ${title}（${item.path}）` : `- ${title}（${item.path}）：${summary}`;
  });
  return [
    "项目知识（这里只给概要，正文按需打开对应路径；不要凭概要臆造细节）：",
    ...lines,
    "",
  ].join("\n");
}
