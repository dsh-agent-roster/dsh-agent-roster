/**
 * 工具层契约测试。
 *
 * 这里锁的是两件在真机上翻过车的事：
 * 1. 模型读到的是 `render()` 产出的文本，不是返回对象——所以每个工具的首行必须是
 *    可解析的 `k=v` 状态行，否则"成功没有"只能靠中文措辞去猜。
 * 2. 返回值必须能无损往返 JSON，否则运行时会整次拒绝（`value is not lossless JSON`）。
 *
 * 依赖 `@deepseek-ai/dsh-tools`（devDependency）提供真实的 `defineTool`；
 * 版本与宿主未必一致，所以这里只断言形状契约，不断言宿主内部行为。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { isLossless } from "../lib/json.js";
import { registerRosterTools } from "../lib/tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examples = path.join(root, "examples");

/** 用最小的假 ctx 注册工具，返回 name → tool 的映射。 */
function register(overrides = {}) {
  const { services = {}, ...config } = overrides;
  const tools = new Map();
  const disposers = [];
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    effect(fn) {
      disposers.push(fn());
    },
    get(name) {
      return services[name];
    },
  };
  registerRosterTools(ctx, { rosterDirs: ["rosters"], knownToolPolicies: [], agentTeamsStateDir: ".agent-teams", ...config }, { version: "0.1.0" });
  return { tools, disposers };
}

const exec = { agent: { session: { header: { cwd: root } } } };

