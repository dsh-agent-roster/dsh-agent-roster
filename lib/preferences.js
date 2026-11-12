/**
 * 每个档案库自己的偏好——目前只有一项：比对运行时与档案时，发现可写回的机械字段要不要直接写。
 *
 * 为什么不全放配置里：插件在部署里可能是 bundle 装进来的，`configEditor` 只编辑
 * profile patch 里已有那一行；写不进配置时，偏好跟着库走（和收藏同一个位置），
 * 换机器、换 profile 都还在。配置里的 `captureAutoApply` 仍然优先：它是全局默认。
 */
import fs from "node:fs";
import nodePath from "node:path";

import { globalRosterRoot } from "./home.js";

export const PREFERENCES_FILE = ".dsh-roster-preferences.json";
export const PREFERENCES_KIND = "dsh-agent-roster/preferences@1";

/** 自动登记的库最多保留多少个（防止一个人点了上百个临时目录后无法收拾）。 */
export const LIBRARY_DIR_LIMIT = 16;

/** @param {string} rootDir 档案库根 */
export function preferencesPath(rootDir) {
  return nodePath.join(rootDir, PREFERENCES_FILE);
}

/**
 * 读库偏好；文件坏了或没有都按"没开"处理，不阻断工具。
 *
 * @param {string} rootDir
 * @returns {{captureAutoApply: boolean, iterateMode: string, iterateArchive: string, libraryDirs: string[], present: boolean}}
 */
export function readPreferences(rootDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(preferencesPath(rootDir), "utf8"));
    return {
      captureAutoApply: parsed?.captureAutoApply === true,
      iterateMode: typeof parsed?.iterateMode === "string" ? parsed.iterateMode : "",
      iterateArchive: typeof parsed?.iterateArchive === "string" ? parsed.iterateArchive : "",
      libraryDirs: normalizeDirs(parsed?.libraryDirs),
      present: true,
    };
  } catch {
    return { captureAutoApply: false, iterateMode: "", iterateArchive: "", libraryDirs: [], present: false };
  }
}

/** 只收绝对路径；相对路径在"跟着库走"的偏好里没有意义（基准会随机器变）。 */
function normalizeDirs(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed === "" || !nodePath.isAbsolute(trimmed)) continue;
    seen.add(nodePath.resolve(trimmed));
  }
  return [...seen].slice(-LIBRARY_DIR_LIMIT);
}

/**
 * 合并写入库偏好（原子替换）。
 *
 * @param {string} rootDir
 * @param {{captureAutoApply?: boolean, iterateMode?: string, iterateArchive?: string, libraryDirs?: string[]}} patch
 */
export function writePreferences(rootDir, patch) {
  const current = readPreferences(rootDir);
  const next = {
    kind: PREFERENCES_KIND,
    captureAutoApply: patch.captureAutoApply ?? current.captureAutoApply,
    iterateMode: patch.iterateMode ?? current.iterateMode,
    iterateArchive: patch.iterateArchive ?? current.iterateArchive,
    libraryDirs: patch.libraryDirs ?? current.libraryDirs,
  };
  const file = preferencesPath(rootDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * 工具用过的库根：自动登记，面板与只读工具都能看见它。
 *
 * 存在全局库的偏好文件里（不是每座库各记一份）：被登记的目录本来就不在任何一座库里，
 * 记在库内会变成"只有那座库看得见"。写失败不影响本次调用，只是下次仍然看不见。
 *
 * @param {string} dir 库根绝对路径
 * @returns {{ok: boolean, added: boolean, code?: string, dirs?: string[]}}
 */
export function rememberLibraryDir(dir) {
  const wanted = typeof dir === "string" ? dir.trim() : "";
  if (wanted === "" || !nodePath.isAbsolute(wanted)) return { ok: false, added: false, code: "invalid-dir" };
  const root = globalRosterRoot();
  const current = readPreferences(root).libraryDirs;
  const resolved = nodePath.resolve(wanted);
  if (current.includes(resolved)) return { ok: true, added: false, dirs: current };
  const next = [...current, resolved].slice(-LIBRARY_DIR_LIMIT);
  try {
    fs.mkdirSync(root, { recursive: true });
    writePreferences(root, { libraryDirs: next });
    return { ok: true, added: true, dirs: next };
  } catch {
    return { ok: false, added: false, code: "write-failed" };
  }
}

/**
 * 自动登记过的库根（全局读取，读不到就是空）。
 *
 * @returns {string[]}
 */
export function registeredLibraryDirs() {
  return readPreferences(globalRosterRoot()).libraryDirs;
}

/**
 * 撤销自动登记（用户手动移除时用；不存在也算成功）。
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function forgetLibraryDir(dir) {
  const root = globalRosterRoot();
  const wanted = nodePath.resolve(String(dir ?? ""));
  const current = readPreferences(root).libraryDirs;
  const next = current.filter((item) => item !== wanted);
  if (next.length === current.length) return true;
  try {
    writePreferences(root, { libraryDirs: next });
    return true;
  } catch {
    return false;
  }
}

/**
 * 记住「以后都自动写回」：优先改部署配置（可见、可被团队共享），
 * 写不进配置时退回这个库的偏好文件。
 *
 * @param {object} ctx 插件 context
 * @param {string} rootDir 档案库根
 * @returns {Promise<"config"|"library"|"failed">}
 */
export async function rememberPreference(ctx, rootDir, patch) {
  const editor = ctx?.get?.("configEditor");
  if (editor !== null && editor !== undefined && typeof editor.edit === "function" && typeof editor.entries === "function") {
    const entry = editor
      .entries()
      .find((item) => item?.name === "@stofone/dsh-agent-roster" || item?.id === "agent-roster");
    if (entry !== undefined) {
      try {
        await editor.edit(entry, (current) => ({ ...current, ...patch }));
        return "config";
      } catch {
        // 落回库偏好
      }
    }
  }
  try {
    writePreferences(rootDir, patch);
    return "library";
  } catch {
    return "failed";
  }
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
  return rememberPreference(ctx, rootDir, { captureAutoApply: true });
}
