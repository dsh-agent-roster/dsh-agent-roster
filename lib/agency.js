import fs from "node:fs";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { splitFrontmatter } from "./frontmatter.js";
import { LIMITS2 } from "./format-v2.js";

/**
 * 把 `@michengai/dsh-agency-agents` 的专家素材转成一座 v2 档案库。
 *
 * 它不是“第二真源”：转换是一次性的快照，写进目标库的是一份份普通角色与档案，
 * 之后与那个包再无关系。原文按 Apache-2.0 分发，所以每条角色都记来源文件、
 * 库根写一份 NOTICE；不复制它的运行时（`summon_expert_team`），只借它的文本。
 */

export const AGENCY_PACKAGE = "@michengai/dsh-agency-agents";
export const AGENCY_ASSET_PREFIX = "agency-agents-";
export const AGENCY_ROLE_PREFIX = "agency-";
export const AGENCY_ROSTER_CHUNK = 24;
export const AGENCY_BODY_CHARS = LIMITS2.bodyChars;
export const AGENCY_PROMPT_CHARS = LIMITS2.promptChars;

/** 从包目录或 assets 目录里找到专家素材根。 */
export function findAgencyAssets(input) {
  const dir = nodePath.resolve(String(input ?? ""));
  if (dir === "") return { ok: false, code: "agency-path-missing", dir: "" };
  const candidates = [];
  if (nodePath.basename(dir).startsWith(AGENCY_ASSET_PREFIX)) candidates.push(dir);
  const assets = nodePath.join(dir, "assets");
  if (fs.existsSync(assets) && fs.statSync(assets).isDirectory()) {
    for (const name of fs.readdirSync(assets).sort()) {
      if (name.startsWith(AGENCY_ASSET_PREFIX)) candidates.push(nodePath.join(assets, name));
    }
  }
  const found = candidates.find((item) => fs.existsSync(item) && fs.statSync(item).isDirectory());
  if (found === undefined) return { ok: false, code: "agency-assets-not-found", dir };
  return { ok: true, dir: found, lang: nodePath.basename(found).slice(AGENCY_ASSET_PREFIX.length) };
}

/** 读一个素材目录下的全部专家；按目录名（领域）分组。 */
export function readAgencyExperts(assetsDir) {
  const experts = [];
  const diagnostics = [];
  const domains = fs.readdirSync(assetsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const domain of domains.sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = nodePath.join(assetsDir, domain.name);
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
      const path = nodePath.join(dir, file);
      const slug = file.slice(0, -3);
      const split = splitFrontmatter(fs.readFileSync(path, "utf8"), { file: path });
      if (!split.ok || split.frontmatter === null) {
        diagnostics.push({ severity: "warn", code: "agency-frontmatter-invalid", file: path, reason: "缺少合法 frontmatter" });
        continue;
      }
      let meta;
      try {
        meta = parseYaml(split.frontmatter) ?? {};
      } catch (error) {
        diagnostics.push({ severity: "warn", code: "agency-frontmatter-invalid", file: path, reason: String(error?.message ?? error) });
        continue;
      }
      const body = String(split.body ?? "").trim();
      if (body === "") {
        diagnostics.push({ severity: "warn", code: "agency-body-empty", file: path, reason: "正文为空" });
        continue;
      }
      if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) {
        diagnostics.push({ severity: "warn", code: "agency-slug-invalid", file: path, reason: `文件名 ${slug} 不是 kebab-case` });
        continue;
      }
      experts.push({
        domain: domain.name,
        slug,
        name: typeof meta.name === "string" ? meta.name.trim() : slug,
        description: typeof meta.description === "string" ? meta.description.trim() : "",
        body,
        file: nodePath.relative(assetsDir, path),
        sha256: createHash("sha256").update(body).digest("hex"),
      });
    }
  }
  return { ok: true, experts, diagnostics };
}

function roleNameOf(expert) {
  return `${AGENCY_ROLE_PREFIX}${expert.slug}`;
}

function splitBody(expert) {
  if (expert.body.length <= AGENCY_BODY_CHARS) return { body: expert.body, rest: "" };
  const cut = expert.body.lastIndexOf("\n\n", AGENCY_BODY_CHARS);
  const at = cut > AGENCY_BODY_CHARS / 2 ? cut : AGENCY_BODY_CHARS;
  return { body: expert.body.slice(0, at).trim(), rest: expert.body.slice(at).trim() };
}

