/**
 * 施工图的执行回执（`dist/<id>-<version>.run.json`）。
 *
 * 施工图（`plan@1`）规定了「谁在什么时候做什么」，但执行发生在队长会话里。没有回执时，
 * 一次失败只会停在某张红卡上；有了回执，下一次编译能把「上一轮哪张卡没过、为什么」带进
 * 重试卡的 description——失败因此能回流到编译，而不是靠人记。
 *
 * 回执只记录可复核的东西：卡片 id、状态、门跑过的命令与退出码、失败意见的原文。
 * 它不记录会话 id 或模型路由——那些是运行时事实，写进来就过期。
 *
 * @module dsh-agent-roster/run
 */
import { diagnostic } from "./parse.js";

export const RUN_KIND = "dsh-agent-roster/run@1";
export const RUN_STATUSES = ["passed", "failed", "skipped"];
const RUN_FIELDS = ["kind", "roster", "rounds", "notes"];
const ROUND_FIELDS = ["round", "at", "tasks"];
const TASK_FIELDS = ["id", "status", "findings", "commands", "note"];
const FINDING_FIELDS = ["severity", "problem", "requiredFix", "file", "line"];
const COMMAND_FIELDS = ["command", "exitCode", "outputTail"];
const SEVERITIES = ["low", "medium", "high", "blocker"];
const LIMITS = { rounds: 20, tasks: 64, findings: 32, commands: 16, text: 2000 };

function unknownKeys(value, allowed, path, file, report) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report.push(diagnostic("error", "run-shape", path, `${path} 必须是对象`, file));
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      report.push(diagnostic("error", "unknown-field", `${path}.${key}`, `未知字段 "${key}"；可用字段：${allowed.join(" / ")}`, file));
    }
  }
  return true;
}

function textField(value, path, file, report, { max = LIMITS.text, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) report.push(diagnostic("error", "run-field", path, `${path} 不能为空`, file));
    return null;
  }
  if (typeof value !== "string") {
    report.push(diagnostic("error", "run-field", path, `${path} 必须是字符串`, file));
    return null;
  }
  if (value.length > max) {
    report.push(diagnostic("error", "run-field", path, `${path} 超过 ${max} 字符`, file));
    return null;
  }
  return value;
}

/** 校验一份执行回执。不合法时返回 `run: null`，并把每条原因写成诊断。 */
export function validateRun(value, { file = "run.json" } = {}) {
  const report = [];
  if (!unknownKeys(value, RUN_FIELDS, "run", file, report)) return { ok: false, run: null, diagnostics: report };
  if (value.kind !== RUN_KIND) {
    report.push(diagnostic("error", "run-kind", "run.kind", `kind 必须是 "${RUN_KIND}"`, file));
  }
  const roster = value.roster;
  if (roster === null || typeof roster !== "object" || Array.isArray(roster)) {
    report.push(diagnostic("error", "run-field", "run.roster", "roster 必须是 {id, version}", file));
  } else {
    unknownKeys(roster, ["id", "version"], "run.roster", file, report);
    textField(roster.id, "run.roster.id", file, report, { required: true, max: 64 });
    textField(roster.version, "run.roster.version", file, report, { required: true, max: 64 });
  }
  const rounds = value.rounds;
  if (!Array.isArray(rounds) || rounds.length === 0) {
    report.push(diagnostic("error", "run-rounds", "run.rounds", "rounds 必须是非空数组", file));
  } else if (rounds.length > LIMITS.rounds) {
    report.push(diagnostic("error", "run-rounds", "run.rounds", `rounds 最多 ${LIMITS.rounds} 轮`, file));
  } else {
    rounds.forEach((round, index) => verifyRound(round, index, file, report));
  }
  if (report.some((item) => item.severity === "error")) return { ok: false, run: null, diagnostics: report };
  return { ok: true, run: value, diagnostics: report };
}

function verifyRound(round, index, file, report) {
  const path = `run.rounds[${index}]`;
  if (!unknownKeys(round, ROUND_FIELDS, path, file, report)) return;
  if (!Number.isInteger(round.round) || round.round < 1) {
    report.push(diagnostic("error", "run-round", `${path}.round`, "round 必须是从 1 开始的整数", file));
  }
  textField(round.at, `${path}.at`, file, report, { max: 40 });
  if (!Array.isArray(round.tasks) || round.tasks.length === 0) {
    report.push(diagnostic("error", "run-tasks", `${path}.tasks`, "tasks 必须是非空数组", file));
    return;
  }
  if (round.tasks.length > LIMITS.tasks) {
    report.push(diagnostic("error", "run-tasks", `${path}.tasks`, `tasks 最多 ${LIMITS.tasks} 张卡`, file));
  }
  round.tasks.forEach((task, taskIndex) => verifyTask(task, `${path}.tasks[${taskIndex}]`, file, report));
}

