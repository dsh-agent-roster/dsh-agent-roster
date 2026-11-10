/**
 * 编译层：把「角色 + 组装」解析成唯一的产物（compiled@1）。
 *
 * 为什么必须有编译产物：运行时只收一条字符串。只要拼装逻辑留在插件代码里，
 * 插件升级就能改变所有成员的行为，而档案 diff 一行没动。把拼装写进格式、把结果物化，
 * 「模型到底会看到什么」才成为可 diff、可哈希、可复核的东西。
 *
 * 编译只读文件、不写文件、不建团队；产物由调用方决定写到哪（`dist/`、面板、工具输出）。
 *
 * @module dsh-agent-roster/compile2
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import nodePath from "node:path";

import { assemblePrompt, charLength, splitFrontmatter } from "./frontmatter.js";
import { sha256Hex, shortSha } from "./digest.js";
import {
  COMPILED_KIND,
  LIMITS2,
  ROLE_FILE_NAME,
  ROLE_PARTS_DIR,
  ROSTER2_FILE_NAMES,
} from "./format-v2.js";
import { ROSTER_KIND } from "./format.js";
import { diagnostic, parseDocumentText } from "./parse.js";
import { loadRoleAt, safeResolve } from "./role.js";
import { validateRoster2 } from "./roster2.js";

/** 递归扫描角色库，返回 `name → 角色` 映射；重名与版本重复都报出来。 */
export function scanRoles(rootDir, options = {}) {
  const root = nodePath.resolve(String(rootDir));
  const diagnostics = [];
  const roles = new Map();
  const files = [];

  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      diagnostics.push(diagnostic("error", "unreadable-role-dir", "", `读不到目录 ${dir}：${error?.message ?? error}`, dir));
      return;
    }
    const sorted = entries.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (sorted.some((entry) => entry.isFile() && entry.name === ROLE_FILE_NAME)) files.push(dir);
    for (const entry of sorted) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === ROLE_PARTS_DIR || entry.name === "node_modules") continue;
      walk(nodePath.join(dir, entry.name), depth + 1);
    }
  };

  if (!existsSync(root)) {
    return { ok: false, roles, diagnostics: [diagnostic("error", "missing-roles-dir", "", `角色库目录不存在：${root}`, root)] };
  }
  walk(root, 0);

  if (files.length > LIMITS2.roleFiles) {
    diagnostics.push(diagnostic("error", "too-many-roles", "", `角色文件 ${files.length} 份，超过上限 ${LIMITS2.roleFiles}`, root));
  }

  for (const dir of files) {
    const loaded = loadRoleAt(dir, {
      knownToolPolicies: options.knownToolPolicies ?? null,
      // `{{> snippets/…}}` 相对库根解析；库根就是 roles/ 的上一级。
      libraryRoot: options.libraryRoot ?? nodePath.dirname(root),
    });
    diagnostics.push(...loaded.diagnostics);
    if (!loaded.ok || loaded.role === null) continue;
    const role = loaded.role;
    const previous = roles.get(role.name);
    if (previous !== undefined) {
      // 重名就是重名：不靠"谁先扫到谁赢"，直接报错（v1 用「目录名必须等于 id」避免了这一整类问题，
      // v2 把身份放进文档，就必须换一条规则来保证唯一性）。
      diagnostics.push(
        diagnostic(
          "error",
          "duplicate-role",
          role.name,
          `角色名 ${role.name} 出现在两个地方：${nodePath.relative(root, previous.dir)} 与 ${nodePath.relative(root, dir)}`,
          loaded.file,
        ),
      );
      continue;
    }
    roles.set(role.name, {
      dir,
      file: loaded.file,
      role,
      prompt: loaded.prompt,
      body: loaded.body,
      sha256: sha256Hex(readFileSync(loaded.file, "utf8")),
    });
  }

  return { ok: !diagnostics.some((item) => item.severity === "error"), roles, diagnostics };
}

