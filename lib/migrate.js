/**
 * v1 档案 → v2（角色 / 组装 / 编译）的原地迁移。
 *
 * 迁移只做形状改写，不做语义发明：
 *
 * - 成员原来内嵌的 `systemPrompt` 变成 `roles/<roster>-<member>/AGENT.md` 的正文；
 * - 原来写在成员上的路由与工具策略搬进角色 frontmatter；
 * - 组装只留引用（`role: <roster>-<member>@1.0.0`），成员名、标题、描述保持原样；
 * - 队长从「成员之外的一个字段」变成真正的角色文件，`captain.role` 指向它；
 * - 能力要求（`capabilities.yaml`）跟着档案走，内容不动。
 *
 * 角色名带档案 id 前缀，是因为 v2 要求**同一座库里角色名唯一**，而仓库里的 21 套业务档案
 * 全都叫 `lead`；不加前缀就无法共存，加了前缀至少能追溯「这份人设属于谁」。
 *
 * @module dsh-agent-roster/migrate
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import { CAPABILITIES_FILE_NAMES, validateCapabilities } from "./capabilities.js";
import { compileRoster, scanRoles } from "./compile2.js";
import { MEMBER_FILE_NAMES } from "./format.js";
import { parseDocumentText } from "./parse.js";
import { compilePlan } from "./plan.js";
import { loadRosterAt } from "./registry.js";

/** 共享角色目录的标准名（旧名 `roles/` 仍被读取，但新库与迁移都写标准名）。 */
export const ROLES_DIR = "shared-roles";
export const LEGACY_ROLES_DIR = "roles";
export const ROSTERS_DIR = "rosters";
export const DIST_DIR = "dist";

const ROLE_VERSION = "1.0.0";
const EMPTY_PERSONA = "（迁移时原档案没有写人设正文；请补上这个角色的职责与边界。）";

/** 把值写成 YAML（块风格）。字符串一律 JSON 转义，避免冒号、井号被误读。 */
export function emitYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        if (item !== null && typeof item === "object") {
          const nested = emitYaml(item, indent + 2);
          // `- key: v` 的形式更像人写的 YAML：第一行跟在短横线后，其余按缩进续行。
          const [first, ...rest] = nested.split("\n");
          return [`${pad}- ${first.trimStart()}`, ...rest].join("\n");
        }
        return `${pad}- ${inline(item)}`;
      })
      .join("\n");
  }
  if (value !== null && typeof value === "object") {
    if (Object.keys(value).length === 0) return "{}";
    const lines = [];
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (Array.isArray(item)) {
        lines.push(item.length === 0 ? `${pad}${key}: []` : `${pad}${key}:\n${emitYaml(item, indent + 2)}`);
      } else if (item !== null && typeof item === "object") {
        const body = emitYaml(item, indent + 2);
        lines.push(Object.keys(item).length === 0 ? `${pad}${key}: {}` : `${pad}${key}:\n${body}`);
      } else {
        lines.push(`${pad}${key}: ${inline(item)}`);
      }
    }
    return lines.join("\n");
  }
  return `${pad}${inline(value)}`;
}

function inline(value) {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return JSON.stringify(String(value));
}

/** 角色文件的内容：frontmatter + 空行 + 正文。 */
export function roleDocument(role, body) {
  const text = String(body ?? "").trim().length > 0 ? String(body).trimEnd() : EMPTY_PERSONA;
  return `---\n${emitYaml(role)}\n---\n\n${text}\n`;
}

function routeOf(source) {
  if (source === null || source === undefined) return null;
  const route = {};
  if (source.provider) route.provider = source.provider;
  if (source.model) route.model = source.model;
  if (source.reasoningEffort) route.reasoningEffort = source.reasoningEffort;
  return Object.keys(route).length > 0 ? route : null;
}

function listOf(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
}

/**
 * 把一份 v1 档案转成 v2 的两类文件（角色文件 + 组装）。
 * 编译产物在写盘之后由 `compileRoster` 生成，这里不重复拼装。
 */
