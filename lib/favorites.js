import fs from "node:fs";
import nodePath from "node:path";

/**
 * 收藏 = 用户自己的一句话：「这几份我要常看」。
 *
 * 它不属于档案，也不属于团队状态：档案被删、团队被拆，收藏都该留着（留着不影响谁），
 * 所以存在库根的一个点文件里，跟着库走——换机器把库带走，收藏也带走。
 *
 * 文件格式固定成 `{kind, favorites: [id...]}`；读到别的东西（手写数组、被人改成注释）也不算错，
 * 只是当空处理并给一条 warn，别让一条坏文件把整座库变成红色。
 */

export const FAVORITES_FILE = ".dsh-roster-favorites.json";
export const FAVORITES_KIND = "dsh-agent-roster/favorites@1";
export const FAVORITES_LIMIT = 500;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function favoritesPath(rootDir) {
  return nodePath.join(rootDir, FAVORITES_FILE);
}

function emptyState() {
  return { ids: new Set(), file: FAVORITES_FILE, present: false, broken: false };
}

/**
 * 读一座库的收藏。
 *
 * @param {string} rootDir
 * @returns {{ ids: Set<string>, file: string, present: boolean, broken: boolean }}
 */
export function readFavorites(rootDir) {
  if (typeof rootDir !== "string" || rootDir === "") return emptyState();
  let text;
  try {
    text = fs.readFileSync(favoritesPath(rootDir), "utf8");
  } catch {
    return emptyState();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...emptyState(), present: true, broken: true };
  }
  // 允许手写成 `["a","b"]`；但 `{}` 或 `{"favorites":"a"}` 这类读不懂的形状要留痕。
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.favorites) ? parsed.favorites : null;
  if (list === null) return { ...emptyState(), present: true, broken: true };
  const ids = new Set(
    list
      .filter((value) => typeof value === "string" && ID_PATTERN.test(value))
      .slice(0, FAVORITES_LIMIT),
  );
  return { ids, file: FAVORITES_FILE, present: true, broken: false };
}

/** 文件坏掉时给面板一条 warn；好文件与「文件还没建」都不出声。 */
export function favoriteDiagnostic(rootDir, state = readFavorites(rootDir)) {
  if (state.broken !== true) return null;
  return {
    severity: "warn",
    code: "favorites-unreadable",
    path: "",
    file: FAVORITES_FILE,
    reason:
      `${FAVORITES_FILE} 读不懂（既不是数组，也没有 favorites 数组），这一轮当作没有收藏。` +
      "在面板里点一次收藏会把这个文件重写成标准形状。",
  };
}

/**
 * 写回整份收藏。原子替换：先写临时文件再 rename，中途断电不会留半截 JSON。
 *
 * @param {string} rootDir
 * @param {Iterable<string>} ids
 * @returns {{ ok: true, favorites: string[] } | { ok: false, code: string, message?: string }}
 */
export function writeFavorites(rootDir, ids) {
  if (typeof rootDir !== "string" || rootDir === "") return { ok: false, code: "unknown-root" };
  const clean = [...new Set([...ids].filter((value) => typeof value === "string" && ID_PATTERN.test(value)))]
    .sort()
    .slice(0, FAVORITES_LIMIT);
  const body = `${JSON.stringify({ kind: FAVORITES_KIND, favorites: clean }, null, 2)}\n`;
  const target = favoritesPath(rootDir);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(temp, body, "utf8");
    fs.renameSync(temp, target);
    return { ok: true, favorites: clean };
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // 临时文件清不掉不影响结论：真正的问题在下面的 message 里。
    }
    return { ok: false, code: "write-failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 收藏 / 取消收藏一份档案。重复收藏与取消不收藏都是幂等的。
 *
 * @param {string} rootDir
 * @param {string} id
 * @param {boolean} favorite
 */
export function setFavorite(rootDir, id, favorite) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return { ok: false, code: "invalid-id" };
  const state = readFavorites(rootDir);
  const ids = new Set(state.ids);
  if (favorite === true) ids.add(id);
  else ids.delete(id);
  return writeFavorites(rootDir, ids);
}

/**
 * 一次收藏多份（保存/导入成功后用：你动手存过的档案，默认就是你想看的）。
 *
 * @param {string} rootDir
 * @param {string[]} list
 */
export function addFavorites(rootDir, list) {
  const state = readFavorites(rootDir);
  const ids = new Set(state.ids);
  for (const id of list) if (typeof id === "string" && ID_PATTERN.test(id)) ids.add(id);
  return writeFavorites(rootDir, ids);
}