/** 找一份组装文档（`rosters/<id>/roster.{yaml,yml,json}`）。 */
export function locateRoster(rootDir, id) {
  const dir = nodePath.resolve(String(rootDir), String(id));
  for (const name of ROSTER2_FILE_NAMES) {
    const file = nodePath.join(dir, name);
    if (existsSync(file) && statSync(file).isFile()) return { dir, file };
  }
  return { dir, file: null };
}

/**
 * 编译一份组装文档。
 *
 * @param {{
 *   rosterDir: string,
 *   rosterFile?: string | null,
 *   roles: Map<string, object>,
 *   expectedId?: string | null,
 *   knownToolPolicies?: string[] | null,
 *   source?: { repo?: string, ref?: string, lock?: string | null },
 * }} options
 * @returns {{ ok: boolean, compiled: object | null, roster: object | null, diagnostics: object[] }}
 */
export function compileRoster(options) {
  const rosterDir = nodePath.resolve(String(options.rosterDir));
  const diagnostics = [];
  const file = options.rosterFile ?? findRosterFile(rosterDir);
  if (file === null) {
    return {
      ok: false,
      compiled: null,
      roster: null,
      diagnostics: [diagnostic("error", "missing-roster-file", "", `目录里没有 ${ROSTER2_FILE_NAMES.join(" / ")}`, rosterDir)],
    };
  }

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, compiled: null, roster: null, diagnostics: [diagnostic("error", "unreadable-roster-file", "", String(error?.message ?? error), file)] };
  }

  const parsed = parseDocumentText(text, { file, format: file.endsWith(".json") ? "json" : "yaml" });
  diagnostics.push(...parsed.diagnostics);
  if (!parsed.ok) return { ok: false, compiled: null, roster: null, diagnostics };

  const validated = validateRoster2(parsed.value, {
    file,
    expectedId: options.expectedId ?? nodePath.basename(rosterDir),
    knownToolPolicies: options.knownToolPolicies ?? null,
  });
  diagnostics.push(...validated.diagnostics);
  if (!validated.ok || validated.roster === null) return { ok: false, compiled: null, roster: null, diagnostics };

  const roster = validated.roster;
  const roles = options.roles;
  const declarations = [];
  const members = [];
  const memberRequires = [];

  for (const member of roster.members) {
    const role = roles.get(member.role.name);
    if (role === undefined) {
      diagnostics.push(
        diagnostic("error", "unknown-role", `members.${member.as}`, `角色库里没有 ${member.role.name}；先把它放进 roles/${member.role.name}/AGENT.md`),
      );
      continue;
    }
    if (role.role.version !== member.role.version) {
      diagnostics.push(
        diagnostic(
          "error",
          "role-version-mismatch",
          `members.${member.as}`,
          `引用 ${member.role.raw}，但角色库里是 ${role.role.name}@${role.role.version}`,
        ),
      );
      continue;
    }

    const extra = readMemberExtras(rosterDir, member, file, diagnostics);
    if (extra === null) continue;
    const assembled = assemblePrompt("", [role.prompt.text], extra);
    const chars = charLength(assembled.text);
    if (chars > LIMITS2.promptChars) {
      diagnostics.push(
        diagnostic("error", "prompt-too-long", `members.${member.as}`, `拼装后 ${chars} 字符，超过上限 ${LIMITS2.promptChars}`, file),
      );
      continue;
    }

    const route = { ...role.role.route, ...member.route };
    const policy = member.tools?.policy ?? role.role.tools?.policy ?? null;

    members.push({
      name: member.as,
      role: role.role.role,
      roleRef: `${role.role.name}@${role.role.version}`,
      roleName: role.role.name,
      roleVersion: role.role.version,
      provider: route.provider ?? null,
      model: route.model ?? null,
      reasoningEffort: route.reasoningEffort ?? null,
      toolPolicy: policy,
      executionPrompt: assembled.text,
      promptStats: {
        chars,
        parts: [
          ...(extra.prepend !== null ? [{ path: extra.prepend, kind: "prepend" }] : []),
          { path: `roles/${nodePath.basename(role.dir)}/${ROLE_FILE_NAME}`, kind: "body+parts" },
          ...(role.prompt.includes ?? []).map((item) => ({ path: item.path, kind: "include", line: item.line, sha256: item.sha256 })),
          ...(role.prompt.parts ?? []).map((part) => ({ path: part.path, kind: "part" })),
          ...(extra.append !== null ? [{ path: extra.append, kind: "append" }] : []),
        ],
        sha256: sha256Hex(assembled.text),
      },
      provenance: { role: `${role.role.name}@${role.role.version}`, sha256: shortSha(role.sha256) },
    });

    collectDeclarations(declarations, member, role, roster, extra);
    memberRequires.push({
      skills: [...role.role.requires.skills, ...member.requires.skills],
      toolPolicies: [...role.role.requires.toolPolicies, ...member.requires.toolPolicies],
    });
  }

  const captain = compileCaptain(roster, rosterDir, roles, file, diagnostics, declarations);
  const orchestration = roster.orchestration === null ? null : compileOrchestration(roster.orchestration, declarations);

  if (diagnostics.some((item) => item.severity === "error")) {
    return { ok: false, compiled: null, roster, diagnostics };
  }

  const compiled = {
    kind: COMPILED_KIND,
    source: {
      roster: roster.id,
      version: roster.version,
      // 产物是唯一被分发的形态：发现它所需的一切（标题、标签、许可、维护者）必须自带，
      // 否则"从远处找一份档案"就只剩一个 id。
      title: roster.title ?? null,
      description: roster.description ?? null,
      tags: Array.isArray(roster.tags) ? roster.tags : [],
      license: roster.license ?? null,
      maintainers: Array.isArray(roster.maintainers) ? roster.maintainers : [],
      repo: options.source?.repo ?? null,
      ref: options.source?.ref ?? null,
      lock: options.source?.lock ?? null,
      file: nodePath.basename(file),
    },
    targets: roster.targets,
    captain,
    members,
    orchestration,
    declarations,
    requires: mergeRequires(roster.requires, memberRequires),
  };

  if (roster.captain !== null && roster.captain !== undefined && !roster.targets.includes("profile/agent-preset")) {
    diagnostics.push(
      diagnostic(
        "warn",
        "captain-not-targeted",
        "targets",
        "声明了 captain，但 targets 里没有 profile/agent-preset：队长只会作为说明出现，不会被落成配置",
        file,
      ),
    );
  }

  return { ok: true, compiled, roster, diagnostics };
}

