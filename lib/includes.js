/**
 * 正文里的引用：`{{> parts/checklist.md}}`。
 *
 * 契约（写进 README 与 schema 注释，编译器只认这一种形态）：
 * - 指令必须**独占一行**；只认 `{{>` 开头的那种，其它 `{{...}}` 是普通文本。
 * - **只展开一层**：被引文件按字面拼入，不再解析。出现第二层引用是 error，不是静默。
 * - 路径两种根：`snippets/…` 相对库根（跨角色共享），其余相对**角色目录**。
 * - 预算按**展开后**字符算；同一文件被引两次就展开两次，不偷偷去重。
 * - 缺文件 / 越界 / 读不到一律 error，带 `AGENT.md:行号`。
 *
 * 为什么不是模板语言：`executionPrompt` 必须是「文件集合的确定性函数」，才能被
 * `promptStats.sha256` 核对、被面板原样展示、被 git diff 解释。一旦有条件和变量，
 * 「到底发出去什么」就变成运行时事实，假绿会原样回来。
 *
 * @module dsh-agent-roster/includes
 */
import { existsSync, readFileSync } from "node:fs";

import { sha256Hex } from "./digest.js";
import { charLength } from "./frontmatter.js";
import { LIMITS2, SNIPPETS_DIR } from "./format-v2.js";
import { diagnostic } from "./parse.js";
import { safeResolve } from "./paths.js";

/** 一整行只有一个引用：前后允许空白，`{{>` 与 `}}` 之间是路径。 */
const INCLUDE_LINE = /^[ \t]*\{\{>[ \t]*(\S+)[ \t]*\}\}[ \t]*$/;

/** 任何 `{{>` 出现即视为「想写引用」——写错了要报错，不能当普通文本发出去。 */
const INCLUDE_MARK = "{{>";

function lineNumberAt(text, index, offset = 0) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line + offset;
}

/**
 * 找出正文里的引用（不展开）。给编译器和「这个角色引了哪些文件」的依赖分析共用。
 *
 * @param {string} text 角色正文（不含 frontmatter）
 * @param {{ lineOffset?: number }} [options] 正文首行在整份文件里的偏移（让报错对到编辑器）
 * @returns {{ items: Array<{path: string, line: number, start: number, end: number}>, diagnostics: object[] }}
 */
export function parseIncludes(text, options = {}) {
  const offset = Number.isInteger(options.lineOffset) ? options.lineOffset : 0;
  const source = String(text ?? "");
  const items = [];
  const diagnostics = [];
  let cursor = 0;
  for (const raw of source.split("\n")) {
    const start = cursor;
    const end = cursor + raw.length;
    cursor = end + 1;
    if (!raw.includes(INCLUDE_MARK)) continue;
    const match = INCLUDE_LINE.exec(raw);
    if (match === null) {
      diagnostics.push(
        diagnostic(
          "error",
          "include-syntax",
          "prompt.include",
          `第 ${lineNumberAt(source, start, offset)} 行的引用写法不合法：「${raw.trim()}」——引用必须独占一行，形如 {{> parts/checklist.md}}`,
          "AGENT.md",
        ),
      );
      continue;
    }
    items.push({ path: match[1], line: lineNumberAt(source, start, offset), start, end });
  }
  return { items, diagnostics };
}

/**
 * 展开正文里的引用（一层）。
 *
 * @param {object} input
 * @param {string} input.text 角色正文
 * @param {string} input.file 报错用的文件名（通常是 `AGENT.md`）
 * @param {string} input.roleDir 角色目录（相对路径的第一种根）
 * @param {string|null} [input.libraryRoot] 库根（`snippets/` 的根）；没有时引用 snippets 会报错
 * @param {number} [input.lineOffset] 正文首行在整份文件里的偏移（默认 0）
 * @returns {{ ok: boolean, text: string, includes: object[], diagnostics: object[] }}
 */
export function expandIncludes({ text, file = "AGENT.md", roleDir, libraryRoot = null, lineOffset = 0 }) {
  const source = String(text ?? "");
  const parsed = parseIncludes(source, { lineOffset });
  const diagnostics = [...parsed.diagnostics];
  const includes = [];

  if (parsed.items.length > LIMITS2.includes) {
    diagnostics.push(
      diagnostic("error", "too-many-includes", "prompt.include", `引用最多 ${LIMITS2.includes} 处，现在是 ${parsed.items.length}`, file),
    );
  }

  // 从后往前替换：前面已经算好的偏移量不受影响。
  let output = source;
  const ordered = parsed.items.slice().sort((left, right) => right.start - left.start);
  for (const item of ordered) {
    const shared = item.path.startsWith(`${SNIPPETS_DIR}/`);
    const base = shared ? libraryRoot : roleDir;
    if (base === null || base === undefined) {
      diagnostics.push(
        diagnostic(
          "error",
          "library-root-unknown",
          "prompt.include",
          `${file}:${item.line} 引用了 ${item.path}，但这次加载不知道库根（snippets/ 只能相对库根解析）`,
          file,
        ),
      );
      continue;
    }
    const resolved = safeResolve(base, item.path);
    if (resolved === null) {
      diagnostics.push(
        diagnostic("error", "unsafe-include", "prompt.include", `${file}:${item.line} 引用的路径不允许越出可读范围：${item.path}`, file),
      );
      continue;
    }
    if (!existsSync(resolved)) {
      diagnostics.push(
        diagnostic(
          "error",
          "missing-include",
          "prompt.include",
          `${file}:${item.line} 引用的文件不存在：${item.path}${shared ? "（相对库根）" : "（相对角色目录）"}`,
          file,
        ),
      );
      continue;
    }
    let body;
    try {
      body = readFileSync(resolved, "utf8");
    } catch (error) {
      diagnostics.push(
        diagnostic("error", "unreadable-include", "prompt.include", `${file}:${item.line} 读不到 ${item.path}：${error?.message ?? error}`, file),
      );
      continue;
    }
    if (body.includes(INCLUDE_MARK)) {
      diagnostics.push(
        diagnostic(
          "error",
          "include-nested",
          "prompt.include",
          `${file}:${item.line} 引用的 ${item.path} 里还有引用——只展开一层，第二层不会被解析`,
          file,
        ),
      );
      continue;
    }
    const chars = charLength(body);
    if (chars > LIMITS2.includeChars) {
      diagnostics.push(
        diagnostic(
          "error",
          "include-too-long",
          "prompt.include",
          `${file}:${item.line} 引用的 ${item.path} 有 ${chars} 字符，超过 ${LIMITS2.includeChars}`,
          file,
        ),
      );
      continue;
    }
    includes.push({ path: item.path, line: item.line, chars, sha256: sha256Hex(body) });
    output = `${output.slice(0, item.start)}${body.replace(/\n$/, "")}${output.slice(item.end)}`;
  }

  // 替换是从后往前做的，但清单要按正文顺序报告（读的人按行号核对）。
  includes.sort((left, right) => left.line - right.line);
  return { ok: !diagnostics.some((item) => item.severity === "error"), text: output, includes, diagnostics };
}
