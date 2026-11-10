import assert from "node:assert/strict";
import test from "node:test";

import { applyCaptain } from "../lib/apply.js";
import { detectTeamTargets, teamTargetOf, TEAM_TARGET_IDS } from "../lib/team-targets.js";

function roster() {
  return {
    id: "agent-teams",
    title: "Agent Teams",
    description: "四个角色的开发团队",
    members: [
      { name: "team-lead", role: "lead", systemPrompt: "你是团队负责人。" },
      { name: "team-reviewer", role: "review", systemPrompt: "你只做审查。" },
    ],
    captain: { systemPrompt: "你是这支团队的队长：先划清边界，再要结论。" },
  };
}

function fakeController() {
  const calls = [];
  return {
    calls,
    async create() {
      calls.push(["create"]);
      return { sessionId: "session-target" };
    },
    async prompt(request, signal) {
      signal.throwIfAborted();
      calls.push(["prompt", request]);
    },
  };
}

test("目标探测：装了就是 available，缺包写清缺哪个；支持的只有闭集里的", () => {
  const all = detectTeamTargets({ resolve: () => true });
  assert.deepEqual(
    all.map((item) => item.id),
    [...TEAM_TARGET_IDS, "experimental-agent-team"],
  );
  assert.equal(all.every((item) => item.available === true && item.missing.length === 0), true);
  assert.equal(teamTargetOf("agent-teams").supported, true);
  // 官方实验线：装得上也不算支持。列出来、说清为什么，比静默消失诚实。
  const unsupported = teamTargetOf("experimental-agent-team");
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.reason, /团队记录/);

  const none = detectTeamTargets({ resolve: () => false });
  assert.equal(none.every((item) => item.available === false), true);
});

test("目标探测：能力矩阵如实描述每个引擎接得住什么", () => {
  const targets = detectTeamTargets({ resolve: () => true });
  const native = targets.find((item) => item.id === "agent-teams");
  assert.deepEqual(native.capabilities, {
    teamRecord: true,
    memberSpecs: true,
    memberPersona: true,
    perMemberModel: true,
    teamName: true,
  });
  const experimental = targets.find((item) => item.id === "experimental-agent-team");
  assert.equal(experimental.supported, false);
  assert.equal(experimental.capabilities.teamRecord, false);
  assert.equal(teamTargetOf("nope"), null);
});

test("applyCaptain：暂不支持的引擎明确失败，不静默按 agent-teams 建团", async () => {
  const controller = fakeController();
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster(),
    mode: "new",
    target: "experimental-agent-team",
    sessionTitle: "probe",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "target-unsupported");
  assert.equal(controller.calls.length, 0);
});

test("applyCaptain 默认走 agent-teams；未知 target 报错不猜", async () => {
  for (const target of [undefined, "agent-teams"]) {
    const controller = fakeController();
    const result = await applyCaptain({ sessionController: controller, roster: roster(), mode: "new", target });
    assert.equal(result.ok, true);
    assert.equal(result.target, "agent-teams");
    const text = controller.calls.find((call) => call[0] === "prompt")[1].content[0].text;
    assert.match(text, /agent_teams_create/);
  }
  const controller = fakeController();
  const unknown = await applyCaptain({ sessionController: controller, roster: roster(), mode: "new", target: "unknown-engine" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "unknown-target");
  assert.equal(controller.calls.length, 0);
});