function compileCaptain(roster, rosterDir, roles, file, diagnostics, declarations) {
  if (roster.captain === null || roster.captain === undefined) {
    return null;
  }
  const captain = roster.captain;
  let persona = null;
  let personaPath = null;
  if (captain.persona !== null) {
    const resolved = safeResolve(rosterDir, captain.persona);
    if (resolved === null || !existsSync(resolved)) {
      diagnostics.push(diagnostic("error", "missing-persona", "captain.persona", `队长 persona 文件不存在：${captain.persona}`, file));
      return null;
    }
    persona = readFileSync(resolved, "utf8").replace(/\s+$/, "");
    personaPath = captain.persona;
  }

  let roleName = null;
  let roleVersion = null;
  let route = { ...captain.route };
  if (captain.role !== null) {
    const role = roles.get(captain.role.name);
    if (role === undefined) {
      diagnostics.push(diagnostic("error", "unknown-role", "captain.role", `角色库里没有 ${captain.role.name}`, file));
      return null;
    }
    if (role.role.version !== captain.role.version) {
      diagnostics.push(
        diagnostic("error", "role-version-mismatch", "captain.role", `引用 ${captain.role.raw}，角色库是 ${role.role.name}@${role.role.version}`, file),
      );
      return null;
    }
    roleName = role.role.name;
    roleVersion = role.role.version;
    route = { ...role.role.route, ...captain.route };
    if (persona === null) {
      persona = role.prompt.text;
      personaPath = null;
    }
  }

  // 队长与成员共用同一个「两端」语义：prepend / append 加在拼装结果外，
  // 不重排、不替换正文。过去队长只能整体换 persona，想加一句就得复制全文。
  const extra = readPromptExtras(rosterDir, captain.prompt, "captain.prompt", file, diagnostics);
  if (extra === null) return null;
  let promptStats = null;
  if (persona !== null || extra.prepend !== null || extra.append !== null) {
    if (persona === null) {
      diagnostics.push(
        diagnostic("error", "captain-prompt-without-base", "captain.prompt", "写了 prepend/append，但没有 persona 或 role 可加——队长正文来自哪里没有说", file),
      );
      return null;
    }
    const assembled = assemblePrompt("", [persona], extra);
    const chars = charLength(assembled.text);
    if (chars > LIMITS2.promptChars) {
      diagnostics.push(diagnostic("error", "prompt-too-long", "captain", `队长人设拼装后 ${chars} 字符，超过上限 ${LIMITS2.promptChars}`, file));
      return null;
    }
    persona = assembled.text;
    promptStats = {
      chars,
      parts: [
        ...(extra.prepend !== null ? [{ path: extra.prepend, kind: "prepend" }] : []),
        personaPath === null ? { path: roleName === null ? "captain" : `roles/${roleName}/${ROLE_FILE_NAME}`, kind: "body+parts" } : { path: personaPath, kind: "persona" },
        ...(extra.append !== null ? [{ path: extra.append, kind: "append" }] : []),
      ],
      sha256: sha256Hex(assembled.text),
    };
  }

  declarations.push({
    scope: "captain",
    field: "route",
    note: "config：队长的路由只能由 profile 的 agent-default-model 落地，插件不写运行时",
  });
  if (persona !== null) {
    declarations.push({ scope: "captain", field: "persona", note: "config：需要落到 profile preset 的 persona" });
  }

  return {
    role: roleName === null ? null : `${roleName}@${roleVersion}`,
    provider: route.provider ?? null,
    model: route.model ?? null,
    reasoningEffort: route.reasoningEffort ?? null,
    persona,
    personaPath,
    personaChars: persona === null ? 0 : charLength(persona),
    personaSha256: persona === null ? null : sha256Hex(persona),
    promptStats,
  };
}

