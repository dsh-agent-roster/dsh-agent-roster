/**
 * 正文引用（`{{> path}}`）的测试。
 *
 * 这里测的是**契约**，不是「能展开」：独占一行、只一层、两种根、预算按展开后算、
 * 缺文件/越界一律 error。任何一条松掉，都会让 executionPrompt 变成猜不出来的东西。
 *
 * @module test/includes
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { expandIncludes, parseIncludes } from "../lib/includes.js";
import { loadRoleAt } from "../lib/role.js";
import { compileRosterAt } from "../lib/compile2.js";

function scratch() {
  return mkdtempSync(nodePath.join(tmpdir(), "dsh-inc-"));
}

function write(root, relative, content) {
  const file = nodePath.join(root, relative);
  mkdirSync(nodePath.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return file;
}

const ROLE = (body) =>
  ["---", "kind: dsh-agent-roster/role@1", "name: reviewer", "version: 1.0.0", "role: 审查者", "---", body].join("\n");

test("引用：只有独占一行的 {{> path}} 才算，行号从正文第一行开始数", () => {
  const text = "第一行\n{{> parts/a.md}}\n第三行";
  const parsed = parseIncludes(text);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].path, "parts/a.md");
  assert.equal(parsed.items[0].line, 2);
  assert.deepEqual(parsed.diagnostics, []);
});

test("引用：混在句子里的 {{> 不猜意图，直接报 include-syntax", () => {
  const parsed = parseIncludes("请先读 {{> parts/a.md}} 再动手");
  assert.equal(parsed.items.length, 0);
  assert.equal(parsed.diagnostics[0].code, "include-syntax");
  assert.match(parsed.diagnostics[0].reason, /独占一行/);
});

test("引用：缺文件是 error missing-include，不是空片段", () => {
  const root = scratch();
  const roleDir = nodePath.join(root, "roles/reviewer");
  write(root, "roles/reviewer/AGENT.md", ROLE("正文"));
  const result = expandIncludes({ text: "{{> parts/nope.md}}", roleDir, file: "AGENT.md" });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "missing-include");
  assert.equal(result.diagnostics[0].file, "AGENT.md");
});

test("引用：越出可读范围是 unsafe-include，绝对路径同样拒绝", () => {
  const root = scratch();
  const roleDir = nodePath.join(root, "roles/reviewer");
  write(root, "roles/reviewer/AGENT.md", ROLE("正文"));
  const relative = expandIncludes({ text: "{{> ../other/AGENT.md}}", roleDir });
  assert.equal(relative.diagnostics[0].code, "unsafe-include");
  const absolute = expandIncludes({ text: `{{> ${nodePath.join(root, "roles/reviewer/AGENT.md")}}}`, roleDir });
  assert.equal(absolute.diagnostics[0].code, "unsafe-include");
});

test("引用：snippets/ 相对库根；不知道库根就报 library-root-unknown，不退回角色目录", () => {
  const root = scratch();
  const roleDir = nodePath.join(root, "roles/reviewer");
  write(root, "snippets/units.md", "金额用整数分。\n");
  write(root, "roles/reviewer/AGENT.md", ROLE("正文"));
  const blind = expandIncludes({ text: "{{> snippets/units.md}}", roleDir });
  assert.equal(blind.diagnostics[0].code, "library-root-unknown");

  const known = expandIncludes({ text: "{{> snippets/units.md}}", roleDir, libraryRoot: root });
  assert.equal(known.ok, true);
  assert.equal(known.text, "金额用整数分。");
  assert.equal(known.includes[0].path, "snippets/units.md");
});

test("引用：只展开一层——被引文件里再写引用是 include-nested，不静默发出去", () => {
  const root = scratch();
  const roleDir = nodePath.join(root, "roles/reviewer");
  write(root, "roles/reviewer/AGENT.md", ROLE("正文"));
  write(root, "roles/reviewer/parts/a.md", "A\n{{> parts/b.md}}\n");
  const result = expandIncludes({ text: "{{> parts/a.md}}", roleDir });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, "include-nested");
});

test("引用：同一文件引两次就展开两次，不偷偷去重", () => {
  const root = scratch();
  const roleDir = nodePath.join(root, "roles/reviewer");
  write(root, "roles/reviewer/AGENT.md", ROLE("正文"));
  write(root, "roles/reviewer/parts/x.md", "X");
  const result = expandIncludes({ text: "{{> parts/x.md}}\n--\n{{> parts/x.md}}", roleDir });
  assert.equal(result.ok, true);
  assert.equal(result.text, "X\n--\nX");
  assert.equal(result.includes.length, 2);
});

test("引用：超过 includeChars 报 include-too-long；按展开后字符计预算", () => {
  const root = scratch();
  const roleDir = nodePath.join(root, "roles/reviewer");
  write(root, "roles/reviewer/AGENT.md", ROLE("正文"));
  write(root, "roles/reviewer/parts/big.md", "x".repeat(6001));
  const result = expandIncludes({ text: "{{> parts/big.md}}", roleDir });
  assert.equal(result.diagnostics[0].code, "include-too-long");
});

test("引用：经 loadRoleAt 展开，prompt.chars 是展开后的长度，includes 带行号与 sha", () => {
  const root = scratch();
  write(root, "snippets/units.md", "金额用整数分。");
  write(root, "roles/reviewer/AGENT.md", ROLE("正文\n{{> parts/check.md}}\n{{> snippets/units.md}}\n"));
  write(root, "roles/reviewer/parts/check.md", "检查清单");
  const loaded = loadRoleAt(nodePath.join(root, "roles/reviewer"), { libraryRoot: root });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.prompt.text, "正文\n检查清单\n金额用整数分。");
  assert.equal(loaded.prompt.includes.length, 2);
  // 行号对到整份 AGENT.md（frontmatter 之后第 2 行），不是正文内部的行号。
  assert.equal(loaded.prompt.includes[0].line, 8);
  assert.equal(loaded.prompt.includes[1].line, 9);
  assert.match(loaded.prompt.includes[1].sha256, /^[0-9a-f]{64}$/);
  // 预算的对象是展开后的文本，不是正文文件的大小。
  assert.equal(loaded.prompt.chars, "正文\n检查清单\n金额用整数分。".length);
});

test("引用：编译产物在 promptStats 里逐条记 kind=include（行号 + sha），可复核", () => {
  const root = scratch();
  write(
    root,
    "roles/reviewer/AGENT.md",
    ["---", "kind: dsh-agent-roster/role@1", "name: reviewer", "version: 1.0.0", "role: 审查者", "---", "看这里", "{{> parts/check.md}}", ""].join("\n"),
  );
  write(root, "roles/reviewer/parts/check.md", "检查清单");
  write(
    root,
    "rosters/demo/roster.yaml",
    [
      "kind: dsh-agent-roster/roster@2",
      "id: demo",
      "version: 1.0.0",
      "members:",
      "  - as: reviewer",
      "    role: reviewer@1.0.0",
      "",
    ].join("\n"),
  );
  const result = compileRosterAt(nodePath.join(root, "rosters/demo"), {
    rolesDir: nodePath.join(root, "roles"),
    libraryRoot: root,
  });
  assert.equal(result.ok, true);
  const member = result.compiled.members[0];
  const include = member.promptStats.parts.find((part) => part.kind === "include");
  assert.equal(include.path, "parts/check.md");
  assert.equal(include.line, 8);
  assert.match(include.sha256, /^[0-9a-f]{64}$/);
  assert.match(member.executionPrompt, /检查清单/);
});

test("includes：knowledge/ 也相对库根解析（与 snippets/ 同一套规则）", () => {
  const dir = scratch();
  const roleDir = nodePath.join(dir, "roles", "lead");
  write(roleDir, "AGENT.md", ["---", "kind: dsh-agent-roster/role@1", "name: lead", "version: 1.0.0", "role: 队长", "---", "", "正文", "", "{{> knowledge/conventions.md}}", ""].join("\n"));
  write(dir, "knowledge/conventions.md", "项目约定：先复述目标。\n");
  const result = expandIncludes({
    text: "正文\n\n{{> knowledge/conventions.md}}\n",
    file: "AGENT.md",
    roleDir,
    libraryRoot: dir,
    lineOffset: 0,
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.match(result.text, /项目约定：先复述目标。/);
  assert.equal(result.includes[0].path, "knowledge/conventions.md");
});
