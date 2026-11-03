/**
 * v2 示例库的端到端测试：示例必须真的能编译，且 `dist/` 里的产物与源码同步。
 *
 * `examples-v2/` 是文档里那条命令的输入，不是摆设：
 * 1. 编译成功、成员与编排都在；
 * 2. 拼装语义可核对（正文 + 片段 + roster 追加，块之间两个换行）；
 * 3. `dist/*.json` 与现编译结果一致——手工改产物会被这个测试打回。
 *
 * @module test/examples-v2
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { compileRosterAt } from "../lib/compile2.js";
import { splitFrontmatter } from "../lib/frontmatter.js";

const root = nodePath.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const example = nodePath.join(root, "examples-v2");
const rosterDir = nodePath.join(example, "rosters", "core-review");
const rolesDir = nodePath.join(example, "roles");

const compile = () =>
  compileRosterAt(rosterDir, {
    rolesDir,
    knownToolPolicies: ["member-safe"],
    source: { repo: "dsh-agent-roster/dsh-agent-roster", ref: "main" },
  });

const readDist = () =>
  JSON.parse(readFileSync(nodePath.join(example, "dist", "core-review-1.0.0.json"), "utf8"));

/** 产物里只跟本机坐标相关的字段，比较时剔除。 */
const stable = ({ source, ...rest }) => ({ source: { roster: source.roster, version: source.version, file: source.file }, ...rest });

test("examples-v2：示例组装能编译，成员来自角色引用", () => {
  const result = compile();
  assert.deepEqual(
    result.diagnostics.filter((item) => item.severity === "error"),
    [],
    "示例库不允许有 error",
  );
  assert.equal(result.ok, true);
  assert.equal(result.compiled.source.roster, "core-review");
  assert.equal(result.compiled.source.version, "1.0.0");
  assert.deepEqual(
    result.compiled.members.map((member) => member.name),
    ["reviewer", "fixer"],
  );
  assert.deepEqual(
    result.compiled.members.map((member) => member.roleRef),
    ["reviewer@1.0.0", "fixer@1.0.0"],
  );
  assert.deepEqual(
    result.compiled.members.map((member) => member.role),
    ["代码评审", "修复"],
  );
  // defaults 在编译时 materialize：每个成员都有显式 route，不再回头读 defaults。
  for (const member of result.compiled.members) {
    assert.equal(member.provider, "deepseek");
    assert.equal(member.model, "deepseek-v4.1-flash");
    assert.equal(member.reasoningEffort, "high");
  }
});

test("examples-v2：拼装语义 = 正文 + 片段 + 追加，块之间恰是两个换行", () => {
  const { compiled } = compile();
  const reviewer = compiled.members.find((member) => member.name === "reviewer");
  const source = readFileSync(nodePath.join(rolesDir, "reviewer", "AGENT.md"), "utf8");
  const split = splitFrontmatter(source, { file: "AGENT.md" });
  assert.equal(split.ok, true);
  assert.equal(reviewer.executionPrompt.startsWith(split.body), true, "正文必须原样在最前");
  assert.equal(reviewer.executionPrompt.includes("## 检查清单"), true, "片段必须拼进人设");
  assert.equal(
    reviewer.executionPrompt.split("\n\n").some((block) => block.startsWith("## 检查清单")),
    true,
    "片段是独立块，不是粘在上一段尾巴上",
  );

  const fixer = compiled.members.find((member) => member.name === "fixer");
  assert.equal(fixer.executionPrompt.endsWith("把失败用例贴进回报里。"), true, "roster 追加必须在最后");
  assert.equal(fixer.promptStats.parts.at(-1).kind, "append");
  assert.equal(fixer.promptStats.chars, [...fixer.executionPrompt].length);
});

test("examples-v2：编排是声明，不是已执行", () => {
  const { compiled } = compile();
  assert.notEqual(compiled.orchestration, null);
  assert.equal(compiled.orchestration.status, "declaration");
  assert.deepEqual(compiled.orchestration.stages.map((stage) => stage.id), ["build", "audit"]);
  assert.deepEqual(compiled.orchestration.gates[0].after, ["audit"]);
  assert.equal(compiled.orchestration.gates[0].by, "reviewer");
  // 队长不是成员：它在自己的段里，成员表里没有 lead。
  assert.equal(compiled.captain.role, "lead@1.0.0");
  assert.equal(compiled.members.some((member) => member.name === "lead"), false);
});

test("examples-v2：dist 与源码同步（手改产物会被打回）", () => {
  const { compiled } = compile();
  assert.deepEqual(stable(readDist()), stable(compiled), "dist 与现编译结果不一致，请跑 `dsh-agent-roster compile --roster examples-v2/rosters/core-review --write`");
});
