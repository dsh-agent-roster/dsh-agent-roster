/**
 * 角色（role）层：一份 `AGENT.md` = frontmatter（参数）+ 正文（人设），可选 `parts/` 片段。
 *
 * 为什么单独一层：人设是散文，路由是参数，两者变更频率与作者都不同。
 * 把它们塞进同一个 YAML 块标量，diff 会混在一起、缩进错一格内容就静默变形。
 *
 * 身份来自文档（frontmatter 的 `name`），目录名只是人的便利——但要满足一条硬约束：
 * **同一座库里 role name 唯一**。我们用一条「重名即报错」代替 v1 的「路径必须等于 id」。
 *
 * @module dsh-agent-roster/role
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import nodePath from "node:path";

import { expandIncludes } from "./includes.js";
import { isSafeRelative, safeResolve } from "./paths.js";

import { assemblePrompt, charLength, splitFrontmatter } from "./frontmatter.js";
import {
  DEFAULT_ON_MISSING,
  LIMITS2,
  ON_MISSING,
  PROMPT_FIELDS,
  REQUIRES_FIELDS,
  ROLE_FIELDS,
  ROLE_FILE_NAME,
  ROLE_KIND,
  ROLE_PARTS_DIR,
  ROLE_REQUIRED,
  ROUTE_FIELDS,
  TOOL_SCOPE_FIELDS,
  TOOLS_FIELDS,
  PATTERNS2,
} from "./format-v2.js";
import { PATTERNS, REASONING_EFFORTS } from "./format.js";
import { loadKnowledgeEntry, normalizeKnowledgeRef } from "./knowledge.js";
import { diagnostic, parseDocumentText } from "./parse.js";

const SINGLE_LINE = new Set(["role", "title", "description", "license", "notes"]);

/**
 * 校验角色 frontmatter（纯函数、零 IO）。
 *
 * @param {unknown} value 已解析的 frontmatter 对象
 * @param {{ file?: string, knownToolPolicies?: string[] | null, bodyChars?: number }} [options]
 * @returns {{ ok: boolean, role: object | null, diagnostics: object[] }}
 */