export function convertRoster(roster, { capabilities = null } = {}) {
  // v1 的 id 字段叫 `roster`；校验后的对象会补一个 `id`，但单测里可能直接传原文。
  const rosterId = roster.id ?? roster.roster;
  const version = roster.version ?? "1.0.0";
  const files = [];
  const members = [];
  const roleNames = [];
  const skills = new Set();
  const policies = new Set();

  for (const member of roster.members ?? []) {
    const roleName = `${rosterId}-${member.name}`;
    roleNames.push(roleName);
    const memberSkills = listOf(member.skills);
    const policy = member.toolPolicy ?? roster.defaults?.toolPolicy ?? null;
    for (const skill of memberSkills) skills.add(skill);
    if (policy) policies.add(policy);
    const role = {
      kind: "dsh-agent-roster/role@1",
      name: roleName,
      version: ROLE_VERSION,
      role: member.role ?? member.name,
    };
    if (member.title) role.title = member.title;
    if (member.description) role.description = member.description;
    if (listOf(member.tags).length > 0) role.tags = listOf(member.tags);
    const route = routeOf(member);
    if (route) role.route = route;
    if (member.toolPolicy) role.tools = { policy: member.toolPolicy };
    if (memberSkills.length > 0) role.requires = { skills: memberSkills };
    files.push({ path: nodePath.join(ROLES_DIR, roleName, "AGENT.md"), text: roleDocument(role, member.systemPrompt) });
    members.push({ as: member.name, role: `${roleName}@${ROLE_VERSION}` });
  }

  let captain = null;
  if (roster.captain) {
    // v1 里队长常常与某个成员同名（`lead` 既是成员又是 captain）；两者人设不同，
    // 所以重名时给队长加后缀，而不是悄悄合并成同一个角色。
    const base = `${rosterId}-${roster.captain.name ?? "captain"}`;
    const captainName = roleNames.includes(base) ? `${base}-captain` : base;
    roleNames.push(captainName);
    const role = {
      kind: "dsh-agent-roster/role@1",
      name: captainName,
      version: ROLE_VERSION,
      role: roster.captain.role ?? "队长",
    };
    if (roster.captain.description) role.description = roster.captain.description;
    const route = routeOf(roster.captain);
    if (route) role.route = route;
    files.push({
      path: nodePath.join(ROLES_DIR, captainName, "AGENT.md"),
      text: roleDocument(role, roster.captain.personaPrefix ?? roster.captain.description ?? ""),
    });
    captain = { role: `${captainName}@${ROLE_VERSION}` };
    const captainRoute = routeOf(roster.captain);
    if (captainRoute) captain.route = captainRoute;
  }

  for (const item of capabilities?.requires?.skills ?? []) skills.add(typeof item === "string" ? item : item.name);
  for (const item of capabilities?.requires?.toolPolicies ?? []) policies.add(typeof item === "string" ? item : item.name);

  const defaults = {};
  const defaultRoute = routeOf(roster.defaults ?? null);
  if (defaultRoute) defaults.route = defaultRoute;
  if (roster.defaults?.toolPolicy) defaults.tools = { policy: roster.defaults.toolPolicy };

  const targets = ["agent-teams/members"];
  if (captain !== null) targets.push("profile/agent-preset");

  const roster2 = { kind: "dsh-agent-roster/roster@2", id: rosterId, version };
  if (roster.title) roster2.title = roster.title;
  if (roster.description) roster2.description = roster.description;
  if (roster.license) roster2.license = roster.license;
  if (listOf(roster.maintainers).length > 0) roster2.maintainers = listOf(roster.maintainers);
  if (listOf(roster.tags).length > 0) roster2.tags = listOf(roster.tags);
  if (Object.keys(defaults).length > 0) roster2.defaults = defaults;
  roster2.targets = targets;
  roster2.members = members;
  if (captain !== null) roster2.captain = captain;
  if (skills.size > 0 || policies.size > 0) {
    roster2.requires = {};
    if (skills.size > 0) roster2.requires.skills = [...skills];
    if (policies.size > 0) roster2.requires.toolPolicies = [...policies];
  }
  if (capabilities?.onMissing) roster2.onMissing = capabilities.onMissing;

  files.push({ path: nodePath.join(ROSTERS_DIR, rosterId, "roster.yaml"), text: `${emitYaml(roster2)}\n` });
  return { roster: roster2, files, members, roleNames, memberCount: members.length, hasCaptain: captain !== null };
}

function loadCapabilitiesOf(dir) {
  for (const name of CAPABILITIES_FILE_NAMES) {
    const file = nodePath.join(dir, name);
    if (!existsSync(file)) continue;
    const parsed = parseDocumentText(readFileSync(file, "utf8"), name);
    if (!parsed.ok) return null;
    const outcome = validateCapabilities(parsed.value, { file: name, expectedId: null });
    return outcome.ok ? outcome.capabilities : null;
  }
  return null;
}

/**
 * 迁移一座 v1 档案库。
 *
 * 不写盘时只返回计划；`write: true` 才落盘、编译、写出 `dist/`，并在最后删掉旧的 `<id>/` 目录。
 */
