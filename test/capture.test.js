import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import test from "node:test";

import { applyCapture, captureTeam, MECHANICAL_FIELDS } from "../lib/capture.js";
import { buildHandoverPlan, handoverPath, renderHandover, writeHandover } from "../lib/handover.js";

const repoRoot = nodePath.resolve(import.meta.dirname, "..");
const examples = nodePath.join(repoRoot, "examples");

function teamOf(overrides = {}) {
  return {
    id: "team-x",
    name: "team-x",
    phase: "running",
    captainSessionId: "session-1",
    description: "roster:core-review@1.0.0#abc12345",
    members: [
      {
        name: "lead",
        role: "core-review-lead@1.0.0",
        provider: "deepseek-official",
        model: "deepseek-v4-pro",
        reasoningEffort: "medium",
        toolPolicy: null,
        executionPrompt: "一致",
        status: "idle",
      },
    ],
    ...overrides,
  };
}

test("captureTeam：逐字段比对，人设只比哈希", () => {
  const report = captureTeam({
    rosterDir: nodePath.join(examples, "rosters/core-review"),
    rootDir: examples,
    id: "core-review",
    team: teamOf(),
  });
  assert.equal(report.ok, true);
  const lead = report.members.find((member) => member.name === "lead");
  assert.ok(lead, "成员 lead 应在比对结果里");
  const model = lead.fields.find((field) => field.field === "model");
  assert.equal(model.status, "differ");
  assert.equal(model.runtime, "deepseek-v4-pro");
  // 运行时正文与档案拼装结果不同 ⇒ 人设不一致，但不写回
  assert.equal(lead.persona.status, "differ");
  assert.ok(report.summary.differ > 0);
});

test("captureTeam：运行时缺成员记 missing，多出来的进 undeclared", () => {
  const report = captureTeam({
    rosterDir: nodePath.join(examples, "rosters/core-review"),
    rootDir: examples,
    id: "core-review",
    team: teamOf({ members: [{ name: "extra", role: "x@1.0.0", executionPrompt: "x" }] }),
  });
  assert.equal(report.ok, true);
  const lead = report.members.find((member) => member.name === "lead");
  assert.equal(lead.fields.every((field) => field.status === "missing"), true);
  assert.deepEqual(report.undeclared, ["extra"]);
});

test("applyCapture：写回机械字段、版本 patch+1、重编译 dist", () => {
  const lib = fs.mkdtempSync(nodePath.join(os.tmpdir(), "roster-capture-"));
  fs.cpSync(examples, lib, { recursive: true });
  const report = captureTeam({
    rosterDir: nodePath.join(lib, "rosters/core-review"),
    rootDir: lib,
    id: "core-review",
    team: teamOf(),
  });
  const applied = applyCapture({
    rosterDir: nodePath.join(lib, "rosters/core-review"),
    rootDir: lib,
    id: "core-review",
    members: report.members,
    fields: MECHANICAL_FIELDS,
  });
  assert.equal(applied.ok, true, JSON.stringify(applied.diagnostics));
  assert.ok(applied.written.some((item) => item.field === "model" && item.value === "deepseek-v4-pro"));
  const text = fs.readFileSync(nodePath.join(lib, "rosters/core-review/roster.yaml"), "utf8");
  assert.match(text, /model:\s*deepseek-v4-pro/);
  assert.ok(applied.dist !== null && fs.existsSync(applied.dist), "dist 应被重编译");
  fs.rmSync(lib, { recursive: true, force: true });
});

test("applyCapture：没有差异就不动文件", () => {
  const lib = fs.mkdtempSync(nodePath.join(os.tmpdir(), "roster-capture-"));
  fs.cpSync(examples, lib, { recursive: true });
  const applied = applyCapture({
    rosterDir: nodePath.join(lib, "rosters/core-review"),
    rootDir: lib,
    id: "core-review",
    members: [{ name: "lead", fields: [{ field: "model", status: "match", runtime: "x" }] }],
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.code, "nothing-to-write");
  fs.rmSync(lib, { recursive: true, force: true });
});

test("handover：清单写盘、渲染与非法步骤", () => {
  const lib = fs.mkdtempSync(nodePath.join(os.tmpdir(), "roster-handover-"));
  const built = buildHandoverPlan({
    roster: { id: "core-review", version: "1.0.0", sha256: "abc" },
    from: { teamId: "team-x", captainSessionId: "session-1" },
    to: {},
    steps: [
      { kind: "timer.cancel", detail: "取消旧会话的 3 条定时器", verify: "schedule_list 不再列出" },
      { kind: "timer.create", detail: "在新会话建日卡定时器" },
    ],
  });
  assert.equal(built.ok, true);
  const written = writeHandover(lib, built.plan);
  assert.ok(fs.existsSync(written.file));
  assert.match(written.file, /\.dsh-handover\/core-review-\d{8}-\d{6}\.json$/);
  const text = renderHandover(built.plan, written.file);
  assert.match(text, /timer\.cancel/);
  assert.match(text, /核对：schedule_list 不再列出/);
  assert.equal(handoverPath(lib, "core-review").includes(".dsh-handover"), true);

  const bad = buildHandoverPlan({ roster: { id: "x" }, steps: [{ kind: "reboot", detail: "x" }] });
  assert.equal(bad.ok, false);
  assert.ok(bad.diagnostics.some((item) => item.code === "handover-kind-unknown"));
  fs.rmSync(lib, { recursive: true, force: true });
});
