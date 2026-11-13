/**
 * 成员上下文包：换代时把「每个成员做到哪、结论是什么」送给下一代的同名成员。
 *
 * 为什么需要这一层：
 * - Agent Teams 的成员之间**不共享对话记录**；队长换代时成员也会被整体重建。
 *   引擎在派任务时只给「任务合同 + 依赖任务输出」，成员自己的推理过程不会跟着走。
 * - 成员的人设（`executionPrompt`）每次派发都会带，所以「人设」不丢；
 *   丢的是「这个人上一代已经查过什么、结论是什么、哪里踩过坑」。
 * - 插件拿不到成员的对话正文，能拿到的只有两样：`team.json` 的任务回执（客观、可核）
 *   与旧会话 id（可以让人回去查日志）。上一代的**总结**必须由旧会话自己写
 *   （`handover.members[].summary`）——插件不替它编。
 *
 * 输出给新队长：每个成员一段包，要求把包原文发给该成员本人（add_member 之后发一条消息；
 * 成员还没启动时，这条消息就是它的初始提示，只发一次），或放进它第一个任务的 description。
 * 成员之间没有别的信道，文档里说清楚比悄悄丢强。
 *
 * @module dsh-agent-roster/member-context
 */
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { diagnostic } from "./parse.js";

export const MEMBER_PACKET_LIMITS = {
  members: 32,
  summaryChars: 800,
  tasksPerMember: 2,
  outputChars: 180,
  roleChars: 48,
  blockChars: 6000,
};

/** 会话日志根：`$DSH_HOME/sessions`，默认 `~/.dsh/sessions`。 */
export function sessionsRoot() {
  const home = process.env.DSH_HOME?.trim() || nodePath.join(os.homedir(), ".dsh");
  return nodePath.join(home, "sessions");
}

/** 会话 id → 目录（工作区目录名一层的子目录），找不到返回 null。 */
export function sessionDirOf(sessionId, root = sessionsRoot()) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (id === "") return null;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = nodePath.join(root, entry.name, id);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

function tasksOf(team, name) {
  const tasks = Array.isArray(team?.tasks) ? team.tasks : [];
  return tasks
    .filter((task) => task?.assignee === name && task?.status !== "cancelled")
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, MEMBER_PACKET_LIMITS.tasksPerMember)
    .map((task) => ({
      id: String(task.id ?? ""),
      subject: String(task.subject ?? ""),
      status: String(task.status ?? ""),
      kind: String(task.kind ?? ""),
      output: oneLine(task.output, MEMBER_PACKET_LIMITS.outputChars),
    }));
}

/**
 * 从**旧团队**里收集每个成员的客观上下文。
 *
 * @returns {{ members: object[], diagnostics: object[] }}
 */
export function collectMemberPackets(team, { sessionsRootDir = sessionsRoot() } = {}) {
  const diagnostics = [];
  const members = Array.isArray(team?.members) ? team.members : [];
  const packets = [];
  // 归档团队的成员状态全是 removed——按状态过滤会让「整队退役」的交接包变成空的，
  // 所以一律保留，把状态写进包里让读者自己判断。
  for (const member of members) {
    const name = String(member?.name ?? "").trim();
    if (name === "") continue;
    const sessionId = String(member?.id ?? "").trim();
    const dir = sessionId === "" ? null : sessionDirOf(sessionId, sessionsRootDir);
    packets.push({
      name,
      role: String(member?.role ?? ""),
      status: String(member?.status ?? ""),
      sessionId,
      sessionPath: dir,
      summary: "",
      tasks: tasksOf(team, name),
    });
    if (packets.length >= MEMBER_PACKET_LIMITS.members) break;
  }
  if (packets.length === 0) {
    diagnostics.push(diagnostic("info", "member-packets-empty", "members", "旧团队没有可交接的成员", "handover"));
  }
  return { members: packets, diagnostics };
}

/**
 * 把上一代写的总结合进客观包。
 *
 * 规则：总结按 name 精确匹配；没写总结的成员如实标「未写」，不拿任务回执冒充总结；
 * 写了但旧团队里没有这个成员，报 warn（多半是改了名，改名等于换人）。
 */
