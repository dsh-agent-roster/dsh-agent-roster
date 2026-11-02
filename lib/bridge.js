/**
 * 桥接层：把静态档案翻译成 dsh-agent-teams 可以执行的调用参数，并如实标注每个字段的归宿。
 *
 * 这一层刻意**只做翻译与核对，不做调用**：真正的成员创建仍由队长模型发起
 * `agent_teams_add_member`。原因是档案层不知道团队此刻处于什么阶段（暂存/运行/已归档），
 * 也不应该替运行时决定"现在创建一个成员"。工具只输出参数，模型原样传入，运行时决定成败。
 *
 * 五个诚实状态必须被区分，否则档案会给人"能力已被运行时保证"的错觉：
 *
 * - `applied`：运行时状态里的值与档案一致（读取的是 team.json，不是我们的请求）；
 * - `overridden`：运行时采用了别的值——真的降级；
 * - `omitted`：档案本来就没声明（或运行时也没有），沿用默认——**预期内**，不算降级；
 * - `not-persisted`：我们发出了值，但运行时状态里根本没有这个键——**无法核对**。
 *   它与 `omitted` 的区别就是本插件曾经报假绿的地方：都叫"没有"，但一个是"本来没有"，
 *   另一个是"发了却没留痕"。后者必须让 `faithful` 变红，并且单独计数，
 *   否则"人设没被核对过"会被折叠进"一致"里（见 issue #2）。
 * - `not-carried`：agent-teams 没有对应承载（toolScope、maxTokens 等），档案只是声明。
 *
 * @module dsh-agent-roster/bridge
 */
import { createHash } from "node:crypto";

import { FIELD_BINDING } from "./format.js";

/** 成员字段 → 调用参数名 / 运行时状态键。 */
const CARRIED_FIELDS = [
  { field: "name", param: "name", stateKey: "name" },
  { field: "role", param: "role", stateKey: "role" },
  { field: "systemPrompt", param: "executionPrompt", stateKey: "executionPrompt" },
  { field: "provider", param: "provider", stateKey: "provider" },
  { field: "model", param: "model", stateKey: "model" },
  { field: "reasoningEffort", param: "reasoning_effort", stateKey: "reasoningEffort" },
  { field: "toolPolicy", param: "tool_policy", stateKey: "toolPolicy" },
];

/** 桥接状态的中文标签，工具输出与 UI 共用。 */
export const BINDING_STATUS = {
  pending: "已生成参数，运行时尚未回执",
  applied: "运行时取值与档案一致",
  overridden: "运行时实际取值与档案不同",
  omitted: "档案未声明，沿用运行时默认",
  "not-persisted": "运行时状态不含该字段（已发出，无法核对）",
  unconfirmed: "缺少运行时状态，无法核对",
  "not-carried": "agent-teams 无承载，仅声明",
  "config-required": "需要落到部署配置才生效",
};

/**
 * 为一份档案里的一个成员生成桥接结果。
 *
 * 字段值缺失时一律写 `null` 而不是 `undefined`：工具返回值要能无损往返 JSON，
 * 带 `undefined` 的键会被序列化丢掉，运行时因此判整次调用失败。
 *
 * @param {object} roster 已校验的档案
 * @param {object} member 已校验的成员
 * @returns {{ args: object, planMember: object, binding: object }}
 */
