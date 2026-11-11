import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPTAIN_SECTION,
  attachCaptainPersona,
  attachedCaptain,
  captainMiss,
  captainTeamOf,
  findRosterDir,
  forgetCaptain,
  installCaptainInjector,
  isCaptainCandidate,
  markCaptainCandidate,
  personaSourceOf,
  personaTextOf,
  resolveCaptainPersona,
  resetCaptainInjector,
  writeSessionBinding,
  readSessionBinding,
  findSessionBinding,
  bindingPath,
  BINDING_KIND,
} from "../lib/captain-inject.js";

function tempRoot() {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), "roster-inject-"));
}

function write(file, text) {
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** 造一个 v2 库：`<lib>/rosters/demo/roster.yaml` + 人设文件。 */
function makeLibrary(lib, { persona = "你是这支团队的队长。", extra = "" } = {}) {
  if (persona === null) {
    write(
      nodePath.join(lib, "rosters", "demo", "roster.yaml"),
      ["kind: dsh-agent-roster/roster@2", "roster: demo", "version: 1.0.0", "members: []", extra].join("\n"),
    );
    return lib;
  }
  write(nodePath.join(lib, "rosters", "demo", "persona", "lead.md"), persona);
  write(
    nodePath.join(lib, "rosters", "demo", "roster.yaml"),
    ["kind: dsh-agent-roster/roster@2", "roster: demo", "version: 1.0.0", "members: []", "captain:", "  persona: persona/lead.md", extra].join("\n"),
  );
  return lib;
}

/** 造一个团队：`<ws>/.agent-teams/<team>/team.json`。 */
function makeTeam(ws, { teamId = "t1", sessionId = "session-1", rosterId = "demo" } = {}) {
  const file = nodePath.join(ws, ".agent-teams", teamId, "team.json");
  write(
    file,
    JSON.stringify({
      id: teamId,
      name: teamId,
      description: `roster:${rosterId}@1.0.0#abcd1234`,
      captainSessionId: sessionId,
      members: [],
    }),
  );
  return file;
}

/** 假 agent：只提供注入层真正用到的两处（id、ctx.systemPrompt、session.header.cwd）。 */
function fakeAgent(cwd, sessionId = "session-1") {
  const sections = [];
  return {
    id: sessionId,
    session: { header: { cwd } },
    ctx: {
      systemPrompt: {
        section(section) {
          sections.push(section);
          return () => {
            sections.splice(sections.indexOf(section), 1);
          };
        },
        getSectionOrder(name) {
          assert.equal(name, "DEPLOYMENT_PERSONA_PREFIX");
          return 0;
        },
      },
    },
    sections,
  };
}

test("personaSourceOf：v2 的 captain.persona 解析成文件；v1 的内联正文原样返回", () => {
  const lib = tempRoot();
  makeLibrary(lib);
  const source = personaSourceOf(nodePath.join(lib, "rosters", "demo"));
  assert.equal(source.kind, "file");
  assert.equal(personaTextOf(source), "你是这支团队的队长。");

  const v1 = tempRoot();
  write(
    nodePath.join(v1, "flat", "roster.yaml"),
    ["name: flat", "version: 1.0.0", "captain:", "  systemPrompt: |", "    你是队长，先要结论。", "members: []"].join("\n"),
  );
  const inline = personaSourceOf(nodePath.join(v1, "flat"));
  assert.equal(inline.kind, "inline");
  assert.equal(personaTextOf(inline), "你是队长，先要结论。");
});

test("captain.prompt：prepend/append 与成员同一套语义，且每步重读", () => {
  const lib = tempRoot();
  write(nodePath.join(lib, "rosters", "demo", "persona", "lead.md"), "正文：先要结论。");
  write(nodePath.join(lib, "rosters", "demo", "parts", "head.md"), "开头：你是研究队的队长。");
  write(nodePath.join(lib, "rosters", "demo", "parts", "tail.md"), "结尾：每次汇报带证据。");
  write(
    nodePath.join(lib, "rosters", "demo", "roster.yaml"),
    [
      "kind: dsh-agent-roster/roster@2",
      "roster: demo",
      "version: 1.0.0",
      "members: []",
      "captain:",
      "  persona: persona/lead.md",
      "  prompt:",
      "    prepend: parts/head.md",
      "    append: parts/tail.md",
    ].join("\n"),
  );
  const dir = nodePath.join(lib, "rosters", "demo");
  const source = personaSourceOf(dir);
  assert.equal(source.kind, "file");
  assert.equal(personaTextOf(source), "开头：你是研究队的队长。\n\n正文：先要结论。\n\n结尾：每次汇报带证据。");

  // 每步重读：改了 prepend 文件，下一次读到的就是新文本。
  write(nodePath.join(lib, "rosters", "demo", "parts", "head.md"), "开头：你是产品队的队长。");
  assert.match(personaTextOf(source), /^开头：你是产品队的队长。/);
});

test("personaSourceOf：越界的人设路径不算数，没有 captain 也不硬造", () => {
  const lib = tempRoot();
  write(
    nodePath.join(lib, "rosters", "demo", "roster.yaml"),
    ["name: demo", "version: 1.0.0", "captain:", "  persona: ../../etc/passwd", "members: []"].join("\n"),
  );
  assert.equal(personaSourceOf(nodePath.join(lib, "rosters", "demo")), null);

  const empty = tempRoot();
  write(nodePath.join(empty, "rosters", "plain", "roster.yaml"), ["name: plain", "version: 1.0.0", "members: []"].join("\n"));
  assert.equal(personaSourceOf(nodePath.join(empty, "rosters", "plain")), null);
});

test("findRosterDir 与 captainTeamOf：两种布局都能找到，按 captainSessionId 归属", () => {
  const lib = tempRoot();
  makeLibrary(lib);
  assert.equal(findRosterDir([{ rootDir: lib, exists: true }], "demo"), nodePath.join(lib, "rosters", "demo"));
  assert.equal(findRosterDir([{ rootDir: lib, exists: true }], "../demo"), null);

  const ws = tempRoot();
  makeTeam(ws, { sessionId: "session-9" });
  const stateDir = nodePath.join(ws, ".agent-teams");
  assert.deepEqual(captainTeamOf(stateDir, "session-9"), { teamId: "t1", rosterId: "demo", version: "1.0.0" });
  assert.equal(captainTeamOf(stateDir, "session-other"), null);
});

test("attachCaptainPersona：注册与成员侧同名的 section，每次求值重读文件", () => {
  resetCaptainInjector();
  const lib = tempRoot();
  makeLibrary(lib);
  const ws = tempRoot();
  makeTeam(ws);
  const agent = fakeAgent(ws);

  const logs = [];
  const ok = attachCaptainPersona(agent, {
    stateDir: nodePath.join(ws, ".agent-teams"),
    roots: [{ rootDir: lib, exists: true }],
    logger: { info: (line) => logs.push(line) },
  });
  assert.equal(ok, true);
  assert.equal(agent.sections.length, 1);
  assert.equal(agent.sections[0].name, CAPTAIN_SECTION);
  assert.equal(agent.sections[0].order, 0);
  assert.equal(agent.sections[0].text(), "你是这支团队的队长。");

  // 改档案立即生效：函数式 text 每个模型步都会重读。
  fs.writeFileSync(nodePath.join(lib, "rosters", "demo", "persona", "lead.md"), "你是新队长。");
  assert.equal(agent.sections[0].text(), "你是新队长。");

  // 文件被删：沿用上一次的好值，不用空串遮蔽部署 persona。
  fs.rmSync(nodePath.join(lib, "rosters", "demo", "persona", "lead.md"));
  assert.equal(agent.sections[0].text(), "你是新队长。");

  assert.equal(logs.length, 1);
  assert.match(logs[0], /attached: session=session-1 roster=demo chars=10 sha=[0-9a-f]{8} source=file/);

  const record = attachedCaptain("session-1");
  assert.equal(record.rosterId, "demo");
  assert.equal(record.source, "file");
  assert.equal(record.chars, "你是这支团队的队长。".length);
  forgetCaptain("session-1");
  assert.equal(attachedCaptain("session-1"), null);
  resetCaptainInjector();
});

test("attachCaptainPersona：没有团队 / 没有人设 / 没有 section 服务时不注册", () => {
  resetCaptainInjector();
  const lib = tempRoot();
  makeLibrary(lib, { persona: null });
  const ws = tempRoot();
  const agent = fakeAgent(ws);

  // 团队还没建：不注册（注册即遮蔽，不能抢跑）。
  assert.equal(attachCaptainPersona(agent, { stateDir: nodePath.join(ws, ".agent-teams"), roots: [{ rootDir: lib }] }), false);
  assert.equal(agent.sections.length, 0);

  // 团队有了，但档案没有 captain.persona：同样不注册。
  makeTeam(ws);
  assert.equal(attachCaptainPersona(agent, { stateDir: nodePath.join(ws, ".agent-teams"), roots: [{ rootDir: lib }] }), false);
  assert.equal(agent.sections.length, 0);

  // 没有 systemPrompt 服务（最小宿主）：不崩、不注册。
  const bare = { id: "session-2", session: { header: { cwd: ws } }, ctx: {} };
  assert.equal(attachCaptainPersona(bare, { stateDir: nodePath.join(ws, ".agent-teams"), roots: [{ rootDir: lib }] }), false);
  resetCaptainInjector();
});

test("会话绑定：写盘、读回，并能按库根找到（重启后靠它重挂）", () => {
  const lib = tempRoot();
  makeLibrary(lib);
  const rosterDir = nodePath.join(lib, "rosters", "demo");
  const written = writeSessionBinding(lib, {
    sessionId: "session-9",
    rosterId: "demo",
    version: "1.0.0",
    rosterDir,
  });
  assert.equal(written.ok, true);
  assert.equal(fs.existsSync(bindingPath(lib, "session-9")), true);

  const binding = readSessionBinding(lib, "session-9");
  assert.equal(binding.kind, BINDING_KIND);
  assert.equal(binding.rosterDir, rosterDir);

  const found = findSessionBinding([{ rootDir: lib }], "session-9");
  assert.equal(found.rootDir, lib);
  assert.equal(found.binding.rosterId, "demo");
  assert.equal(findSessionBinding([{ rootDir: tempRoot() }], "session-9"), null);
});

test("已有会话建团：mark 时把 live agent 交给注入层，团队已在就立刻挂上", () => {
  resetCaptainInjector();
  const lib = tempRoot();
  makeLibrary(lib);
  const ws = tempRoot();
  makeTeam(ws); // 团队记录已经落盘（已有会话建团的情形）
  const agent = fakeAgent(ws);

  const handlers = new Map();
  const ctx = {
    on(name, fn) {
      handlers.set(name, fn);
    },
    off(name, fn) {
      if (handlers.get(name) === fn) handlers.delete(name);
    },
  };
  const dispose = installCaptainInjector(ctx, { agentTeamsStateDir: ".agent-teams" }, {
    roots: () => [{ rootDir: lib, exists: true }],
  });
  markCaptainCandidate("session-1", { rosterRoot: lib, agent });
  assert.equal(agent.sections.length, 1, "不会再等到一次 agent/created");
  assert.equal(attachedCaptain("session-1").rosterId, "demo");
  dispose();
  resetCaptainInjector();
});

test("installCaptainInjector：没有团队记录时，按会话绑定在 agent/created 重挂", () => {
  resetCaptainInjector();
  const lib = tempRoot();
  makeLibrary(lib);
  const ws = tempRoot();
  writeSessionBinding(lib, {
    sessionId: "session-1",
    rosterId: "demo",
    version: "1.0.0",
    rosterDir: nodePath.join(lib, "rosters", "demo"),
  });
  const agent = fakeAgent(ws);

  const handlers = new Map();
  const ctx = {
    on(name, fn) {
      handlers.set(name, fn);
    },
    off(name, fn) {
      if (handlers.get(name) === fn) handlers.delete(name);
    },
  };
  const dispose = installCaptainInjector(ctx, { agentTeamsStateDir: ".agent-teams" }, {
    roots: () => [{ rootDir: lib, exists: true }],
  });
  handlers.get("agent/created")({ agent });
  assert.equal(agent.sections.length, 1, "没有 team.json 也要按绑定挂上");
  assert.equal(attachedCaptain("session-1").rosterId, "demo");
  dispose();
  resetCaptainInjector();
});

test("installCaptainInjector：团队晚落盘也能挂上，agent 销毁后清掉", async () => {
  resetCaptainInjector();
  const lib = tempRoot();
  makeLibrary(lib);
  const ws = tempRoot();
  const agent = fakeAgent(ws);

  const handlers = new Map();
  const ctx = {
    on(name, fn) {
      handlers.set(name, fn);
    },
    off(name, fn) {
      if (handlers.get(name) === fn) handlers.delete(name);
    },
  };
  const dispose = installCaptainInjector(ctx, { agentTeamsStateDir: ".agent-teams" }, {
    roots: () => [{ rootDir: lib, exists: true }],
    watchIntervalMs: 5,
    watchTimeoutMs: 1_000,
  });

  // 真实调用方（applyCaptain）建完会话就登记；否则注入层不会为一个子会话排队。
  markCaptainCandidate("session-1");
  handlers.get("agent/created")({ agent });
  assert.equal(agent.sections.length, 0, "建会话时团队还不存在");

  await new Promise((resolve) => setTimeout(resolve, 20));
  makeTeam(ws);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(agent.sections.length, 1, "团队落盘后应自动挂上");
  assert.equal(attachedCaptain("session-1").rosterId, "demo");

  handlers.get("agent/disposed")({ agent });
  assert.equal(attachedCaptain("session-1"), null);
  dispose();
  resetCaptainInjector();
});

test("installCaptainInjector：没登记过的会话（子会话）不排队", async () => {
  resetCaptainInjector();
  const lib = tempRoot();
  makeLibrary(lib);
  const ws = tempRoot();
  const agent = fakeAgent(ws, "session-child");

  const handlers = new Map();
  const ctx = {
    on(name, fn) {
      handlers.set(name, fn);
    },
    off() {},
  };
  const dispose = installCaptainInjector(ctx, { agentTeamsStateDir: ".agent-teams" }, {
    roots: () => [{ rootDir: lib, exists: true }],
    watchIntervalMs: 5,
    watchTimeoutMs: 200,
  });
  assert.equal(isCaptainCandidate("session-child"), false);
  handlers.get("agent/created")({ agent });
  makeTeam(ws, { sessionId: "session-child" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(agent.sections.length, 0, "没登记就不该为它起轮询");
  dispose();
  resetCaptainInjector();
});

test("installCaptainInjector：先有 agent/created 后登记，也能补挂（applyCaptain 的真实顺序）", async () => {
  resetCaptainInjector();
  const lib = tempRoot();
  makeLibrary(lib);
  const ws = tempRoot();
  const agent = fakeAgent(ws, "session-late-mark");

  const handlers = new Map();
  const ctx = {
    on(name, fn) {
      handlers.set(name, fn);
    },
    off() {},
  };
  const dispose = installCaptainInjector(ctx, { agentTeamsStateDir: ".agent-teams" }, {
    roots: () => [{ rootDir: lib, exists: true }],
    watchIntervalMs: 5,
    watchTimeoutMs: 1_000,
  });

  handlers.get("agent/created")({ agent });
  assert.equal(agent.sections.length, 0);
  // 宿主在建会话的调用内部就发了事件；登记发生在 create 返回之后。
  markCaptainCandidate("session-late-mark");
  await new Promise((resolve) => setTimeout(resolve, 20));
  makeTeam(ws, { sessionId: "session-late-mark" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(agent.sections.length, 1);
  assert.equal(agent.sections[0].text(), "你是这支团队的队长。");
  dispose();
  resetCaptainInjector();
});

test("personaSourceOf：真实样例里队长是角色引用，人设取角色组装正文", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const rosterDir = nodePath.join(repoRoot, "examples/rosters/core-review");
  const source = personaSourceOf(rosterDir);
  assert.equal(source?.kind, "role");
  // 角色正文要按同一套规则展开（body + parts + {{> …}}），与成员读到的同一份。
  assert.match(personaTextOf(source), /派活前先复述目标与验收标准/);
  // 起始消息与注入层同源：解析函数给出同一段正文。
  assert.equal(resolveCaptainPersona(rosterDir)?.text, personaTextOf(source));
});

test("候选根：建会话时传的库不在 rosterDirs 里，也能挂上（roster_team --path 的真实用法）", async () => {
  resetCaptainInjector();
  const lib = tempRoot();
  makeLibrary(lib);
  const ws = tempRoot();
  const agent = fakeAgent(ws, "session-path-root");

  const handlers = new Map();
  const ctx = {
    on(name, fn) {
      handlers.set(name, fn);
    },
    off() {},
  };
  // 配置根是空的：过去这里必然静默跳过。
  const dispose = installCaptainInjector(ctx, { agentTeamsStateDir: ".agent-teams" }, {
    roots: () => [],
    watchIntervalMs: 5,
    watchTimeoutMs: 1_000,
  });

  handlers.get("agent/created")({ agent });
  assert.equal(agent.sections.length, 0);
  markCaptainCandidate("session-path-root", { rosterRoot: lib });
  makeTeam(ws, { sessionId: "session-path-root" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(agent.sections.length, 1);
  assert.equal(agent.sections[0].text(), "你是这支团队的队长。");
  dispose();
  resetCaptainInjector();
});

test("找不到档案根：记下原因并列搜过的根，只 warn 一次（不再静默）", () => {
  resetCaptainInjector();
  const ws = tempRoot();
  makeTeam(ws, { sessionId: "session-miss" });
  const agent = fakeAgent(ws, "session-miss");
  const warnings = [];
  const logger = { warn: (line) => warnings.push(line), info: () => {} };
  const roots = [{ rootDir: "/nonexistent-roster-root", exists: true }];

  assert.equal(attachCaptainPersona(agent, { stateDir: nodePath.join(ws, ".agent-teams"), roots, logger }), false);
  assert.equal(attachCaptainPersona(agent, { stateDir: nodePath.join(ws, ".agent-teams"), roots, logger }), false);
  const miss = captainMiss("session-miss");
  assert.equal(miss.reason, "roster-not-found");
  assert.equal(miss.rosterId, "demo");
  assert.deepEqual(miss.roots, ["/nonexistent-roster-root"]);
  assert.equal(warnings.length, 1, "轮询重试不该刷日志");
  assert.match(warnings[0], /roster "demo" not found in roots \[\/nonexistent-roster-root\]/);
  resetCaptainInjector();
});
