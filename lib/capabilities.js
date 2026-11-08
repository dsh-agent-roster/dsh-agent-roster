/**
 * 能力要求（`capabilities.yaml`）：与档案同目录的**兄弟文件**，只写"要用到哪些能力"，
 * 不承载任何能力本身。
 *
 * 为什么不在 `roster.yaml` 里加字段：档案格式是严格闭集（未知键 = 错误），
 * 而且上游只会消费那 17 个已知字段。能力要求属于"部署侧的事实"，不是"成员是谁"，
 * 所以另放一个文件，由本插件自己读、自己校验。
 *
 * 三条纪律（都是踩过的坑换来的）：
 *
 * 1. **只声明能核对的**。目前能核对两类：技能是否装在技能目录里（`ctx.get("skills")`），
 *    toolPolicy id 是否在部署声明里（配置 `knownToolPolicies`）。模型路由、插件版本、
 *    凭据指针一律不写——它们在这个上下文里没有证据源，写进来只会再造一次假绿。
 * 2. **缺失的语义由 `onMissing` 决定，默认 `refuse`**：拒绝出参数，而不是"先建了再说"。
 *    静默降级正是 `systemPrompt` 假绿的翻版。
 * 3. **核对不到 ≠ 缺失**。没有证据源时状态是 `unchecked`，既不翻红也不冒充通过。
 *
 * @module dsh-agent-roster/capabilities
 */
import { diagnostic } from "./parse.js";
import { isSafeRelative } from "./paths.js";

/** 能力要求文档的格式标识。 */
export const CAPABILITIES_KIND = "dsh-agent-roster-capabilities/v1";

/** 兄弟文件的候选文件名，按优先级取第一个。 */
export const CAPABILITIES_FILE_NAMES = ["capabilities.yaml", "capabilities.yml", "capabilities.json"];

/** 能力缺失时的行为。`refuse` 是默认值：缺能力就不出参数。 */
export const ON_MISSING = /** @type {const} */ (["refuse", "degraded"]);
export const DEFAULT_ON_MISSING = "refuse";

/** 顶层字段闭集。 */
const ROOT_FIELDS = new Set(["kind", "roster", "onMissing", "asOf", "requires", "notes"]);
/** `requires` 的字段闭集。 */
const REQUIRES_FIELDS = new Set(["skills", "toolPolicies", "documents"]);

export const LIMITS = { requirements: 32, nameChars: 64, reasonChars: 200, notesChars: 500 };

/** 与 format.js 同一口径的 kebab-case id 模式。 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** 技能名允许大写与下划线（DSH 技能目录不强制 kebab-case）。 */
export const SKILL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** `asOf` 只接受日期，不接受时间戳：能力清单是按天核的，写时分秒会制造假精度。 */
const AS_OF_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 校验一份能力要求文档（纯函数、零 IO）。
 *
 * @param {unknown} value 已解析的对象树
 * @param {{ file?: string, expectedId?: string | null }} [options]
 * @returns {{ ok: boolean, capabilities: object | null, diagnostics: object[] }}
 */
