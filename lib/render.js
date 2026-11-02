/**
 * 人读渲染：工具输出与 CLI 共用同一套文本，避免"工具里一个样子、CI 里另一个样子"。
 *
 * 输出一律是纯文本（不是 Markdown 表格）：模型读、人在终端读都成立，
 * 也不会因为成员名里的字符破坏表格。JSON 视图由 `toJson` 单独提供。
 *
 * @module dsh-agent-roster/render
 */
import { BINDING_STATUS, describeField, summarizeBinding } from "./bridge.js";
import { LIMITS } from "./format.js";
import { memberVerdict } from "./verify.js";


/** 核对结论的人读标签。 */
const VERDICT_LABEL = { faithful: "一致", unverified: "未核实", drift: "降级", missing: "未部署" };

/**
 * 一行工具过滤器摘要。`null` 表示 `team.json` 里没有物化后的 deny 列表——
 * 那不是"一致"，只是读不到，所以照实写"无法核对"。
 *
 * @param {{ deny: number, allow: number, sha: string } | null} digest
 * @returns {string}
 */
function toolFilterLine(digest) {
  if (digest === null) return "   toolFilter  无法核对（team.json 没有物化后的 deny 列表）";
  return `   toolFilter  deny ${digest.deny} · allow ${digest.allow} · sha ${digest.sha}`;
}

/**
 * 一句人读的溯源结论。
 *
 * @param {object} item `verifyBindings` 的 provenance 项
 * @returns {string}
 */
function provenanceText(item) {
  switch (item.status) {
    case "absent":
      return "description 里没有溯源串（建团队时把 roster_create 给的那一行写进 description 才有出处）";
    case "unknown-roster":
      return `声明 ${item.declared}，但本机没有这份档案`;
    case "id-only":
      return `声明 ${item.declared}，没有内容哈希，只能核对 id 与版本`;
    case "match":
      return `${item.declared} · 与当前档案内容一致`;
    default:
      return `${item.declared} · 档案文件内容已变（当前 #${item.currentSha}）`;
  }
}

/**
 * 诊断列表 → 文本块。错误在前、按文件分组，超出上限时明确写出省略了多少条。
 *
 * @param {object[]} diagnostics
 * @param {{ limit?: number, indent?: string }} [options]
 * @returns {string}
 */
export function renderDiagnostics(diagnostics, options = {}) {
  const list = (diagnostics ?? []).filter((item) => item !== null && typeof item === "object");
  if (list.length === 0) return "";
  const limit = options.limit ?? 40;
  const indent = options.indent ?? "  ";
  const severityRank = { error: 0, warn: 1, info: 2 };
  const sorted = list
    .slice()
    .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9));
  const shown = sorted.slice(0, limit);
  const lines = [];
  for (const item of shown) {
    // path/file 都可能是 null（"这条诊断不属于任何字段/文件"），null 不能落成字面量 "null"。
    const path = item.path === null ? "" : String(item.path ?? "");
    const fileText = item.file === null ? "" : String(item.file ?? "");
    const where = path === "" ? "" : ` ${path}`;
    const file = fileText === "" ? "" : `${fileText}: `;
    lines.push(`${indent}${item.severity}${where}  ${file}${item.reason}${item.code ? `  [${item.code}]` : ""}`);
  }
  if (sorted.length > shown.length) {
    lines.push(`${indent}… 还有 ${sorted.length - shown.length} 条诊断未显示`);
  }
  return lines.join("\n");
}

/**
 * 档案库总览。
 *
 * @param {{ rootDir: string, entries: object[], stats: object }} scan
 * @returns {string}
 */