export function validateRole(value, options = {}) {
  const file = String(options.file ?? "");
  const diagnostics = [];
  const report = (severity, code, path, reason) => diagnostics.push(diagnostic(severity, code, path, reason, file));

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("error", "document-not-mapping", "", "frontmatter 顶层必须是映射（对象）");
    return { ok: false, role: null, diagnostics };
  }

  for (const key of Object.keys(value)) {
    if (!ROLE_FIELDS.includes(key)) {
      report("error", "unknown-field", key, `未知字段 ${key}；允许的字段见 schema/role.v1.schema.json`);
    }
  }
  for (const key of ROLE_REQUIRED) {
    if (value[key] === undefined) report("error", "missing-field", key, `缺少必填字段 ${key}`);
  }

  if (value.kind !== ROLE_KIND) {
    report("error", "invalid-kind", "kind", `kind 必须是 "${ROLE_KIND}"，实际是 ${describe(value.kind)}`);
  }

  const name = singleLine(value.name, "name", LIMITS2.roleNameChars, report);
  if (name !== null && !PATTERNS2.id.test(name)) {
    report("error", "invalid-role-name", "name", `角色名必须是 kebab-case 的 2~64 字符：${name}`);
  }

  const version = singleLine(value.version, "version", 64, report);
  if (version !== null && !PATTERNS2.semver.test(version)) {
    report("error", "invalid-semver", "version", `version 必须是精确 SemVer：${version}`);
  }

  const roleLabel = singleLine(value.role, "role", LIMITS2.roleChars, report);
  const title = singleLine(value.title, "title", LIMITS2.titleChars, report);
  const description = singleLine(value.description, "description", LIMITS2.descriptionChars, report);
  const license = singleLine(value.license, "license", LIMITS2.titleChars, report);
  const notes = singleLine(value.notes, "notes", LIMITS2.notesChars, report);
  const maintainers = stringList(value.maintainers, "maintainers", LIMITS2.maintainers, PATTERNS2.id, report);
  const tags = stringList(value.tags, "tags", LIMITS2.tagsPerRole, PATTERNS2.tag, report);

  const route = validateRoute(value.route, "route", report);
  const tools = validateTools(value.tools, "tools", options.knownToolPolicies ?? null, report);
  const prompt = validatePrompt(value.prompt, report);
  const skills = stringList(value.skills, "skills", LIMITS2.skillsPerRole, PATTERNS2.skill, report);
  const knowledge = stringList(value.knowledge, "knowledge", LIMITS2.knowledgePerRole, null, report);
  knowledge.forEach((item, index) => {
    const normalized = normalizeKnowledgeRef(item);
    if (normalized !== "" && !/^knowledge\/[A-Za-z0-9._-]+\.md$/.test(normalized)) {
      report("error", "invalid-knowledge", `knowledge[${index}]`, `知识引用必须是 knowledge/<name>.md 或简写 <name>：${item}`);
    }
  });
  const requires = validateRequires(value.requires, "requires", report);

  let examples = null;
  if (value.examples !== undefined) {
    if (typeof value.examples !== "string" || value.examples === "") {
      report("error", "invalid-field", "examples", "examples 必须是相对路径字符串");
    } else if (!isSafeRelative(value.examples)) {
      report("error", "unsafe-path", "examples", `examples 不允许绝对路径或 ..：${value.examples}`);
    } else {
      examples = value.examples;
    }
  }

  let onMissing = DEFAULT_ON_MISSING;
  if (value.onMissing !== undefined) {
    if (!ON_MISSING.includes(value.onMissing)) {
      report("error", "invalid-on-missing", "onMissing", `onMissing 只能是 ${ON_MISSING.join(" / ")}`);
    } else {
      onMissing = value.onMissing;
    }
  }

  // 拼装后的上限要在这里就拦住：等到运行时才截断，等于让人设静默少一段。
  const bodyChars = Number.isFinite(options.bodyChars) ? Number(options.bodyChars) : null;
  if (bodyChars !== null && bodyChars > LIMITS2.bodyChars) {
    report("error", "prompt-too-long", "body", `正文 ${bodyChars} 字符，超过上限 ${LIMITS2.bodyChars}`);
  }
  if (prompt !== null && prompt.budget !== null && bodyChars !== null && bodyChars > prompt.budget) {
    report(
      "error",
      "prompt-over-budget",
      "prompt.budget",
      `正文 ${bodyChars} 字符超过本角色声明的预算 ${prompt.budget}`,
    );
  }

  if (diagnostics.some((item) => item.severity === "error")) {
    return { ok: false, role: null, diagnostics };
  }

  return {
    ok: true,
    role: {
      kind: ROLE_KIND,
      name,
      version,
      role: roleLabel,
      title,
      description,
      license,
      notes,
      maintainers,
      tags,
      route: route ?? {},
      tools: tools ?? {},
      prompt: prompt ?? { parts: [], budget: null },
      skills,
      knowledge: knowledge ?? [],
      examples,
      requires,
      onMissing,
    },
    diagnostics,
  };
}

/**
 * 读一份角色目录：`AGENT.md` + `parts/*`，拼出最终 executionPrompt。
 *
 * 路径安全是硬要求：片段只允许角色目录内的相对路径，`..`、绝对路径、指向目录外的符号链接
 * 一律拒绝；缺文件是 **error**，绝不静默当成空片段（空人设比报错更危险）。
 *
 * @param {string} dirPath 角色目录
 * @param {{ knownToolPolicies?: string[] | null }} [options]
 * @returns {{
 *   ok: boolean, role: object | null, body: string, prompt: object | null,
 *   diagnostics: object[], file: string, dir: string, promptSha: string | null,
 * }}
 */
