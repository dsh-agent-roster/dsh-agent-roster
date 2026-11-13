/**
 * 交接步骤的载体：把「迭代时要额外做的事」写成一份可核对的清单文件。
 *
 * 为什么不直接执行这些步骤：
 * - 定时器在宿主侧归 `schedule` 插件，插件层拿不到它的服务；唤醒路由是团队自己的脚本；
 *   归档要走 workspace 接口。它们都不属于档案层，硬做只会变成一个"看起来自动化、
 *   实际只对某台机器成立"的假动作。
 * - 所以这里只负责**承载 + 校验 + 交给新队长执行**：步骤是封闭枚举、必须带可核对的
 *   verify 文本；清单随材料落盘，新会话的起始提示里带上它，做完在会话里回报。
 *
 * 文件放在库根 `.dsh-handover/`，扫描器跳过点开头的目录，不会变成第二份档案。
 *
 * @module dsh-agent-roster/handover
 */
import fs from "node:fs";
import nodePath from "node:path";

import { diagnostic } from "./parse.js";

/** 清单格式。 */
export const HANDOVER_KIND = "dsh-agent-roster/handover@1";
/** 步骤种类是封闭集合：写错一个词不会被静默忽略。 */
export const HANDOVER_STEP_KINDS = [
  "capture",
  "session.create",
  "timer.cancel",
  "timer.create",
  "wake.update",
  "archive",
  "notify",
  "verify",
  "note",
];
export const HANDOVER_DIR = ".dsh-handover";
export const HANDOVER_LIMITS = { steps: 32, detailChars: 400, verifyChars: 400, summaryChars: 2000 };

function stamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 清单落点：`<rootDir>/.dsh-handover/<roster>-<时间>.json`。 */
export function handoverPath(rootDir, rosterId, now = new Date()) {
  return nodePath.join(rootDir, HANDOVER_DIR, `${rosterId}-${stamp(now)}.json`);
}

/**
 * 校验并构造清单。
 *
 * @returns {{ ok: boolean, plan?: object, diagnostics: object[] }}
 */
export function buildHandoverPlan(input) {
  const diagnostics = [];
  const report = (severity, code, p, reason) => diagnostics.push(diagnostic(severity, code, p, reason, "handover"));
  const raw = Array.isArray(input.steps) ? input.steps : [];
  const earlySummary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (raw.length === 0 && earlySummary === "") {
    return { ok: false, diagnostics: [diagnostic("error", "handover-empty", "steps", "没有交接步骤，也没有交接摘要", "handover")] };
  }
  if (raw.length > HANDOVER_LIMITS.steps) {
    report("error", "handover-too-many", "steps", `步骤最多 ${HANDOVER_LIMITS.steps} 条`);
  }

  const steps = [];
  raw.forEach((item, index) => {
    const p = `steps[${index}]`;
    if (item === null || typeof item !== "object") {
      report("error", "handover-step-invalid", p, "每条步骤必须是映射");
      return;
    }
    const kind = typeof item.kind === "string" ? item.kind.trim() : "";
    if (!HANDOVER_STEP_KINDS.includes(kind)) {
      report("error", "handover-kind-unknown", `${p}.kind`, `未知步骤种类 "${kind}"；可选：${HANDOVER_STEP_KINDS.join(", ")}`);
      return;
    }
    const detail = typeof item.detail === "string" ? item.detail.trim() : "";
    if (detail === "") {
      report("error", "handover-detail-missing", `${p}.detail`, "步骤必须写清做什么");
      return;
    }
    if (detail.length > HANDOVER_LIMITS.detailChars) {
      report("error", "handover-detail-too-long", `${p}.detail`, `最多 ${HANDOVER_LIMITS.detailChars} 字符`);
    }
    const verify = typeof item.verify === "string" ? item.verify.trim() : "";
    if (verify.length > HANDOVER_LIMITS.verifyChars) {
      report("error", "handover-verify-too-long", `${p}.verify`, `最多 ${HANDOVER_LIMITS.verifyChars} 字符`);
    }
    if (verify === "" && kind !== "note") {
      report("warn", "handover-verify-missing", `${p}.verify`, "没有写怎么核对：做完也只能靠自述");
    }
    steps.push({ id: `${kind}-${index + 1}`, kind, detail, verify, status: "pending" });
  });

  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (summary.length > HANDOVER_LIMITS.summaryChars) {
    report("error", "handover-summary-too-long", "summary", `摘要最多 ${HANDOVER_LIMITS.summaryChars} 字符（新会话没有旧对话记录，过长的摘要反而没人读）`);
  }

  if (diagnostics.some((item) => item.severity === "error")) return { ok: false, diagnostics };

  const now = input.now instanceof Date ? input.now : new Date();
  return {
    ok: true,
    plan: {
      kind: HANDOVER_KIND,
      createdAt: now.toISOString(),
      roster: {
        id: input.roster?.id ?? "",
        version: input.roster?.version ?? "",
        sha256: input.roster?.sha256 ?? null,
      },
      from: {
        teamId: input.from?.teamId ?? null,
        captainSessionId: input.from?.captainSessionId ?? "",
      },
      to: {
        sessionId: input.to?.sessionId ?? "",
        sessionTitle: input.to?.sessionTitle ?? "",
        teamName: input.to?.teamName ?? "",
      },
      summary,
      steps,
    },
    diagnostics,
  };
}