/** 生成整座库的文本计划；不写盘。 */
export function planAgencyLibrary(experts, { spaceId, source = AGENCY_PACKAGE }) {
  const roles = [];
  const rosters = [];
  const diagnostics = [];
  const usable = [];
  for (const expert of experts) {
    const split = splitBody(expert);
    const total = split.body.length + (split.rest === "" ? 0 : split.rest.length);
    if (total > AGENCY_PROMPT_CHARS) {
      diagnostics.push({
        severity: "warn",
        code: "agency-too-long",
        file: expert.file,
        reason: `正文 ${expert.body.length} 字符，超过 ${AGENCY_PROMPT_CHARS} 的提示词预算；已跳过`,
      });
      continue;
    }
    const name = roleNameOf(expert);
    const frontmatter = {
      kind: "dsh-agent-roster/role@1",
      name,
      version: "1.0.0",
      role: expert.domain,
      title: expert.name.slice(0, 80),
      description: expert.description.slice(0, 200),
      tags: ["agency", expert.domain],
      notes: `${source} · ${expert.file} · sha256:${expert.sha256.slice(0, 12)} · Apache-2.0`,
    };
    const parts = [];
    if (split.rest !== "") parts.push({ path: `parts/rest.md`, text: split.rest });
    roles.push({ path: `roles/${name}/AGENT.md`, text: `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${split.body}\n` });
    for (const part of parts) roles.push({ path: `roles/${name}/${part.path}`, text: `${part.text}\n` });
    if (parts.length > 0) {
      // 片段必须由角色自己声明；改写成带 prompt.parts 的 frontmatter。
      const role = roles[roles.length - 1 - parts.length];
      role.text = role.text.replace(
        `---\n${stringifyYaml(frontmatter).trimEnd()}\n---`,
        `---\n${stringifyYaml({ ...frontmatter, prompt: { parts: parts.map((item) => item.path) } }).trimEnd()}\n---`,
      );
    }
    usable.push({ expert, name });
  }

  const byDomain = new Map();
  for (const item of usable) {
    if (!byDomain.has(item.expert.domain)) byDomain.set(item.expert.domain, []);
    byDomain.get(item.expert.domain).push(item);
  }
  const rosterIds = [];
  for (const domain of [...byDomain.keys()].sort()) {
    const items = byDomain.get(domain);
    const chunks = Math.ceil(items.length / AGENCY_ROSTER_CHUNK);
    for (let index = 0; index < chunks; index += 1) {
      const slice = items.slice(index * AGENCY_ROSTER_CHUNK, (index + 1) * AGENCY_ROSTER_CHUNK);
      const id = `agency-${domain}-${index + 1}`;
      const roster = {
        kind: "dsh-agent-roster/roster@2",
        id,
        version: "1.0.0",
        title: `${domain} 专家${chunks > 1 ? `（${index + 1}/${chunks}）` : ""}`,
        description: `从 ${source} 导入的 ${slice.length} 名${domain}专家。`,
        tags: ["agency", domain],
        targets: ["agent-teams/members"],
        notes: `来源：${source} · Apache-2.0；见库根 NOTICE-agency.txt。`,
        members: slice.map((item) => ({ as: item.expert.slug, role: `${item.name}@1.0.0` })),
      };
      rosterIds.push(id);
      rosters.push({ path: `rosters/${id}/roster.yaml`, text: stringifyYaml(roster) });
    }
  }
  const notice = [
    `这份库里的角色正文来自 ${source}（Apache License 2.0）。`,
    "每个角色目录的 frontmatter `notes` 记录了来源文件与正文哈希；角色正文按原样复制，未改写语义。",
    "导入是一次性快照，与源包再无联动；源包升级不会自动更新这里。",
    "",
  ].join("\n");
  const space = {
    kind: "dsh-agent-roster/space@1",
    space: spaceId,
    title: `${spaceId}（导入）`,
    description: `由 ${source} 导入的专家档案库。`,
    license: "Apache-2.0",
    layout: "monorepo",
    rosters: rosterIds.map((id) => ({ id })),
  };
  return {
    ok: rosterIds.length > 0,
    roles,
    rosters,
    notice,
    space: { path: "space.yaml", text: stringifyYaml(space) },
    rosterIds,
    skipped: diagnostics.length,
    diagnostics,
    stats: { experts: experts.length, roles: roles.filter((item) => item.path.endsWith("AGENT.md")).length, rosters: rosterIds.length },
  };
}

/** 写盘：只允许空目录，或用 force 覆盖自己生成过的路径。 */
export function writeAgencyLibrary(targetDir, plan, { force = false } = {}) {
  const dir = nodePath.resolve(targetDir);
  const existing = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  if (existing.length > 0 && !force) {
    return { ok: false, code: "target-not-empty", dir, written: [] };
  }
  const files = [plan.space, ...plan.roles, ...plan.rosters];
  for (const file of files) {
    const path = nodePath.join(dir, file.path);
    fs.mkdirSync(nodePath.dirname(path), { recursive: true });
    fs.writeFileSync(path, file.text);
  }
  fs.writeFileSync(nodePath.join(dir, "NOTICE-agency.txt"), plan.notice);
  return { ok: true, dir, written: files.map((file) => file.path) };
}