export function loadRoleAt(dirPath, options = {}) {
  const dir = nodePath.resolve(String(dirPath));
  const file = nodePath.join(dir, ROLE_FILE_NAME);
  const diagnostics = [];

  if (!existsSync(file)) {
    diagnostics.push(
      diagnostic("error", "missing-role-file", ROLE_FILE_NAME, `角色目录里没有 ${ROLE_FILE_NAME}`, nodePath.basename(dir)),
    );
    return { ok: false, role: null, body: "", prompt: null, diagnostics, file: null, dir, promptSha: null };
  }

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    diagnostics.push(diagnostic("error", "unreadable-role-file", ROLE_FILE_NAME, String(error?.message ?? error), file));
    return { ok: false, role: null, body: "", prompt: null, diagnostics, file, dir, promptSha: null };
  }

  const split = splitFrontmatter(text, { file });
  diagnostics.push(...split.diagnostics);
  if (!split.ok) return { ok: false, role: null, body: "", prompt: null, diagnostics, file, dir, promptSha: null };

  const parsed = parseDocumentText(split.frontmatter, { file, format: "yaml" });
  diagnostics.push(...parsed.diagnostics);
  if (!parsed.ok) return { ok: false, role: null, body: split.body, prompt: null, diagnostics, file, dir, promptSha: null };

  const validated = validateRole(parsed.value, {
    file,
    knownToolPolicies: options.knownToolPolicies ?? null,
    bodyChars: charLength(split.body),
  });
  diagnostics.push(...validated.diagnostics);
  if (!validated.ok) {
    return { ok: false, role: null, body: split.body, prompt: null, diagnostics, file, dir, promptSha: null };
  }

  const role = validated.role;
  const partTexts = [];
  for (const relative of role.prompt.parts) {
    const resolved = safeResolve(dir, relative);
    if (resolved === null) {
      diagnostics.push(diagnostic("error", "unsafe-path", "prompt.parts", `片段路径不允许越出角色目录：${relative}`, file));
      continue;
    }
    if (!existsSync(resolved)) {
      diagnostics.push(diagnostic("error", "missing-part", "prompt.parts", `片段文件不存在：${relative}`, file));
      continue;
    }
    let partText;
    try {
      partText = readFileSync(resolved, "utf8");
    } catch (error) {
      diagnostics.push(diagnostic("error", "unreadable-part", "prompt.parts", `读不到片段 ${relative}：${error?.message ?? error}`, file));
      continue;
    }
    const chars = charLength(partText);
    if (chars > LIMITS2.partChars) {
      diagnostics.push(diagnostic("error", "part-too-long", "prompt.parts", `片段 ${relative} 有 ${chars} 字符，超过 ${LIMITS2.partChars}`, file));
    }
    partTexts.push({ path: relative, text: partText, chars });
  }

  if (role.prompt.parts.length > LIMITS2.parts) {
    diagnostics.push(diagnostic("error", "too-many-parts", "prompt.parts", `片段最多 ${LIMITS2.parts} 个`, file));
  }

  if (diagnostics.some((item) => item.severity === "error")) {
    return { ok: false, role, body: split.body, prompt: null, diagnostics, file, dir, promptSha: null };
  }

  // 共享知识：只声明不内联。库根未知时跳过（单角色校验拿不到库根），
  // 编译路径一定会传 libraryRoot，所以不会静默缺一块。
  const knowledgeEntries = [];
  for (const reference of role.knowledge) {
    const loaded = loadKnowledgeEntry(options.libraryRoot ?? "", reference, { file, field: "knowledge" });
    diagnostics.push(...loaded.diagnostics);
    if (loaded.entry !== null) knowledgeEntries.push(loaded.entry);
  }
  role.knowledge = knowledgeEntries.map((entry) => entry.path);

  // 正文里的引用只展开一层；展开后的字符才是预算的对象（引用不是"免费的"）。
  const expanded = expandIncludes({
    text: split.body,
    file: ROLE_FILE_NAME,
    roleDir: dir,
    libraryRoot: options.libraryRoot ?? null,
    lineOffset: Number.isInteger(split.bodyLine) ? split.bodyLine - 1 : 0,
  });
  diagnostics.push(...expanded.diagnostics);
  if (!expanded.ok) {
    return { ok: false, role, body: split.body, prompt: null, diagnostics, file, dir, promptSha: null };
  }

  const assembled = assemblePrompt(expanded.text, partTexts.map((part) => part.text));
  const chars = charLength(assembled.text);
  if (chars > LIMITS2.promptChars) {
    diagnostics.push(
      diagnostic("error", "prompt-too-long", "prompt", `拼装后 ${chars} 字符，超过上限 ${LIMITS2.promptChars}`, file),
    );
    return { ok: false, role, body: split.body, prompt: null, diagnostics, file, dir, promptSha: null };
  }
  if (role.prompt.budget !== null && chars > role.prompt.budget) {
    diagnostics.push(
      diagnostic("error", "prompt-over-budget", "prompt.budget", `拼装后 ${chars} 字符超过预算 ${role.prompt.budget}`, file),
    );
    return { ok: false, role, body: split.body, prompt: null, diagnostics, file, dir, promptSha: null };
  }

  return {
    ok: true,
    role,
    body: split.body,
    prompt: {
      text: assembled.text,
      chars,
      parts: [{ path: "body", chars: charLength(split.body) }, ...partTexts.map((part) => ({ path: part.path, chars: part.chars }))],
      includes: expanded.includes,
      knowledge: knowledgeEntries,
    },
    diagnostics,
    file,
    dir,
    promptSha: null,
  };
}