function compileOrchestration(orchestration, declarations) {
  declarations.push({
    scope: "orchestration",
    field: "stages/gates",
    note: "declaration：运行时不会执行这份编排；它先作为可校验的计划存在，编译成任务 DAG 是下一步",
  });
  return {
    shape: orchestration.shape,
    stages: orchestration.stages.map((stage) => ({
      id: stage.id,
      parallel: stage.parallel,
      serial: stage.serial,
      join: stage.join,
      on: stage.on,
      role: stage.role === null ? null : `${stage.role.name}@${stage.role.version}`,
      maxRounds: stage.maxRounds,
    })),
    gates: orchestration.gates.map((gate) => ({
      id: gate.id,
      after: gate.after.slice(),
      requires: gate.requires.slice(),
      verify: gate.verify.map((item) => ({ command: item.command, expectExit: item.expectExit })),
      by: gate.by,
    })),
    status: "declaration",
  };
}

function collectDeclarations(declarations, member, role, roster, extra) {
  if (role.role.tools?.scope !== undefined) {
    declarations.push({ scope: "member", member: member.as, field: "tools.scope", note: "declaration：运行时不生效，只作说明" });
  }
  if (role.role.skills.length > 0) {
    declarations.push({ scope: "member", member: member.as, field: "skills", note: "declaration：插件只核对技能是否安装" });
  }
  if (role.role.examples !== null) {
    declarations.push({ scope: "member", member: member.as, field: "examples", note: "declaration：示例永不进 prompt" });
  }
  if (role.role.requires.skills.length > 0 || role.role.requires.toolPolicies.length > 0) {
    declarations.push({ scope: "member", member: member.as, field: "requires", note: "deployment：角色级要求，编译时并入 requires" });
  }
  if (roster.defaults?.route && Object.keys(roster.defaults.route).length > 0) {
    declarations.push({ scope: "roster", field: "defaults.route", note: "materialized：已展开成每个成员的显式值" });
  }
  if (extra.append !== null || extra.prepend !== null) {
    declarations.push({ scope: "member", member: member.as, field: "prompt.append/prepend", note: "materialized：已拼进 executionPrompt" });
  }
}

