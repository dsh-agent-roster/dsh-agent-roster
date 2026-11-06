import assert from "node:assert/strict";
import test from "node:test";

import { applyCaptain, buildCaptainPrompt, listSessions, pickSessionModel, sessionTitleOf } from "../lib/apply.js";

/** 一份最小的队长档案：只要 id/description/成员与 captain 段。 */
function roster(overrides = {}) {
  return {
    id: "agent-teams",
    title: "Agent Teams",
    description: "四个角色的开发团队",
    members: [
      { name: "team-lead", role: "lead", systemPrompt: "你是团队负责人。" },
      { name: "team-reviewer", role: "review", systemPrompt: "你只做审查。" },
    ],
    captain: { provider: "tsingmicro", model: "deepseek-v4.1-flash", reasoningEffort: "high" },
    ...overrides,
  };
}

/** 记录调用的假 sessionController。 */
function fakeController(overrides = {}) {
  const calls = [];
  const controller = {
    calls,
    async list() {
      calls.push(["list"]);
      return {
        items: [
          {
            sessionId: "s-existing",
            cwd: "/tmp/project",
            updatedAt: 2,
            running: false,
            blank: false,
            projections: {
              kind: "cached",
              asOfSeq: 1,
              values: {
                title: " 档案库改造 ",
                modelSelection: { lastUsed: { provider: "p", model: "m", reasoningEffort: "low" } },
              },
            },
          },
          { sessionId: "s-blank", updatedAt: 1, blank: true },
          { sessionId: "s-child", origin: "subagent" },
        ],
      };
    },
    async create(request) {
      calls.push(["create", request]);
      return { sessionId: "s-created" };
    },
    async rename(request) {
      calls.push(["rename", request]);
      return { sessionId: request.sessionId, title: request.title };
    },
    async selectModel(request) {
      calls.push(["selectModel", request]);
      return { selected: { provider: request.provider, model: request.model } };
    },
    async prompt(request, signal) {
      // 宿主服务的真实签名是 `prompt(request, signal)`，第一句就是
      // `signal.throwIfAborted()`；假控制器必须照这个契约来，否则会漏掉
      // "少传 signal ⇒ TypeError ⇒ 被包成 prompt-not-queued" 这类事故。
      signal.throwIfAborted();
      calls.push(["prompt", request, signal]);
      return { accepted: true };
    },
    ...overrides,
  };
  return controller;
}

test("pickSessionModel 从 projections 里取最后使用的模型", () => {
  const model = pickSessionModel({
    projections: { kind: "cached", asOfSeq: 1, values: { modelSelection: { lastUsed: { provider: "p", model: "m" } } } },
  });
  assert.deepEqual(model, { provider: "p", model: "m", reasoningEffort: "" });
  assert.equal(pickSessionModel({}), null);
});

test("sessionTitleOf 只认投影里的标题，取不到就是空串", () => {
  assert.equal(sessionTitleOf({ projections: { values: { title: " 档案库改造 " } } }), "档案库改造");
  assert.equal(sessionTitleOf({}), "");
  assert.equal(sessionTitleOf({ projections: { values: { title: null } } }), "");
  assert.equal(sessionTitleOf({ projections: { values: { title: 42 } } }), "");
});

test("listSessions 过滤子代理会话，并带上模型与 cwd", async () => {
  const result = await listSessions(fakeController());
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.sessions.map((session) => session.sessionId),
    ["s-existing", "s-blank"],
  );
  assert.equal(result.sessions[0].cwd, "/tmp/project");
  assert.equal(result.sessions[0].title, "档案库改造");
  assert.equal(result.sessions[1].title, "");
  assert.deepEqual(result.sessions[0].model, { provider: "p", model: "m", reasoningEffort: "low" });
  assert.equal(result.sessions[1].blank, true);
});

test("listSessions 没有 sessionController 时明确报不可用", async () => {
  const result = await listSessions(undefined);
  assert.equal(result.ok, false);
  assert.equal(result.code, "session-controller-unavailable");
  assert.deepEqual(result.sessions, []);
});

test("buildCaptainPrompt 给出要建的成员，但要求人设从 roster_show 取", () => {
  const prompt = buildCaptainPrompt({ roster: roster() });
  assert.match(prompt, /agent_teams_create/);
  assert.match(prompt, /roster_show/);
  assert.match(prompt, /team-lead \| role: lead/);
  assert.match(prompt, /provenance 写 "roster:agent-teams"/);
  // 人设原文不进提示词，避免把整份档案塞进上下文。
  assert.equal(prompt.includes("你是团队负责人。"), false);
});