export function validateCapabilities(value, options = {}) {
  const file = String(options.file ?? "");
  const expectedId =
    typeof options.expectedId === "string" && options.expectedId !== "" ? options.expectedId : null;
  const diagnostics = [];
  const report = (severity, code, path, reason) =>
    diagnostics.push(diagnostic(severity, code, path, reason, file));

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("error", "capabilities-not-mapping", "", "能力要求文档顶层必须是映射（对象）");
    return { ok: false, capabilities: null, diagnostics };
  }

  for (const key of Object.keys(value)) {
    if (!ROOT_FIELDS.has(key)) {
      report(
        "error",
        "unknown-field",
        key,
        `未知字段 "${key}"。能力要求只接受 ${[...ROOT_FIELDS].join(" / ")}；` +
          "模型路由、插件版本、凭据指针没有证据源，写进来只会变成永不核对的假绿。",
      );
    }
  }

  if (value.kind !== CAPABILITIES_KIND) {
    report(
      "error",
      "invalid-kind",
      "kind",
      `kind 必须是 "${CAPABILITIES_KIND}"，实际是 ${describe(value.kind)}`,
    );
  }

  const rosterId = value.roster;
  if (typeof rosterId !== "string" || rosterId === "") {
    report("error", "missing-field", "roster", "缺少 roster（这份要求属于哪份档案）");
  } else if (!ID_PATTERN.test(rosterId)) {
    report("error", "invalid-id", "roster", `roster 必须是 kebab-case 的 2~64 字符：${rosterId}`);
  } else if (expectedId !== null && rosterId !== expectedId) {
    report(
      "error",
      "roster-id-mismatch",
      "roster",
      `roster 字段（${rosterId}）必须与所在目录名（${expectedId}）一致`,
    );
  }

  let onMissing = DEFAULT_ON_MISSING;
  if (value.onMissing !== undefined && value.onMissing !== null) {
    if (!ON_MISSING.includes(value.onMissing)) {
      report(
        "error",
        "invalid-on-missing",
        "onMissing",
        `onMissing 只能是 ${ON_MISSING.join(" / ")}，实际是 ${describe(value.onMissing)}`,
      );
    } else {
      onMissing = value.onMissing;
    }
  }

  let asOf = null;
  if (value.asOf !== undefined && value.asOf !== null) {
    if (typeof value.asOf !== "string" || !AS_OF_PATTERN.test(value.asOf)) {
      report("error", "invalid-as-of", "asOf", `asOf 必须是 YYYY-MM-DD 日期：${describe(value.asOf)}`);
    } else {
      asOf = value.asOf;
    }
  }

  const notes = optionalText(value.notes, "notes", LIMITS.notesChars, report);
  const requires = validateRequires(value.requires, report);

  return {
    ok: diagnostics.every((item) => item.severity !== "error"),
    capabilities: {
      kind: CAPABILITIES_KIND,
      roster: typeof rosterId === "string" ? rosterId : null,
      onMissing,
      asOf,
      requires,
      notes,
    },
    diagnostics,
  };
}

function validateRequires(raw, report) {
  const empty = { skills: [], toolPolicies: [], documents: [] };
  if (raw === undefined || raw === null) return empty;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    report("error", "invalid-requires", "requires", "requires 必须是映射（对象）");
    return empty;
  }
  for (const key of Object.keys(raw)) {
    if (!REQUIRES_FIELDS.has(key)) {
      report(
        "error",
        "unknown-field",
        `requires.${key}`,
        `未知的能力类别 "requires.${key}"。目前只核对 skills / toolPolicies / documents；` +
          "其余类别没有证据源，不接收。",
      );
    }
  }
  return {
    skills: requirementList(raw.skills, "requires.skills", SKILL_PATTERN, report),
    toolPolicies: requirementList(raw.toolPolicies, "requires.toolPolicies", ID_PATTERN, report),
    documents: documentList(raw.documents, "requires.documents", report),
  };
}

/**
 * 读取一组能力要求。每一项可以写成裸字符串，也可以写成 `{name, reason}`：
 * 裸字符串够用于 CI，带 `reason` 是给人看的——"为什么需要它"往往比"需要它"更重要。
 */
function requirementList(raw, path, pattern, report) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    report("error", "invalid-requirement-list", path, `${path} 必须是数组`);
    return [];
  }
  if (raw.length > LIMITS.requirements) {
    report("error", "too-many-requirements", path, `${path} 最多 ${LIMITS.requirements} 项`);
    return [];
  }
  const seen = new Map();
  const out = [];
  raw.forEach((item, index) => {
    const at = `${path}[${index}]`;
    let name;
    let reason = null;
    if (typeof item === "string") {
      name = item;
    } else if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      for (const key of Object.keys(item)) {
        if (key !== "name" && key !== "reason") {
          report("error", "unknown-field", `${at}.${key}`, `未知字段 "${key}"，只接受 name / reason`);
        }
      }
      name = item.name;
      if (item.reason !== undefined && item.reason !== null) {
        reason = optionalText(item.reason, `${at}.reason`, LIMITS.reasonChars, report);
      }
    } else {
      report("error", "invalid-requirement", at, `${at} 必须是字符串或 {name, reason} 对象`);
      return;
    }
    if (typeof name !== "string" || name === "") {
      report("error", "missing-field", `${at}.name`, `${at} 缺少 name`);
      return;
    }
    if (name.length > LIMITS.nameChars) {
      report("error", "name-too-long", `${at}.name`, `${at}.name 最长 ${LIMITS.nameChars} 字符`);
      return;
    }
    if (!pattern.test(name)) {
      report("error", "invalid-requirement-name", `${at}.name`, `${at}.name 不合格式：${name}`);
      return;
    }
    if (seen.has(name)) {
      report(
        "error",
        "duplicate-requirement",
        `${at}.name`,
        `${name} 重复声明（已出现在 ${seen.get(name)}）；重复不会让要求更强，只会让人以为写了两条。`,
      );
      return;
    }
    seen.set(name, at);
    out.push({ name, reason });
  });
  return out;
}

