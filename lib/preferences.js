/**
 * 每个档案库自己的偏好——目前只有一项：比对运行时与档案时，发现可写回的机械字段要不要直接写。
 *
 * 为什么不全放配置里：插件在部署里可能是 bundle 装进来的，`configEditor` 只编辑
 * profile patch 里已有那一行；写不进配置时，偏好跟着库走（和收藏同一个位置），
 * 换机器、换 profile 都还在。配置里的 `captureAutoApply` 仍然优先：它是全局默认。
 */
import fs from "node:fs";
import nodePath from "node:path";

export const PREFERENCES_FILE = ".dsh-roster-preferences.json";
export const PREFERENCES_KIND = "dsh-agent-roster/preferences@1";

/** @param {string} rootDir 档案库根 */
export function preferencesPath(rootDir) {
  return nodePath.join(rootDir, PREFERENCES_FILE);
}

/**
 * 读库偏好；文件坏了或没有都按"没开"处理，不阻断工具。
 *
 * @param {string} rootDir
 * @returns {{captureAutoApply: boolean, present: boolean}}
 */
export function readPreferences(rootDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(preferencesPath(rootDir), "utf8"));
    return { captureAutoApply: parsed?.captureAutoApply === true, present: true };
  } catch {
    return { captureAutoApply: false, present: false };
  }
}

/**
 * 合并写入库偏好（原子替换）。
 *
 * @param {string} rootDir
 * @param {{captureAutoApply?: boolean}} patch
 */
export function writePreferences(rootDir, patch) {
  const current = readPreferences(rootDir);
  const next = {
    kind: PREFERENCES_KIND,
    captureAutoApply: patch.captureAutoApply ?? current.captureAutoApply,
  };
  const file = preferencesPath(rootDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * 记住「以后都自动写回」：优先改部署配置（可见、可被团队共享），
 * 写不进配置时退回这个库的偏好文件。
 *
 * @param {object} ctx 插件 context
 * @param {string} rootDir 档案库根
 * @returns {Promise<"config"|"library"|"failed">}
 */
export async function rememberCaptureAutoApply(ctx, rootDir) {
  const editor = ctx?.get?.("configEditor");
  if (editor !== null && editor !== undefined && typeof editor.edit === "function" && typeof editor.entries === "function") {
    const entry = editor
      .entries()
      .find((item) => item?.name === "@stofone/dsh-agent-roster" || item?.id === "agent-roster");
    if (entry !== undefined) {
      try {
        await editor.edit(entry, (current) => ({ ...current, captureAutoApply: true }));
        return "config";
      } catch {
        // 落回库偏好
      }
    }
  }
  try {
    writePreferences(rootDir, { captureAutoApply: true });
    return "library";
  } catch {
    return "failed";
  }
}