/** 从 frontmatter 的 `prompt.parts` 里读出片段路径列表（未校验版本，仅给扫描器算依赖用）。 */
export function rolePartPaths(role) {
  return Array.isArray(role?.prompt?.parts) ? role.prompt.parts.slice() : [];
}

/** 角色目录里 `parts/` 的实际文件名（用于「片段存在但没被引用」提示）。 */
export function listPartFiles(dirPath) {
  const dir = nodePath.join(nodePath.resolve(String(dirPath)), ROLE_PARTS_DIR);
  try {
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

function validateRoute(value, path, report) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("error", "invalid-field", path, "route 必须是映射");
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!ROUTE_FIELDS.includes(key)) report("error", "unknown-field", `${path}.${key}`, `未知字段 ${path}.${key}`);
  }
  const route = {};
  if (value.provider !== undefined) {
    if (typeof value.provider !== "string" || !PATTERNS2.provider.test(value.provider)) {
      report("error", "invalid-provider", `${path}.provider`, `provider 形态不合法：${describe(value.provider)}`);
    } else route.provider = value.provider;
  }
  if (value.model !== undefined) {
    if (typeof value.model !== "string" || !PATTERNS2.model.test(value.model)) {
      report("error", "invalid-model", `${path}.model`, `model 形态不合法：${describe(value.model)}`);
    } else route.model = value.model;
  }
  if (value.reasoningEffort !== undefined) {
    if (!REASONING_EFFORTS.includes(value.reasoningEffort)) {
      report("error", "invalid-effort", `${path}.reasoningEffort`, `reasoningEffort 只能是 ${REASONING_EFFORTS.join(" / ")}`);
    } else route.reasoningEffort = value.reasoningEffort;
  }
  if (route.provider !== undefined && route.model === undefined) {
    report("error", "incomplete-route", path, "声明了 provider 就必须声明 model（两者成对出现）");
  }
  if (route.model !== undefined && route.provider === undefined) {
    report("error", "incomplete-route", path, "声明了 model 就必须声明 provider（两者成对出现）");
  }
  return route;
}

function validateTools(value, path, knownToolPolicies, report) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("error", "invalid-field", path, "tools 必须是映射");
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!TOOLS_FIELDS.includes(key)) report("error", "unknown-field", `${path}.${key}`, `未知字段 ${path}.${key}`);
  }
  const tools = {};
  if (value.policy !== undefined) {
    if (typeof value.policy !== "string" || !PATTERNS2.id.test(value.policy)) {
      report("error", "invalid-tool-policy", `${path}.policy`, `policy 必须是 kebab-case 的 2~64 字符：${describe(value.policy)}`);
    } else {
      tools.policy = value.policy;
      if (knownToolPolicies !== null && knownToolPolicies.length > 0 && !knownToolPolicies.includes(value.policy)) {
        report(
          "error",
          "unknown-tool-policy",
          `${path}.policy`,
          `部署没有声明工具策略 ${value.policy}；已知：${knownToolPolicies.join(", ")}`,
        );
      }
    }
  }
  if (value.scope !== undefined) {
    if (value.scope === null || typeof value.scope !== "object" || Array.isArray(value.scope)) {
      report("error", "invalid-field", `${path}.scope`, "scope 必须是映射");
    } else {
      for (const key of Object.keys(value.scope)) {
        if (!TOOL_SCOPE_FIELDS.includes(key)) {
          report("error", "unknown-field", `${path}.scope.${key}`, `未知字段 ${path}.scope.${key}`);
        }
      }
      tools.scope = {};
      for (const key of TOOL_SCOPE_FIELDS) {
        if (value.scope[key] === undefined) continue;
        const list = value.scope[key];
        if (!Array.isArray(list) || list.length > 64 || list.some((item) => typeof item !== "string" || !PATTERNS.toolPattern.test(item))) {
          report("error", "invalid-tool-scope", `${path}.scope.${key}`, `${key} 必须是工具名数组（最多 64 项）`);
          continue;
        }
        tools.scope[key] = list.slice();
      }
    }
  }
  return tools;
}