/**
 * 读取文档要求：`requires.documents` 是 `{path, sha256?, reason?}` 的数组。
 *
 * 为什么不收裸字符串：文档的价值在于"指到具体那份"，裸名字解析不到文件；
 * 而 sha256 是可选的——不写就是"只要它在"，写了就是"内容也得对得上"。
 */
function documentList(raw, path, report) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    report("error", "invalid-requirement-list", path, `${path} 必须是数组`);
    return [];
  }
  if (raw.length > LIMITS.requirements) {
    report("error", "too-many-requirements", path, `${path} 最多 ${LIMITS.requirements} 项`);
    return [];
  }
  const seen = new Map();
  const out = [];
  raw.forEach((item, index) => {
    const at = `${path}[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      report("error", "invalid-requirement", at, `${at} 必须是 {path, sha256?, reason?} 对象——裸字符串没有证据`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (key !== "path" && key !== "sha256" && key !== "reason") {
        report("error", "unknown-field", `${at}.${key}`, `未知字段 "${key}"，只接受 path / sha256 / reason`);
      }
    }
    const documentPath = item.path;
    if (typeof documentPath !== "string" || !isSafeRelative(documentPath)) {
      report("error", "invalid-document-path", `${at}.path`, `${at}.path 必须是库内相对路径（不许 .. 或绝对路径）`);
      return;
    }
    let sha = null;
    if (item.sha256 !== undefined && item.sha256 !== null) {
      if (typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256)) {
        report("error", "invalid-document-sha", `${at}.sha256`, "sha256 必须是 64 位小写十六进制");
        return;
      }
      sha = item.sha256;
    }
    if (seen.has(documentPath)) {
      report(
        "error",
        "duplicate-requirement",
        `${at}.path`,
        `${documentPath} 重复声明（已出现在 ${seen.get(documentPath)}）；重复不会让要求更强`,
      );
      return;
    }
    seen.set(documentPath, at);
    const reason =
      item.reason === undefined || item.reason === null
        ? null
        : optionalText(item.reason, `${at}.reason`, LIMITS.reasonChars, report);
    out.push({ path: documentPath, sha256: sha, reason });
  });
  return out;
}

function optionalText(value, path, limit, report) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    report("error", "invalid-type", path, `${path} 必须是字符串`);
    return null;
  }
  const text = value.trim();
  if (text === "") return null;
  if (text.length > limit) {
    report("error", "too-long", path, `${path} 最长 ${limit} 字符，实际 ${text.length}`);
    return null;
  }
  if (/[\r\n]/.test(text)) {
    report("error", "multiline-text", path, `${path} 必须是单行文本`);
    return null;
  }
  return text;
}

function describe(value) {
  if (value === null) return "null";
  if (value === undefined) return "（缺失）";
  if (typeof value === "string") return `"${value}"`;
  if (Array.isArray(value)) return "数组";
  return typeof value === "object" ? "对象" : String(value);
}

/**
 * 把能力要求摊平成一串待核对项。
 *
 * @param {object | null} capabilities
 * @returns {{ kind: "skill" | "toolPolicy", name: string, reason: string | null }[]}
 */
export function capabilityRequirements(capabilities) {
  if (capabilities === null || capabilities === undefined) return [];
  const requires = capabilities.requires ?? {};
  return [
    ...(requires.skills ?? []).map((item) => ({ kind: "skill", name: item.name, reason: item.reason })),
    ...(requires.toolPolicies ?? []).map((item) => ({
      kind: "toolPolicy",
      name: item.name,
      reason: item.reason,
    })),
    ...(requires.documents ?? []).map((item) => ({
      kind: "document",
      name: item.path,
      sha256: item.sha256,
      reason: item.reason,
    })),
  ];
}

/**
 * 核对能力要求。
 *
 * 三种结果，**互不冒充**：
 * - `present`：证据源说它在；
 * - `missing`：证据源说它不在（这是唯一会让 `refuse` 生效的状态）；
 * - `unknown`：没有证据源（技能服务没挂、`knownToolPolicies` 没配），既不算过也不算错。
 *
 * @param {object[]} rosters 已通过校验的档案
 * @param {Record<string, object>} capabilitiesById 档案 id → 能力要求对象
 * @param {{ knownSkills?: string[] | null, knownToolPolicies?: string[] | null }} [evidence]
 * @returns {{ entries: object[], summary: object }}
 */
export function checkCapabilities(rosters, capabilitiesById, evidence = {}) {
  const knownSkills =
    Array.isArray(evidence.knownSkills) && evidence.knownSkills.length > 0
      ? new Set(evidence.knownSkills.filter((name) => typeof name === "string" && name !== ""))
      : null;
  const knownPolicies =
    Array.isArray(evidence.knownToolPolicies) && evidence.knownToolPolicies.length > 0
      ? new Set(evidence.knownToolPolicies.filter((id) => typeof id === "string" && id !== ""))
      : null;
  // 文档证据按档案给：path → { exists, sha256 }。没给就是"没有证据源"，
  // 记 unknown 而不是 missing——读不到文件不等于文件不在。
  const documents = evidence.documents !== undefined && evidence.documents !== null ? evidence.documents : null;

  const entries = [];
  const summary = { declared: 0, present: 0, missing: 0, unknown: 0, blocked: 0, degraded: 0 };

  for (const roster of rosters) {
    const capabilities = capabilitiesById?.[roster.id] ?? null;
    const requirements = capabilityRequirements(capabilities);
    if (requirements.length === 0 && capabilities === null) continue;

    const missing = [];
    const unknown = [];
    const present = [];
    for (const requirement of requirements) {
      if (requirement.kind === "document") {
        const evidenceMap = documents === null ? null : documents?.[roster.id] ?? null;
        if (evidenceMap === null) {
          unknown.push(requirement);
          continue;
        }
        const found = evidenceMap[requirement.name];
        if (found === undefined) {
          unknown.push(requirement);
          continue;
        }
        if (found.exists !== true) {
          missing.push({ ...requirement, reason: requirement.reason, why: "file-missing" });
          continue;
        }
        if (typeof requirement.sha256 === "string" && requirement.sha256 !== "" && found.sha256 !== requirement.sha256) {
          missing.push({ ...requirement, why: "sha-mismatch", actual: found.sha256 });
          continue;
        }
        present.push(requirement);
        continue;
      }
      const evidenceSet = requirement.kind === "skill" ? knownSkills : knownPolicies;
      if (evidenceSet === null) {
        unknown.push(requirement);
      } else if (evidenceSet.has(requirement.name)) {
        present.push(requirement);
      } else {
        missing.push(requirement);
      }
    }

    const onMissing = capabilities?.onMissing ?? DEFAULT_ON_MISSING;
    // 只有"确实缺"才触发策略；核对不到不许当成缺，否则配不上证据源的机器会全红。
    const blocked = onMissing === "refuse" && missing.length > 0;
    summary.declared += requirements.length;
    summary.present += present.length;
    summary.missing += missing.length;
    summary.unknown += unknown.length;
    if (blocked) summary.blocked += 1;
    else if (onMissing === "degraded" && missing.length > 0) summary.degraded += 1;

    entries.push({
      rosterId: roster.id,
      version: roster.version,
      onMissing,
      asOf: capabilities?.asOf ?? null,
      requires: requirements.length,
      present,
      missing,
      unknown,
      blocked,
      status: blocked ? "blocked" : missing.length > 0 ? "degraded" : unknown.length > 0 ? "unchecked" : "ok",
    });
  }

  return { entries, summary };
}

/** 能力类别的人话名与"该装到哪"——拒绝时直接告诉人怎么修。 */
export const CAPABILITY_HINTS = {
  skill: {
    label: "技能",
    install:
      "把技能目录放进仓库的 .dsh/skills/ 或全局 ~/.dsh/skills/（由 dsh-skill-filesystem 监听，拷进去即生效）",
  },
  toolPolicy: {
    label: "工具策略",
    install: "在本插件配置的 knownToolPolicies 里声明该 id，并在 profile 的 toolPolicies 中定义它",
  },
  document: {
    label: "文档",
    install: "把文件放进档案库根目录下（path 相对库根），需要防止漂移就写上它的 sha256",
  },
};

/**
 * 面板层的能力诊断：把"能同步判定的部分"变成诊断条目。
 *
 * 为什么只判工具策略：面板快照是同步的，而技能目录只能通过宿主的技能服务异步列出来。
 * 与其在面板里编一个"看起来通过"的结论，不如把技能要求标成"面板不核对"——
 * 这与 `checkCapabilities` 的 `unknown` 是同一个态度：没有证据源就说没有，不冒充通过。
 *
 * @param {Record<string, object>} capabilitiesById 档案 id → 能力要求
 * @param {Record<string, string>} capabilityFiles 档案 id → 能力文件相对路径
 * @param {string[] | null} knownToolPolicies 部署已声明的策略 id
 * @returns {object[]} 与 `scanRosterLibrary` 同形状的诊断
 */
export function capabilityDiagnostics(capabilitiesById, capabilityFiles, knownToolPolicies) {
  const ids = Object.keys(capabilitiesById ?? {}).sort();
  if (ids.length === 0) return [];

  const policies = Array.isArray(knownToolPolicies) ? knownToolPolicies : null;
  const diagnostics = [];
  const skipped = [];

  for (const id of ids) {
    const capabilities = capabilitiesById[id];
    const file = capabilityFiles?.[id] ?? `${id}/capabilities.yaml`;
    const base = { path: "", file };

    const declaredPolicies = (capabilities.requires?.toolPolicies ?? []).map((item) => item.name);
    const declaredSkills = (capabilities.requires?.skills ?? []).map((item) => item.name);

    if (declaredPolicies.length > 0) {
      if (policies === null) {
        // 证据源缺席：逐份档案刷"无法核对"只会变成噪音，汇总成一条。
        skipped.push(id);
      } else {
        const missing = declaredPolicies.filter((name) => !policies.includes(name));
        if (missing.length > 0) {
          const refuse = (capabilities.onMissing ?? DEFAULT_ON_MISSING) === "refuse";
          diagnostics.push({
            ...base,
            severity: refuse ? "error" : "warn",
            code: "capability-policy-missing",
            reason: refuse
              ? `档案 "${id}" 要求工具策略 ${missing.join("、")}，但部署的 knownToolPolicies 里没有；` +
                "onMissing: refuse，建队会被拒绝。"
              : `档案 "${id}" 要求工具策略 ${missing.join("、")}，但部署的 knownToolPolicies 里没有；` +
                "onMissing: degraded，建队照常，但每次核对都会记为 degraded。",
          });
        }
      }
    }

    if (declaredSkills.length > 0) {
      diagnostics.push({
        ...base,
        severity: "info",
        code: "capability-skills-unverified",
        reason:
          `档案 "${id}" 声明了技能要求 ${declaredSkills.join("、")}；` +
          "面板不列技能目录，因此这里不判定——用 roster_verify 核对（技能服务在场时才会给出缺/不缺）。",
      });
    }
  }

  if (skipped.length > 0) {
    diagnostics.push({
      severity: "info",
      code: "capability-cross-check-skipped",
      path: "",
      file: null,
      reason:
        `未配置 knownToolPolicies：${skipped.join("、")} 的 toolPolicies 要求只做格式校验，不与部署交叉核对。` +
        "把部署里存在的策略 id 列进该配置即可启用核对。",
    });
  }

  return diagnostics;
}
