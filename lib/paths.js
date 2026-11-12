/**
 * 相对路径的边界：片段、引用、示例、能力文件共用的唯一实现。
 *
 * 为什么单独成模块：`role.js`（片段与引用）与 `compile2.js`（人设、示例）都要这条规则，
 * 而 `includes.js` 又不能反过来 import `role.js`（会成环）。规则只写一次，谁都可以用。
 *
 * @module dsh-agent-roster/paths
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import nodePath from "node:path";

/** 相对路径安全：非空、非绝对、不含 `..` 段、不含反斜杠与协议头。 */
export function isSafeRelative(value) {
  if (typeof value !== "string" || value === "") return false;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  // `./x` 是人的习惯写法，等价于 `x`；但它不能掩盖真正的越界（`..` 一律拒绝）。
  const normalized = value.replace(/^(\.\/)+/, "");
  if (normalized === "") return false;
  return normalized.split("/").every((segment) => segment !== ".." && segment !== "" && segment !== ".");
}

/** 把相对路径解析到基准目录内；越界返回 null（含符号链接逃逸）。 */
export function safeResolve(baseDir, relative) {
  if (!isSafeRelative(relative)) return null;
  const base = nodePath.resolve(String(baseDir));
  const resolved = nodePath.resolve(base, relative);
  const prefix = base.endsWith(nodePath.sep) ? base : base + nodePath.sep;
  if (resolved !== base && !resolved.startsWith(prefix)) return null;
  try {
    if (existsSync(resolved)) {
      const realBase = realpathSync(base);
      const realResolved = realpathSync(resolved);
      const realPrefix = realBase.endsWith(nodePath.sep) ? realBase : realBase + nodePath.sep;
      if (realResolved !== realBase && !realResolved.startsWith(realPrefix)) return null;
    }
  } catch {
    return null;
  }
  return resolved;
}

/** 共享角色目录：标准名 `shared-roles/`，旧名 `roles/` 仍读（标准名优先）。 */
export const SHARED_ROLES_DIR_NAMES = Object.freeze(["shared-roles", "roles"]);

/** 档案本地角色目录：`rosters/<id>/roles/`，只被这一份档案引用，同名时压过共享角色。 */
export const LOCAL_ROLES_DIR = "roles";

function isDirAt(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 找到库的共享角色目录；没有就返回 null。 */
export function sharedRolesDir(rootDir) {
  for (const name of SHARED_ROLES_DIR_NAMES) {
    const dir = nodePath.join(String(rootDir), name);
    if (isDirAt(dir)) return { dir, name, legacy: name !== SHARED_ROLES_DIR_NAMES[0] };
  }
  return null;
}

/** 档案自己的角色目录（`rosters/<id>/roles/`）；没有就返回 null。 */
export function localRolesDir(rosterDir) {
  const dir = nodePath.join(String(rosterDir), LOCAL_ROLES_DIR);
  return isDirAt(dir) ? dir : null;
}
