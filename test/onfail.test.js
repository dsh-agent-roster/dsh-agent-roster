/**
 * 失败回边（`gate.onFail`）：门没过时回到哪个阶段、最多几轮。
 *
 * 守四件事：
 * 1. 目标必须是已声明的阶段，且不能是本门 after 里的阶段（那是原地重试）；
 * 2. 目标必须被某个门覆盖，否则修复完回不到任何一个门——这条回边没有出口；
 * 3. 两条回边可以互相指，但环上的轮数乘积必须有上限（默认 5）；
 * 4. 没写 onFail 的组装完全不受影响。
 *
 * @module test/onfail
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { validateRoster2 } from "../lib/roster2.js";

function rosterDoc(orchestration) {
  return {
    kind: "dsh-agent-roster/roster@2",
    id: "core-review",
    version: "1.0.0",
    title: "核心评审组",
    targets: ["agent-teams/members"],
    members: [
      { as: "fixer", role: "fixer@1.0.0" },
      { as: "reviewer", role: "reviewer@1.0.0" },
    ],
    orchestration,
  };
}

function pipeline(overrides = {}) {
  const base = {
    shape: "gate-pipeline",
    stages: [
      { id: "build", serial: ["fixer"] },
      { id: "audit", parallel: ["reviewer"] },
      { id: "repair", serial: ["fixer"] },
    ],
    gates: [
      {
        id: "audit-pass",
        after: ["audit"],
        verify: [{ command: "node --test", expectExit: 0 }],
        by: "reviewer",
      },
      {
        id: "repair-pass",
        after: ["repair"],
        verify: [{ command: "node --test", expectExit: 0 }],
        by: "reviewer",
      },
    ],
  };
  return { ...base, ...overrides };
}

function codes(diagnostics) {
  return diagnostics.filter((item) => item.severity === "error").map((item) => item.code);
}

test("失败回边：写对了就通过，并原样带进校验结果", () => {
  const orchestration = pipeline();
  orchestration.gates[0].onFail = { to: "repair", maxRounds: 2 };
  const result = validateRoster2(rosterDoc(orchestration));
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
  assert.deepEqual(result.roster.orchestration.gates[0].onFail, { to: "repair", maxRounds: 2 });
});

test("失败回边：目标必须是已声明的阶段", () => {
  const orchestration = pipeline();
  orchestration.gates[0].onFail = { to: "nope", maxRounds: 1 };
  const result = validateRoster2(rosterDoc(orchestration));
  assert.equal(result.ok, false);
  assert.ok(codes(result.diagnostics).includes("onfail-unknown-stage"));
});

test("失败回边：不能指回本门 after 里的阶段", () => {
  const orchestration = pipeline();
  orchestration.gates[0].onFail = { to: "audit", maxRounds: 1 };
  const result = validateRoster2(rosterDoc(orchestration));
  assert.equal(result.ok, false);
  assert.ok(codes(result.diagnostics).includes("onfail-immediate"));
});

test("失败回边：目标没有被任何门覆盖时，这条回边没有出口", () => {
  const orchestration = pipeline();
  orchestration.gates[0].onFail = { to: "repair", maxRounds: 2 };
  orchestration.gates = [orchestration.gates[0]];
  const result = validateRoster2(rosterDoc(orchestration));
  assert.equal(result.ok, false);
  assert.ok(codes(result.diagnostics).includes("onfail-dangling"));
});

test("失败回边：两条回边互相指时，轮数乘积必须有上限", () => {
  const orchestration = pipeline();
  orchestration.gates[0].onFail = { to: "repair", maxRounds: 3 };
  orchestration.gates[1].onFail = { to: "audit", maxRounds: 3 };
  const result = validateRoster2(rosterDoc(orchestration));
  assert.equal(result.ok, false);
  assert.ok(codes(result.diagnostics).includes("onfail-unbounded"));

  // 同一条环，轮数收小就合法：上限是 5。
  orchestration.gates[0].onFail = { to: "repair", maxRounds: 2 };
  orchestration.gates[1].onFail = { to: "audit", maxRounds: 2 };
  assert.equal(validateRoster2(rosterDoc(orchestration)).ok, true);
});

test("失败回边：maxRounds 必填且只能 1~5", () => {
  const orchestration = pipeline();
  orchestration.gates[0].onFail = { to: "repair" };
  const result = validateRoster2(rosterDoc(orchestration));
  assert.equal(result.ok, false);
  assert.ok(codes(result.diagnostics).includes("onfail-unbounded"));
});

test("tools.scope 只是声明：校验时明确说它不生效", () => {
  const doc = rosterDoc(pipeline());
  doc.members[0].tools = { scope: { allow: ["read"] } };
  const result = validateRoster2(doc);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
  const info = result.diagnostics.find((item) => item.code === "scope-declaration-only");
  assert.ok(info !== undefined);
  assert.equal(info.severity, "info");
});
