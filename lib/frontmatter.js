/**
 * Markdown + YAML frontmatter 解析：把一份 `AGENT.md` 拆成「参数」（frontmatter）与「人设」（正文）。
 *
 * 为什么不用一种方言装两种内容：散文需要高亮、diff、lint；参数需要机器校验。
 * 混在一个 YAML 块标量里，缩进错一格内容就静默变形（v1 的真实痛点，见 issue #3）。
 *
 * 解析只回答「这段文本能否拆成两块」，语义校验交给 `role.js`；失败一律转诊断，不抛异常。
 *
 * @module dsh-agent-roster/frontmatter
 */
import { diagnostic } from "./parse.js";

const FENCE = /^---[ \t]*$/;

/**
 * 拆分 frontmatter 与正文。
 *
 * 规则（写死在这里，作为格式的一部分）：
 * 1. 第一行必须是 `---`（允许前面有空行与 BOM，但只有这一种围栏）；
 * 2. 结束围栏是**独占一行**的 `---`；
 * 3. 正文只去掉开头连续的空白行，其余原样保留（不做 dedent、不改缩进）。
 *
 * @param {string} text 文件全文
 * @param {{ file?: string }} [options]
 * @returns {{ ok: boolean, frontmatter: string | null, body: string, diagnostics: object[] }}
 */
export function splitFrontmatter(text, options = {}) {
  const file = String(options.file ?? "");
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  const diagnostics = [];

  if (source.trim() === "") {
    diagnostics.push(diagnostic("error", "empty-document", "", "文档为空", file));
    return { ok: false, frontmatter: null, body: "", diagnostics };
  }

  const lines = source.split("\n");
  let index = 0;
  while (index < lines.length && lines[index].trim() === "") index += 1;

  if (index >= lines.length || !FENCE.test(lines[index])) {
    diagnostics.push(
      diagnostic(
        "error",
        "missing-frontmatter",
        "",
        "AGENT.md 必须以独占一行的 --- 开头，紧接着 YAML frontmatter；正文放在第二个 --- 之后",
        file,
      ),
    );
    return { ok: false, frontmatter: null, body: "", diagnostics };
  }

  const start = index + 1;
  let end = -1;
  for (let cursor = start; cursor < lines.length; cursor += 1) {
    if (FENCE.test(lines[cursor])) {
      end = cursor;
      break;
    }
  }

  if (end === -1) {
    diagnostics.push(
      diagnostic("error", "unterminated-frontmatter", "", "frontmatter 没有结束围栏（缺少独占一行的 ---）", file),
    );
    return { ok: false, frontmatter: null, body: "", diagnostics };
  }

  const frontmatter = lines.slice(start, end).join("\n");
  if (frontmatter.trim() === "") {
    diagnostics.push(diagnostic("error", "empty-frontmatter", "", "frontmatter 为空：至少要有 kind / name / version / role", file));
    return { ok: false, frontmatter: null, body: "", diagnostics };
  }

  let bodyStart = end + 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") bodyStart += 1;
  const body = lines.slice(bodyStart).join("\n").replace(/\s+$/, "");

  if (body === "") {
    diagnostics.push(
      diagnostic("error", "empty-body", "body", "正文为空：人设写在第二个 --- 之后；空人设不会被当成“用默认值”", file),
    );
    return { ok: false, frontmatter, body: "", diagnostics };
  }

  return { ok: true, frontmatter, body, diagnostics };
}

/**
 * 把正文与片段按格式规定的语义拼成最终 executionPrompt。
 *
 * 拼装规则是格式的一部分：`join("\n\n", [body, ...parts])`。
 * 除了 roster 层允许的 prepend / append，没有第二个改变顺序或分隔符的入口。
 *
 * @param {string} body 角色正文
 * @param {string[]} parts 片段正文（按 frontmatter 里的顺序）
 * @param {{ prepend?: string, append?: string }} [extra] roster 层追加
 * @returns {{ text: string, parts: string[] }}
 */
export function assemblePrompt(body, parts, extra = {}) {
  const blocks = [];
  if (typeof extra.prepend === "string" && extra.prepend !== "") blocks.push(extra.prepend);
  if (body !== "") blocks.push(body);
  for (const part of parts ?? []) if (typeof part === "string" && part !== "") blocks.push(part);
  if (typeof extra.append === "string" && extra.append !== "") blocks.push(extra.append);
  return { text: blocks.join("\n\n"), parts: blocks.map((block) => block.length) };
}

/** 字符数（人设预算按字符计，不按字节，也不猜 token）。 */
export function charLength(text) {
  return [...String(text ?? "")].length;
}