export function migrateLibrary(rootDir, { write = false, knownToolPolicies = null, source = {}, fromDir = rootDir } = {}) {
  const report = { rootDir, write, entries: [], diagnostics: [], written: [], removed: [], compiled: [] };
  let children = [];
  try {
    children = readdirSync(fromDir, { withFileTypes: true });
  } catch (error) {
    report.diagnostics.push({ severity: "error", code: "unreadable-dir", path: "", file: null, reason: `档案库不可读：${error?.message ?? error}` });
    return report;
  }

  const seenRoles = new Map();
  for (const child of children) {
    if (!child.isDirectory() || child.isSymbolicLink()) continue;
    if (
      child.name.startsWith(".") ||
      child.name === ROLES_DIR ||
      child.name === LEGACY_ROLES_DIR ||
      child.name === ROSTERS_DIR ||
      child.name === DIST_DIR
    ) continue;
    const dir = nodePath.join(fromDir, child.name);
    // v1 的档案文件名可以是 yaml / yml / json——迁移只认内容，不认扩展名。
    if (!MEMBER_FILE_NAMES.some((name) => existsSync(nodePath.join(dir, name)))) continue;
    const loaded = loadRosterAt(dir, { knownToolPolicies });
    if (!loaded.ok) {
      report.diagnostics.push({
        severity: "warn",
        code: "migrate-skipped",
        path: "",
        file: `${child.name}/roster.yaml`,
        reason: `跳过：${loaded.diagnostics.map((item) => item.reason).join("；") || "读不出档案"}`,
      });
      continue;
    }
    const capabilities = loadCapabilitiesOf(dir);
    const converted = convertRoster(loaded.roster, { capabilities });
    for (const roleName of converted.roleNames) {
      if (seenRoles.has(roleName)) {
        report.diagnostics.push({
          severity: "error",
          code: "duplicate-role",
          path: "",
          file: `${child.name}/roster.yaml`,
          reason: `角色名 "${roleName}" 与 ${seenRoles.get(roleName)} 重复；v2 要求同库唯一`,
        });
      }
      seenRoles.set(roleName, child.name);
    }
    report.entries.push({
      id: loaded.roster.id,
      version: loaded.roster.version,
      from: `${child.name}/roster.yaml`,
      files: converted.files,
      memberCount: converted.memberCount,
      hasCaptain: converted.hasCaptain,
      capabilities: capabilities !== null,
    });
  }

  if (!write) return report;

  for (const entry of report.entries) {
    for (const file of entry.files) {
      const target = nodePath.join(rootDir, file.path);
      mkdirSync(nodePath.dirname(target), { recursive: true });
      writeFileSync(target, file.text, "utf8");
      report.written.push(file.path);
    }
    for (const name of CAPABILITIES_FILE_NAMES) {
      const source = nodePath.join(fromDir, entry.id, name);
      if (!existsSync(source)) continue;
      const relative = nodePath.join(ROSTERS_DIR, entry.id, name);
      const target = nodePath.join(rootDir, relative);
      mkdirSync(nodePath.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(source, "utf8"), "utf8");
      report.written.push(relative);
      break;
    }
    // 就地迁移时旧的 roster.json / roster.yml 会和新的 roster.yaml 并排躺着：
    // 两份同义文件就是两个真源，删掉非 .yaml 的旧件。
    for (const name of MEMBER_FILE_NAMES) {
      if (name === "roster.yaml") continue;
      const stale = nodePath.join(rootDir, ROSTERS_DIR, entry.id, name);
      if (existsSync(stale)) rmSync(stale, { force: true });
    }
  }

  const scanned = scanRoles(nodePath.join(rootDir, ROLES_DIR), { knownToolPolicies });
  report.diagnostics.push(...scanned.diagnostics);
  for (const entry of report.entries) {
    const compiled = compileRoster({
      rosterDir: nodePath.join(rootDir, ROSTERS_DIR, entry.id),
      roles: scanned.roles,
      expectedId: entry.id,
      knownToolPolicies,
      libraryRoot: rootDir,
      source: { ...source },
    });
    if (!compiled.ok) {
      report.diagnostics.push({
        severity: "error",
        code: "migrate-compile-failed",
        path: "",
        file: `${ROSTERS_DIR}/${entry.id}/roster.yaml`,
        reason: compiled.diagnostics.map((item) => item.reason).join("；"),
      });
      continue;
    }
    const name = `${compiled.compiled.source.roster}-${compiled.compiled.source.version}`;
    const planResult = compilePlan(compiled.compiled);
    const outputs = [{ path: nodePath.join(DIST_DIR, `${name}.json`), text: `${JSON.stringify(compiled.compiled, null, 2)}\n` }];
    if (planResult.plan !== null) {
      outputs.push({ path: nodePath.join(DIST_DIR, `${name}.tasks.json`), text: `${JSON.stringify(planResult.plan, null, 2)}\n` });
    }
    for (const output of outputs) {
      const target = nodePath.join(rootDir, output.path);
      mkdirSync(nodePath.dirname(target), { recursive: true });
      writeFileSync(target, output.text, "utf8");
      report.written.push(output.path);
    }
    report.compiled.push({ id: entry.id, members: compiled.compiled.members.length, plan: planResult.plan !== null });
  }

  for (const entry of report.entries) {
    const legacy = nodePath.join(fromDir, entry.id);
    // 仓库根 + rosters/ 的布局里，v1 的 rosters/<id>/ 正是 v2 新档案落脚处 —— 不能删。
    if (nodePath.resolve(legacy) === nodePath.resolve(nodePath.join(rootDir, ROSTERS_DIR, entry.id))) continue;
    if (!existsSync(legacy) || !statSync(legacy).isDirectory()) continue;
    // 只删「迁移前的那份目录」：v2 布局里档案在 rosters/ 下，root 上不该再有同名目录。
    rmSync(legacy, { recursive: true, force: true });
    report.removed.push(entry.id);
  }
  return report;
}
