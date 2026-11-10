/**
 * v2 三个新层（角色 / 组装 / 编译）的测试。
 *
 * 这里刻意不测「能否跑通」这种表面事实，而测四条不变量：
 * 1. 拼装语义写进格式（顺序、分隔符、上限），不在插件代码里变魔术；
 * 2. 身份来自文档，但重名必须报错（否则「谁是权威」就退回路径）；
 * 3. 缺文件一律 error，绝不静默当成空人设；
 * 4. 编译产物的每个字段都标注归宿：direct / config / declaration。
 *
 * @module test/compile2
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { compileRoster, compileRosterAt, compileToMembers, flattenCompiledToRoster, scanRoles } from "../lib/compile2.js";
import { splitFrontmatter, assemblePrompt } from "../lib/frontmatter.js";
import { loadRoleAt } from "../lib/role.js";
import { validateRoster2 } from "../lib/roster2.js";
import { parseDocumentText } from "../lib/parse.js";

function scratch() {
  return mkdtempSync(nodePath.join(tmpdir(), "dsh-v2-"));
}

function write(root, relative, content) {
  const file = nodePath.join(root, relative);
  mkdirSync(nodePath.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return file;
}

function roleDoc({ name = "reviewer", version = "1.0.0", body = "你只找会出错的地方。", extra = "", parts = [] } = {}) {
  const lines = [
    "---",
    "kind: dsh-agent-roster/role@1",
    `name: ${name}`,
    `version: ${version}`,
    "role: 审查者",
    ...extra.split("\n").filter(Boolean),
  ];
  if (parts.length > 0) {
    lines.push("prompt:", "  parts:");
    for (const part of parts) lines.push(`    - ${part}`);
  }
  lines.push("---", "", body, "");
  return lines.join("\n");
}

function rosterDoc({ id = "core-review", version = "2.1.0", members = [], extra = "" } = {}) {
  const lines = [
    "kind: dsh-agent-roster/roster@2",
    `id: ${id}`,
    `version: ${version}`,
    "title: 代码审查小组",
  ];
  for (const line of extra.split("\n")) if (line !== "") lines.push(line);
  lines.push("members:");
  if (members.length === 0) {
    lines.push("  - as: correctness", "    role: reviewer@1.0.0");
  } else {
    for (const member of members) lines.push(...member);
  }
  return lines.join("\n") + "\n";
}

// ── 拆分与拼装 ──────────────────────────────────────────────────────────────

test("frontmatter：拆成参数与正文，正文原样保留开头缩进", () => {
  const split = splitFrontmatter("---\nname: x\n---\n\n  第一行\n第二行\n", { file: "AGENT.md" });
  assert.equal(split.ok, true);
  assert.equal(split.frontmatter, "name: x");
  assert.equal(split.body, "  第一行\n第二行");
});

test("frontmatter：缺围栏 / 未闭合 / 空正文都是 error，不猜意图", () => {
  assert.equal(splitFrontmatter("name: x\n---\nbody").diagnostics[0].code, "missing-frontmatter");
  assert.equal(splitFrontmatter("---\nname: x\nbody").diagnostics[0].code, "unterminated-frontmatter");
  assert.equal(splitFrontmatter("---\nname: x\n---\n\n\n").diagnostics[0].code, "empty-body");
});

test("拼装：body + parts 顺序固定、分隔符是空行，roster 只能 prepend/append", () => {
  const assembled = assemblePrompt("正文", ["片段一", "片段二"], { prepend: "前缀", append: "后缀" });
  assert.equal(assembled.text, "前缀\n\n正文\n\n片段一\n\n片段二\n\n后缀");
  assert.deepEqual(assembled.parts, [2, 2, 3, 3, 2]);
});

// ── 角色 ────────────────────────────────────────────────────────────────────

test("角色：最简 AGENT.md 通过，prompt 等于正文", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", roleDoc());
  const loaded = loadRoleAt(nodePath.join(root, "roles/reviewer"));
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
  assert.equal(loaded.role.name, "reviewer");
  assert.equal(loaded.prompt.text, "你只找会出错的地方。");
  assert.equal(loaded.prompt.chars, 10);
});

test("角色：parts 按 frontmatter 顺序拼进 prompt，并逐个记账", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", roleDoc({ parts: ["parts/10-rules.md", "parts/20-format.md"] }));
  write(root, "roles/reviewer/parts/10-rules.md", "规则一");
  write(root, "roles/reviewer/parts/20-format.md", "输出格式");
  const loaded = loadRoleAt(nodePath.join(root, "roles/reviewer"));
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
  assert.equal(loaded.prompt.text, "你只找会出错的地方。\n\n规则一\n\n输出格式");
  assert.deepEqual(loaded.prompt.parts.map((part) => part.path), ["body", "parts/10-rules.md", "parts/20-format.md"]);
});

test("角色：片段缺失是 error，不静默当空片段", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", roleDoc({ parts: ["parts/nope.md"] }));
  const loaded = loadRoleAt(nodePath.join(root, "roles/reviewer"));
  assert.equal(loaded.ok, false);
  assert.ok(loaded.diagnostics.some((item) => item.code === "missing-part" && item.severity === "error"));
});

test("角色：片段路径不允许越出角色目录", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", roleDoc({ parts: ["../escape.md"] }));
  write(root, "roles/escape.md", "外部内容");
  const loaded = loadRoleAt(nodePath.join(root, "roles/reviewer"));
  assert.equal(loaded.ok, false);
  assert.ok(loaded.diagnostics.some((item) => item.code === "unsafe-path"));
});

test("角色：未知字段与拼错的 onMissing 都被拒绝", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", roleDoc({ extra: "temperatur: 0.2\nonMissing: ignore" }));
  const loaded = loadRoleAt(nodePath.join(root, "roles/reviewer"));
  assert.equal(loaded.ok, false);
  assert.ok(loaded.diagnostics.some((item) => item.code === "unknown-field" && item.path === "temperatur"));
  assert.ok(loaded.diagnostics.some((item) => item.code === "invalid-on-missing"));
});

test("角色：预算按字符算，超出即报错（不猜 token）", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", roleDoc({ body: "很长".repeat(10), extra: "prompt:\n  budget: 5" }));
  const loaded = loadRoleAt(nodePath.join(root, "roles/reviewer"));
  assert.equal(loaded.ok, false);
  assert.ok(loaded.diagnostics.some((item) => item.code === "prompt-over-budget"));
});

// ── 组装 ────────────────────────────────────────────────────────────────────

test("组装：未知键、错误角色引用、重复成员名都被拒绝", () => {
  const root = scratch();
  write(
    root,
    "rosters/core-review/roster.yaml",
    rosterDoc({
      extra: "unknownThing: 1",
      members: [
        ["  - as: correctness", "    role: reviewer"],
        ["  - as: correctness", "    role: reviewer@1.0.0"],
      ],
    }),
  );
  const text = readFileSync(nodePath.join(root, "rosters/core-review/roster.yaml"), "utf8");
  const parsed = parseDocumentText(text, { file: "roster.yaml" });
  const result = validateRoster2(parsed.value, { file: "roster.yaml" });
  assert.equal(result.ok, false);
  const codes = result.diagnostics.map((item) => item.code);
  assert.ok(codes.includes("unknown-field"));
  assert.ok(codes.includes("invalid-role-ref"));
  assert.ok(codes.includes("duplicate-member"));
});

test("组装：defaults 只允许桥接字段，targets 只允许已知目标", () => {
  const value = {
    kind: "dsh-agent-roster/roster@2",
    id: "core-review",
    version: "2.1.0",
    defaults: { route: { provider: "deepseek", model: "deepseek-v4.1-flash" }, temperature: 0.2 },
    targets: ["agent-teams/members", "somewhere/else"],
    members: [{ as: "a", role: "reviewer@1.0.0" }],
  };
  const result = validateRoster2(value, {});
  assert.equal(result.ok, false);
  const codes = result.diagnostics.map((item) => item.code);
  assert.ok(codes.includes("unknown-field"));
  assert.ok(codes.includes("invalid-target"));
});

// ── 编译 ────────────────────────────────────────────────────────────────────

test("编译：defaults 被 materialize，append 进拼装，provenance 带角色版本与哈希", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", roleDoc({ body: "你只找会出错的地方。", extra: "route:\n  provider: deepseek\n  model: deepseek-v4.1-flash\n  reasoningEffort: high\ntools:\n  policy: readonly\n  scope:\n    allow: [read, grep]" }));
  write(root, "rosters/core-review/overrides.md", "额外要求：先给触发条件。");
  write(
    root,
    "rosters/core-review/roster.yaml",
    rosterDoc({
      extra: "defaults:\n  route:\n    reasoningEffort: medium",
      members: [["  - as: correctness", "    role: reviewer@1.0.0", "    prompt:", "      append: ./overrides.md"]],
    }),
  );

  const result = compileRosterAt(nodePath.join(root, "rosters/core-review"), {
    rolesDir: nodePath.join(root, "roles"),
    knownToolPolicies: null,
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
  const compiled = result.compiled;
  assert.equal(compiled.kind, "dsh-agent-roster/compiled@1");
  assert.equal(compiled.members.length, 1);
  const member = compiled.members[0];
  assert.equal(member.provider, "deepseek");
  assert.equal(member.model, "deepseek-v4.1-flash");
  assert.equal(member.reasoningEffort, "medium", "roster defaults 覆盖角色路由");
  assert.equal(member.toolPolicy, "readonly");
  assert.equal(member.executionPrompt, "你只找会出错的地方。\n\n额外要求：先给触发条件。");
  assert.match(member.provenance.role, /^reviewer@1\.0\.0$/);
  assert.equal(member.provenance.sha256.length, 8);
  assert.ok(compiled.declarations.some((item) => item.field === "tools.scope" && item.note.startsWith("declaration")));
});

test("编译：角色不存在 / 版本不匹配都是 error，不降级到别的版本", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", roleDoc({ version: "1.0.1" }));
  write(root, "rosters/core-review/roster.yaml", rosterDoc());

  const missing = compileRosterAt(nodePath.join(root, "rosters/core-review"), {
    rolesDir: nodePath.join(root, "roles"),
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.diagnostics.some((item) => item.code === "role-version-mismatch"));

  const none = compileRosterAt(nodePath.join(root, "rosters/core-review"), {
    rolesDir: nodePath.join(root, "roles-that-do-not-exist"),
  });
  assert.equal(none.ok, false);
  assert.ok(none.diagnostics.some((item) => item.code === "missing-roles-dir"));
});

test("编译：重名角色报 duplicate-role，而不是谁先扫到谁赢", () => {
  const root = scratch();
  write(root, "roles/a/reviewer/AGENT.md", roleDoc());
  write(root, "roles/b/other/AGENT.md", roleDoc());
  const scanned = scanRoles(nodePath.join(root, "roles"));
  assert.equal(scanned.ok, false);
  assert.ok(scanned.diagnostics.some((item) => item.code === "duplicate-role"));
});

test("编译：编排编译成计划，并显式标注「运行时不执行」", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", roleDoc());
  write(root, "roles/implementer/AGENT.md", roleDoc({ name: "implementer", body: "你做最小修复。" }));
  write(
    root,
    "rosters/core-review/roster.yaml",
    rosterDoc({
      extra: [
        "orchestration:",
        "  shape: gate-pipeline",
        "  stages:",
        "    - id: review",
        "      parallel: [correctness]",
        "      join: captain",
        "    - id: repair",
        "      role: implementer@1.0.0",
        "      maxRounds: 2",
        "  gates:",
        "    - id: publish",
        "      after: [repair]",
        "      requires: [评审通过，且没有未解决的高危项]",
        "      verify:",
        "        - command: node --test",
        "          expectExit: 0",
        "      by: correctness",
      ].join("\n"),
    }),
  );
  const result = compileRosterAt(nodePath.join(root, "rosters/core-review"), {
    rolesDir: nodePath.join(root, "roles"),
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.compiled.orchestration.shape, "gate-pipeline");
  assert.equal(result.compiled.orchestration.status, "declaration");
  assert.deepEqual(result.compiled.orchestration.stages.map((stage) => stage.id), ["review", "repair"]);
  assert.ok(result.compiled.declarations.some((item) => item.scope === "orchestration"));
});

test("组装：阶段引用不存在的成员、门引用不存在的阶段都报错", () => {
  const value = {
    kind: "dsh-agent-roster/roster@2",
    id: "core-review",
    version: "2.1.0",
    members: [{ as: "correctness", role: "reviewer@1.0.0" }],
    orchestration: {
      shape: "gate-pipeline",
      stages: [{ id: "review", parallel: ["ghost"] }],
      gates: [{ id: "publish", after: ["nowhere"], by: "ghost" }],
    },
  };
  const result = validateRoster2(value, {});
  assert.equal(result.ok, false);
  const codes = result.diagnostics.map((item) => item.code);
  assert.ok(codes.includes("unknown-member"));
  assert.ok(codes.includes("unknown-stage"));
});

test("编译：队长 persona 来自组装目录，落成 config 而不是成员", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", roleDoc());
  write(root, "rosters/core-review/captain.persona.md", "派活前先复述目标与验收标准。");
  write(
    root,
    "rosters/core-review/roster.yaml",
    rosterDoc({
      extra: [
        "targets: [agent-teams/members, profile/agent-preset]",
        "captain:",
        "  route: {provider: deepseek, model: deepseek-v4.1-pro, reasoningEffort: high}",
        "  persona: ./captain.persona.md",
      ].join("\n"),
    }),
  );
  const result = compileRosterAt(nodePath.join(root, "rosters/core-review"), {
    rolesDir: nodePath.join(root, "roles"),
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.compiled.captain.model, "deepseek-v4.1-pro");
  assert.equal(result.compiled.captain.persona, "派活前先复述目标与验收标准。");
  assert.ok(result.compiled.captain.personaChars > 0);
  assert.ok(result.compiled.declarations.some((item) => item.scope === "captain" && item.field === "persona"));
});

test("编译：缺 persona 文件是 error，不回退到角色正文", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", roleDoc());
  write(
    root,
    "rosters/core-review/roster.yaml",
    rosterDoc({ extra: "captain:\n  persona: ./missing.md" }),
  );
  const result = compileRosterAt(nodePath.join(root, "rosters/core-review"), {
    rolesDir: nodePath.join(root, "roles"),
  });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === "missing-persona"));
});

test("编译产物可摊平成桥接层认识的成员形状", () => {
  const compiled = {
    members: [
      {
        name: "correctness",
        role: "审查者",
        executionPrompt: "正文",
        provider: "deepseek",
        model: "deepseek-v4.1-flash",
        reasoningEffort: "high",
        toolPolicy: "readonly",
      },
    ],
  };
  const [member] = compileToMembers(compiled);
  assert.deepEqual(member, {
    name: "correctness",
    role: "审查者",
    systemPrompt: "正文",
    provider: "deepseek",
    model: "deepseek-v4.1-flash",
    reasoningEffort: "high",
    toolPolicy: "readonly",
    aliases: [],
    skills: [],
    examples: [],
  });
});

test("编译产物自带发现元数据：远端只拿到一个文件时也能被搜到", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", roleDoc());
  write(
    root,
    "rosters/core-review/roster.yaml",
    rosterDoc({
      extra: "description: 一名队长加两名审查者。\nlicense: MIT\nmaintainers:\n  - STofone\ntags:\n  - review\n  - quality",
    }),
  );

  const result = compileRosterAt(nodePath.join(root, "rosters/core-review"), {
    rolesDir: nodePath.join(root, "roles"),
    knownToolPolicies: null,
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
  const source = result.compiled.source;
  assert.equal(source.title, "代码审查小组");
  assert.equal(source.description, "一名队长加两名审查者。");
  assert.deepEqual(source.tags, ["review", "quality"]);
  assert.equal(source.license, "MIT");
  assert.deepEqual(source.maintainers, ["STofone"]);

  // 远端订阅只拿到产物：摊回 v1 文档时元数据不能掉，否则"从远处找一份档案"只剩 id。
  const flat = flattenCompiledToRoster(result.compiled);
  assert.equal(flat.title, "代码审查小组");
  assert.deepEqual(flat.tags, ["review", "quality"]);
  assert.equal(flat.license, "MIT");
  assert.deepEqual(flat.maintainers, ["STofone"]);
});

test("编译：队长的 prepend/append 与成员同一套语义（加在正文两端，不替换）", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", roleDoc({ body: "你只找会出错的地方。" }));
  write(root, "rosters/core-review/lead.prepend.md", "开工先复述目标。");
  write(root, "rosters/core-review/lead.append.md", "汇报先结论后证据。");
  write(
    root,
    "rosters/core-review/roster.yaml",
    rosterDoc({
      extra: [
        "targets: [agent-teams/members, profile/agent-preset]",
        "captain:",
        "  role: reviewer@1.0.0",
        "  prompt:",
        "    prepend: ./lead.prepend.md",
        "    append: ./lead.append.md",
      ].join("\n"),
    }),
  );
  const result = compileRosterAt(nodePath.join(root, "rosters/core-review"), {
    rolesDir: nodePath.join(root, "roles"),
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(
    result.compiled.captain.persona,
    ["开工先复述目标。", "你只找会出错的地方。", "汇报先结论后证据。"].join("\n\n"),
  );
  assert.deepEqual(
    result.compiled.captain.promptStats.parts.map((item) => item.kind),
    ["prepend", "body+parts", "append"],
  );
  assert.ok(result.compiled.captain.personaChars > 0);
});

test("编译：队长只写 prepend 而没有正文，是 error（不猜正文从哪来）", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", roleDoc());
  write(root, "rosters/core-review/lead.prepend.md", "开工先复述目标。");
  write(
    root,
    "rosters/core-review/roster.yaml",
    rosterDoc({ extra: ["captain:", "  prompt:", "    prepend: ./lead.prepend.md"].join("\n") }),
  );
  const result = compileRosterAt(nodePath.join(root, "rosters/core-review"), {
    rolesDir: nodePath.join(root, "roles"),
  });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === "captain-prompt-without-base"));
});