function verifyTask(task, path, file, report) {
  if (!unknownKeys(task, TASK_FIELDS, path, file, report)) return;
  textField(task.id, `${path}.id`, file, report, { required: true, max: 120 });
  if (!RUN_STATUSES.includes(task.status)) {
    report.push(diagnostic("error", "run-status", `${path}.status`, `status 只能是 ${RUN_STATUSES.join(" / ")}`, file));
  }
  if (task.findings !== undefined) {
    if (!Array.isArray(task.findings)) {
      report.push(diagnostic("error", "run-findings", `${path}.findings`, "findings 必须是数组", file));
    } else if (task.findings.length > LIMITS.findings) {
      report.push(diagnostic("error", "run-findings", `${path}.findings`, `findings 最多 ${LIMITS.findings} 条`, file));
    } else {
      task.findings.forEach((finding, index) => verifyFinding(finding, `${path}.findings[${index}]`, file, report));
    }
  }
  if (task.commands !== undefined) {
    if (!Array.isArray(task.commands)) {
      report.push(diagnostic("error", "run-commands", `${path}.commands`, "commands 必须是数组", file));
    } else if (task.commands.length > LIMITS.commands) {
      report.push(diagnostic("error", "run-commands", `${path}.commands`, `commands 最多 ${LIMITS.commands} 条`, file));
    } else {
      task.commands.forEach((command, index) => verifyCommand(command, `${path}.commands[${index}]`, file, report));
    }
  }
  textField(task.note, `${path}.note`, file, report, { max: 500 });
}

function verifyFinding(finding, path, file, report) {
  if (!unknownKeys(finding, FINDING_FIELDS, path, file, report)) return;
  if (!SEVERITIES.includes(finding.severity)) {
    report.push(diagnostic("error", "run-severity", `${path}.severity`, `severity 只能是 ${SEVERITIES.join(" / ")}`, file));
  }
  textField(finding.problem, `${path}.problem`, file, report, { required: true });
  textField(finding.requiredFix, `${path}.requiredFix`, file, report, { required: true });
  textField(finding.file, `${path}.file`, file, report, { max: 300 });
  if (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1)) {
    report.push(diagnostic("error", "run-line", `${path}.line`, "line 必须是正整数", file));
  }
}

function verifyCommand(command, path, file, report) {
  if (!unknownKeys(command, COMMAND_FIELDS, path, file, report)) return;
  textField(command.command, `${path}.command`, file, report, { required: true, max: 500 });
  if (!Number.isInteger(command.exitCode)) {
    report.push(diagnostic("error", "run-exit", `${path}.exitCode`, "exitCode 必须是整数", file));
  }
  textField(command.outputTail, `${path}.outputTail`, file, report, { max: LIMITS.text });
}

/** 取最新一轮里失败的卡片。 */
export function failedTasksOf(run) {
  const latest = run?.rounds?.at(-1);
  return (latest?.tasks ?? []).filter((task) => task.status === "failed");
}

/**
 * 把最新一轮的失败带进施工图：重试卡的 description 追加一段「上一轮为什么没过」。
 *
 * 只改重试目标那一张卡，其余卡片原样保留——施工图仍然是编译产物，不是运行态。
 */
export function mergeRunIntoPlan(plan, run) {
  if (plan === null || run === null) return { plan, feedback: [] };
  const failed = failedTasksOf(run);
  const feedback = failed.map((task) => summarizeTask(task));
  const retryId = plan.loop?.onGateFailure?.retry ?? null;
  if (retryId === null || feedback.length === 0) return { plan, feedback };
  const round = (run.rounds?.at(-1)?.round ?? 0) + 1;
  const text = [
    "",
    `上一轮（第 ${round - 1} 轮）失败，重做时先修这些：`,
    ...feedback.map((line, index) => `${index + 1}. ${line}`),
  ].join("\n");
  const tasks = plan.tasks.map((task) =>
    task.id === retryId ? { ...task, description: `${task.description}${text}`, feedback: feedback } : task,
  );
  return { plan: { ...plan, tasks, round, feedback }, feedback };
}

function summarizeTask(task) {
  const parts = [`卡 ${task.id} 未通过`];
  for (const command of task.commands ?? []) {
    if (command.exitCode === 0) continue;
    const tail = String(command.outputTail ?? "").trim().split("\n").slice(-3).join(" / ");
    parts.push(`命令 \`${command.command}\` 退出 ${command.exitCode}${tail ? `（${tail}）` : ""}`);
  }
  for (const finding of task.findings ?? []) {
    const where = finding.file ? ` [${finding.file}${finding.line ? `:${finding.line}` : ""}]` : "";
    parts.push(`${finding.severity}: ${finding.problem}${where} → ${finding.requiredFix}`);
  }
  return parts.join("；");
}