function validatePrompt(value, report) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("error", "invalid-field", "prompt", "prompt 必须是映射");
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!PROMPT_FIELDS.includes(key)) report("error", "unknown-field", `prompt.${key}`, `未知字段 prompt.${key}`);
  }
  const parts = [];
  if (value.parts !== undefined) {
    if (!Array.isArray(value.parts) || value.parts.length > LIMITS2.parts) {
      report("error", "invalid-parts", "prompt.parts", `parts 必须是有序数组（最多 ${LIMITS2.parts} 项）`);
    } else {
      value.parts.forEach((item, index) => {
        if (typeof item !== "string" || !isSafeRelative(item)) {
          report("error", "unsafe-path", `prompt.parts[${index}]`, `片段必须是不含 .. 的相对路径：${describe(item)}`);
        } else {
          parts.push(item);
        }
      });
      if (new Set(parts).size !== parts.length) report("error", "duplicate-part", "prompt.parts", "同一个片段被引用了两次");
    }
  }
  let budget = null;
  if (value.budget !== undefined) {
    if (!Number.isInteger(value.budget) || value.budget <= 0) {
      report("error", "invalid-budget", "prompt.budget", "budget 必须是正整数（字符数）");
    } else {
      budget = value.budget;
    }
  }
  return { parts, budget };
}

function validateRequires(value, path, report) {
  if (value === undefined) return { skills: [], toolPolicies: [] };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("error", "invalid-field", path, "requires 必须是映射");
    return { skills: [], toolPolicies: [] };
  }
  for (const key of Object.keys(value)) {
    if (!REQUIRES_FIELDS.includes(key)) {
      report("error", "unknown-field", `${path}.${key}`, `未知要求 ${path}.${key}：只有有证据源的要求才能被声明`);
    }
  }
  return {
    skills: stringList(value.skills, `${path}.skills`, LIMITS2.skillsPerRole, PATTERNS2.skill, report),
    toolPolicies: stringList(value.toolPolicies, `${path}.toolPolicies`, 16, PATTERNS2.id, report),
  };
}

function singleLine(value, path, maxChars, report) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value === "") {
    report("error", "invalid-field", path, `${path} 必须是非空字符串`);
    return null;
  }
  if (value.includes("\n")) {
    report("error", "multiline-field", path, `${path} 必须是单行；长文本请写进正文或 parts/`);
    return null;
  }
  const chars = charLength(value);
  if (SINGLE_LINE.has(path) && chars > maxChars) {
    report("error", "field-too-long", path, `${path} 有 ${chars} 字符，超过 ${maxChars}`);
    return null;
  }
  return value;
}

function stringList(value, path, max, pattern, report) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    report("error", "invalid-field", path, `${path} 必须是数组`);
    return [];
  }
  if (value.length > max) report("error", "too-many-items", path, `${path} 最多 ${max} 项`);
  const out = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || (pattern !== null && !pattern.test(item))) {
      report("error", "invalid-item", `${path}[${index}]`, `${path}[${index}] 形态不合法：${describe(item)}`);
      return;
    }
    out.push(item);
  });
  if (new Set(out).size !== out.length) report("error", "duplicate-item", path, `${path} 里有重复项`);
  return out;
}

export { isSafeRelative, safeResolve } from "./paths.js";

function describe(value) {
  if (value === undefined) return "缺失";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `数组(${value.length})`;
  return "对象";
}
