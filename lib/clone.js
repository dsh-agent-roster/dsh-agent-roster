/**
 * 把一个远端「档案空间」拉成一份本地副本。
 *
 * 为什么不能只拉 `dist/`：编译产物是一份自包含的快照，能读、不能改——
 * 你改它，改的是快照，不是仓库里的任何一个源文件。要让"编辑"和源文件对得上，
 * 拉下来的目录结构必须和仓库里的**同形**：`roles/<role>/AGENT.md`、
 * `rosters/<id>/roster.yaml`、`dist/<id>-<ver>.json`，一条路径都不许改。
 *
 * 三种来源都收：
 * - `space.yaml` 在（layout: monorepo）：按目录树逐文件拉，收到 `dist/`；
 * - `space.yaml` 在（layout: flat）：只拉 `<id>/roster.yaml`；
 * - `space.yaml` 不在（老仓库）：按 flat 处理，并在本地副本上补一份带 `origin` 的 space.yaml。
 *
 * @module dsh-agent-roster/clone
 */

import fs from "node:fs";
import nodePath from "node:path";

import { SNIPPETS_DIR } from "./format-v2.js";
import { resolveCommit, sha256Of, writeOrigin } from "./origin.js";
import { parseDocumentText } from "./parse.js";
import { SPACE_FILE_NAMES, SPACE_KIND, validateSpace } from "./space.js";

const RAW = "https://raw.githubusercontent.com";

/** 拉取并发度：单次 clone 的文件数在几十份量级，6 路够用且不冒犯对方。 */
export const CLONE_CONCURRENCY = 6;

/** 目录里的相对路径只允许这些形态：拼 URL 前先钉死，免得把 `..` 带进写盘。 */
const SAFE_RELATIVE = /^(?:\.[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._-]+)*$/;