export function renderRosterList(scan) {
  const { entries, stats, rootDir } = scan;
  const lines = [];
  lines.push(`档案库  ${rootDir}`);
  const organization = scan.organization ?? null;
  if (organization !== null) {
    const check = scan.organizationCheck ?? { declared: 0, present: 0, missing: [], undeclared: [], archived: [] };
    lines.push(`组织    ${organization.id}  ${organization.title}`);
    if (organization.description !== "") lines.push(`        ${organization.description}`);
    const parts = [
      `登记 ${check.declared}`,
      `在库 ${check.present}`,
      `缺 ${check.missing.length}`,
      `未登记 ${check.undeclared.length}`,
    ];
    if (check.archived.length > 0) parts.push(`已归档 ${check.archived.length}`);
    if (organization.maintainers.length > 0) parts.push(`维护者 ${organization.maintainers.join(", ")}`);
    lines.push(`        ${parts.join(" · ")}`);
  }
  if (entries.length === 0) {
    lines.push("");
    lines.push(scan.missing === true ? "（目录尚未创建：保存第一份档案时会自动建）" : "（空：没有任何 roster 目录）");
    lines.push("目录约定：<root>/<roster-id>/roster.{json,yaml,yml}");
    return lines.join("\n");
  }
  lines.push(`共 ${stats.total} 个目录 · 通过 ${stats.ok} · 失败 ${stats.failed}`);
  lines.push("");
  lines.push("ID                    版本      成员  状态     标题");
  for (const entry of entries) {
    const roster = entry.roster;
    if (roster === null) {
      lines.push(`${pad(entry.id, 21)}${pad("-", 10)}${pad("-", 5)}${pad("失败", 9)}(无有效档案)`);
      continue;
    }
    lines.push(
      `${pad(roster.id, 21)}${pad(roster.version, 10)}${pad(String(roster.members.length), 5)}${pad("通过", 9)}${roster.title}`,
    );
    lines.push(`  ${roster.members.map((member) => member.name).join(", ")}`);
  }
  const failed = scan.diagnostics.filter((item) => item.severity === "error");
  if (failed.length > 0) {
    lines.push("");
    lines.push("失败原因：");
    lines.push(renderDiagnostics(failed, { limit: 20 }));
  }
  return lines.join("\n");
}

/**
 * 单份档案详情。
 *
 * @param {object} roster
 * @param {string[]} [onlyMembers]
 * @returns {string}
 */
export function renderRosterDetail(roster, onlyMembers) {
  const wanted =
    Array.isArray(onlyMembers) && onlyMembers.length > 0 ? roster.members.filter((m) => onlyMembers.includes(m.name)) : roster.members;
  const lines = [];
  lines.push(`roster:${roster.id}@${roster.version}  ${roster.title}`);
  if (roster.description !== "") lines.push(`  ${roster.description}`);
  const meta = [];
  if (roster.license !== "") meta.push(`license=${roster.license}`);
  if (roster.maintainers.length > 0) meta.push(`maintainers=${roster.maintainers.join(", ")}`);
  if (roster.tags.length > 0) meta.push(`tags=${roster.tags.join(", ")}`);
  if (meta.length > 0) lines.push(`  ${meta.join("  ")}`);
  if (roster.captain !== null && roster.captain !== undefined) {
    lines.push(...renderCaptainSection(roster.captain));
  }

  const defaults = Object.entries(roster.defaults ?? {});
  if (defaults.length > 0) {
    lines.push("");
    lines.push("defaults（成员未写该字段时继承）");
    for (const [key, value] of defaults) {
      lines.push(`  ${pad(key, 16)}${literal(value)}`);
    }
  }

  if (wanted.length === 0) {
    lines.push("");
    lines.push(`（档案里没有成员：${(onlyMembers ?? []).join(", ")}）`);
    return lines.join("\n");
  }

  lines.push("");
  lines.push(`成员 ${wanted.length} 个`);
  for (const member of wanted) {
    lines.push("");
    lines.push(`▸ ${member.name}  —  ${member.role}`);
    if (member.provider !== undefined || member.model !== undefined) {
      const route = [member.provider ?? "(默认 provider)", member.model ?? "(默认 model)"].join(" / ");
      lines.push(`  model           ${route}${member.inherited?.includes("model") ? "  (继承 defaults)" : ""}`);
    } else {
      lines.push("  model           未指定 → 运行时沿用队长模型");
    }
    if (member.reasoningEffort !== undefined) lines.push(`  reasoningEffort ${member.reasoningEffort}`);
    if (member.toolPolicy !== undefined) lines.push(`  toolPolicy      ${member.toolPolicy}（必须是部署已声明的策略 id）`);
    if (member.fallback !== undefined) lines.push(`  fallback        ${member.fallback.provider} / ${member.fallback.model}（需落部署配置）`);
    if (member.toolScope !== undefined) lines.push(`  toolScope       仅声明：${describeToolScope(member.toolScope)}`);
    if (member.maxTokens !== undefined) lines.push(`  maxTokens       ${member.maxTokens}（仅声明）`);
    if (member.tags.length > 0) lines.push(`  tags            ${member.tags.join(", ")}`);
    if (member.description !== undefined && member.description !== "") {
      lines.push(`  description     ${member.description}`);
    }
    if (member.aliases !== undefined && member.aliases.length > 0) {
      lines.push(`  aliases         ${member.aliases.join(", ")}（改名前的旧名，核对时仍认作同一成员）`);
    }
    if (member.skills !== undefined && member.skills.length > 0) {
      lines.push(`  skills          ${member.skills.join(", ")}（仅声明：运行时不会自动加载技能）`);
    }
    if (member.examples !== undefined && member.examples.length > 0) {
      lines.push(`  examples        ${member.examples.length} 条典型请求`);
      for (const example of member.examples) lines.push(`    · ${example}`);
    }
    if (member.notes !== "") lines.push(`  notes           ${member.notes}`);
    lines.push(`  systemPrompt    ${member.systemPrompt.length} 字符 / 上限 ${LIMITS.systemPromptChars}`);
    lines.push(`    ${firstLines(member.systemPrompt, 2, 160)}`);
  }
  return lines.join("\n");
}

