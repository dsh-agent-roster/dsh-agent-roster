/**
 * 施工图测试：编排摊成卡片清单之后，依赖、门与重试都必须可核对。
 *
 * 这里守三件事：
 * 1. 阶段按顺序串起来，门的依赖只挂在它 `after` 指的阶段上；
 * 2. 门的判据（命令 + 期望退出码）原样进施工图，不会被「判据是句子」稀释；
 * 3. 施工图不假装执行：`executor` 是 captain，插件自己不产生任何 agent_teams_* 调用。
 *
 * @module test/plan
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { compileRosterAt } from "../lib/compile2.js";
import { compilePlan, runRecordName } from "../lib/plan.js";

const scratch = () => mkdtempSync(nodePath.join(tmpdir(), "dsh-plan-"));

function write(root, relative, body) {
  const file = nodePath.join(root, relative);
  mkdirSync(nodePath.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function roleDoc({ name, body = "按职责办事。" }) {
  return [
    "---",
    "kind: dsh-agent-roster/role@1",
    `name: ${name}`,
    "version: 1.0.0",
    `role: ${name}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function rosterDoc({ id = "core-review", orchestration }) {
  return [
    "kind: dsh-agent-roster/roster@2",
    `id: ${id}`,
    "version: 1.0.0",
    "title: 核心评审组",
    "targets: [agent-teams/members]",
    "members:",
    "  - as: fixer",
    "    role: fixer@1.0.0",
    "  - as: reviewer",
    "    role: reviewer@1.0.0",
    orchestration,
    "",
  ].join("\n");
}

function compileWith(orchestration) {
  const root = scratch();
  write(root, "roles/fixer/AGENT.md", roleDoc({ name: "fixer" }));
  write(root, "roles/reviewer/AGENT.md", roleDoc({ name: "reviewer" }));
  write(root, "rosters/core-review/roster.yaml", rosterDoc({ orchestration }));
  return compileRosterAt(nodePath.join(root, "rosters/core-review"), { rolesDir: nodePath.join(root, "roles") });
}

const PIPELINE = [
  "orchestration:",
  "  shape: gate-pipeline",
  "  stages:",
  "    - id: build",
  "      serial: [fixer]",
  "      maxRounds: 2",
  "    - id: audit",
  "      parallel: [reviewer]",
  "  gates:",
  "    - id: tests-pass",
  "      after: [audit]",
  "      requires: [评审没有高危问题]",
  "      verify:",
  "        - command: node --test",
  "          expectExit: 0",
  "      by: reviewer",
].join("\n");

test("施工图：阶段串成链，门挂在它等待的阶段后面", () => {
  const compiled = compileWith(PIPELINE);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics, null, 2));
  const { ok, plan } = compilePlan(compiled.compiled);
  assert.equal(ok, true);
  assert.deepEqual(
    plan.tasks.map((task) => task.id),
    ["build", "audit", "tests-pass"],
  );
  assert.deepEqual(plan.tasks.map((task) => task.dependencies), [[], ["build"], ["audit"]]);
  assert.deepEqual(
    plan.tasks.map((task) => task.kind),
    ["stage", "stage", "gate"],
  );
  assert.equal(plan.executor, "captain");
  assert.equal(plan.roster.id, "core-review");
});

test("施工图：门的命令与期望退出码原样保留，门不靠一句话自称通过", () => {
  const compiled = compileWith(PIPELINE);
  const { plan } = compilePlan(compiled.compiled);
  const gate = plan.tasks.find((task) => task.kind === "gate");
  assert.deepEqual(gate.gate.verify, [{ command: "node --test", expectExit: 0 }]);
  assert.deepEqual(gate.gate.requires, ["评审没有高危问题"]);
  assert.equal(gate.member, "reviewer");
  assert.match(gate.description, /\$ node --test/);
  assert.match(gate.description, /期望退出码 0/);
});

test("施工图：失败回到第一个阶段，轮数取阶段里最大的 maxRounds", () => {
  const compiled = compileWith(PIPELINE);
  const { plan } = compilePlan(compiled.compiled);
  assert.deepEqual(plan.loop.onGateFailure, { retry: "build", maxRounds: 2 });
  assert.equal(plan.loop.runRecord, runRecordName("core-review", "1.0.0"));
  assert.equal(plan.loop.runRecord, "dist/core-review-1.0.0.run.json");
});

test("施工图：并行阶段每人一张卡，后续阶段等齐它们", () => {
  const orchestration = [
    "orchestration:",
    "  shape: gate-pipeline",
    "  stages:",
    "    - id: split",
    "      parallel: [fixer, reviewer]",
    "    - id: merge",
    "      serial: [fixer]",
    "  gates: []",
  ].join("\n");
  const compiled = compileWith(orchestration);
  const { plan } = compilePlan(compiled.compiled);
  assert.deepEqual(
    plan.tasks.map((task) => task.id),
    ["split.fixer", "split.reviewer", "merge"],
  );
  assert.deepEqual(plan.tasks[2].dependencies, ["split.fixer", "split.reviewer"]);
});

test("施工图：没有编排就没有施工图，不编造空计划", () => {
  const compiled = compileWith("");
  assert.equal(compiled.ok, true);
  const { ok, plan } = compilePlan(compiled.compiled);
  assert.equal(ok, true);
  assert.equal(plan, null);
});

test("施工图：门等待的阶段没有卡片时报错，而不是产出一份空依赖", () => {
  const compiled = compileWith(PIPELINE);
  // 直接破坏编译产物，模拟「编排引用了没有卡片的阶段」。
  const broken = structuredClone(compiled.compiled);
  broken.orchestration.gates[0].after = ["nowhere"];
  const { ok, diagnostics } = compilePlan(broken);
  assert.equal(ok, false);
  assert.equal(diagnostics[0].code, "gate-without-stage");
});

test("门没有可执行判据时，组建本身就被拒（不是到施工图才失败）", () => {
  const orchestration = [
    "orchestration:",
    "  shape: gate-pipeline",
    "  stages:",
    "    - id: build",
    "      serial: [fixer]",
    "  gates:",
    "    - id: ship",
    "      after: [build]",
    "      requires: [我觉得可以]",
    "      by: reviewer",
  ].join("\n");
  const compiled = compileWith(orchestration);
  assert.equal(compiled.ok, false);
  assert.ok(compiled.diagnostics.some((item) => item.code === "gate-unverifiable"));
});
