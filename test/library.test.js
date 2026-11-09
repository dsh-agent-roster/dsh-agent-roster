/**
 * 面板快照测试：工作区 × 档案库的展开、跨库同 id 冲突、以及"不假装知道工作区"。
 *
 * 这段逻辑只服务 UI，却决定了用户看到的东西是否与工具一致，所以用纯数据断言守着：
 * 不启动宿主、不连浏览器，只喂一个假的 ctx 与配置。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import { tmpdir } from "node:os";

import { collectLibrary, markDuplicateIds, serializeRoster } from "../lib/library.js";
import { globalRosterRoot } from "../lib/home.js";
import { makeLibrary, rosterDocument } from "./helpers.js";

/** 假 ctx：没有工作区注册表，走"退回进程工作目录"的分支。 */
const noWorkspaceCtx = { get: () => undefined };

/** 与 package.json 一致的插件元信息；测试只断言它被原样带进快照。 */
const META = { name: "@stofone/dsh-agent-roster", version: "0.1.0" };

/** 固定用假 ctx 与固定元信息采集快照，用例只关心配置。 */
function snapshot(config) {
  return collectLibrary(noWorkspaceCtx, config, META);
}

test("快照：绝对路径是全局库，不按工作区翻倍", () => {
  const first = makeLibrary({ "core-review/roster.json": rosterDocument() });
  const second = makeLibrary({
    "research/roster.json": rosterDocument({ roster: "research", title: "调研组" }),
  });
  try {
    const payload = snapshot({
      rosterDirs: [first.rootDir, second.rootDir],
      knownToolPolicies: null,
      agentTeamsStateDir: ".agent-teams",
    });
    assert.equal(payload.workspaces.length, 2, "两座全局库 = 两条报告，不随工作区数量变化");
    assert.equal(payload.plugin, "@stofone/dsh-agent-roster");
    assert.deepEqual(payload.rosterDirs, [first.rootDir, second.rootDir]);
    assert.equal(payload.workspaces[0].scope, "global");
    assert.equal(payload.workspaces[0].workspacePath, "");
    assert.equal(payload.workspaces[0].fallbackWorkspace, false);
    assert.equal(payload.workspaces[0].rosters[0].id, "core-review");
    assert.equal(payload.workspaces[1].rosters[0].id, "research");
    assert.equal(payload.workspaces[0].stats.ok, 1);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("快照：没配目录时用全局默认库 <DSH_HOME>/agent-roster", () => {
  const payload = snapshot({ knownToolPolicies: null, agentTeamsStateDir: ".agent-teams" });
  // 真实全局库里可能已经「拉取整个空间」过（<root>/<space-id>/），那是嵌套库，
  // 不该影响"默认根是哪一座"这条断言；这里只看不嵌套的那一条。
  const base = payload.workspaces.filter((workspace) => workspace.nested !== true);
  assert.equal(base.length, 1);
  assert.equal(payload.rosterDirs[0], "");
  assert.equal(base[0].scope, "global");
  assert.equal(base[0].rootDir, globalRosterRoot());
  assert.ok(
    payload.workspaces.every((workspace) => workspace.nested !== true || workspace.parentRootDir === globalRosterRoot()),
    "嵌套库必须把自己的父根写在报告里",
  );
});

test("快照：空目录不是错误，也不会有 error 级诊断", () => {
  const empty = makeLibrary({});
  try {
    const payload = snapshot({
      rosterDirs: [empty.rootDir],
      knownToolPolicies: null,
      agentTeamsStateDir: ".agent-teams",
    });
    const report = payload.workspaces[0];
    assert.deepEqual(report.rosters, []);
    assert.equal(report.stats.errors, 0);
    assert.equal(report.stats.ok, 0);
    assert.throws(
      () => assert.ok(report.diagnostics.some((item) => item.severity === "error")),
      "空档案库不该报错",
    );
  } finally {
    empty.cleanup();
  }
});

test("快照：目录根本不存在时零诊断，只标记 missing", () => {
  const missing = nodePath.join(tmpdir(), `dsh-agent-roster-absent-${Date.now()}`);
  const payload = snapshot({
    rosterDirs: [missing],
    knownToolPolicies: null,
    agentTeamsStateDir: ".agent-teams",
  });
  const report = payload.workspaces[0];
  assert.equal(report.missing, true);
  assert.deepEqual(report.diagnostics, [], "空库不该有任何诊断噪音");
  assert.equal(report.stats.errors, 0);
});

test("快照：跨库同 id 会在两份报告上各留一条警告，且不删档", () => {
  const first = makeLibrary({ "core-review/roster.json": rosterDocument() });
  const second = makeLibrary({ "core-review/roster.json": rosterDocument({ version: "9.9.9" }) });
  try {
    const payload = snapshot({
      rosterDirs: [first.rootDir, second.rootDir],
      knownToolPolicies: null,
      agentTeamsStateDir: ".agent-teams",
    });
    const [firstReport, secondReport] = payload.workspaces;
    // 冲突只在后来者上点名，先出现的库保持干净。
    assert.equal(firstReport.diagnostics.some((item) => item.code === "duplicate-roster-id"), false);
    const warning = secondReport.diagnostics.find((item) => item.code === "duplicate-roster-id");
    assert.ok(warning, "第二座库必须带冲突警告");
    assert.equal(warning.severity, "warn");
    assert.match(warning.reason, /重复/);
    // 两份档案都还在：插件不替用户删文件。
    assert.equal(firstReport.rosters.length, 1);
    assert.equal(secondReport.rosters.length, 1);
    assert.equal(secondReport.rosters[0].diagnostics.some((item) => item.code === "duplicate-roster-id"), true);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("markDuplicateIds：同一工作区不同 id 不误报", () => {
  const reports = [
    {
      workspacePath: "/ws",
      rootDir: "/ws/a",
      diagnostics: [],
      rosters: [{ id: "one", file: "one/roster.yaml", diagnostics: [] }],
    },
    {
      workspacePath: "/ws",
      rootDir: "/ws/b",
      diagnostics: [],
      rosters: [{ id: "two", file: "two/roster.yaml", diagnostics: [] }],
    },
  ];
  markDuplicateIds(reports);
  assert.deepEqual(reports[0].diagnostics, []);
  assert.deepEqual(reports[1].diagnostics, []);
});

test("serializeRoster：同目录诊断跟着档案走，别处的不带", () => {
  const scanDiagnostics = [
    { severity: "error", code: "invalid-name", file: "core-review/roster.yaml", path: "members[0].name", reason: "x" },
    { severity: "warn", code: "unexpected-file", file: "loose.yaml", path: "", reason: "y" },
  ];
  const roster = {
    id: "core-review",
    version: "1.0.0",
    title: "t",
    description: "d",
    file: "core-review/roster.yaml",
    tags: [],
    maintainers: [],
    defaults: {},
    members: [],
  };
  const projection = serializeRoster(roster, scanDiagnostics);
  assert.equal(projection.diagnostics.length, 1);
  assert.equal(projection.diagnostics[0].code, "invalid-name");
  assert.equal("systemPrompt" in projection.members, false);
});

test("serializeRoster：队长段进面板投影，建团才知道这份档案有队长", () => {
  const roster = {
    id: "core-review",
    version: "1.0.0",
    title: "t",
    description: "d",
    file: "rosters/core-review/roster.yaml",
    tags: [],
    maintainers: [],
    defaults: {},
    members: [],
    captain: {
      name: "core-review-lead-captain",
      roleRef: "core-review-lead-captain@1.0.0",
      description: "主会话即队长",
      provider: "deepseek",
      model: "deepseek-v4.1-flash",
      reasoningEffort: "high",
      personaPrefix: "派活前先复述目标",
    },
  };
  const projection = serializeRoster(roster, []);
  assert.deepEqual(projection.captain, {
    name: "core-review-lead-captain",
    roleRef: "core-review-lead-captain@1.0.0",
    description: "主会话即队长",
    provider: "deepseek",
    model: "deepseek-v4.1-flash",
    reasoningEffort: "high",
    personaPrefix: "派活前先复述目标",
    personaChars: 8,
  });
  assert.equal(serializeRoster({ ...roster, captain: null }, []).captain, null);
  assert.equal(serializeRoster({ ...roster, captain: undefined }, []).captain, null);
});

test("快照：库根下挂着的空间（拉取整个空间的结果）会被单独展开", () => {
  const rootDir = mkdtempSync(nodePath.join(tmpdir(), "dsh-nested-"));
  try {
    const spaceDir = nodePath.join(rootDir, "alpha");
    mkdirSync(nodePath.join(spaceDir, "demo"), { recursive: true });
    writeFileSync(
      nodePath.join(spaceDir, "space.yaml"),
      ["kind: dsh-agent-roster/space@1", "space: alpha", "layout: flat", "rosters:", "  - id: demo", ""].join("\n"),
      "utf8",
    );
    writeFileSync(nodePath.join(spaceDir, "demo", "roster.json"), JSON.stringify(rosterDocument({ roster: "demo" })), "utf8");

    const payload = snapshot({ rosterDirs: [rootDir], knownToolPolicies: null, agentTeamsStateDir: ".agent-teams" });
    const base = payload.workspaces.filter((workspace) => workspace.nested !== true);
    const nested = payload.workspaces.filter((workspace) => workspace.nested === true);
    assert.equal(base.length, 1);
    assert.deepEqual(base[0].rosters, [], "库根本身没有档案");
    assert.equal(nested.length, 1);
    assert.equal(nested[0].rootDir, spaceDir);
    assert.equal(nested[0].parentRootDir, rootDir);
    assert.equal(nested[0].space?.id, "alpha");
    assert.equal(nested[0].rosters[0].id, "demo");
    assert.deepEqual(nested[0].diagnostics.filter((item) => item.severity === "error"), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
