/**
 * 换代对比（`roster_diff`）的契约测试。
 *
 * 换班时第一个问题就是"新一代改了什么"，而之前的工具只能回答"档案 ↔ 运行态"。
 * 这里锁三件事：成员按 name 对齐（改名不被静默吞掉）、比较有效值（defaults 搬家不算变更）、
 * 人设只比指纹（不把 8000 字人设贴进输出）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { diffRosters } from "../lib/diff.js";
import { registerRosterTools } from "../lib/tools.js";
import { validateRoster } from "../lib/validate.js";
import { makeLibrary, rosterDocument } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 校验一份档案（可选地改一处深字段）。 */
function rosterOf(mutate = () => {}) {
  const document = rosterDocument();
  mutate(document);
  const result = validateRoster(document, { file: "core-review/roster.yaml" });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.roster;
}

test("档案差异：成员增删改与技能增减", () => {
  const before = rosterOf();
  const after = rosterOf((document) => {
    document.members[0].model = "deepseek-v4.1-pro";
    document.members[0].skills = ["frontend-skill"];
    document.members[1].name = "release-guard";
    document.members.push({ name: "auditor", role: "审计", systemPrompt: "你负责审计。", toolPolicy: "readonly" });
  });

  const diff = diffRosters(before, after);
  assert.deepEqual(diff.members.added, ["release-guard", "auditor"]);
  // 改名不自动合并：显示成"删一个、加一个"，不会被静默吞掉。
  assert.deepEqual(diff.members.removed, ["release-manager"]);
  const reviewer = diff.members.changed.find((item) => item.name === "reviewer");
  assert.ok(reviewer, "reviewer 应有变更");
  assert.equal(reviewer.fields.find((field) => field.field === "model").to, "deepseek-v4.1-pro");
  assert.deepEqual(diff.skills, [{ member: "reviewer", added: ["frontend-skill"], removed: [] }]);
  assert.deepEqual(diff.counts, { added: 2, removed: 1, changed: 1 });
});

test("档案差异：defaults 搬家但有效值不变，不算变更", () => {
  const before = rosterOf();
  const after = rosterOf((document) => {
    // 把这个成员继承来的默认模型写成自己的值，有效值一模一样。
    document.members[0].model = "deepseek-v4.1-flash";
  });
  const diff = diffRosters(before, after);
  assert.equal(diff.counts.changed, 0);
  assert.deepEqual(diff.rosters, []);
});

test("档案差异：人设只给长度与哈希，不贴正文", () => {
  const before = rosterOf();
  const after = rosterOf((document) => {
    document.members[0].systemPrompt = "你是更严格的评审者。";
  });
  const diff = diffRosters(before, after);
  const persona = diff.members.changed[0].fields.find((field) => field.field === "systemPrompt");
  assert.match(persona.from, /^\d+ 字符 #[0-9a-f]{8}$/);
  assert.match(persona.to, /^\d+ 字符 #[0-9a-f]{8}$/);
  assert.equal(JSON.stringify(diff).includes("你是更严格的评审者"), false);
});

/** 用最小的假 ctx 注册工具。 */
function register() {
  const tools = new Map();
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    effect(fn) { fn(); },
  };
  registerRosterTools(
    ctx,
    { rosterDirs: ["rosters"], knownToolPolicies: [], agentTeamsStateDir: ".agent-teams" },
    { version: "0.1.0" },
  );
  return tools;
}

const exec = { agent: { session: { header: { cwd: root } } } };

test("roster_diff：两份档案目录能比出差异，也认档案库目录", async () => {
  const oldLibrary = makeLibrary({
    "core-review/roster.json": rosterDocument(),
  });
  const newLibrary = makeLibrary({
    "core-review/roster.json": rosterDocument({ version: "2.0.0" }),
  });
  try {
    const tools = register();
    const tool = tools.get("roster_diff");
    const value = await tool.execute({ from: oldLibrary.rootDir, to: newLibrary.rootDir }, exec);
    assert.equal(value.ok, true);
    assert.equal(value.from.version, "1.2.0");
    assert.equal(value.to.version, "2.0.0");
    assert.equal(value.counts.changed, 0);
    const text = tool.output.render({}, value)[0].text;
    assert.match(text.split("\n")[0], /^\[roster_diff\] ok=true /);
    assert.match(text, /roster:core-review@1\.2\.0#/);
    assert.match(text, /version  1\.2\.0 → 2\.0\.0/);
  } finally {
    oldLibrary.cleanup();
    newLibrary.cleanup();
  }
});

test("roster_diff：目录里有多份档案时要求用 id 指明", async () => {
  const library = makeLibrary({
    "core-review/roster.json": rosterDocument(),
    "other/roster.json": rosterDocument({ roster: "other", title: "另一份" }),
  });
  try {
    const tools = register();
    const tool = tools.get("roster_diff");
    const ambiguous = await tool.execute({ from: library.rootDir, to: library.rootDir }, exec);
    assert.equal(ambiguous.ok, false);
    assert.match(tool.output.render({}, ambiguous)[0].text, /请用 id 指明/);

    const picked = await tool.execute({ from: library.rootDir, to: library.rootDir, id: "core-review" }, exec);
    assert.equal(picked.ok, true);
    assert.match(tool.output.render({}, picked)[0].text, /两份档案没有语义差别|两份是逐字节相同的文件/);
  } finally {
    library.cleanup();
  }
});

test("roster_create：输出建议写进 description 的溯源行", async () => {
  const library = makeLibrary({ "core-review/roster.json": rosterDocument() });
  try {
    const tools = register();
    const tool = tools.get("roster_create");
    const value = await tool.execute({ ref: "core-review", path: library.rootDir }, exec);
    assert.equal(value.ok, true);
    assert.match(value.provenance.line, /^roster:core-review@1\.2\.0#[0-9a-f]{8}$/);
    assert.equal(value.provenance.contentSha.length, 64);
    assert.match(tool.output.render({}, value)[0].text, /agent_teams_create 的 description/);
  } finally {
    library.cleanup();
  }
});
