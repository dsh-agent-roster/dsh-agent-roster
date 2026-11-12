import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyCaptain,
  buildCaptainPrompt,
  listHostWorkspaces,
  listSessions,
  pickSessionModel,
  sessionTitleOf,
  workspaceIdForPath,
} from "../lib/apply.js";

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
    captain: {
      provider: "tsingmicro",
      model: "deepseek-v4.1-flash",
      reasoningEffort: "high",
      systemPrompt: "你是这支团队的队长：先划清边界，再要结论。",
    },
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

test("buildCaptainPrompt 带上队长人设，但成员人设仍从 roster_show 取", () => {
  const prompt = buildCaptainPrompt({ roster: roster() });
  assert.match(prompt, /agent_teams_create/);
  assert.match(prompt, /roster_show/);
  assert.match(prompt, /team-lead \| role: lead/);
  assert.match(prompt, /roster_create`，参数 id/);
  assert.match(prompt, /第 2 步的溯源行追加在最后/);
  assert.match(prompt, /这个工具没有 provenance 参数/);
  assert.match(prompt, /参数按第 2 步给出的原样传/);
  // 队长人设是“对队长本人”的声明，必须进提示词，否则档案的 captain 段没有落点。
  assert.equal(prompt.includes("你是这支团队的队长：先划清边界，再要结论。"), true);
  assert.match(prompt, /队长人设（来自档案 captain 段，本次会话按它行动）/);
  assert.match(prompt, /建团队与后续工作都以它为准/);
  // 成员人设原文仍不进提示词，避免把整份档案塞进上下文。
  assert.equal(prompt.includes("你是团队负责人。"), false);
});

test("buildCaptainPrompt 在队长没有写人设时如实退回部署的人设", () => {
  const prompt = buildCaptainPrompt({ roster: roster({ captain: { provider: "tsingmicro", model: "m" } }) });
  assert.equal(prompt.includes("队长人设（来自档案 captain 段"), false);
  assert.match(prompt, /captain 段没有人设，本次会话的行为以部署的 preset persona 为准/);
});

test("buildCaptainPrompt 认得 v2 档案的 captain.personaPrefix（角色式档案）", () => {
  // v2 把队长人设放在 personaPrefix（编译产物里是 captain.persona 的正文）。
  // 只认 systemPrompt 会把角色式档案的队长人设静默丢掉。
  const prompt = buildCaptainPrompt({
    roster: roster({ captain: { name: "lead", personaPrefix: "你是角色式档案的队长。" } }),
  });
  assert.equal(prompt.includes("你是角色式档案的队长。"), true);
  assert.match(prompt, /队长人设（来自档案 captain 段/);
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

test("工作区列表读宿主的 id 字段（不是 workspaceId）", () => {
  const list = listHostWorkspaces({
    list: () => [
      { id: "ws-a", title: "A", path: "/tmp/a" },
      { workspaceId: "ws-b", title: "B", path: "/tmp/b" },
      { id: "ws-empty", title: "no path", path: "" },
    ],
  });
  assert.deepEqual(list, [
    { workspaceId: "ws-a", title: "A", path: "/tmp/a" },
    { workspaceId: "ws-b", title: "B", path: "/tmp/b" },
  ]);
});

test("workspaceIdForPath 取最长的那个前缀，越界返回空串", () => {
  const registry = {
    list: () => [
      { id: "ws-root", path: "/tmp" },
      { id: "ws-a", path: "/tmp/a" },
    ],
  };
  assert.equal(workspaceIdForPath(registry, "/tmp/a/rosters/demo"), "ws-a");
  assert.equal(workspaceIdForPath(registry, "/tmp/a"), "ws-a");
  assert.equal(workspaceIdForPath(registry, "/tmp/other"), "ws-root");
  assert.equal(workspaceIdForPath(registry, "/elsewhere"), "");
  assert.equal(workspaceIdForPath(null, "/tmp/a"), "");
});

test("applyCaptain 只给目录时也把会话登记进对应工作区", async () => {
  const controller = fakeController();
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster(),
    mode: "new",
    cwd: "/tmp/a/rosters/demo",
    workspaceRegistry: { list: () => [{ id: "ws-a", path: "/tmp/a" }] },
    sessionTitle: "probe",
  });

  assert.equal(result.ok, true);
  const create = controller.calls.find((call) => call[0] === "create");
  assert.deepEqual(create[1], { workspaceId: "ws-a" }, "目录能对上工作区时改发 workspaceId");
});

test("角色式队长：人设从角色正文解析，进入起始消息（真实样例）", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const rosterDir = nodePath.join(repoRoot, "examples/rosters/core-review");
  const controller = fakeController();
  const result = await applyCaptain({
    sessionController: controller,
    roster: {
      id: "core-review",
      title: "核心评审",
      file: "rosters/core-review/roster.yaml",
      rootDir: nodePath.join(repoRoot, "examples"),
      members: [],
      captain: { role: "core-review-lead-captain@1.0.0", provider: "deepseek", model: "deepseek-v4.1-flash" },
    },
    rosterDir,
    mode: "new",
    cwd: "/tmp/ws",
    sessionTitle: "core-review",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const prompt = controller.calls.find((call) => call[0] === "prompt")[1].content[0].text;
  assert.match(prompt, /派活前先复述目标与验收标准/);
});

test("应用队长：可以用面板选的模型覆盖档案里的 route", async () => {
  const controller = fakeController();
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster(),
    mode: "new",
    cwd: "/tmp/ws",
    model: { provider: "tsing", model: "deepseek-v4-pro" },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const selection = controller.calls.find((call) => call[0] === "selectModel");
  assert.deepEqual(selection?.[1], {
    sessionId: result.sessionId,
    provider: "tsing",
    model: "deepseek-v4-pro",
    // 档案的 reasoningEffort 仍沿用：覆盖的是"哪个模型"，不是"想多深"。
    reasoningEffort: "high",
  });
  assert.equal(result.model.provider, "tsing");
  assert.equal(result.model.model, "deepseek-v4-pro");
});

test("应用队长：没有覆盖时仍按档案的 route 选模型", async () => {
  const controller = fakeController();
  const result = await applyCaptain({ sessionController: controller, roster: roster(), mode: "new", cwd: "/tmp/ws" });
  assert.equal(result.ok, true);
  const selection = controller.calls.find((call) => call[0] === "selectModel");
  assert.equal(selection?.[1].provider, "tsingmicro");
  assert.equal(selection?.[1].model, "deepseek-v4.1-flash");
});

test("applyCaptain 把这次用的档案根交给注入层：配置里没有，也能按 path 挂上人设", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { installCaptainInjector, markCaptainCandidate, resetCaptainInjector } = await import("../lib/captain-inject.js");

  resetCaptainInjector();
  const lib = fs.mkdtempSync(nodePath.join(os.tmpdir(), "roster-apply-root-"));
  fs.mkdirSync(nodePath.join(lib, "rosters", "agent-teams"), { recursive: true });
  fs.writeFileSync(nodePath.join(lib, "rosters", "agent-teams", "lead.md"), "你是这支团队的队长。");
  fs.writeFileSync(
    nodePath.join(lib, "rosters", "agent-teams", "roster.yaml"),
    ["kind: dsh-agent-roster/roster@2", "roster: agent-teams", "version: 1.0.0", "members: []", "captain:", "  persona: lead.md"].join("\n"),
  );
  const ws = fs.mkdtempSync(nodePath.join(os.tmpdir(), "roster-apply-ws-"));
  fs.mkdirSync(nodePath.join(ws, ".agent-teams", "t1"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(ws, ".agent-teams", "t1", "team.json"),
    JSON.stringify({ id: "t1", name: "t1", phase: "ready", description: "roster:agent-teams@1.0.0#abcd1234", captainSessionId: "s-new", members: [], tasks: [] }),
  );

  const handlers = new Map();
  const dispose = installCaptainInjector(
    { on: (name, fn) => handlers.set(name, fn), off: () => {} },
    { agentTeamsStateDir: ".agent-teams" },
    { roots: () => [], watchIntervalMs: 5, watchTimeoutMs: 200 },
  );
  const sections = [];
  const agent = {
    id: "s-new",
    session: { header: { cwd: ws } },
    ctx: {
      systemPrompt: {
        section(section) {
          sections.push(section);
          return () => {};
        },
        getSectionOrder: () => 0,
      },
    },
  };

  const controller = fakeController({
    async create() {
      return { sessionId: "s-new" };
    },
    async rename() {
      return { title: "t" };
    },
    async selectModel(selection) {
      return { selected: { provider: "tsing", model: "deepseek-v4.1-flash", reasoningEffort: "" } };
    },
    async prompt() {},
  });
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster({ captain: { provider: "tsing", model: "deepseek-v4.1-flash" } }),
    rosterDir: nodePath.join(lib, "rosters", "agent-teams"),
    mode: "new",
    cwd: ws,
  });
  assert.equal(result.ok, true);
  assert.equal(result.rosterRoot, lib);
  // 注入层只认配置根（这里是空的）；候选根来自 apply 传的 path。
  handlers.get("agent/created")({ agent });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sections.length, 1);
  assert.equal(sections[0].text(), "你是这支团队的队长。");
  dispose();
  resetCaptainInjector();
  markCaptainCandidate("s-new");
});

test("buildCaptainPrompt：空间登记的知识只给指针，不把正文塞进提示词", () => {
  const text = buildCaptainPrompt({
    roster: roster(),
    teamName: "demo",
    knowledge: [
      { path: "knowledge/guide.md", abs: "/tmp/lib/knowledge/guide.md", sha: "a".repeat(64), title: "项目指南" },
      { path: "knowledge/plain.md", abs: "/tmp/lib/knowledge/plain.md", sha: "", title: "" },
    ],
  });
  assert.match(text, /项目知识（这里只给概要，正文按需打开对应路径/);
  assert.match(text, /- 项目指南（\/tmp\/lib\/knowledge\/guide\.md）/);
  assert.match(text, /- plain（\/tmp\/lib\/knowledge\/plain\.md）\n/);
  assert.ok(!text.includes("这是项目指南正文"), "知识正文不该被贴进提示词");
});

test("库根传进来时不要再往上走一层：注入层与档案在同一座库里", async () => {
  const lib = fs.mkdtempSync(nodePath.join(os.tmpdir(), "apply-root-"));
  const ws = fs.mkdtempSync(nodePath.join(os.tmpdir(), "apply-root-ws-"));
  fs.mkdirSync(nodePath.join(lib, "roles", "lead-captain"), { recursive: true });
  fs.mkdirSync(nodePath.join(lib, "rosters", "agent-teams"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(lib, "rosters", "agent-teams", "roster.yaml"),
    JSON.stringify(
      {
        kind: "dsh-agent-roster/roster@2",
        roster: "agent-teams",
        version: "1.0.0",
        members: [{ as: "lead", role: "lead-captain@1.0.0" }],
        captain: { role: "lead-captain@1.0.0" },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    nodePath.join(lib, "roles", "lead-captain", "AGENT.md"),
    "---\nname: lead-captain\nrole: 队长\n---\n你是这支团队的队长。\n",
  );

  const controller = fakeController({
    async create() {
      return { sessionId: "s-lib" };
    },
    async rename() {
      return { title: "t" };
    },
    async selectModel() {
      return { selected: { provider: "tsing", model: "deepseek-v4.1-flash", reasoningEffort: "" } };
    },
    async prompt() {},
  });
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster({ captain: { provider: "tsing", model: "deepseek-v4.1-flash" } }),
    rosterDir: lib,
    mode: "new",
    cwd: ws,
  });
  assert.equal(result.ok, true);
  assert.equal(result.rosterRoot, lib, "库根不能被当成档案目录再取一次父目录");
  fs.rmSync(lib, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});
