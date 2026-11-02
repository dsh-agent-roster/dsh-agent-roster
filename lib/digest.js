/**
 * 摘要工具：把"看不见的东西"变成可以比对的一行字。
 *
 * 两个用途，都是 issue #2 暴露出来的盲区：
 * - **档案文件内容**：团队状态里没有"由哪一版档案建成"的字段，只能把文件内容的 sha256
 *   写进 `agent_teams_create` 的 description（溯源串），下次核对比的是同一份字节。
 * - **物化后的工具策略**：`team.json` 里除了 `toolPolicy` 这个 id，还存了策略被展开成工具名
 *   之后的 `toolFilter` {@code {deny:[…]}}。只比 id 会在"部署侧改了策略定义"时永远绿，
 *   所以要比这一坨工具名的规范化摘要。
 *
 * 规范化一律按"排序 + JSON.stringify"：键序与元素顺序不同不算变化，否则每次重排都会假报漂移。
 *
 * @module dsh-agent-roster/digest
 */
import { createHash } from "node:crypto";

/**
 * 计算文本的 sha256 十六进制摘要。
 *
 * @param {string | Uint8Array} input
 * @returns {string} 64 位小写十六进制
 */
export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * 取摘要前 8 位：打印、写进 description 时用短的，避免把一行文字撑得太长。
 *
 * @param {string | null | undefined} hex
 * @returns {string}
 */
export function shortSha(hex) {
  return typeof hex === "string" && hex !== "" ? hex.slice(0, 8) : "";
}

/**
 * 把一个成员的工具过滤器折叠成"可比较的形状"。
 *
 * 缺失、非对象、字段类型不对时返回 `null`——读不到就是读不到，不编一个空摘要出来，
 * 否则"没有 toolFilter"会被伪装成"toolFilter 与别人一致"。
 *
 * @param {unknown} toolFilter `team.json` 成员的 `toolFilter`
 * @returns {{ deny: number, allow: number, sha: string } | null}
 */
export function toolFilterDigest(toolFilter) {
  if (toolFilter === null || typeof toolFilter !== "object" || Array.isArray(toolFilter)) return null;
  const deny = namesOf(toolFilter.deny);
  const allow = namesOf(toolFilter.allow);
  if (deny === null && allow === null) return null;
  const canonical = JSON.stringify({ allow: allow ?? [], deny: deny ?? [] });
  return { deny: (deny ?? []).length, allow: (allow ?? []).length, sha: shortSha(sha256Hex(canonical)) };
}

/**
 * 取出字符串数组并排序去重；不是数组时返回 `null`，让调用方区分"空"与"没有这个键"。
 *
 * @param {unknown} value
 * @returns {string[] | null}
 */
function namesOf(value) {
  if (!Array.isArray(value)) return null;
  const names = value.filter((item) => typeof item === "string" && item !== "");
  return [...new Set(names)].sort();
}