/**
 * 桥接计划：把每个成员翻译成一条 `agent_teams_add_member` 调用，并标注每个字段的归宿。
 *
 * @param {{ roster: object, entries: object[], planMembers: object[] }} plan
 * @returns {string}
 */
export function renderBridgePlan(plan) {
  const { roster, entries } = plan;
  const lines = [];
  lines.push(`桥接计划  roster:${roster.id}@${roster.version}  →  ${entries.length} 个成员`);
  lines.push("");
  lines.push("本插件不创建成员：下面的参数请由队长原样传给 dsh-agent-teams 的 agent_teams_add_member。");
  lines.push("（新团队也可以把这些成员放进 agent_teams_create 的 plan.members。）");
  for (const [index, entry] of entries.entries()) {
    lines.push("");
    lines.push(`${index + 1}) ${entry.member.name}  —  ${entry.member.role}`);
    lines.push(`   agent_teams_add_member(${JSON.stringify(entry.args, null, 2).replace(/\n/g, "\n   ")})`);
    lines.push("");
    for (const field of entry.binding.fields) {
      lines.push(`   ${describeField(field)}`);
    }
    const summary = summarizeBinding(entry.binding);
    const awaiting = summary.counts.pending ?? 0;
    lines.push("");
    lines.push(`   待运行时回执的字段：${awaiting}；仅声明：${summary.counts["not-carried"] ?? 0}；需落配置：${summary.counts["config-required"] ?? 0}`);
  }
  lines.push("");
  lines.push("成员创建完成后，用 roster_verify 比对 team.json 里的实际值；一致才算档案真正生效。");
  return lines.join("\n");
}

/**
 * 核对报告。
 *
 * @param {object} report `verifyBindings` 的结果
 * @param {{ rosterIds?: string[] }} [options]
 * @returns {string}
 */
