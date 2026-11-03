/**
 * 执行回执：校验形状，以及「失败能不能回到下一次编译」。
 *
 * 这一层最容易写成装饰——记录一堆字段，但下一次编译看都不看。所以这里的主断言不是
 * 「字段都在」，而是 `mergeRunIntoPlan` 之后**重试卡的 description 真的多了上一轮的失败原因**。
 *
 * @module test/run
 */
import assert from "node:assert/strict";
import test from "node:test";

import { failedTasksOf, mergeRunIntoPlan, validateRun } from "../lib/run.js";

function runDocument(overrides = {}) {
  return {
    kind: "dsh-agent-roster/run@1",
    roster: { id: "core-review", version: "1.0.0" },
    rounds: [
      {
        round: 1,
        at: "2026-11-03T03:00:00Z",
        tasks: [
          { id: "build", status: "passed" },
          {
            id: "tests-pass",
            status: "failed",
            commands: [{ command: "node --test", exitCode: 1, outputTail: "not ok 3 - 边界值\n# fail 1" }],
            findings: [{ severity: "high", problem: "空输入没有判空", requiredFix: "在入口处返回 400", file: "lib/x.js", line: 12 }],
          },
        ],
      },
    ],
    ...overrides,
  };
}

const plan = {
  kind: "dsh-agent-roster/plan@1",
  roster: { id: "core-review", version: "1.0.0" },
  executor: "captain",
  tasks: [
    { id: "build", kind: "stage", member: "fixer", description: "先修。" },
    { id: "tests-pass", kind: "gate", member: "reviewer", description: "门。" },
  ],
  loop: { onGateFailure: { retry: "build", maxRounds: 2 }, runRecord: "dist/core-review-1.0.0.run.json" },
};

test("run：合法回执通过，失败卡被识别", () => {
  const report = validateRun(runDocument());
  assert.equal(report.ok, true);
  assert.deepEqual(report.diagnostics.filter((item) => item.severity === "error"), []);
  assert.deepEqual(failedTasksOf(report.run).map((task) => task.id), ["tests-pass"]);
});

test("run：未知字段、坏状态、空轮次都被拒绝", () => {
  const unknown = validateRun({ ...runDocument(), extra: 1 });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.diagnostics.some((item) => item.code === "unknown-field"));

  const badStatus = validateRun(runDocument({ rounds: [{ round: 1, tasks: [{ id: "a", status: "maybe" }] }] }));
  assert.equal(badStatus.ok, false);
  assert.ok(badStatus.diagnostics.some((item) => item.code === "run-status"));

  const empty = validateRun(runDocument({ rounds: [] }));
  assert.equal(empty.ok, false);
  assert.ok(empty.diagnostics.some((item) => item.code === "run-rounds"));
});

test("run：失败原因并进重试卡，其余卡片原样", () => {
  const report = validateRun(runDocument());
  const merged = mergeRunIntoPlan(plan, report.run);
  assert.equal(merged.feedback.length, 1);
  const retry = merged.plan.tasks.find((task) => task.id === "build");
  assert.match(retry.description, /上一轮（第 1 轮）失败/);
  assert.match(retry.description, /空输入没有判空/);
  assert.match(retry.description, /node --test.*退出 1/);
  assert.deepEqual(retry.feedback.length, 1);
  assert.equal(merged.plan.round, 2);
  const untouched = merged.plan.tasks.find((task) => task.id === "tests-pass");
  assert.equal(untouched.description, "门。");
});

test("run：没有失败时不动施工图", () => {
  const passing = runDocument({ rounds: [{ round: 1, tasks: [{ id: "build", status: "passed" }] }] });
  const merged = mergeRunIntoPlan(plan, validateRun(passing).run);
  assert.equal(merged.plan, plan);
  assert.deepEqual(merged.feedback, []);
});
