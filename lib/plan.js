/**
 * 施工图：把 `orchestration` 摊成一份卡片清单。
 *
 * 这份文件是「声明」与「执行」之间那条缝上的东西，所以它必须说清三件事：
 *
 * 1. **谁执行** —— `executor: "captain"`。插件不调用 `agent_teams_create_task`：
 *    写团队状态的能力只属于队长会话，越界一次，这个仓库所有「只声明不承载」的
 *    承诺就全部作废。
 * 2. **谁判门** —— 门的每条 `verify` 都要能被跑：命令 + 期望退出码。没有判据的门
 *    在 `lib/roster2.js` 里就已经被拒了，这里只负责原样传下去。
 * 3. **谁重试** —— `loop.onGateFailure`：门不过就回到第一个阶段，最多 `maxRounds`
 *    轮；每轮的失败意见由执行者写进 `runRecord` 指向的文件，下一次编译读它。
 *
 * 这里刻意不生成「任务 id」以外的任何运行时观念：卡片真正的 id 由团队分配，
 * 本文件里的 id 只在施工图内部表达依赖。
 *
 * @module lib/plan
 */
import { PLAN_KIND } from "./format-v2.js";

/** 施工图里一条依赖最多指向几张卡（防御性上限，正常远小于它）。 */
const MAX_DEPENDENCIES = 32;

/**
 * 编译施工图。
 *
 * @param {object} compiled 编译产物（`compileRoster` 的返回值）
 * @returns {{ok: boolean, plan: object|null, diagnostics: object[]}}
 */
export function compilePlan(compiled) {
  const diagnostics = [];
  const orchestration = compiled.orchestration;
  if (orchestration === null) {
    return { ok: true, plan: null, diagnostics };
  }

  const rosterTitle = compiled.source.title ?? compiled.source.roster;
  const roleTitles = new Map(compiled.members.map((member) => [member.name, member.role]));
  const tasks = [];
  const stageTasks = new Map();
  let previous = [];

  for (const stage of orchestration.stages) {
    const members = [...stage.serial, ...stage.parallel];
    if (members.length === 0) {
      diagnostics.push({
        severity: "error",
        code: "empty-stage",
        path: `orchestration.stages.${stage.id}`,
        reason: `阶段 ${stage.id} 没有指定成员`,
      });
      continue;
    }
    const ids = members.map((member) => {
      const id = members.length === 1 ? stage.id : `${stage.id}.${member}`;
      const role = roleTitles.get(member) ?? member;
      tasks.push({
        id,
        kind: "stage",
        stage: stage.id,
        member,
        subject: `${rosterTitle} · ${stage.id} · ${member}`,
        description: stageDescription({ stage, member, role, previous, stageTasks }),
        dependencies: previous.slice(0, MAX_DEPENDENCIES),
        gate: null,
      });
      return id;
    });
    stageTasks.set(stage.id, ids);
    previous = ids;
  }

  for (const gate of orchestration.gates) {
    const dependencies = gate.after.flatMap((stageId) => stageTasks.get(stageId) ?? []);
    const problem = dependencies.length === 0;
    if (problem) {
      diagnostics.push({
        severity: "error",
        code: "gate-without-stage",
        path: `orchestration.gates.${gate.id}.after`,
        reason: `门 ${gate.id} 等待的阶段没有任何卡片：${gate.after.join(", ")}`,
      });
    }
    tasks.push({
      id: gate.id,
      kind: "gate",
      stage: null,
      member: gate.by,
      subject: `${rosterTitle} · 判定 · ${gate.id}`,
      description: gateDescription(gate),
      dependencies: dependencies.slice(0, MAX_DEPENDENCIES),
      gate: {
        id: gate.id,
        requires: gate.requires.slice(),
        verify: gate.verify.map((item) => ({ command: item.command, expectExit: item.expectExit })),
        by: gate.by,
      },
    });
  }

  const rounds = orchestration.stages.reduce((max, stage) => Math.max(max, stage.maxRounds), 1);
  const first = tasks.find((task) => task.kind === "stage") ?? null;
  const plan = {
    kind: PLAN_KIND,
    roster: { id: compiled.source.roster, version: compiled.source.version },
    shape: orchestration.shape,
    executor: "captain",
    tasks,
    loop: {
      onGateFailure: {
        retry: first === null ? null : first.id,
        maxRounds: rounds,
      },
      runRecord: runRecordName(compiled.source.roster, compiled.source.version),
    },
    notes: [
      "插件不调用任何 agent_teams_* 工具：这份文件是给队长会话的施工图。",
      "卡片真正的 id 由团队分配；这里的 id 只在施工图内部表达依赖。",
      "门必须先跑 verify 里的命令，全部满足期望退出码才算通过；requires 是给人读的补充判据，不能替代 verify。",
      "失败意见写进 runRecord 指向的文件，下一次编译会把它带进重试卡。",
    ],
  };

  if (orchestration.status === "declaration") {
    plan.notes.push("orchestration.status = declaration：施工图描述的是「打算怎么跑」，不是「已经跑过」。");
  }
  return { ok: diagnostics.every((item) => item.severity !== "error"), plan, diagnostics };
}

/** 运行记录文件名：与产物同目录，避免第二处命名规则。 */
export function runRecordName(rosterId, version) {
  return `dist/${rosterId}-${version}.run.json`;
}

function stageDescription({ stage, member, role, previous, stageTasks }) {
  const lines = [`阶段 ${stage.id}：${member}（${role}）负责。`];
  if (previous.length === 0) {
    lines.push("这是第一个阶段，没有前置卡片。");
  } else {
    const names = [...stageTasks.entries()]
      .filter(([, ids]) => ids.some((id) => previous.includes(id)))
      .map(([id]) => id);
    lines.push(`前置：${names.length > 0 ? names.join("、") : previous.join("、")}。`);
  }
  if (stage.maxRounds > 1) {
    lines.push(`允许返工 ${stage.maxRounds} 轮。`);
  }
  if (stage.join !== null) {
    lines.push(`汇合到：${stage.join}。`);
  }
  lines.push("完成后把结果写进任务输出；不要自行判定门。");
  return lines.join("\n");
}

function gateDescription(gate) {
  const lines = [`门 ${gate.id}：由 ${gate.by} 判定，必须先跑完下面的命令。`];
  for (const item of gate.verify) {
    lines.push(`  $ ${item.command}`);
    lines.push(`    期望退出码 ${item.expectExit}`);
  }
  if (gate.requires.length > 0) {
    lines.push("此外还要满足（人读判据，不能替代上面的命令）：");
    for (const item of gate.requires) lines.push(`  - ${item}`);
  }
  lines.push(`判定结论写进任务输出；不通过时在 ${gate.by} 的结论里写清哪条命令失败、失败输出前 20 行。`);
  return lines.join("\n");
}