export function mergeMemberSummaries(packets, summaries) {
  const diagnostics = [];
  const list = Array.isArray(summaries) ? summaries : [];
  const byName = new Map(packets.map((packet) => [packet.name, packet]));
  for (const [index, item] of list.entries()) {
    const p = `members[${index}]`;
    if (item === null || typeof item !== "object") {
      diagnostics.push(diagnostic("error", "member-summary-invalid", p, "每条成员总结必须是 {name, summary}", "handover"));
      continue;
    }
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    if (name === "") {
      diagnostics.push(diagnostic("error", "member-summary-name-missing", `${p}.name`, "成员总结必须写 name", "handover"));
      continue;
    }
    if (summary === "") {
      diagnostics.push(diagnostic("error", "member-summary-empty", `${p}.summary`, `成员 ${name} 的总结是空的：要么写，要么不传这一条`, "handover"));
      continue;
    }
    if (summary.length > MEMBER_PACKET_LIMITS.summaryChars) {
      diagnostics.push(diagnostic("error", "member-summary-too-long", `${p}.summary`, `最多 ${MEMBER_PACKET_LIMITS.summaryChars} 字符`, "handover"));
      continue;
    }
    const packet = byName.get(name);
    if (packet === undefined) {
      diagnostics.push(diagnostic("warn", "member-summary-unknown", `${p}.name`, `旧团队里没有成员 "${name}"（改名等于换人，总结不会送过去）`, "handover"));
      continue;
    }
    packet.summary = summary;
  }
  return { members: packets, diagnostics };
}

/** 渲染成起始消息里的一段；没有成员就返回 ""。 */
/** 压成一行：换行与连续空白折叠，再按字符数截断（附省略号）。包里每一行都占一屏，不能放任原文。 */
function oneLine(value, max) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function renderMemberPackets(packets, { teamId = "" } = {}) {
  const list = Array.isArray(packets) ? packets : [];
  if (list.length === 0) return "";
  const lines = [
    `成员上下文包（来自旧团队 ${teamId === "" ? "（未知）" : teamId}，${list.length} 名成员）：`,
    "成员之间不共享对话记录；请在 add_member 之后把每一名成员的包原文发给他本人（他还没启动时，这条消息就是初始提示，只发一次；也可以放进他第一个任务的 description），这是上一代经验唯一能送到成员手里的地方。",
  ];
  const omitted = [];
  let used = lines.join("\n").length;
  for (const packet of list) {
    const facts = [`角色 ${packet.role === "" ? "-" : oneLine(packet.role, MEMBER_PACKET_LIMITS.roleChars)}`, `状态 ${packet.status === "" ? "-" : packet.status}`];
    if (packet.sessionId !== "") {
      facts.push(`旧会话 ${packet.sessionId}`);
      if (packet.sessionPath !== null) facts.push(`日志 ${packet.sessionPath}`);
    }
    const startAt = lines.length;
    lines.push(`- ${packet.name}（${facts.join("，")}）`);
    if (packet.summary === "") {
      lines.push("    上一代总结：未写（只有任务回执；要更准的上下文，请旧会话补 handover.members）");
    } else {
      lines.push(`    上一代总结：${packet.summary}`);
    }
    if (packet.tasks.length === 0) {
      lines.push("    最近任务：无");
    } else {
      for (const task of packet.tasks) {
        lines.push(
          `    最近任务：${task.id} ${task.subject}（${task.status}）${task.output === "" ? "" : `——${task.output}`}`,
        );
      }
    }
    const section = lines.slice(startAt).join("\n").length + 1;
    if (used + section > MEMBER_PACKET_LIMITS.blockChars && lines.length > startAt + 1) {
      lines.length = startAt;
      omitted.push(packet.name);
      continue;
    }
    used += section;
  }
  if (omitted.length > 0) {
    lines.push(`…还有 ${omitted.length} 名成员（${omitted.join("、")}）未展开：包超过 ${MEMBER_PACKET_LIMITS.blockChars} 字符，完整内容见交接清单文件。`);
  }
  return lines.join("\n");
}