export function renderVerifyReport(report, options = {}) {
  const lines = [];
  const rosterIds = new Set(options.rosterIds ?? []);
  const checks = rosterIds.size === 0 ? report.checks : report.checks.filter((check) => rosterIds.has(check.rosterId));

  if (checks.length === 0) {
    lines.push("没有可核对的成员（档案为空，或指定成员不在档案里）。");
    return lines.join("\n");
  }

  const byRoster = new Map();
  for (const check of checks) {
    const key = `${check.rosterId}@${check.rosterVersion}`;
    if (!byRoster.has(key)) byRoster.set(key, []);
    byRoster.get(key).push(check);
  }

  for (const [key, group] of byRoster) {
    const found = group.filter((check) => check.found).length;
    const faithful = group.filter((check) => memberVerdict(check) === "faithful").length;
    const unverified = group.filter((check) => memberVerdict(check) === "unverified").length;
    const suffix = unverified === 0 ? "" : ` · 未核实 ${unverified}`;
    lines.push(`roster:${key}  成员 ${group.length} · 已部署 ${found} · 一致 ${faithful}${suffix}`);
    for (const check of group) {
      if (!check.found) {
        lines.push("");
        lines.push(`▸ ${check.member}  未在团队中部署（档案定义了，运行时没有同名成员）`);
        continue;
      }
      lines.push("");
      const verdict = memberVerdict(check);
      lines.push(`▸ ${check.member}  @ ${check.teamName}   ${VERDICT_LABEL[verdict]}`);
      if (typeof check.matchedAs === "string" && check.matchedAs !== check.member) {
        lines.push(`   （运行时以旧名 "${check.matchedAs}" 记录，来自 aliases）`);
      }
      lines.push(toolFilterLine(check.toolFilter));
      for (const field of check.binding.fields) {
        if (field.status === "pending") continue;
        lines.push(`   ${describeField(field)}`);
      }
      if (!check.faithful) {
        const summary = check.summary;
        lines.push(
          `   → ${verdict === "unverified" ? "无法核对" : "降级"}字段：覆盖 ${summary.counts.overridden ?? 0} · 未留痕 ${summary.counts["not-persisted"] ?? 0} · 未声明 ${summary.counts.omitted ?? 0} · 无法核对 ${summary.counts.unconfirmed ?? 0}`,
        );
      }
    }
    lines.push("");
  }

  if (report.unmanaged.length > 0) {
    lines.push(`另有 ${report.unmanaged.length} 个成员不在任何档案里（运行时直接创建的）：`);
    for (const item of report.unmanaged) {
      const route = [item.provider, item.model].filter((part) => part !== "").join("/");
      lines.push(`  · ${item.name} @ ${item.teamName}${route === "" ? "" : `  ${route}`}`);
    }
    lines.push("");
  }

  const drift = report.policyDrift ?? [];
  if (drift.length > 0) {
    lines.push("策略漂移（同一个 toolPolicy 被物化成了不同的 deny 列表）");
    for (const item of drift) {
      lines.push(`  · ${item.toolPolicy} @ ${item.teamName}：${item.variants.length} 种物化结果`);
      for (const variant of item.variants) {
        lines.push(`      deny ${variant.deny} · sha ${variant.sha} · ${variant.members.length} 人（${variant.members.join(", ")}）`);
      }
    }
    lines.push("");
  }

  const provenance = report.provenance ?? [];
  if (provenance.length > 0) {
    lines.push("团队溯源（团队由哪一版档案建成；插件只读 description）");
    for (const item of provenance) lines.push(`  · ${item.teamName}：${provenanceText(item)}`);
    lines.push("");
  }

  const summary = report.summary;
  lines.push(
    `汇总：忠实 ${summary.faithful} · 未核实 ${summary.unverified} · 降级 ${summary.drift} · 未部署 ${summary.missing} · 无档案 ${summary.unmanaged}`,
  );
  if (summary.unverified > 0) {
    lines.push("（未核实 = 档案声明了值、运行时却不持久化该字段，例如人设 executionPrompt；这不是降级，但也拿不到回执。）");
  }
  if (summary.policyDrift > 0) lines.push(`（另有 ${summary.policyDrift} 处策略漂移、${summary.provenanceDiffer} 处溯源自建档案后已变。）`);

  const skills = (report.skills ?? []).filter(
    (item) => rosterIds.size === 0 || rosterIds.has(item.rosterId),
  );
  if (skills.length > 0) {
    lines.push("");
    lines.push("技能声明核对（声明层：运行时不会据此加载技能）");
    for (const item of skills) {
      const state = !item.checked
        ? "无法核对（宿主没有提供技能目录）"
        : item.missing.length > 0
          ? `未安装：${item.missing.join(", ")}`
          : "全部已安装";
      lines.push(`  · ${item.member}  [${item.rosterId}]  ${item.declared.join(", ")}  →  ${state}`);
    }
  }
  return lines.join("\n");
}

