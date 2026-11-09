import assert from "node:assert/strict";
import test from "node:test";

import { applyCaptain } from "../lib/apply.js";
import {
  buildExperimentalPrompt,
  detectTeamTargets,
  teamTargetOf,
  TEAM_TARGET_IDS,
} from "../lib/team-targets.js";

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

test("目标探测：装了就是 available，缺包会写清缺哪个", () => {
  const all = detectTeamTargets({ resolve: () => true });
  assert.deepEqual(all.map((item) => item.id), TEAM_TARGET_IDS);
  assert.equal(all.every((item) => item.available === true && item.missing.length === 0), true);

  const none = detectTeamTargets({ resolve: () => false });
  assert.equal(none.every((item) => item.available === false), true);
  assert.deepEqual(none[1].missing, [
    "@deepseek-ai/dsh-experimental-agent-team",
    "@deepseek-ai/dsh-experimental-tool-agent-team",
  ]);
});

test("目标探测：能力矩阵如实描述每个引擎接得住什么", () => {
  const targets = detectTeamTargets({ resolve: () => true });
  const native = targets.find((item) => item.id === "agent-teams");
  const experimental = targets.find((item) => item.id === "experimental-agent-team");
  assert.deepEqual(native.capabilities, {
    teamRecord: true,
    memberSpecs: true,
    memberPersona: true,
    perMemberModel: true,
    teamName: true,
  });
  assert.deepEqual(experimental.capabilities, {
    teamRecord: false,
    memberSpecs: false,
    memberPersona: false,
    perMemberModel: false,
    teamName: false,
  });
  assert.equal(teamTargetOf("nope"), null);
  assert.equal(teamTargetOf("agent-teams").label, "Agent Teams");
});

test("实验线提示：走 spawn_teammate，不走 agent_teams_create，并说明成员规格不生效", () => {
  const prompt = buildExperimentalPrompt({ roster: roster(), teamName: "ignored" });
  assert.match(prompt, /spawn_teammate/);
  assert.match(prompt, /list_agents/);
  assert.equal(prompt.includes("agent_teams_create"), false);
  assert.equal(prompt.includes("agent_teams_add_member"), false);
  assert.match(prompt, /team-lead \| role: lead/);
  assert.match(prompt, /不支持给成员单独指定模型、人设或 toolPolicy/);
});

test("applyCaptain 按 target 选提示词：实验线不发 agent_teams_create", async () => {
  const controller = fakeController();
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster(),
    mode: "new",
    target: "experimental-agent-team",
    sessionTitle: "probe",
  });
  assert.equal(result.ok, true);
  assert.equal(result.target, "experimental-agent-team");
  const text = controller.calls.find((call) => call[0] === "prompt")[1].content[0].text;
  assert.match(text, /spawn_teammate/);
  assert.equal(text.includes("agent_teams_create"), false);
});

test("applyCaptain 默认走 agent-teams；未知 target 不猜成实验线", async () => {
  for (const target of [undefined, "unknown-engine", "agent-teams"]) {
    const controller = fakeController();
    const result = await applyCaptain({
      sessionController: controller,
      roster: roster(),
      mode: "new",
      target,
    });
    assert.equal(result.ok, true);
    assert.equal(result.target, "agent-teams");
    const text = controller.calls.find((call) => call[0] === "prompt")[1].content[0].text;
    assert.match(text, /agent_teams_create/);
  }
});
