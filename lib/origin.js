/**
 * 远端来源账本：拉下来的空间改过没有、远端动过没有。
 *
 * 为什么需要它：`clone` 写出的 `space.yaml` 只记 `origin: {repo, ref, path}`，
 * 记不下"拉的是哪一版、每个文件当时是什么内容"。于是本地编辑之后，既不知道
 * 自己改了什么（没有基线），也不知道远端有没有新版本（没有可比对的摘要）。
 *
 * 账本是本地副本根目录下的点文件 `.dsh-roster-origin.json`（扫描器跳过 `.` 开头的条目）：
 *
 * ```json
 * { "kind": "dsh-agent-roster/origin@1", "origin": {...}, "commit": "...", "pulledAt": "...",
 *   "files": { "rosters/api-design/roster.yaml": { "sha256": "...", "blob": null } } }
 * ```
 *
 * 六态：`clean`（两边都没动）/ `local-only`（只有本地改了）/ `remote-only`（只有远端改了）/
 * `diverged`（两边都改了）/ `remote-deleted`（远端删了）/ `missing`（本地文件不见了）。
 *
 * **不做自动合并**：YAML 加散文没有 merge base，自动合并只会造出重名成员和静默改语义的档案。
 * 冲突就停下，把两边的 sha 与 diff 摆出来，由人决定。
 *
 * @module dsh-agent-roster/origin
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";

import { parse as parseYaml, parseDocument as parseYamlDocument } from "yaml";

import { isSafeRelative } from "./paths.js";

const SPACE_FILE_NAMES = ["space.yaml", "space.yml", "space.json"];
const SPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * 远端 `space.yaml` 里声明、但账本没记的文件（知识文档、新加的档案）。
 *
 * 为什么需要：update 原来只比对账本里记过的文件。上游**新增**一个文件时，
 * 账本里根本没有它，于是永远报“干净”——2026-11 就有一次：远端给 examples
 * 加了 `knowledge/project-map.md`，本地副本却一直显示已是最新。
 */
export function declaredSpaceFiles(text) {
  if (typeof text !== "string") return [];
  let space;
  try {
    space = parseYaml(text);
  } catch {
    return [];
  }
  if (space === null || typeof space !== "object") return [];
  const flat = space.layout === "flat";
  const paths = [];
  for (const item of Array.isArray(space.knowledge) ? space.knowledge : []) {
    if (item !== null && typeof item === "object" && isSafeRelative(item.path ?? "")) paths.push(item.path);
  }
  for (const item of Array.isArray(space.rosters) ? space.rosters : []) {
    const id = typeof item === "string" ? item : item?.id;
    if (typeof id === "string" && SPACE_ID_PATTERN.test(id)) {
      paths.push(flat ? `${id}/roster.yaml` : `rosters/${id}/roster.yaml`);
    }
  }
  return paths;
}

/** 账本文件名；点开头，扫描器本来就会跳过。 */
export const ORIGIN_FILE = ".dsh-roster-origin.json";

/** 账本格式版本。 */
export const ORIGIN_KIND = "dsh-agent-roster/origin@1";

const RAW = "https://raw.githubusercontent.com";
const API = "https://api.github.com";

/** 单个空间最多记这么多文件；再多就不是"一份档案空间"了。 */
export const ORIGIN_FILE_LIMIT = 500;