/** 调一次工具，返回返回值与首行文本；顺带断言无损与渲染形状。 */
async function call(tools, name, args) {
  const tool = tools.get(name);
  assert.ok(tool, `未注册 ${name}`);
  const value = await tool.execute(args, exec);

  const losslessCheck = isLossless(value);
  assert.equal(losslessCheck.ok, true, `${name} 返回值不可无损往返：${losslessCheck.reason}`);

  const blocks = tool.output.render(args, value);
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} 必须渲染出内容块`);
  assert.equal(typeof blocks[0].text, "string");
  const firstLine = blocks[0].text.split("\n")[0];
  assert.match(firstLine, new RegExp(`^\\[${name}\\] `), `${name} 首行应是 [${name}] 状态行，实际：${firstLine}`);
  return { value, firstLine, text: blocks[0].text };
}

test("注册十三个工具，旧的六个能在 examples 上执行", async () => {
  const { tools } = register();
  assert.deepEqual([...tools.keys()].sort(), [
    "roster_capture",
    "roster_changes",
    "roster_compile",
    "roster_create",
    "roster_diff",
    "roster_index",
    "roster_iterate",
    "roster_list",
    "roster_search",
    "roster_show",
    "roster_space",
    "roster_team",
    "roster_verify",
  ]);

  const list = await call(tools, "roster_list", { path: examples });
  assert.match(list.firstLine, /total=2/);
  assert.match(list.firstLine, /ok=2/);

  const show = await call(tools, "roster_show", { ref: "core-review", path: examples });
  assert.match(show.firstLine, /found=true/);
  assert.match(show.firstLine, /members=3/);

  const create = await call(tools, "roster_create", { ref: "research", path: examples });
  assert.match(create.firstLine, /ok=true/);
  assert.match(create.firstLine, /calls=2/);
  // v2 库里的档案也要拿得到内容哈希：少了 #sha，团队溯源只能对到"哪一版"，对不到"哪一份"。
  assert.match(create.value.text, /roster:research@\d+\.\d+\.\d+#[0-9a-f]{8}/);

  const verify = await call(tools, "roster_verify", { path: examples, stateDir: path.join(root, "test", "no-such-state") });
  assert.match(verify.firstLine, /state=unavailable/);
  assert.match(verify.firstLine, /missing=5/);
});

test("新工具：空间、搜索、编译预览、更新检查、建团队", async () => {
  const { tools } = register();

  const space = await call(tools, "roster_space", { path: examples });
  assert.match(space.firstLine, /space=examples/);
  assert.match(space.firstLine, /layout=monorepo/);
  assert.equal(space.value.missing.length, 0);

  const found = await call(tools, "roster_search", { query: "review", path: examples, remote: false });
  assert.match(found.firstLine, /hits=\d+/);
  assert.ok(Array.isArray(found.value.results));

  const preview = await call(tools, "roster_compile", { ref: "core-review", path: examples });
  assert.match(preview.firstLine, /id=core-review/);
  assert.equal(preview.value.ok, true);

  const changes = await call(tools, "roster_changes", { path: examples, refresh: false });
  assert.match(changes.firstLine, /ok=false|ok=true/);

  // 没有 sessionController 时如实报 unavailable，而不是假装建了团队。
  const team = await call(tools, "roster_team", { id: "core-review", path: examples });
  assert.equal(team.value.ok, false);
  assert.match(team.firstLine, /ok=false/);

  // existing 模式缺 sessionId 时先拦住，不去碰 sessionController。
  const noSession = await call(tools, "roster_team", { id: "core-review", mode: "existing", path: examples });
  assert.equal(noSession.value.code, "missing-session");

  // 索引：collection 上要能看出本机有没有对应副本（这里没拉过，就是 false）。
  const index = await call(tools, "roster_index", {});
  assert.equal(index.value.collections.length > 0, true);
  assert.equal(index.value.collections[0].pulled.present, false);
});

test("roster_team：引擎与模型入参都透传，未知模型先拦", async () => {
  const calls = [];
  const sessionController = {
    async create(request) {
      calls.push(["create", request]);
      return { sessionId: "session-test" };
    },
    async rename(request) {
      calls.push(["rename", request]);
      return { title: request.title };
    },
    async selectModel(request) {
      calls.push(["selectModel", request]);
      return { selected: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort ?? "" } };
    },
    async prompt(request, signal) {
      signal.throwIfAborted();
      calls.push(["prompt", request]);
      return {};
    },
    async list() {
      return { items: [] };
    },
  };
  const llm = {
    listProviders: () => [{ id: "tsing", displayName: "Tsing" }],
    listModels: async () => [{ id: "deepseek-v4.1-flash", name: "flash" }],
  };
  const workspaceRegistry = { list: () => [{ id: "ws-1", path: root, title: "示例" }] };
  const { tools } = register({ services: { sessionController, llm, workspaceRegistry } });

  const ok = await call(tools, "roster_team", {
    id: "core-review",
    path: examples,
    target: "agent-teams",
    model: { provider: "tsing", model: "deepseek-v4.1-flash" },
    sessionName: "probe-team",
  });
  assert.equal(ok.value.ok, true);
  assert.equal(ok.value.target, "agent-teams");
  assert.match(ok.value.text, /团队引擎：agent-teams/);
  assert.match(ok.value.text, /队长模型：tsing\/deepseek-v4\.1-flash/);
  // 注入根必须是传进来的 path，而不是它的上一层：早先这里记成 cwd，注入层静默失配。
  assert.equal(ok.value.rosterRoot, path.resolve(examples));
  const selection = calls.find((entry) => entry[0] === "selectModel");
  assert.ok(selection, "必须真的切模型");
  assert.equal(selection[1].provider, "tsing");
  assert.equal(selection[1].model, "deepseek-v4.1-flash");

  const bad = await call(tools, "roster_team", {
    id: "core-review",
    path: examples,
    model: { provider: "tsing", model: "no-such-model" },
  });
  assert.equal(bad.value.ok, false);
  assert.equal(bad.value.code, "model-unavailable");
  assert.match(bad.value.text, /本部署不服务 tsing\/no-such-model/);
});

test("找不到档案时也是同一套状态行，而不是自由文本", async () => {
  const { tools } = register();
  const show = await call(tools, "roster_show", { ref: "no-such-roster", path: examples });
  assert.equal(show.value.found, false);
  assert.match(show.firstLine, /found=false/);

  const create = await call(tools, "roster_create", { ref: "no-such-roster", path: examples });
  assert.equal(create.value.ok, false);
  assert.match(create.firstLine, /ok=false/);
});

test("显式 path 覆盖配置目录（真机回归点）", async () => {
  const { tools } = register();
  const byDefault = await call(tools, "roster_list", {});
  assert.equal(byDefault.value.rootDir, path.resolve(root, "rosters"), "默认应走配置的 rosters");

  const overridden = await call(tools, "roster_list", { path: examples });
  assert.equal(overridden.value.rootDir, path.resolve(examples));
  assert.match(overridden.firstLine, /total=2/);
});

test("释放后不残留工具", () => {
  const { tools, disposers } = register();
  assert.equal(tools.size, 13);
  for (const dispose of disposers) dispose();
  assert.equal(tools.size, 0);
});

test("roster_index 能真的跑起来：工具体里引用的函数都 import 了", async () => {
  // 这条针对 0.10.2 的事故：execute() 里用了 loadRemotePanel / fetchCollection，
  // 文件顶部却没 import，模块加载期不报错，一调用就 ReferenceError。
  const { tools } = register({ indexes: false });
  const { value, firstLine } = await call(tools, "roster_index", {});
  assert.match(firstLine, /^\[roster_index\] /);
  assert.deepEqual(value.collections, []);
  assert.deepEqual(value.indexes, []);
});

test("队长核对：会话实际模型与档案声明不一致时，如实报 differ（不拿部署默认值冒充）", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "dsh-captain-session-"));
  mkdirSync(path.join(stateDir, "demo"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "demo", "team.json"),
    JSON.stringify(
      {
        id: "demo",
        name: "demo",
        phase: "ready",
        description: "roster:core-review@1.2.0",
        captainSessionId: "session-1",
        members: [],
        tasks: [],
      },
      null,
      2,
    ),
  );
  const services = {
    sessionController: {
      async list() {
        return {
          items: [
            {
              sessionId: "session-1",
              origin: "main",
              cwd: root,
              updatedAt: 1,
              running: false,
              blank: false,
              projections: {
                values: {
                  modelSelection: {
                    lastUsed: { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "high" },
                  },
                },
              },
            },
          ],
        };
      },
    },
  };
  const { tools } = register({ services });
  const { value } = await call(tools, "roster_verify", { ref: "core-review", path: examples, stateDir });
  const captain = value.captain.find((item) => item.rosterId === "core-review");
  assert.ok(captain !== undefined);
  const model = captain.checks.find((item) => item.field === "session.model");
  assert.equal(model.status, "differ");
  assert.equal(model.declared, "deepseek-flash");
  assert.equal(model.actual, "deepseek-v4-pro");
});

test("roster_verify：空库且没给 path 时，提示改用 path=", async () => {
  const { tools } = register();
  const { text } = await call(tools, "roster_verify", { ref: "money-lab" });
  assert.match(text, /没有档案或成员叫 "money-lab"/);
  assert.match(text, /path=/);
});

test("roster_verify：没注入时说出真实原因（找不到档案根），不再把所有情况都算成“会话太老”", async () => {
  const { installCaptainInjector, markCaptainCandidate, resetCaptainInjector } = await import("../lib/captain-inject.js");
  resetCaptainInjector();
  const stateDir = mkdtempSync(path.join(tmpdir(), "dsh-captain-miss-"));
  mkdirSync(path.join(stateDir, "demo"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "demo", "team.json"),
    JSON.stringify(
      { id: "demo", name: "demo", phase: "ready", description: "roster:core-review@1.2.0", captainSessionId: "session-miss", members: [], tasks: [] },
      null,
      2,
    ),
  );
  const handlers = new Map();
  let dispose = () => {};
  try {
    // 注入层只认配置根，而这里配的是空的——正是用户踩到的形态。
    dispose = installCaptainInjector(
      { on: (name, fn) => handlers.set(name, fn), off: () => {} },
      { agentTeamsStateDir: stateDir },
      { roots: () => [], watchIntervalMs: 5, watchTimeoutMs: 50 },
    );
    markCaptainCandidate("session-miss", { rosterRoot: "" });
    handlers.get("agent/created")?.({
      agent: {
        id: "session-miss",
        session: { header: { cwd: root } },
        ctx: { systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 } },
      },
    });
    // 团队匹配要读会话列表；注入层的 miss 记录与它无关，但 verify 会先取会话。
    const { tools } = register({ services: { sessionController: { list: async () => ({ items: [] }) } } });
    const { text, value } = await call(tools, "roster_verify", { ref: "core-review", path: examples, stateDir });
    assert.match(text, /找不到档案目录/);
    const captain = value.captain.find((item) => item.rosterId === "core-review");
    assert.equal(captain.personaMiss.reason, "roster-not-found");
  } finally {
    dispose();
    resetCaptainInjector();
  }
});

test("roster_capture：把运行时差异算出来，默认不写回", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "capture-state-"));
  mkdirSync(path.join(stateDir, "demo"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "demo", "team.json"),
    JSON.stringify({
      id: "demo",
      name: "demo",
      phase: "running",
      description: "roster:core-review@1.0.0#abc12345",
      captainSessionId: "session-1",
      members: [
        { name: "lead", role: "core-review-lead@1.0.0", provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "high", executionPrompt: "runtime text" },
      ],
    }),
  );
  const { tools } = register();
  const { text, value } = await call(tools, "roster_capture", { id: "core-review", path: examples, stateDir });
  assert.match(text, /^\[roster_capture\] /);
  assert.match(text, /differ=1/);
  assert.match(text, /deepseek-v4-pro/);
  assert.match(text, /人设/);
  assert.ok(value.written === null || value.written.length === 0);
  assert.ok(value.summary.differ > 0);

  // 写回必须在副本上做：仓库里的 examples 是只读夹具。
  const lib = mkdtempSync(path.join(tmpdir(), "capture-lib-"));
  const { cpSync } = await import("node:fs");
  cpSync(examples, lib, { recursive: true });
  const applied = await call(tools, "roster_capture", { id: "core-review", path: lib, stateDir, apply: true });
  assert.match(applied.firstLine, /^\[roster_capture\] /);
  assert.ok(Array.isArray(applied.value.written.written) && applied.value.written.written.length > 0, applied.text);
});

test("roster_capture：默认把「可写回什么」问出来；设置打开后直接写回", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "capture-ask-"));
  mkdirSync(path.join(stateDir, "demo"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "demo", "team.json"),
    JSON.stringify({
      id: "demo",
      name: "demo",
      phase: "running",
      description: "roster:core-review@1.0.0#abc12345",
      captainSessionId: "session-1",
      members: [
        { name: "lead", role: "core-review-lead@1.0.0", provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "high", executionPrompt: "runtime text" },
      ],
    }),
  );
  const { cpSync } = await import("node:fs");
  const lib = mkdtempSync(path.join(tmpdir(), "capture-ask-lib-"));
  cpSync(examples, lib, { recursive: true });

  const { tools } = register();
  const asked = await call(tools, "roster_capture", { id: "core-review", path: lib, stateDir });
  assert.equal(asked.value.needsConfirmation, true);
  assert.ok(Array.isArray(asked.value.pending) && asked.value.pending.length > 0);
  assert.match(asked.text, /apply: true/);
  assert.match(asked.text, /captureAutoApply/);

  const auto = register({ captureAutoApply: true });
  const applied = await call(auto.tools, "roster_capture", { id: "core-review", path: lib, stateDir });
  assert.ok(applied.value.written.written.length > 0);
  assert.equal(applied.value.needsConfirmation, false);
  assert.match(applied.text, /captureAutoApply/);
});

test("roster_capture：remember:true 优先改配置，写不进配置就写库偏好", async () => {
  const { cpSync } = await import("node:fs");
  const stateDir = mkdtempSync(path.join(tmpdir(), "capture-remember-"));
  mkdirSync(path.join(stateDir, "demo"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "demo", "team.json"),
    JSON.stringify({
      id: "demo",
      name: "demo",
      phase: "running",
      description: "roster:core-review@1.0.0#abc12345",
      captainSessionId: "session-1",
      members: [
        { name: "lead", role: "core-review-lead@1.0.0", provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "high", executionPrompt: "runtime text" },
      ],
    }),
  );
  const edits = [];
  const configEditor = {
    entries: () => [{ id: "agent-roster", name: "@stofone/dsh-agent-roster" }],
    async edit(entry, change) {
      edits.push(change({}, {}));
    },
  };
  const libA = mkdtempSync(path.join(tmpdir(), "capture-remember-a-"));
  cpSync(examples, libA, { recursive: true });
  const withEditor = register({ services: { configEditor } });
  const saved = await call(withEditor.tools, "roster_capture", { id: "core-review", path: libA, stateDir, apply: true, remember: true });
  assert.equal(saved.value.remembered, "config");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].captureAutoApply, true);

  const libB = mkdtempSync(path.join(tmpdir(), "capture-remember-b-"));
  cpSync(examples, libB, { recursive: true });
  const noEditor = register();
  const fellBack = await call(noEditor.tools, "roster_capture", { id: "core-review", path: libB, stateDir, apply: true, remember: true });
  assert.equal(fellBack.value.remembered, "library");
  const prefs = JSON.parse(readFileSync(path.join(libB, ".dsh-roster-preferences.json"), "utf8"));
  assert.equal(prefs.captureAutoApply, true);
});

test("roster_iterate：有可写回差异时先问，不建会话；capture:false 才继续", async () => {
  const { cpSync } = await import("node:fs");
  const lib = mkdtempSync(path.join(tmpdir(), "iterate-ask-lib-"));
  const stateDir = mkdtempSync(path.join(tmpdir(), "iterate-ask-state-"));
  const ws = mkdtempSync(path.join(tmpdir(), "iterate-ask-ws-"));
  cpSync(examples, lib, { recursive: true });
  mkdirSync(path.join(stateDir, "old-team"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "old-team", "team.json"),
    JSON.stringify({
      id: "old-team",
      name: "old-team",
      phase: "running",
      description: "roster:core-review@1.0.0#abc12345",
      captainSessionId: "session-old",
      members: [
        { name: "lead", role: "core-review-lead@1.0.0", provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "high", executionPrompt: "runtime text" },
      ],
    }),
  );
  const calls = [];
  const sessionController = {
    async list() { return { items: [] }; },
    async create(request) { calls.push(["create", request]); return { sessionId: "session-new" }; },
    async rename(request) { calls.push(["rename", request]); return {}; },
    async selectModel(request) { calls.push(["selectModel", request]); return {}; },
    async prompt(request, signal) { signal.throwIfAborted(); calls.push(["prompt", request]); return {}; },
  };
  const { tools } = register({
    services: { sessionController, workspaceRegistry: { list: () => [{ id: "ws-1", path: ws, title: "ws" }] } },
    agentTeamsStateDir: stateDir,
  });

  const asked = await call(tools, "roster_iterate", { id: "core-review", path: lib, stateDir, sessionName: "next" });
  assert.equal(asked.value.needsConfirmation, true);
  assert.equal(asked.value.sessionId, null);
  assert.equal(calls.filter((item) => item[0] === "create").length, 0);
  assert.match(asked.text, /capture: true/);

  const skipped = await call(tools, "roster_iterate", { id: "core-review", path: lib, stateDir, sessionName: "next", capture: false });
  assert.equal(skipped.value.sessionId, "session-new");
  assert.equal(calls.filter((item) => item[0] === "create").length, 1);
});

test("roster_iterate：旧团队按溯源匹配，交接清单落盘并附进起始消息", async () => {
  const lib = mkdtempSync(path.join(tmpdir(), "iterate-lib-"));
  const stateDir = mkdtempSync(path.join(tmpdir(), "iterate-state-"));
  const ws = mkdtempSync(path.join(tmpdir(), "iterate-ws-"));
  const { cpSync } = await import("node:fs");
  cpSync(examples, lib, { recursive: true });
  mkdirSync(path.join(stateDir, "old-team"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "old-team", "team.json"),
    JSON.stringify({
      id: "old-team",
      name: "old-team",
      phase: "running",
      description: "roster:core-review@1.0.0#abc12345",
      captainSessionId: "session-old",
      members: [],
    }),
  );
  const calls = [];
  const sessionController = {
    async list() { return { items: [] }; },
    async create(request) { calls.push(["create", request]); return { sessionId: "session-new" }; },
    async rename(request) { calls.push(["rename", request]); return {}; },
    async selectModel(request) { calls.push(["selectModel", request]); return {}; },
    async prompt(request, signal) { signal.throwIfAborted(); calls.push(["prompt", request]); return {}; },
  };
  const { tools } = register({
    services: {
      sessionController,
      workspaceRegistry: { list: () => [{ id: "ws-1", path: ws, title: "ws" }] },
    },
    agentTeamsStateDir: stateDir,
  });
  const { text, value } = await call(tools, "roster_iterate", {
    id: "core-review",
    path: lib,
    stateDir,
    sessionName: "core-review-next",
    teamName: "core-review-next",
    handover: { steps: [{ kind: "note", detail: "先看一遍差异" }] },
  });
  assert.match(text, /^\[roster_iterate\] /);
  assert.match(text, /交接清单/);
  assert.equal(value.sessionId, "session-new");
  assert.ok(value.handover.file.endsWith(".json"));
  const promptCall = calls.find((item) => item[0] === "prompt");
  assert.match(promptCall[1].content[0].text, /交接清单/);
  assert.match(promptCall[1].content[0].text, /系统级迭代补充/);
});