function mergeRequires(rosterRequires, memberRequires) {
  const skills = new Set(rosterRequires.skills);
  const toolPolicies = new Set(rosterRequires.toolPolicies);
  for (const entry of memberRequires) {
    for (const skill of entry.skills ?? []) skills.add(skill);
    for (const policy of entry.toolPolicies ?? []) toolPolicies.add(policy);
  }
  return { skills: [...skills].sort(), toolPolicies: [...toolPolicies].sort() };
}

function readPromptExtras(rosterDir, prompt, field, file, diagnostics) {
  const extra = { prepend: null, append: null };
  for (const key of ["prepend", "append"]) {
    const relative = prompt?.[key] ?? null;
    if (relative === null) continue;
    const resolved = safeResolve(rosterDir, relative);
    if (resolved === null) {
      diagnostics.push(diagnostic("error", "unsafe-path", `${field}.${key}`, `路径越出组装目录：${relative}`, file));
      return null;
    }
    if (!existsSync(resolved)) {
      diagnostics.push(diagnostic("error", "missing-prompt-part", `${field}.${key}`, `文件不存在：${relative}`, file));
      return null;
    }
    let text;
    try {
      text = readFileSync(resolved, "utf8").replace(/\s+$/, "");
    } catch (error) {
      diagnostics.push(diagnostic("error", "unreadable-prompt-part", `${field}.${key}`, `读不到 ${relative}：${error?.message ?? error}`, file));
      return null;
    }
    const chars = charLength(text);
    if (chars > LIMITS2.appendChars) {
      diagnostics.push(diagnostic("error", "prompt-part-too-long", `${field}.${key}`, `${relative} 有 ${chars} 字符，超过 ${LIMITS2.appendChars}`, file));
      return null;
    }
    extra[key] = text;
  }
  return extra;
}

/** 成员的 prepend/append：路径相对档案目录，与队长同一套规则。 */
function readMemberExtras(rosterDir, member, file, diagnostics) {
  return readPromptExtras(rosterDir, member.prompt, `members.${member.as}.prompt`, file, diagnostics);
}