test("buildCaptainPrompt 用给定的团队名，缺省才退回档案 id", () => {
  const named = buildCaptainPrompt({ roster: roster(), teamName: "ops-floor" });
  assert.match(named, /agent_teams_create`，参数 name: "ops-floor"/);
  const fallback = buildCaptainPrompt({ roster: roster() });
  assert.match(fallback, /agent_teams_create`，参数 name: "agent-teams"/);
});

test("applyCaptain 走已有会话：切模型 + 排队提示词", async () => {
  const controller = fakeController();
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster(),
    mode: "existing",
    sessionId: "s-existing",
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "s-existing");
  assert.deepEqual(
    controller.calls.map((call) => call[0]),
    ["selectModel", "prompt"],
  );
  const selection = controller.calls[0][1];
  assert.equal(selection.provider, "tsingmicro");
  assert.equal(selection.model, "deepseek-v4.1-flash");
  assert.equal(selection.reasoningEffort, "high");
  const prompt = controller.calls[1][1];
  assert.equal(prompt.sessionId, "s-existing");
  assert.equal(prompt.mode, "queue");
  assert.equal(prompt.content[0].type, "text");
  assert.match(prompt.content[0].text, /roster_show/);
  // 宿主服务的第二个参数是 AbortSignal；不带它，服务内部 `signal.throwIfAborted()`
  // 会抛 TypeError，我们就会把"少参数"误报成"排队失败"。
  assert.equal(controller.calls[1][2] instanceof AbortSignal, true);
  assert.equal(controller.calls[1][2].aborted, false);
});

test("applyCaptain 新建会话：create 之后再用新 id 切模型并提示", async () => {
  const controller = fakeController();
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster(),
    mode: "new",
    cwd: "D:\\workspace",
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "s-created");
  assert.equal(controller.calls[0][0], "create");
  assert.deepEqual(controller.calls[0][1], { cwd: "D:\\workspace" });
  assert.equal(controller.calls[1][1].sessionId, "s-created");
});

test("applyCaptain 已有会话但没给 sessionId 时拒绝，不猜", async () => {
  const result = await applyCaptain({ sessionController: fakeController(), roster: roster(), mode: "existing" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing-session");
});

test("applyCaptain 档案没声明路由时只排队提示词，不碰模型", async () => {
  const controller = fakeController();
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster({ captain: {} }),
    mode: "existing",
    sessionId: "s-existing",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    controller.calls.map((call) => call[0]),
    ["prompt"],
  );
  assert.equal(result.model, null);
});

test("applyCaptain 没有 sessionController 时明确报不可用", async () => {
  const result = await applyCaptain({ sessionController: null, roster: roster(), mode: "new" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "session-controller-unavailable");
});

test("applyCaptain 切模型失败时如实失败，不继续发提示词", async () => {
  const controller = fakeController({
    async create() {
      return { sessionId: "s-created" };
    },
    async selectModel() {
      throw new Error("session/model-unavailable");
    },
  });
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster(),
    mode: "existing",
    sessionId: "s-existing",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "model-not-applied");
  assert.equal(controller.calls.some((call) => call[0] === "prompt"), false);
});

test("applyCaptain 新建会话：落在给定空间里，并建完就改名", async () => {
  const controller = fakeController();
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster(),
    mode: "new",
    workspaceId: "ws-7",
    sessionTitle: "档案库改造",
    teamName: "ops-floor",
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "s-created");
  assert.equal(result.sessionTitle, "档案库改造");
  const create = controller.calls.find((call) => call[0] === "create");
  assert.deepEqual(create[1], { workspaceId: "ws-7" }, "workspaceId 与 cwd 互斥，只传空间");
  const rename = controller.calls.find((call) => call[0] === "rename");
  assert.deepEqual(rename[1], { sessionId: "s-created", title: "档案库改造" });
  assert.equal(controller.calls.at(-1)[0], "prompt");
});

test("applyCaptain 改名失败如实报错，但会话 id 仍带回来", async () => {
  const controller = fakeController({
    async rename() {
      throw new Error("title rejected");
    },
  });
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster(),
    mode: "new",
    workspaceId: "ws-7",
    sessionTitle: "x",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "session-rename-failed");
  assert.equal(result.sessionId, "s-created");
});