export function buildMemberBinding(roster, member) {
  const args = { name: member.name, role: member.role, executionPrompt: member.systemPrompt };
  if (member.provider !== undefined) args.provider = member.provider;
  if (member.model !== undefined) args.model = member.model;
  if (member.reasoningEffort !== undefined) args.reasoning_effort = member.reasoningEffort;
  if (member.toolPolicy !== undefined) args.tool_policy = member.toolPolicy;

  const planMember = { name: member.name, role: member.role };
  if (member.provider !== undefined) planMember.provider = member.provider;
  if (member.model !== undefined) planMember.model = member.model;
  if (member.reasoningEffort !== undefined) planMember.reasoning_effort = member.reasoningEffort;
  if (member.toolPolicy !== undefined) planMember.tool_policy = member.toolPolicy;

  const binding = {
    rosterId: roster.id,
    rosterVersion: roster.version,
    member: member.name,
    origin: provenanceOf(roster, member),
    fields: [],
  };

  for (const { field, param, stateKey } of CARRIED_FIELDS) {
    const carried = args[param] !== undefined;
    const source = member.inherited?.includes(field) ? "defaults" : "member";
    if (!carried && field !== "name" && field !== "role" && field !== "systemPrompt") {
      binding.fields.push({
        field,
        param,
        stateKey,
        source,
        status: "omitted",
        requested: null,
        actual: null,
        note: "档案未指定，运行时将沿用队长默认",
      });
      continue;
    }
    if (!carried) {
      // name/role/executionPrompt 永远有值，走到这里说明数据损坏，明确报出来而不是静默跳过。
      binding.fields.push({
        field,
        param,
        stateKey,
        source,
        status: "omitted",
        requested: null,
        actual: null,
        note: "档案缺少该必填字段",
      });
      continue;
    }
    binding.fields.push({
      field,
      param,
      stateKey,
      source,
      status: "pending",
      requested: args[param],
      actual: null,
      note: "",
    });
  }

  for (const [field, kind] of Object.entries(FIELD_BINDING)) {
    if (kind === "direct") continue;
    const value = member[field];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string" && value === "") continue;
    binding.fields.push({
      field,
      param: null,
      stateKey: null,
      source: member.inherited?.includes(field) ? "defaults" : "member",
      status: kind === "config" ? "config-required" : "not-carried",
      requested: value,
      actual: null,
      note:
        kind === "config"
          ? field === "fallback"
            ? "备用路由需写进成员创建后的部署配置（本插件不代写配置）"
            : "该字段需落到部署配置才会生效"
          : "agent-teams 成员无此承载，档案仅作能力声明与校验依据",
    });
  }

  return { args, planMember, binding };
}

/**
 * 用一份真实的团队状态（team.json 的 members[]）核对该成员的桥接结果。
 *
 * 比对的是运行时**持久化的实际值**，不是我们发出去的请求参数——这是"验证"与"自我报告"的分界。
 *
 * @param {object} binding `buildMemberBinding` 产出的 binding
 * @param {object | null} teamMember team.json 里同名的成员记录
 * @returns {object} 同一个 binding（就地更新），便于链式使用
 */
export function reconcileBinding(binding, teamMember) {
  const found = teamMember ?? null;
  for (const entry of binding.fields) {
    if (entry.param === null) continue;
    if (found === null) {
      entry.status = "unconfirmed";
      entry.note = "团队状态里没有同名成员";
      continue;
    }
    const actual = found[entry.stateKey];
    entry.actual = actual ?? null;
    if (actual === undefined || actual === null || actual === "") {
      // 两个方向都要分清，否则会同时制造假绿和假红：
      // - 档案没声明、运行时也没记 → 沿用默认，预期内；
      // - 档案声明了值、运行时状态里没有这个键 → 发了却没留痕，无法核对（issue #2）。
      if (entry.requested === null) {
        entry.status = "omitted";
        entry.note = "档案未声明，运行时也未记录（沿用默认）";
      } else {
        entry.status = "not-persisted";
        entry.note = "team.json 未持久化该字段，无法核对（不等于未生效）";
      }
      continue;
    }
    if (entry.requested === null) {
      // 档案没声明路由，运行时取了队长默认：这不是"运行时改了我们的值"，不该报降级。
      entry.status = "omitted";
      entry.note = "档案未声明，运行时取了默认值";
      continue;
    }
    entry.status = valueMatches(entry.field, entry.requested, actual) ? "applied" : "overridden";
    entry.note = entry.status === "applied" ? "" : "运行时采用了不同的值";
  }
  return binding;
}

/**
 * 生成绑定摘要：按状态统计，供工具输出和索引里的 `binding` 段使用。
 *
 * `degraded` 与 `faithful` 只在这里算一次——曾经 `isBindingFaithful` 自己另写了一份判据，
 * 两份判据一旦不一致就会出现"摘要说降级、判定说忠实"的假绿（issue #2）。
 *
 * @param {object} binding
 * @returns {{
 *   counts: Record<string, number>, carried: number, applied: number,
 *   degraded: number, unverified: number, absent: number, faithful: boolean,
 * }}
 */
export function summarizeBinding(binding) {
  const counts = {};
  for (const entry of binding.fields) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  const carried = binding.fields.filter((entry) => entry.param !== null).length;
  const applied = counts.applied ?? 0;
  const notPersisted = counts["not-persisted"] ?? 0;
  const overridden = counts.overridden ?? 0;
  const unconfirmed = counts.unconfirmed ?? 0;
  const degraded = overridden + notPersisted + unconfirmed;
  return {
    counts,
    carried,
    applied,
    degraded,
    /** 发出了值却拿不到运行时回执的字段数（今天只有 systemPrompt 会命中）。 */
    unverified: notPersisted,
    /** 档案本来就没声明、运行时也没记的字段数：预期内，不计入降级。 */
    absent: counts.omitted ?? 0,
    faithful: degraded === 0,
  };
}