/**
 * 档案差异（`roster_diff`）的人读渲染。
 *
 * @param {object} diff `diffRosters` 的结果
 * @param {{ from: object, to: object }} labels 两端的档案标识（`{ id, version, sha }`）
 * @returns {string}
 */
export function renderRosterDiff(diff, labels) {
  const lines = [];
  lines.push(`档案差异  ${rosterLabel(labels.from)}  →  ${rosterLabel(labels.to)}`);
  lines.push("（比的是有效值：defaults 已合进成员；成员按 name 对齐，aliases 不自动合并）");

  if (diff.rosters.length === 0 && diff.counts.added === 0 && diff.counts.removed === 0 && diff.counts.changed === 0) {
    lines.push("");
    lines.push("两份档案没有语义差别。");
  }

  if (diff.rosters.length > 0) {
    lines.push("");
    lines.push("档案字段");
    for (const change of diff.rosters) {
      lines.push(`  · ${change.field}  ${change.from} → ${change.to}`);
    }
  }

  lines.push("");
  lines.push(`成员  增 ${diff.counts.added} · 删 ${diff.counts.removed} · 改 ${diff.counts.changed}`);
  for (const name of diff.members.added) lines.push(`  + ${name}  （新一代新增，旧团队里没有）`);
  for (const name of diff.members.removed) lines.push(`  - ${name}  （新一代已移除，旧团队里还在）`);
  for (const change of diff.members.changed) {
    lines.push(`  · ${change.name}`);
    for (const field of change.fields) {
      const origin = field.origin === undefined ? "" : `   [${field.origin}]`;
      lines.push(`      ${field.field}  ${field.from} → ${field.to}${origin}`);
    }
  }

  if (diff.skills.length > 0) {
    lines.push("");
    lines.push("技能（声明层：不会因为档案写了就加载）");
    for (const change of diff.skills) {
      const parts = [];
      if (change.added.length > 0) parts.push(`新增 ${change.added.join(", ")}`);
      if (change.removed.length > 0) parts.push(`移除 ${change.removed.join(", ")}`);
      lines.push(`  · ${change.member}  ${parts.join("；")}`);
    }
  }
  return lines.join("\n");
}

/**
 * `roster:<id>@<ver>[#sha8]`。
 *
 * @param {{ id: string, version: string, sha: string | null }} label
 * @returns {string}
 */
function rosterLabel(label) {
  const sha = typeof label.sha === "string" && label.sha !== "" ? `#${label.sha.slice(0, 8)}` : "";
  return `roster:${label.id}@${label.version}${sha}`;
}

/**
 * 队长段：说明"能声明什么，真要生效要改哪里"。
 *
 * 队长不是成员——它就是创建团队的那个会话。这里绝不写成"档案已配置队长"，
 * 否则使用者会以为改档案就能换队长模型。
 *
 * @param {object} captain 已校验的 captain 段
 * @returns {string[]}
 */
export function renderCaptainSection(captain) {
  const lines = [];
  lines.push("");
  lines.push(`队长 captain:${captain.name}（声明层：档案不创建队长，也不改写它的会话）`);
  if (captain.description !== "") lines.push(`  ${captain.description}`);
  if (captain.provider !== undefined || captain.model !== undefined) {
    lines.push(`  路由声明        ${captain.provider ?? "?"} / ${captain.model ?? "?"}（需落到 profile 的 agent-default-model）`);
  }
  if (captain.personaPrefix !== "") lines.push(`  personaPrefix   ${firstLines(captain.personaPrefix, 2, 160)}`);
  if (captain.systemPrompt !== "") {
    lines.push(`  systemPrompt    ${captain.systemPrompt.length} 字符（追加给队长的行为约定，需拼进团队目标的描述里）`);
  }
  lines.push("  生效方式        agent-teams 没有 captain 成员行：队长＝创建团队的那个会话");
  lines.push("                  1) 路由 → profile 的 agent-default-model（或会话内切模型）");
  lines.push("                  2) 人格 → agent preset 里 @deepseek-ai/dsh-persona 的 prefix/suffix");
  lines.push("                  3) 追加约定 → 写进 agent_teams_create 的 description/goal");
  if (captain.provider !== undefined && captain.model !== undefined) {
    lines.push("");
    lines.push("  profile 片段（cordis.patch.yml）：");
    lines.push("    - id: agent-default-model");
    lines.push('      name: "@deepseek-ai/dsh-agent-default-model"');
    lines.push("      config:");
    lines.push(`        provider: ${captain.provider}`);
    lines.push(`        model: ${captain.model}`);
  }
  return lines;
}

