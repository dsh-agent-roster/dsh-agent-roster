import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import test from "node:test";

import { compileRosterAt } from "../lib/compile2.js";
import { formatKnowledgeBlock, normalizeKnowledgeRef, parseKnowledgeText } from "../lib/knowledge.js";

function tmpLibrary() {
  const lib = mkdtempSync(nodePath.join(os.tmpdir(), "roster-knowledge-"));
  mkdirSync(nodePath.join(lib, "roles", "writer"), { recursive: true });
  mkdirSync(nodePath.join(lib, "knowledge"), { recursive: true });
  mkdirSync(nodePath.join(lib, "rosters", "demo"), { recursive: true });
  return lib;
}

function writeRole(lib, frontmatter) {
  writeFileSync(
    nodePath.join(lib, "roles", "writer", "AGENT.md"),
    `---\nkind: dsh-agent-roster/role@1\nname: writer\nversion: 1.0.0\nrole: 写手\n${frontmatter}---\n你负责写文档。\n`,
  );
}

function writeRoster(lib, extra = "") {
  writeFileSync(
    nodePath.join(lib, "rosters", "demo", "roster.yaml"),
    `kind: dsh-agent-roster/roster@2\nid: demo\nversion: 1.0.0\ntitle: 演示\n${extra}members:\n  - as: writer\n    role: writer@1.0.0\n`,
  );
}

test("知识引用：两种写法归一，越界与非 knowledge/ 路径不合法", () => {
  assert.equal(normalizeKnowledgeRef("project-map"), "knowledge/project-map.md");
  assert.equal(normalizeKnowledgeRef("project-map.md"), "knowledge/project-map.md");
  assert.equal(normalizeKnowledgeRef("knowledge/project-map.md"), "knowledge/project-map.md");
  assert.equal(normalizeKnowledgeRef(""), "");
  assert.equal(normalizeKnowledgeRef("   "), "");
});

test("知识文本：frontmatter 的 title/summary 优先，否则取第一个标题与首段", () => {
  const withMeta = parseKnowledgeText("---\ntitle: 项目地图\nsummary: 仓库布局与验证命令。\n---\n# 别的标题\n正文。\n");
  assert.equal(withMeta.title, "项目地图");
  assert.equal(withMeta.summary, "仓库布局与验证命令。");

  const plain = parseKnowledgeText("# 约定\n\n所有改动都走 PR，合并前 verify 必须绿。\n\n第二段不该进概要。\n");
  assert.equal(plain.title, "约定");
  assert.equal(plain.summary, "所有改动都走 PR，合并前 verify 必须绿。");
  assert.ok(!plain.summary.includes("第二段"));
});

test("知识块：只有标题与概要，正文不出现；空列表渲染空串", () => {
  const block = formatKnowledgeBlock([{ path: "knowledge/a.md", title: "A", summary: "一句话。" }]);
  assert.match(block, /项目知识（这里只给概要/);
  assert.match(block, /- A（knowledge\/a\.md）：一句话。/);
  assert.equal(formatKnowledgeBlock([]), "");
});

test("角色级 knowledge：概要+路径进 executionPrompt，正文不进；缺失文件报错", () => {
  const lib = tmpLibrary();
  writeRole(lib, "knowledge:\n  - project-map\n");
  writeFileSync(
    nodePath.join(lib, "knowledge", "project-map.md"),
    "---\ntitle: 项目地图\nsummary: 仓库布局、关键目录与验证命令。\n---\n# 项目地图\n这里有很长的正文。\n",
  );
  writeRoster(lib);

  const compiled = compileRosterAt(nodePath.join(lib, "rosters", "demo"), { rolesDir: nodePath.join(lib, "roles") });
  assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
  const prompt = compiled.compiled.members[0].executionPrompt;
  assert.match(prompt, /- 项目地图（knowledge\/project-map\.md）：仓库布局、关键目录与验证命令。/);
  assert.ok(!prompt.includes("这里有很长的正文"), "正文不该被贴进提示词");
  const kinds = compiled.compiled.members[0].promptStats.parts.map((part) => part.kind);
  assert.ok(kinds.includes("knowledge"));

  writeRole(lib, "knowledge:\n  - missing-one\n");
  const broken = compileRosterAt(nodePath.join(lib, "rosters", "demo"), { rolesDir: nodePath.join(lib, "roles") });
  assert.equal(broken.ok, false);
  assert.ok(broken.diagnostics.some((item) => item.code === "missing-knowledge"));
});

test("roster 级 knowledge：队长与每个成员都拿到同一份概要", () => {
  const lib = tmpLibrary();
  writeRole(lib, "");
  writeFileSync(nodePath.join(lib, "knowledge", "conventions.md"), "# 约定\n\n所有改动都走 PR，合并前 verify 必须绿。\n");
  writeRoster(lib, "knowledge:\n  - conventions\n");
  writeFileSync(
    nodePath.join(lib, "rosters", "demo", "roster.yaml"),
    `kind: dsh-agent-roster/roster@2\nid: demo\nversion: 1.0.0\ntitle: 演示\nknowledge:\n  - conventions\ncaptain:\n  role: writer@1.0.0\nmembers:\n  - as: writer\n    role: writer@1.0.0\n`,
  );

  const compiled = compileRosterAt(nodePath.join(lib, "rosters", "demo"), { rolesDir: nodePath.join(lib, "roles") });
  assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
  const line = /- 约定（knowledge\/conventions\.md）：所有改动都走 PR，合并前 verify 必须绿。/;
  assert.match(compiled.compiled.members[0].executionPrompt, line);
  assert.match(compiled.compiled.captain.persona, line);
});