/** 人读的一行：`model          已应用  deepseek/deepseek-v4.1-flash（来源：member）`。 */
export function describeField(entry) {
  const label = entry.field.padEnd(15, " ");
  const source = entry.source === "defaults" ? "继承 defaults" : "成员自带";
  const value = entry.actual !== null ? entry.actual : entry.requested;
  const rendered =
    entry.field === "systemPrompt"
      ? `${String(value ?? "").length} 字符`
      : value === null || value === undefined
        ? "—"
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
  const note = entry.note === "" ? "" : `（${entry.note}）`;
  return `${label}${BINDING_STATUS[entry.status] ?? entry.status}  ${rendered}  · ${source}${note}`;
}

/**
 * 团队状态是否与档案一致：只统计"被运行时承载"的字段。
 *
 * 三个真降级都会让这里变红：`overridden`（运行时换了值）、`unconfirmed`（查不到成员）、
 * 以及 `not-persisted`（发了值但运行时状态里没留痕，无法核对）。
 * `omitted` 不算——那是档案本来就没声明、运行时沿用默认，属预期内。
 *
 * 判据只有一份，就在 {@link summarizeBinding} 里：此处绝不重复实现，
 * 否则两份判据一漂移就回到 issue #2 的假绿。
 */
export function isBindingFaithful(binding) {
  return summarizeBinding(binding).faithful;
}

/**
 * 团队溯源串：`roster:<id>@<version>#<档案内容 sha256 前 8 位>`。
 *
 * `team.json` 没有"由哪一版档案建成"的字段，所以只能借 `description` 这一行把出处的**指针**带进去。
 * 插件仍然不写团队状态——它只给出"建议写什么"，由队长模型传进 `agent_teams_create`。
 *
 * @param {object} roster 已校验档案
 * @param {string} [contentSha] 档案文件内容的 sha256（十六进制）；缺省时省略 `#` 段
 * @returns {string}
 */
export function provenanceLine(roster, contentSha) {
  const short = typeof contentSha === "string" && contentSha !== "" ? `#${contentSha.slice(0, 8)}` : "";
  return `roster:${roster.id}@${roster.version}${short}`;
}

/**
 * 从任意文本里解析溯源串。
 *
 * @param {string} text 团队 description 或任意一行文字
 * @returns {{ id: string, version: string, sha: string | null, raw: string } | null}
 */
export function parseProvenanceLine(text) {
  if (typeof text !== "string") return null;
  // 版本段必须是一个**完整**的 semver 词，且其后立刻是 `#<sha>` 或词边界。
  // 否则 `roster:core-review@1.2.0+provider,model`（`provenanceOf` 产出的另一种写法，
  // 带继承字段后缀）会被读成 version `1.2.0+provider`——一个根本不存在的版本，
  // 比对时永远 differ，比"读不出来"更糟。
  const match = /roster:([A-Za-z0-9][A-Za-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:#([0-9a-f]{8}))?(?![0-9A-Za-z.+,-])/.exec(
    text,
  );
  if (match === null) return null;
  return { id: match[1], version: match[2], sha: match[3] ?? null, raw: match[0] };
}

/** `roster:<id>@<version>`——出现在输出、提交信息与绑定记录里的出处标识。 */
export function provenanceOf(roster, member) {
  const suffix = member.inherited?.length ? `+${member.inherited.join(",")}` : "";
  return `roster:${roster.id}@${roster.version}${suffix}`;
}

/**
 * 比较字段值。`reasoningEffort` 容许运行时把 "default" 解析成具体档位，
 * 其余字段要求严格相等：档案说用什么模型，运行时就得记录那个模型。
 */
function valueMatches(field, requested, actual) {
  if (requested === undefined || requested === null) return false;
  if (field === "systemPrompt") return String(requested).trim() === String(actual).trim();
  if (field === "reasoningEffort") {
    if (requested === actual) return true;
    // "default" 表示"由目标模型决定"，运行时落成任何具体档位都算忠实执行。
    return requested === "default" || actual === "default";
  }
  return String(requested) === String(actual);
}