/** 目录里的相对路径只允许这些形态（与 clone 的写盘守卫一致）。 */
const SAFE_RELATIVE = /^(?:\.[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * 七态：前六个是"两边都比对过"的结论，`unverified` 是"远端没回话，根本没核对上"。
 * 单独给它一个状态，是为了不把"没核对"显示成"干净"——那是假绿。
 */
export const CHANGE_STATES = ["clean", "local-only", "remote-only", "diverged", "remote-deleted", "missing", "unverified"];

/** @param {string | Buffer} content */
export function sha256Of(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** @param {string} dir */
export function originPath(dir) {
  return nodePath.join(dir, ORIGIN_FILE);
}

/**
 * 读账本；没有就是 `null`（不是错误：手写的库没有账本也能用）。
 *
 * @param {string} dir
 * @returns {object | null}
 */
export function readOrigin(dir) {
  const file = originPath(dir);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { broken: true, file, reason: "账本不是合法 JSON；按没有账本处理。" };
  }
  if (value === null || typeof value !== "object" || value.kind !== ORIGIN_KIND) {
    return { broken: true, file, reason: `账本的 kind 不是 ${ORIGIN_KIND}；按没有账本处理。` };
  }
  const origin = value.origin !== null && typeof value.origin === "object" ? value.origin : {};
  const files = {};
  for (const [relative, entry] of Object.entries(value.files ?? {})) {
    if (!SAFE_RELATIVE.test(relative)) continue;
    if (entry === null || typeof entry !== "object") continue;
    const sha = typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/.test(entry.sha256) ? entry.sha256 : null;
    if (sha === null) continue;
    files[relative] = { sha256: sha, blob: typeof entry.blob === "string" ? entry.blob : null };
  }
  return {
    kind: ORIGIN_KIND,
    file,
    origin: {
      repo: typeof origin.repo === "string" ? origin.repo : "",
      ref: typeof origin.ref === "string" ? origin.ref : "",
      path: typeof origin.path === "string" ? origin.path : "",
    },
    commit: typeof value.commit === "string" ? value.commit : null,
    pulledAt: typeof value.pulledAt === "string" ? value.pulledAt : null,
    files,
  };
}

/**
 * 写账本（原子替换）。
 *
 * @param {string} dir
 * @param {{ origin: object, commit?: string | null, files: Record<string, {sha256: string, blob?: string | null}>, pulledAt?: string }} input
 * @returns {{ ok: boolean, code?: string, reason?: string }}
 */
export function writeOrigin(dir, input) {
  const files = {};
  for (const [relative, entry] of Object.entries(input.files ?? {})) {
    if (!SAFE_RELATIVE.test(relative)) continue;
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) continue;
    files[relative] = { sha256: entry.sha256, blob: typeof entry.blob === "string" ? entry.blob : null };
  }
  const value = {
    kind: ORIGIN_KIND,
    origin: input.origin,
    commit: typeof input.commit === "string" ? input.commit : null,
    pulledAt: typeof input.pulledAt === "string" ? input.pulledAt : new Date().toISOString(),
    files,
  };
  const target = originPath(dir);
  const temp = `${target}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temp, target);
    return { ok: true };
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // 失败清理失败不影响主结论。
    }
    return { ok: false, code: "write-failed", reason: String(error?.message ?? error) };
  }
}

/**
 * 目录里被账本跟踪的相对路径（不含 `space.yaml`：它是本地生成的封面，不是远端文件）。
 *
 * @param {string} dir
 * @param {string[]} relatives
 * @returns {Record<string, string | null>} 相对路径 → 本地 sha256（文件不在则 null）
 */
export function localDigests(dir, relatives) {
  const out = {};
  for (const relative of relatives) {
    if (!SAFE_RELATIVE.test(relative)) continue;
    try {
      out[relative] = sha256Of(fs.readFileSync(nodePath.join(dir, ...relative.split("/"))));
    } catch {
      out[relative] = null;
    }
  }
  return out;
}

function joinUrl(base, relative) {
  return `${base}${relative
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

/**
 * 远端内容摘要：逐文件拉 raw。空间通常十几个文件，比读整棵树再解码更省事，
 * 也避免为一次检查引入 GitHub tree API 的分页与截断语义。
 *
 * @param {{ repo: string, ref: string, path: string }} origin
 * @param {string[]} relatives
 * @param {((url: string, init?: object) => Promise<object>) | null} fetchImpl
 * @returns {Promise<Record<string, { sha256: string | null, status: number }>>}
 */
export async function remoteDigests(origin, relatives, fetchImpl, options = {}) {
  const out = {};
  if (typeof fetchImpl !== "function") {
    for (const relative of relatives) out[relative] = { sha256: null, status: 0 };
    return out;
  }
  // 账本里的 repo 可能带 `github:` 前缀（旧版本克隆写下的），拼 URL 前统一归一。
  const repo = String(origin.repo ?? "").replace(/^github:/, "");
  const base = `${RAW}/${repo}/${encodeURIComponent(origin.ref || "main")}/${origin.path === "" ? "" : `${origin.path}/`}`;
  const wanted = Math.max(1, Math.min(8, Number.isFinite(options.concurrency) ? Number(options.concurrency) : 6));
  let cursor = 0;
  // 逐文件串行在 500 个文件时要几十秒；小并发既不压垮 GitHub，也不会让面板看起来卡死。
  async function worker() {
    while (cursor < relatives.length) {
      const relative = relatives[cursor];
      cursor += 1;
      try {
        const response = await fetchImpl(joinUrl(base, relative), { headers: { accept: "*/*" } });
        if (!response.ok) {
          out[relative] = { sha256: null, status: Number(response.status ?? 0) };
          continue;
        }
        const text = await response.text();
        out[relative] = { sha256: sha256Of(text), status: 200, text };
      } catch (error) {
        out[relative] = { sha256: null, status: 0, reason: String(error?.message ?? error) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(wanted, relatives.length) }, () => worker()));
  return out;
}

/**
 * 逐文件判定状态。
 *
 * @param {string} relative
 * @param {string | null} ledgerSha
 * @param {string | null} localSha
 * @param {{ sha256: string | null, status: number }} remote
 * @returns {string}
 */
export function changeState(relative, ledgerSha, localSha, remote, options = {}) {
  const localChanged = localSha !== null && localSha !== ledgerSha;
  const localMissing = localSha === null;
  const remoteGone = remote.status === 404;
  if (localMissing) return "missing";
  if (remoteGone) return "remote-deleted";
  const remoteKnown = remote.sha256 !== null;
  // `compared === false` 是"这次刻意不连远端"（只看本地改动），那不叫没核对上。
  if (!remoteKnown) {
    if (localChanged) return "local-only";
    return options.compared === false ? "clean" : "unverified";
  }
  const remoteChanged = remote.sha256 !== ledgerSha;
  if (localChanged && remoteChanged) return "diverged";
  if (localChanged) return "local-only";
  if (remoteChanged) return "remote-only";
  return "clean";
}

/**
 * 计算一份本地副本与远端的差异。
 *
 * @param {string} dir 本地副本根目录（含 `.dsh-roster-origin.json`）
 * @param {{ fetchImpl?: Function | null, refresh?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, code?: string, origin: object | null, commit: string | null, entries: object[], summary: Record<string, number>, text?: string }>}
 */
function readSpaceTextSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export async function checkOrigin(dir, options = {}) {
  const ledger = readOrigin(dir);
  if (ledger === null) {
    return {
      ok: false,
      code: "no-origin-ledger",
      origin: null,
      commit: null,
      entries: [],
      summary: {},
      text: `目录 ${dir} 里没有 ${ORIGIN_FILE}：这份副本不是用 clone 拉的，或者拉取早于 1.5.0。先重新拉一次，才有可比的基线。`,
    };
  }
  if (ledger.broken === true) {
    return { ok: false, code: "origin-ledger-broken", origin: null, commit: null, entries: [], summary: {}, text: ledger.reason };
  }
  // 账本是磁盘上的文件，可能被人手改：只认安全的相对路径，越界的条目直接不算数
  // （否则 applyFastForward 会照着账本写到空间目录外面去）。
  const relatives = Object.keys(ledger.files).filter((relative) => isSafeRelative(relative)).sort();
  const local = localDigests(dir, relatives);
  const remote = options.refresh === false
    ? Object.fromEntries(relatives.map((relative) => [relative, { sha256: null, status: 0 }]))
    : await remoteDigests(ledger.origin, relatives, options.fetchImpl ?? null);
  const compareRemote = options.refresh !== false;
  const entriesBase = relatives.map((relative) => {
    const ledgerSha = ledger.files[relative].sha256;
    const seen = remote[relative] ?? { sha256: null, status: 0 };
    const state = changeState(relative, ledgerSha, local[relative], seen, { compared: compareRemote });
    return {
      path: relative,
      state,
      ledger: ledgerSha,
      local: local[relative],
      remote: seen.sha256 ?? null,
      remoteStatus: seen.status ?? 0,
      // 远端没回话（网络/限频）：本地没改时 state 直接是 unverified；本地改过时 state
      // 仍是 local-only，但这里也标 true，面板因此不会把两者混成"已是最新"。
      unverified: compareRemote && seen.sha256 === null && seen.status !== 404,
      // 只在"远端确实读到了内容"时带文本；调用方要用它覆盖本地时不必再拉一次。
      remoteText: typeof seen.text === "string" ? seen.text : null,
    };
  });
  // 远端 space.yaml 里新声明、账本没记的文件：账本里没有它们，就永远比不出"远端新增"。
  // 这里补两类：knowledge[] 与 rosters[]（按 layout 推出 roster 文件路径）。
  // 账本里通常没有 space.yaml（clone 单独写封面），所以封面要按名字单独取一次。
  const coverEntry = entriesBase.find((entry) => SPACE_FILE_NAMES.includes(entry.path));
  let coverText = coverEntry === undefined ? null : coverEntry.remoteText;
  if (coverText === null && compareRemote) {
    const fetchedCover = await remoteDigests(ledger.origin, SPACE_FILE_NAMES, options.fetchImpl ?? null);
    for (const name of SPACE_FILE_NAMES) {
      if (typeof fetchedCover[name]?.text === "string") {
        coverText = fetchedCover[name].text;
        break;
      }
    }
  }
  const declared = declaredSpaceFiles(coverText);
  const extraPaths = declared.filter((relative) => !(relative in ledger.files));
  let entries = entriesBase;
  if (extraPaths.length > 0) {
    const extraRemote = compareRemote
      ? await remoteDigests(ledger.origin, extraPaths, options.fetchImpl ?? null)
      : Object.fromEntries(extraPaths.map((relative) => [relative, { sha256: null, status: 0 }]));
    const extraLocal = localDigests(dir, extraPaths);
    const extra = extraPaths.flatMap((relative) => {
      const seen = extraRemote[relative] ?? { sha256: null, status: 0 };
      if ((seen.status ?? 0) === 404) return [];
      const localSha = extraLocal[relative] ?? null;
      // 本地没有、远端有 ⇒ 可以被快进；本地已有（同名未登记文件）⇒ 只报告，不动它。
      const state = localSha === null ? (compareRemote ? "remote-only" : "unverified") : "local-only";
      return [{
        path: relative,
        state,
        ledger: null,
        local: localSha,
        remote: seen.sha256 ?? null,
        remoteStatus: seen.status ?? 0,
        unverified: compareRemote && seen.sha256 === null && seen.status !== 404,
        remoteText: typeof seen.text === "string" ? seen.text : null,
        declared: true,
      }];
    });
    entries = [...entriesBase, ...extra];
  }
  // 本地封面落后于远端声明（典型：远端新加了 knowledge[]）时，把封面也当作一次快进，
  // 但只合并声明段，保留本地封面里的 origin——那是"这份副本从哪来"的唯一记录。
  if (coverText !== null && declared.length > 0) {
    const localName = SPACE_FILE_NAMES.find((name) => fs.existsSync(nodePath.join(dir, name)));
    if (localName !== undefined) {
      const localCover = readSpaceTextSafe(nodePath.join(dir, localName));
      const localDeclared = new Set(declaredSpaceFiles(localCover));
      const missing = declared.filter((relative) => !localDeclared.has(relative));
      if (missing.length > 0) {
        entries = [...entries, {
          path: localName,
          state: "remote-only",
          ledger: null,
          local: sha256Of(localCover),
          remote: sha256Of(coverText),
          remoteStatus: 200,
          unverified: false,
          remoteText: coverText,
          cover: true,
        }];
      }
    }
  }
  const summary = { clean: 0, "local-only": 0, "remote-only": 0, diverged: 0, "remote-deleted": 0, missing: 0, unverified: 0 };
  for (const entry of entries) {
    summary[entry.state] = (summary[entry.state] ?? 0) + 1;
    // unverified 既是一个状态、也是一个标记：state 已是 unverified 的不能再加一次。
    if (entry.unverified && entry.state !== "unverified") summary.unverified += 1;
  }
  const pending = summary["remote-only"] + summary.diverged + summary["remote-deleted"];
  // 能自动快进的只有 remote-only；冲突与远端删除要人看，不能混进"更新"里。
  const fastForward = summary["remote-only"];
  return {
    ok: true,
    origin: ledger.origin,
    commit: ledger.commit,
    pulledAt: ledger.pulledAt,
    entries,
    summary,
    pending,
    fastForward,
    unverified: summary.unverified,
    text: renderChanges(entries, summary, ledger),
  };
}

/**
 * 应用"远端改了、本地没动"的文件（快进）。冲突一律不碰。
 *
 * @param {string} dir
 * @param {object[]} entries `checkOrigin` 的 entries
 * @returns {{ applied: string[], skipped: string[], ok: boolean }}
 */
/**
 * 合并封面：远端声明（knowledge / rosters）覆盖本地，本地 origin 原样保留。
 * 用 Document 而不是 stringify，尽量不破坏作者写的注释与字段顺序。
 */
function mergeSpaceCover(localText, remoteText) {
  let remote;
  try {
    remote = parseYaml(remoteText);
  } catch {
    return remoteText;
  }
  if (localText === "" || remote === null || typeof remote !== "object") return remoteText;
  const document = parseYamlDocument(localText);
  if (document.errors.length > 0) return remoteText;
  for (const key of ["knowledge", "rosters", "shared-roles", "roles", "layout"]) {
    if (remote[key] !== undefined) document.set(key, document.createNode(remote[key]));
  }
  return String(document);
}

export function applyFastForward(dir, entries) {
  const applied = [];
  const skipped = [];
  const ledger = readOrigin(dir);
  if (ledger === null || ledger.broken === true) return { applied, skipped, ok: false };
  const files = { ...ledger.files };
  for (const entry of entries) {
    if (!isSafeRelative(entry.path)) {
      skipped.push(entry.path);
      continue;
    }
    if (entry.state !== "remote-only" || typeof entry.remoteText !== "string") {
      if (entry.state !== "clean" && entry.state !== "local-only") skipped.push(entry.path);
      continue;
    }
    const target = nodePath.join(dir, ...entry.path.split("/"));
    try {
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      if (entry.cover === true) {
        fs.writeFileSync(target, mergeSpaceCover(readSpaceTextSafe(target), entry.remoteText), "utf8");
        applied.push(entry.path);
        continue;
      }
      fs.writeFileSync(target, entry.remoteText, "utf8");
      files[entry.path] = { sha256: sha256Of(entry.remoteText), blob: entry.remoteBlob ?? null };
      applied.push(entry.path);
    } catch {
      skipped.push(entry.path);
    }
  }
  if (applied.length > 0) {
    const written = writeOrigin(dir, { origin: ledger.origin, commit: ledger.commit, pulledAt: ledger.pulledAt, files });
    if (!written.ok) return { applied: [], skipped: entries.map((entry) => entry.path), ok: false };
  }
  return { applied, skipped, ok: true };
}

/**
 * 认账：把指定文件的基线改成当前本地内容（"保留本地"就是把它接受为新的起点）。
 *
 * @param {string} dir
 * @param {string[]} relatives
 * @returns {{ ok: boolean, updated: string[] }}
 */
export function acceptLocal(dir, relatives) {
  const ledger = readOrigin(dir);
  if (ledger === null || ledger.broken === true) return { ok: false, updated: [] };
  const files = { ...ledger.files };
  const updated = [];
  for (const relative of relatives) {
    // `in` 会命中原型链（toString、__proto__）；只认账本自己的、且不越界的键。
    if (!Object.hasOwn(files, relative) || !isSafeRelative(relative)) continue;
    try {
      const bytes = fs.readFileSync(nodePath.join(dir, ...relative.split("/")));
      files[relative] = { sha256: sha256Of(bytes), blob: null };
      updated.push(relative);
    } catch {
      // 本地也没了：不认账，让它继续显示 missing。
    }
  }
  if (updated.length === 0) return { ok: true, updated };
  const written = writeOrigin(dir, { origin: ledger.origin, commit: ledger.commit, pulledAt: ledger.pulledAt, files });
  return { ok: written.ok, updated };
}

/**
 * 给账本补 commit 与 blob（clone 拉完时调一次；网络失败就留空，不影响拉取）。
 *
 * @param {{ repo: string, ref: string }} origin
 * @param {Function | null} fetchImpl
 * @returns {Promise<{ commit: string | null }>}
 */
export async function resolveCommit(origin, fetchImpl) {
  if (typeof fetchImpl !== "function" || typeof origin?.repo !== "string" || origin.repo === "") return { commit: null };
  try {
    const repo = String(origin.repo ?? "").replace(/^github:/, "");
    const response = await fetchImpl(`${API}/repos/${repo}/commits/${encodeURIComponent(origin.ref || "main")}`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) return { commit: null };
    const body = JSON.parse(await response.text());
    return { commit: typeof body?.sha === "string" ? body.sha : null };
  } catch {
    return { commit: null };
  }
}

/**
 * 人读的一段差异说明。
 *
 * @param {object[]} entries
 * @param {Record<string, number>} summary
 * @param {object} ledger
 * @returns {string}
 */
export function renderChanges(entries, summary, ledger) {
  const lines = [];
  lines.push(`来源 ${ledger.origin.repo}@${ledger.origin.ref}${ledger.origin.path === "" ? "" : `/${ledger.origin.path}`}`);
  lines.push(`拉取于 ${ledger.pulledAt ?? "-"}${ledger.commit === null ? "" : ` · commit ${ledger.commit.slice(0, 8)}`}`);
  lines.push(
    `干净 ${summary.clean} · 仅本地 ${summary["local-only"]} · 仅远端 ${summary["remote-only"]} · 冲突 ${summary.diverged} · 远端删除 ${summary["remote-deleted"]} · 本地缺失 ${summary.missing}` +
      ((summary.unverified ?? 0) > 0 ? ` · 无法核对 ${summary.unverified}（远端没回话，不是"干净"）` : ""),
  );
  const interesting = entries.filter((entry) => entry.state !== "clean");
  if (interesting.length === 0) {
    lines.push("", "没有变化。");
    return lines.join("\n");
  }
  lines.push("");
  for (const entry of interesting) {
    const note =
      entry.state === "unverified"
        ? "远端没回话，无法核对"
        : entry.state === "diverged"
        ? `两改：本地 ${entry.local?.slice(0, 8) ?? "-"} / 远端 ${entry.remote?.slice(0, 8) ?? "-"}（不自动合并）`
        : entry.state === "remote-deleted"
          ? "远端已删除（本地保留）"
          : entry.state === "missing"
            ? "本地文件不见了"
            : entry.state === "local-only"
              ? "只有本地改过"
              : "远端有新版本（可快进）";
    lines.push(`  ${entry.path}  ${entry.state}  ${note}`);
  }
  return lines.join("\n");
}