/** 原子写盘；返回落点的绝对路径。 */
export function writeHandover(rootDir, plan) {
  fs.mkdirSync(nodePath.join(rootDir, HANDOVER_DIR), { recursive: true });
  const file = handoverPath(rootDir, plan.roster.id || "roster", new Date(plan.createdAt));
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
  return { ok: true, file };
}

/** 读回清单（用于核对或续跑）。 */
export function readHandover(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value === null || typeof value !== "object" || value.kind !== HANDOVER_KIND) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * 系统级迭代补充：用户给的步骤永远优先，这段只是兜底清单。
 *
 * 为什么要有它：一次迭代里真正难的不是“新建一个会话”，而是“旧会话里有哪些东西
 * 档案承载不了、却必须跟着人走”。这些每台机器都不同，插件无法替人判断，
 * 但可以固定地把问题问全，避免新队长只照着用户列的三条做完就宣布接班完成。
 */
export const SYSTEM_ITERATION_NOTES = [
  "先做用户列出的步骤；这一段是兜底，不改变用户的优先级，也不替他做决定。",
  "盘点档案承载不了、但换代必须继承的东西：宿主定时器、唤醒路由、只存在于旧会话里的结论、会话 id、凭据指针、外部系统里的登记项。逐项写清“新会话怎么接手”，不要只写“已知”。",
  "盘点旧会话里未完成的临时任务与半成品：决定继承还是丢弃，每条给一句理由；拿不准的先读旧会话日志或问用户，不要凭印象补。",
  "无法核对的事不许写成已完成：每条交接要么给出可执行的核对命令，要么明说为什么核对不了。",
  "收尾时用 roster_verify 核对新团队，并把“没有继承的东西”如实报出来——漏报比少做更危险。",
];

/** 把系统级补充渲染成一段可拼进起始消息的文本。 */
export function renderIterationNotes() {
  return ["系统级迭代补充（兜底；用户步骤优先）：", ...SYSTEM_ITERATION_NOTES.map((line) => `- ${line}`)].join("\n");
}

/** 渲染成起始提示里的清单。 */
/**
 * 档案里的交接指南：换代时先读什么、有哪些具体交接事项。
 *
 * 它是**指导**，不是动作脚本：插件只把它放进新会话的起始消息，执行与否、怎么执行，
 * 由新队长判断——把定时器/会话 id 之类写进档案只会得到一份会腐烂的“自动化”。
 */
export function renderArchiveHandover(items) {
  const list = Array.isArray(items) ? items.filter((item) => item !== null && typeof item === "object" && typeof item.title === "string" && item.title.trim() !== "") : [];
  if (list.length === 0) return "";
  const lines = ["档案里的交接指南（换代时先读；这是指导，不是动作脚本）："];
  for (const item of list) {
    const detail = typeof item.detail === "string" && item.detail.trim() !== "" ? `：${item.detail.trim()}` : "";
    const verify = typeof item.verify === "string" && item.verify.trim() !== "" ? `（核对：${item.verify.trim()}）` : "";
    lines.push(`- ${item.title.trim()}${detail}${verify}`);
  }
  return lines.join("\n");
}

export function renderHandover(plan, file) {
  const lines = [];
  const summary = typeof plan?.summary === "string" ? plan.summary.trim() : "";
  if (summary !== "") {
    lines.push(
      "交接摘要（来自旧会话；新会话没有旧会话的对话记录，这段是唯一的上下文载体，其余细节按需读旧会话日志或问用户）：",
      summary,
      "",
    );
  }
  if (Array.isArray(plan.steps) && plan.steps.length > 0) {
    lines.push(
      "交接清单（这些动作不在档案里，须由你在新会话里逐条做完再开工）：",
      `清单文件：${file}`,
    );
    for (const step of plan.steps) {
      lines.push(`- [ ] ${step.kind}：${step.detail}${step.verify === "" ? "" : `（核对：${step.verify}）`}`);
    }
    lines.push("做完一条就在会话里报一条；没有 verify 的条目说明为什么无法核对。");
  }
  lines.push("", renderIterationNotes());
  return lines.join("\n");
}