function joinUrl(base, relative) {
  const encoded = relative
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}${encoded}`;
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { accept: "application/json, text/plain, */*" } });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, text: await response.text() };
}

/**
 * 正文里引用的共享片段（`{{> snippets/…}}`）。只认独占一行的形态：
 * 写在句子里的那种本地编译会报 `include-syntax`，这里不必替它猜。
 */
export function snippetPathsOf(text) {
  const out = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const match = /^[ \t]*\{\{>[ \t]*(\S+)[ \t]*\}\}[ \t]*$/.exec(line);
    if (match !== null && match[1].startsWith(`${SNIPPETS_DIR}/`)) out.add(match[1]);
  }
  return [...out].sort();
}

/** 角色名取自 `name@1.2.3` 这种引用；取不到就不猜。 */
function roleNameOf(reference) {
  if (typeof reference !== "string") return null;
  const at = reference.lastIndexOf("@");
  return at > 0 ? reference.slice(0, at) : reference;
}

/**
 * 从一份 roster 文档里收集它引用的角色名（成员 + 队长）。
 *
 * @param {object} roster
 * @returns {string[]}
 */
export function rolesOfRoster(roster) {
  const names = new Set();
  for (const member of Array.isArray(roster?.members) ? roster.members : []) {
    const name = roleNameOf(member?.role);
    if (name) names.add(name);
  }
  const captain = roster?.captain;
  if (captain && typeof captain === "object") {
    const name = roleNameOf(captain.role);
    if (name) names.add(name);
  }
  return [...names].sort();
}

/**
 * 拉一个空间到 `<rootDir>/<spaceId>/`。
 *
 * @param {{
 *   rootDir: string,
 *   spaceId: string,
 *   repo: string,
 *   ref?: string,
 *   path?: string,
 *   fetchImpl: (url: string, init?: object) => Promise<object>,
 *   concurrency?: number,
 * }} input
 * @returns {Promise<{ok: boolean, dir: string, layout: string, written: string[], skipped: string[], diagnostics: object[]}>}
 */
export async function cloneSpace(input) {
  const ref = input.ref ?? "main";
  const originPath = input.path ?? "";
  // registry 里的坐标两种写法都合法（`github:owner/repo` 与 `owner/repo`），
  // 拼 URL 前必须归一：`github:` 留下来只会得到 404，然后一路退化成空拉取。
  const repo = String(input.repo ?? "").replace(/^github:/, "");
  const base = `${RAW}/${repo}/${encodeURIComponent(ref)}/${originPath === "" ? "" : `${originPath}/`}`;
  const fetchImpl = input.fetchImpl;
  const concurrency = Math.max(1, Math.min(16, input.concurrency ?? CLONE_CONCURRENCY));
  const diagnostics = [];
  const written = [];
  const skipped = [];

  const read = async (relative) => {
    try {
      return await fetchText(joinUrl(base, relative), fetchImpl);
    } catch (error) {
      diagnostics.push({ severity: "error", code: "clone-fetch-failed", path: relative, file: relative, reason: `拉取失败：${String(error?.message ?? error)}` });
      return { ok: false, status: 0 };
    }
  };

  // 1. 读空间封面；没有就按 flat 老仓库处理。
  let spaceFile = null;
  let raw = null;
  for (const name of SPACE_FILE_NAMES) {
    const got = await read(name);
    if (got.ok) {
      spaceFile = name;
      raw = got.text;
      break;
    }
    if (got.status !== 404 && got.status !== undefined) {
      diagnostics.push({ severity: "warn", code: "clone-space-unreadable", path: name, file: name, reason: `读取 ${name} 返回 ${got.status}。` });
    }
  }

  let space = null;
  let layout = "flat";
  let rosterIds = [];
  if (spaceFile !== null) {
    const parsed = parseDocumentText(raw, { file: spaceFile, format: spaceFile.endsWith(".json") ? "json" : "yaml" });
    if (!parsed.ok) {
      return { ok: false, dir: nodePath.join(input.rootDir, input.spaceId), layout, written, skipped, diagnostics: [...diagnostics, ...parsed.diagnostics] };
    }
    const validated = validateSpace(parsed.value, { file: spaceFile, expectedId: null });
    if (!validated.ok) {
      return { ok: false, dir: nodePath.join(input.rootDir, input.spaceId), layout, written, skipped, diagnostics: [...diagnostics, ...validated.diagnostics] };
    }
    space = validated.space;
    layout = space.layout;
    rosterIds = space.rosters.map((item) => item.id);
  } else {
    // 没有封面：调用方必须给 ids（来自 registry 索引），否则无从下手。
    rosterIds = Array.isArray(input.rosterIds) ? [...input.rosterIds] : [];
    if (rosterIds.length === 0) {
      diagnostics.push({
        severity: "error",
        code: "clone-no-space",
        path: "",
        file: null,
        reason: `${input.repo}@${ref}${originPath === "" ? "" : `/${originPath}`} 没有 space.yaml，调用方也没有给档案 id 列表。`,
      });
      return { ok: false, dir: nodePath.join(input.rootDir, input.spaceId), layout, written, skipped, diagnostics };
    }
  }

  const dir = nodePath.join(input.rootDir, input.spaceId);
  const files = new Map();
  let rosterFound = 0;

  // 2. 档案本体（外加能力要求这种"同目录兄弟文件"）。
  for (const id of rosterIds) {
    const relative = layout === "monorepo" ? `rosters/${id}/roster.yaml` : `${id}/roster.yaml`;
    const got = await read(relative);
    if (!got.ok) {
      skipped.push(relative);
      diagnostics.push({
        severity: "warn",
        code: "clone-roster-missing",
        path: relative,
        file: relative,
        reason: `${id} 在 ${relative} 处读不到（${got.status}）；本地副本会少这一份。`,
      });
      continue;
    }
    files.set(relative, got.text);
    rosterFound += 1;
    if (layout === "monorepo") {
      const capabilities = await read(`rosters/${id}/capabilities.yaml`);
      if (capabilities.ok) files.set(`rosters/${id}/capabilities.yaml`, capabilities.text);
    }
  }

  // 一份档案都没拉到就不是"成功"：只写一份 space.yaml 的空空间会让面板显示
  // 拉取成功、却一个档案都看不到——这正是用户报的"拉取后仍显示未在本机"。
  if (rosterIds.length > 0 && rosterFound === 0) {
    diagnostics.push({
      severity: "error",
      code: "clone-no-rosters",
      path: "",
      file: null,
      reason:
        `在 ${repo}@${ref}${originPath === "" ? "" : `/${originPath}`} 上没有拉到任何档案文件。` +
        `检查 registry 里的 repo/ref/path，或空间的 layout 是否与实际目录一致。`,
    });
    return { ok: false, dir, layout, written, skipped, diagnostics };
  }

  // 3. monorepo：把被引用的角色连同片段一起拉下来，否则本地编译不出人设。
  if (layout === "monorepo") {
    const roles = new Set(space?.roles ?? []);
    for (const [relative, text] of [...files]) {
      if (!relative.endsWith("roster.yaml")) continue;
      const parsed = parseDocumentText(text, { file: relative, format: "yaml" });
      if (!parsed.ok) continue;
      for (const name of rolesOfRoster(parsed.value)) roles.add(name);
    }
    for (const name of [...roles].sort()) {
      const agentPath = `roles/${name}/AGENT.md`;
      const got = await read(agentPath);
      if (!got.ok) {
        if (!skipped.includes(agentPath)) {
          skipped.push(agentPath);
          diagnostics.push({
            severity: "warn",
            code: "clone-role-missing",
            path: agentPath,
            file: agentPath,
            reason: `角色 ${name} 读不到（${got.status}）；本地编译会缺这一份人设。`,
          });
        }
        continue;
      }
      files.set(agentPath, got.text);
      // 片段路径写在 frontmatter 里，只能读完才知道；一次多一跳，不猜。
      for (const part of partPathsOf(got.text)) {
        const partPath = part.startsWith("roles/") ? part : `roles/${name}/${part}`;
        const piece = await read(partPath);
        if (piece.ok) files.set(partPath, piece.text);
        else skipped.push(partPath);
      }
      // 共享片段（`{{> snippets/…}}`）也一并拉：不拉，本地编译就会缺文件。
      for (const snippet of snippetPathsOf(got.text)) {
        if (files.has(snippet)) continue;
        const shared = await read(snippet);
        if (shared.ok) {
          files.set(snippet, shared.text);
        } else {
          skipped.push(snippet);
          diagnostics.push({
            severity: "warn",
            code: "clone-snippet-missing",
            path: snippet,
            file: snippet,
            reason: `角色 ${name} 引用的共享片段 ${snippet} 读不到（${shared.status}）；本地编译会缺这一段。`,
          });
        }
      }
    }
  }

  // 4. 落盘：先写文件，最后写空间封面（封面存在即代表这次 clone 完整）。
  try {
    for (const [relative, text] of files) {
      if (!SAFE_RELATIVE.test(relative)) {
        diagnostics.push({ severity: "error", code: "clone-unsafe-path", path: relative, file: relative, reason: "拒绝写入：路径不是安全的相对路径。" });
        continue;
      }
      const target = nodePath.join(dir, ...relative.split("/"));
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, "utf8");
      written.push(relative);
    }
    const cover = spaceCover({
      space,
      spaceId: input.spaceId,
      layout,
      rosterIds,
      origin: { repo, ref, path: originPath },
    });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "space.yaml"), cover, "utf8");
    written.push("space.yaml");
    // 账本：记下这一版每个文件的摘要。没有它，本地改过之后既没有基线，
    // 也无法判断远端动没动（1.5.0 起的更新检测全靠它）。
    const ledgerFiles = {};
    for (const relative of written) {
      if (relative === "space.yaml") continue;
      const target = nodePath.join(dir, ...relative.split("/"));
      ledgerFiles[relative] = { sha256: sha256Of(fs.readFileSync(target)), blob: null };
    }
    const resolved = await resolveCommit({ repo, ref }, fetchImpl);
    writeOrigin(dir, { origin: { repo, ref, path: originPath }, commit: resolved.commit, files: ledgerFiles });
  } catch (error) {
    diagnostics.push({ severity: "error", code: "clone-write-failed", path: "", file: null, reason: `写盘失败：${String(error?.message ?? error)}` });
    return { ok: false, dir, layout, written, skipped, diagnostics };
  }

  return {
    ok: diagnostics.every((item) => item.severity !== "error"),
    dir,
    layout,
    written,
    skipped,
    diagnostics,
  };
}

/**
 * 从 AGENT.md 的 frontmatter 里取片段路径；解析不了就返回空数组（不猜）。
 *
 * @param {string} text
 * @returns {string[]}
 */
function partPathsOf(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match === null) return [];
  const lines = match[1].split(/\r?\n/);
  const parts = [];
  let inParts = false;
  for (const line of lines) {
    if (/^prompt:\s*$/.test(line)) continue;
    if (/^\s+parts:\s*$/.test(line)) {
      inParts = true;
      continue;
    }
    if (inParts) {
      const item = line.match(/^\s*-\s*(\S+)\s*$/);
      if (item) {
        parts.push(item[1].replace(/^["']|["']$/g, ""));
        continue;
      }
      if (/^\s{0,2}\S/.test(line)) inParts = false;
    }
  }
  return parts;
}

/**
 * 生成本地副本的 `space.yaml`：远端的那份 + `origin`。
 *
 * @param {{space: object|null, spaceId: string, layout: string, rosterIds: string[], origin: {repo: string, ref: string, path: string}}} input
 * @returns {string}
 */
export function spaceCover(input) {
  const title = input.space?.title ?? input.spaceId;
  const description = input.space?.description ?? "";
  const license = input.space?.license ?? "";
  const homepage = input.space?.homepage ?? "";
  const maintainers = input.space?.maintainers ?? [];
  const roles = input.space?.roles ?? [];
  const lines = ["kind: " + SPACE_KIND, `space: ${input.spaceId}`, `title: ${yamlScalar(title)}`];
  if (description !== "") lines.push(`description: ${yamlScalar(description)}`);
  if (license !== "") lines.push(`license: ${yamlScalar(license)}`);
  if (homepage !== "") lines.push(`homepage: ${yamlScalar(homepage)}`);
  if (maintainers.length > 0) {
    lines.push("maintainers:");
    for (const who of maintainers) lines.push(`  - ${yamlScalar(who)}`);
  }
  lines.push(`layout: ${input.layout}`);
  lines.push("origin:");
  lines.push(`  repo: ${yamlScalar(input.origin.repo)}`);
  lines.push(`  ref: ${yamlScalar(input.origin.ref)}`);
  if (input.origin.path !== "") lines.push(`  path: ${yamlScalar(input.origin.path)}`);
  if (roles.length > 0) {
    lines.push("roles:");
    for (const name of roles) lines.push(`  - ${yamlScalar(name)}`);
  }
  lines.push("rosters:");
  for (const id of input.rosterIds) lines.push(`  - id: ${id}`);
  return `${lines.join("\n")}\n`;
}

/** YAML 标量：需要引号就加双引号并转义，不需要就原样写。 */
function yamlScalar(value) {
  const text = String(value);
  if (/^[A-Za-z0-9\u4e00-\u9fa5][^:{}[\],&*#?|\-<>=!%@`"']*$/.test(text) && text.trim() === text) return text;
  return JSON.stringify(text);
}