/** 状态标签，供 UI 与报告共用。 */
/**
 * 队长核对结果：逐字段给「一致 / 不一致 / 未声明 / 无法核对」。
 *
 * 四态是刻意的：读不到部署配置时不能写成「通过」，也不能写成「不一致」。
 *
 * @param {{ checks?: object[] }} verified
 * @param {{ displayed?: string }} [options]
 * @returns {string}
 */
export function renderCaptainVerification(verified, options = {}) {
  const lines = [];
  const where = options.displayed === undefined || options.displayed === "" ? "" : `（部署：${options.displayed}）`;
  lines.push(`队长档案核对${where}`);
  for (const check of verified.checks ?? []) {
    if (check.status === "match") lines.push(`  ✓ 一致    ${check.field} ${check.declared}`);
    else if (check.status === "differ") {
      lines.push(`  ✗ 不一致  ${check.field} 声明 ${check.declared || "（空）"} / 部署 ${check.actual || "（空）"}`);
    } else if (check.status === "undeclared") {
      lines.push(`  · 未声明  ${check.field} 未声明，运行时用部署默认${check.actual === "" ? "" : "（" + check.actual + "）"}`);
    } else lines.push(`  ? 无法核对 ${check.field} 读不到部署配置`);
  }
  lines.push("  说明：队长＝创建团队的那个会话，没有成员行；模型来自部署 agent-default-model，人格来自 preset 的 persona。");
  return lines.join("\n");
}

export function statusLabel(status) {
  return BINDING_STATUS[status] ?? status;
}

function pad(text, width) {
  const value = String(text);
  if (value.length >= width) return `${value} `;
  return value + " ".repeat(width - value.length);
}