function findRosterFile(dir) {
  for (const name of ROSTER2_FILE_NAMES) {
    const file = nodePath.join(dir, name);
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

/** 从磁盘加载一份组装并编译（CLI / 工具用；测试也可直接用 compileRoster 传内存 roles）。 */
export function compileRosterAt(rosterDir, options = {}) {
  const scanned = scanRoles(options.rolesDir, {
    knownToolPolicies: options.knownToolPolicies ?? null,
    libraryRoot: options.libraryRoot ?? nodePath.dirname(options.rolesDir),
  });
  const result = compileRoster({
    rosterDir,
    roles: scanned.roles,
    expectedId: options.expectedId ?? null,
    knownToolPolicies: options.knownToolPolicies ?? null,
    source: options.source ?? {},
  });
  return { ...result, diagnostics: [...scanned.diagnostics, ...result.diagnostics], roles: scanned.roles };
}

/** 供 `roster create` 之类使用：把编译产物摊平成桥接层认识的成员形状。 */
export function compileToMembers(compiled) {
  return (compiled?.members ?? []).map((member) => ({
    name: member.name,
    role: member.role,
    systemPrompt: member.executionPrompt,
    ...(member.provider === null ? {} : { provider: member.provider }),
    ...(member.model === null ? {} : { model: member.model }),
    ...(member.reasoningEffort === null ? {} : { reasoningEffort: member.reasoningEffort }),
    ...(member.toolPolicy === null ? {} : { toolPolicy: member.toolPolicy }),
    aliases: [],
    skills: [],
    examples: [],
  }));
}

export { splitFrontmatter };

/**
 * 把编译产物摊成「读档案的人」熟悉的形状。
 *
 * v2 的组装只写引用（`role: name@1.0.0`），人设正文在角色文件里；但面板、验证器与
 * 桥接层仍然按「一份档案 = id + 成员 + 队长」来读。这里是两种形状之间唯一的转换点：
 * 成员的人设一律取编译后的 `executionPrompt`（也就是运行时真正会收到的那个字符串），
 * 不用角色文件里的正文——否则「声明的人设」和「发出的人设」又会分成两份。
 */
export function rosterViewOf(compiled, roster2, options = {}) {
  const roles = options.roles ?? new Map();
  const roleOf = (ref) => {
    const name = String(ref ?? "").replace(/@[^@]*$/, "");
    return roles.get(name)?.role ?? null;
  };
  const members = (compiled.members ?? []).map((member) => {
    const role = roleOf(member.roleRef);
    const declared = (roster2?.members ?? []).find((item) => item.as === member.name) ?? {};
    // 哪个字段是「继承来的」这件事只有组装与角色知道，编译产物里已经摊平成值了。
    // 桥接层靠 `inherited` 判断该把这个值记成"成员自带"还是"继承 defaults"，所以在这里还原。
    const inherited = [];
    for (const field of ["provider", "model", "reasoningEffort"]) {
      if (!declared.route?.[field] && !role?.route?.[field]) inherited.push(field);
    }
    if (!declared.tools?.policy && !role?.tools?.policy) inherited.push("toolPolicy");
    return {
      name: member.name,
      role: member.role ?? role?.role ?? "",
      title: role?.title ?? "",
      description: role?.description ?? "",
      tags: role?.tags ?? [],
      skills: role?.requires?.skills ?? [],
      provider: member.provider,
      model: member.model,
      reasoningEffort: member.reasoningEffort,
      toolPolicy: member.toolPolicy ?? null,
      systemPrompt: member.executionPrompt,
      roleRef: member.roleRef,
      promptChars: member.promptStats?.chars ?? 0,
      inherited,
    };
  });
  const captain = compiled.captain
    ? {
        name: String(compiled.captain.role ?? "").replace(/@[^@]*$/, ""),
        roleRef: compiled.captain.role ?? null,
        description: roleOf(compiled.captain.role)?.description ?? "",
        systemPrompt: "",
        provider: compiled.captain.provider,
        model: compiled.captain.model,
        reasoningEffort: compiled.captain.reasoningEffort,
        personaPrefix: compiled.captain.persona ?? "",
      }
    : null;
  return {
    format: "v2",
    id: compiled.source.roster,
    version: compiled.source.version,
    file: compiled.source.file ?? null,
    title: roster2?.title ?? compiled.source.title ?? "",
    description: roster2?.description ?? compiled.source.description ?? "",
    license: roster2?.license ?? compiled.source.license ?? "",
    maintainers: roster2?.maintainers ?? compiled.source.maintainers ?? [],
    tags: roster2?.tags ?? compiled.source.tags ?? [],
    notes: roster2?.notes ?? null,
    members,
    captain,
    requires: compiled.requires ?? { skills: [], toolPolicies: [] },
    orchestration: compiled.orchestration ?? null,
  };
}

/**
 * 校验一份编译产物。
 *
 * 这是「消费者只看产物」的入口：远端订阅拿到的就是它，所以这里只认产物该有的形状，
 * 不回头读角色文件——拉一份档案不该变成拉一个仓库。
 *
 * @param {unknown} value
 * @param {{ file?: string | null }} [options]
 * @returns {{ ok: boolean, compiled: object | null, diagnostics: object[] }}
 */
export function validateCompiled(value, { file = null } = {}) {
  const diagnostics = [];
  const at = (relative) => (file === null ? relative : `${file} · ${relative}`);
  const fail = () => ({ ok: false, compiled: null, diagnostics });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push({ severity: "error", code: "compiled-not-object", reason: "编译产物必须是一个对象", file });
    return fail();
  }
  if (value.kind !== COMPILED_KIND) {
    diagnostics.push({
      severity: "error",
      code: "compiled-kind",
      reason: `判别键必须是 ${COMPILED_KIND}，实际是 ${JSON.stringify(value.kind ?? null)}`,
      file,
    });
  }
  const source = value.source;
  if (source === null || typeof source !== "object") {
    diagnostics.push({ severity: "error", code: "compiled-source", reason: "缺少 source", file });
  } else {
    for (const key of ["roster", "version"]) {
      if (typeof source[key] !== "string" || source[key] === "") {
        diagnostics.push({
          severity: "error",
          code: "compiled-source",
          reason: `source.${key} 必须是非空字符串`,
          file: at("source"),
        });
      }
    }
  }
  const members = value.members;
  if (!Array.isArray(members) || members.length === 0) {
    diagnostics.push({ severity: "error", code: "compiled-members", reason: "members 必须是非空数组", file });
  } else {
    for (const [index, member] of members.entries()) {
      const where = at(`members[${String(index)}]`);
      if (member === null || typeof member !== "object") {
        diagnostics.push({ severity: "error", code: "compiled-member", reason: "成员必须是对象", file: where });
        continue;
      }
      if (typeof member.name !== "string" || member.name === "") {
        diagnostics.push({ severity: "error", code: "compiled-member", reason: "成员缺少 name", file: where });
      }
      if (typeof member.executionPrompt !== "string" || member.executionPrompt.trim() === "") {
        diagnostics.push({ severity: "error", code: "compiled-member", reason: "成员缺少 executionPrompt", file: where });
      }
    }
  }
  const ok = diagnostics.every((item) => item.severity !== "error");
  return { ok, compiled: ok ? value : null, diagnostics };
}

/**
 * 把编译产物摊回一份 v1 档案文档。
 *
 * 远端订阅只拿得到产物：产物里的人设已经是最终拼装结果，所以导入本地时写成 v1 内联档案，
 * 不假装自己带着角色目录。想要角色分层，导入后跑一次 `migrate` 重写即可。
 *
 * @param {object} compiled
 * @returns {object}
 */
export function flattenCompiledToRoster(compiled) {
  const source = compiled.source ?? {};
  const members = (compiled.members ?? []).map((member) => {
    const flat = {
      name: member.name,
      role: member.role ?? "",
      systemPrompt: member.executionPrompt,
    };
    if (member.title) flat.title = member.title;
    if (member.description) flat.description = member.description;
    if (member.provider) flat.provider = member.provider;
    if (member.model) flat.model = member.model;
    if (member.reasoningEffort) flat.reasoningEffort = member.reasoningEffort;
    if (member.toolPolicy) flat.toolPolicy = member.toolPolicy;
    return flat;
  });
  const roster = {
    kind: ROSTER_KIND,
    roster: source.roster,
    version: source.version,
    members,
  };
  if (source.title) roster.title = source.title;
  if (source.description) roster.description = source.description;
  if (source.license) roster.license = source.license;
  if (Array.isArray(source.maintainers) && source.maintainers.length > 0) roster.maintainers = source.maintainers;
  if (Array.isArray(source.tags) && source.tags.length > 0) roster.tags = source.tags;
  if (compiled.captain) {
    const captain = { name: String(compiled.captain.role ?? "").replace(/@[^@]*$/, "") };
    if (compiled.captain.provider) captain.provider = compiled.captain.provider;
    if (compiled.captain.model) captain.model = compiled.captain.model;
    if (compiled.captain.reasoningEffort) captain.reasoningEffort = compiled.captain.reasoningEffort;
    if (compiled.captain.persona) captain.personaPrefix = compiled.captain.persona;
    roster.captain = captain;
  }
  return roster;
}
