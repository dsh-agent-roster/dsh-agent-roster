/**
 * 工具输出的小工具：统一的状态行。
 *
 * 六个老工具与五个新工具共用同一行格式（`[tool] key=value …`），
 * 这样"给人读的一行"在各工具间不会因为复制粘贴而漂移。
 *
 * @module dsh-agent-roster/tool-output
 */

/**
 * 一行状态：`[roster_list] rosters=3 ok=true`。
 *
 * @param {string} tool 工具名
 * @param {Record<string, unknown>} fields 字段（按传入顺序，原样显示）
 * @returns {string}
 */
export function statusLine(tool, fields) {
  return `[${tool}] ${Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")}`;
}