function literal(value) {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function describeToolScope(scope) {
  const parts = [];
  if (Array.isArray(scope.allow) && scope.allow.length > 0) parts.push(`allow(${scope.allow.length})`);
  if (Array.isArray(scope.deny) && scope.deny.length > 0) parts.push(`deny(${scope.deny.length})`);
  return parts.length === 0 ? "空" : parts.join(" ");
}

function firstLines(text, maxLines, maxChars) {
  const value = String(text ?? "")
    .trim()
    .replace(/\r\n/g, "\n");
  const lines = value.split("\n").slice(0, maxLines).join(" / ");
  const clipped = lines.length > maxChars ? `${lines.slice(0, maxChars)}…` : lines;
  return clipped === "" ? "（空）" : clipped;
}

/**
 * 一份档案的「能力要求」声明块（`roster_show` 用）。
 *
 * 只陈述"要求什么、缺失时怎么办、什么时候核过"，不评价是否满足——满足与否是核对器的事，
 * 两件事混在一段文字里，读者永远分不清哪句是声明、哪句是判定。
 *
 * @param {object} roster 已校验档案
 * @param {object} capabilities `capabilities.yaml` 的解析结果
 * @returns {string}
 */
export function renderCapabilityRequirements(roster, capabilities) {
  const requires = capabilities?.requires ?? { skills: [], toolPolicies: [] };
  const lines = [
    `能力要求  ${roster.id}  onMissing=${capabilities?.onMissing ?? "refuse"}` +
      `${capabilities?.asOf === null || capabilities?.asOf === undefined ? "" : `  asOf=${capabilities.asOf}`}`,
  ];
  const sections = [
    ["技能", requires.skills ?? []],
    ["工具策略", requires.toolPolicies ?? []],
  ];
  const total = sections.reduce((sum, [, items]) => sum + items.length, 0);
  if (total === 0) {
    lines.push("  （没有声明任何能力要求）");
  } else {
    for (const [label, items] of sections) {
      if (items.length === 0) continue;
      lines.push(`  ${label}  ${items.length} 项`);
      for (const item of items) {
        lines.push(`    · ${item.name}${item.reason === null || item.reason === undefined ? "" : ` — ${item.reason}`}`);
      }
    }
  }
  if (capabilities?.notes) lines.push(`  说明  ${capabilities.notes}`);
  lines.push("  只声明不承载：能力本体在技能目录与策略定义里，这份文件只回答「需要什么」。");
  return lines.join("\n");
}

/**
 * 拒绝出参数时的说明（`roster_create` 的闸门）。
 *
 * 三件事必须同时说清：缺什么、缺的那项该装到哪、以及"核对不到"为什么不算缺。
 * 只说"缺少能力"等于把问题原样丢回给调用者。
 *
 * @param {object} roster 已校验档案
 * @param {object} gate `checkCapabilities().entries` 的单条结果
 * @param {Record<string, { label: string, install: string }>} hints 类别 → 人话名与安装位置
 * @returns {string}
 */
export function renderCapabilityGate(roster, gate, hints) {
  const lines = [
    `能力闸门  ${roster.id}  缺 ${gate.missing.length} 项，未生成建队参数（onMissing=${gate.onMissing}）`,
  ];
  for (const item of gate.missing) {
    const hint = hints[item.kind] ?? { label: item.kind, install: "（无已知安装位置）" };
    lines.push(`  ✖ ${hint.label} ${item.name}${item.reason ? ` — ${item.reason}` : ""}`);
    lines.push(`      怎么补：${hint.install}`);
  }
  if (gate.unknown.length > 0) {
    lines.push(
      `  ? 核对不到 ${gate.unknown.length} 项（不算缺失，也不会被当成通过）：` +
        gate.unknown.map((item) => item.name).join("、"),
    );
    lines.push("      原因通常是宿主没挂技能服务，或本插件没配 knownToolPolicies。");
  }
  return lines.join("\n");
}

/**
 * 多份档案的能力核对汇总（`roster_verify` 用）。
 *
 * @param {object[]} entries `checkCapabilities().entries`
 * @param {Record<string, { label: string }>} hints 类别 → 人话名
 * @returns {string}
 */
export function renderCapabilityReport(entries, hints) {
  const total = { declared: 0, missing: 0, unknown: 0, blocked: 0 };
  const lines = [];
  for (const entry of entries) {
    total.declared += entry.requires;
    total.missing += entry.missing.length;
    total.unknown += entry.unknown.length;
    if (entry.blocked) total.blocked += 1;
  }
  lines.push(
    `能力要求  要求 ${total.declared} · 缺 ${total.missing} · 核对不到 ${total.unknown} · 拦下 ${total.blocked} 份档案`,
  );
  for (const entry of entries) {
    const detail =
      entry.requires === 0
        ? "未声明要求"
        : entry.missing.length > 0
          ? `缺 ${entry.missing.map((item) => `${hints[item.kind]?.label ?? item.kind}:${item.name}`).join("、")}`
          : entry.unknown.length > 0
            ? `核对不到 ${entry.unknown.map((item) => item.name).join("、")}`
            : `要求 ${entry.requires} 项全部在位`;
    lines.push(
      `  ${entry.rosterId.padEnd(24)} ${entry.status.padEnd(9)} ${detail}` +
        `  onMissing=${entry.onMissing}${entry.asOf === null ? "" : `  asOf=${entry.asOf}`}`,
    );
  }
  if (total.unknown > 0) {
    lines.push("  核对不到 ≠ 缺失：没有证据源时既不翻红，也不冒充通过。");
  }
  return lines.join("\n");
}
