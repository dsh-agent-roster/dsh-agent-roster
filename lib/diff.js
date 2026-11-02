/**
 * 档案 ↔ 档案的差异：换班时第一个要回答的问题就是"新一代改了什么"。
 *
 * 已有的核对都是"档案 ↔ 运行态"（`roster_verify`），它回答不了这个问题：
 * 同一个团队换成新一代档案后，运行态与**新**档案一致，旧档案与新档案的差别却没人记得。
 * 所以这里只做纯函数比较，不读文件、不碰团队状态——载入与解析由调用方负责。
 *
 * 三条判读纪律：
 * 1. **成员按 `name` 对齐**，`aliases` 只作提示不自动合并——否则"改名"会被静默吞成"没变"。
 * 2. **比较的是有效值**（`defaults` 已合进成员），并标注这个值是成员自己写的还是继承来的；
 *    档案里把 `model` 从成员搬到 `defaults`、值不变，不算变更。
 * 3. **人设不进差异正文**，只给长度与内容哈希——8000 字人设并排贴在终端里没人读得下去，
 *    而"长度变了 / 哈希变了"足够回答"改没改"。
 *
 * @module dsh-agent-roster/diff
 */
import { sha256Hex, shortSha } from "./digest.js";

/** 参与逐一比较的成员字段（顺序即输出顺序）。 */
const MEMBER_FIELDS = ["role", "provider", "model", "reasoningEffort", "toolPolicy", "toolScope", "maxTokens"];

/** 档案顶层参与比较的字段。 */
const ROSTER_FIELDS = ["version", "title", "description", "license"];

/**
 * 比较两份已校验档案。
 *
 * @param {object} from 旧档案
 * @param {object} to 新档案
 * @returns {{ rosters: object[], members: object, skills: object[], counts: object }}
 */
export function diffRosters(from, to) {
  const members = diffMembers(from, to);
  return {
    rosters: diffRosterFields(from, to),
    members,
    skills: diffSkills(from, to),
    counts: { added: members.added.length, removed: members.removed.length, changed: members.changed.length },
  };
}

/**
 * 档案顶层字段。
 *
 * @param {object} from
 * @param {object} to
 * @returns {{ field: string, from: string, to: string }[]}
 */
function diffRosterFields(from, to) {
  const changes = [];
  for (const field of ROSTER_FIELDS) {
    const before = textOf(from?.[field]);
    const after = textOf(to?.[field]);
    if (before !== after) changes.push({ field, from: before, to: after });
  }
  for (const field of ["provider", "model", "reasoningEffort"]) {
    const before = textOf(from?.defaults?.[field]);
    const after = textOf(to?.defaults?.[field]);
    if (before !== after) changes.push({ field: `defaults.${field}`, from: before, to: after });
  }
  return changes;
}

/**
 * 成员层面的增删改。
 *
 * @param {object} from
 * @param {object} to
 * @returns {{ added: string[], removed: string[], changed: object[] }}
 */
function diffMembers(from, to) {
  const before = membersByName(from);
  const after = membersByName(to);
  const added = [...after.keys()].filter((name) => !before.has(name));
  const removed = [...before.keys()].filter((name) => !after.has(name));
  const changed = [];
  for (const [name, newMember] of after) {
    const oldMember = before.get(name);
    if (oldMember === undefined) continue;
    const fields = [];
    for (const field of MEMBER_FIELDS) {
      const left = textOf(oldMember[field]);
      const right = textOf(newMember[field]);
      if (left === right) continue;
      fields.push({
        field,
        from: left,
        to: right,
        origin: originOf(oldMember, newMember, field),
      });
    }
    const persona = diffPersona(oldMember.systemPrompt, newMember.systemPrompt);
    if (persona !== null) fields.push(persona);
    const aliases = diffList(oldMember.aliases, newMember.aliases, "aliases");
    if (aliases !== null) fields.push(aliases);
    if (fields.length > 0) changed.push({ name, fields });
  }
  return { added, removed, changed };
}

/**
 * 人设只比长度与哈希。两段文字一模一样时连这一行都不出现。
 *
 * @param {unknown} before
 * @param {unknown} after
 * @returns {{ field: string, from: string, to: string } | null}
 */
function diffPersona(before, after) {
  const left = typeof before === "string" ? before : "";
  const right = typeof after === "string" ? after : "";
  if (left === right) return null;
  return { field: "systemPrompt", from: fingerprintOf(left), to: fingerprintOf(right) };
}

/**
 * 列表字段（aliases / skills）按集合比较，顺序变化不算变更。
 *
 * @param {unknown} before
 * @param {unknown} after
 * @param {string} field
 * @returns {{ field: string, from: string, to: string } | null}
 */
function diffList(before, after, field) {
  const left = listOf(before);
  const right = listOf(after);
  if (left.join("\u0000") === right.join("\u0000")) return null;
  return { field, from: left.join(", "), to: right.join(", ") };
}

/**
 * 技能按成员逐条比增减——换班时最常问的是"新加的成员要装什么技能"。
 *
 * @param {object} from
 * @param {object} to
 * @returns {{ member: string, added: string[], removed: string[] }[]}
 */
function diffSkills(from, to) {
  const before = membersByName(from);
  const after = membersByName(to);
  const changes = [];
  for (const [name, newMember] of after) {
    const oldMember = before.get(name);
    if (oldMember === undefined) continue;
    const left = new Set(listOf(oldMember.skills));
    const right = new Set(listOf(newMember.skills));
    const added = [...right].filter((item) => !left.has(item));
    const removed = [...left].filter((item) => !right.has(item));
    if (added.length > 0 || removed.length > 0) changes.push({ member: name, added, removed });
  }
  return changes;
}

/**
 * 成员名 → 成员，跳过没有名字的记录（校验层已拦，这里只防崩）。
 *
 * @param {object} roster
 * @returns {Map<string, object>}
 */
function membersByName(roster) {
  const map = new Map();
  for (const member of Array.isArray(roster?.members) ? roster.members : []) {
    if (member !== null && typeof member === "object" && typeof member.name === "string" && member.name !== "") {
      map.set(member.name, member);
    }
  }
  return map;
}

/**
 * 这个字段的差别来自哪里：成员自己改的，还是从 `defaults` 继承来的。
 *
 * @param {object} before
 * @param {object} after
 * @param {string} field
 * @returns {string}
 */
function originOf(before, after, field) {
  const left = before.inherited?.includes(field) ? "defaults" : "member";
  const right = after.inherited?.includes(field) ? "defaults" : "member";
  if (left === right) return right;
  return `${left} → ${right}`;
}

/**
 * 人读指纹：`1234 字符 #ab12cd34`。
 *
 * @param {string} text
 * @returns {string}
 */
function fingerprintOf(text) {
  if (text === "") return "（空）";
  return `${text.length} 字符 #${shortSha(sha256Hex(text))}`;
}

/**
 * 标量转文本：缺省显示成 `（未声明）`，避免 `undefined` 混进差异表。
 *
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  if (value === undefined || value === null) return "（未声明）";
  if (typeof value === "string") return value === "" ? "（空）" : value;
  return String(value);
}

/**
 * 字符串数组规范化：去空、排序、去重。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function listOf(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string" && item !== ""))].sort();
}
