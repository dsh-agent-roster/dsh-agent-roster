/**
 * 能力要求（`capabilities.yaml`）的契约测试。
 *
 * 这里锁的是"声明"与"核对"两件事的边界：
 * - 声明只写要求，不承载能力，也不能借机塞进没有证据源的字段；
 * - 核对三分（在 / 缺 / 核对不到），只有"确实缺"才拦住建队，核对不到不许冒充通过。
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPABILITIES_KIND,
  ID_PATTERN,
  LIMITS,
  ON_MISSING,
  SKILL_PATTERN,
  capabilityDiagnostics,
  checkCapabilities,
  validateCapabilities,
} from "../lib/capabilities.js";
import { scanRosterLibrary } from "../lib/registry.js";
import { registerRosterTools } from "../lib/tools.js";
import { isLossless } from "../lib/json.js";
import { makeLibrary, rosterDocument } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exec = { agent: { session: { header: { cwd: root } } } };

/** 一份最小能力要求文档。 */
function capabilitiesDocument(overrides = {}) {
  return {
    kind: "dsh-agent-roster-capabilities/v1",
    roster: "core-review",
    onMissing: "refuse",
    asOf: "2026-11-02",
    requires: { skills: [], toolPolicies: [] },
    ...overrides,
  };
}

/** 用最小的假 ctx 注册工具。 */
function register(config = {}) {
  const tools = new Map();
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    effect(fn) { fn(); },
  };
  registerRosterTools(
    ctx,
    { rosterDirs: ["rosters"], knownToolPolicies: [], agentTeamsStateDir: ".agent-teams", ...config },
    { version: "0.1.0" },
  );
  return tools;
}

async function call(tools, name, args) {
  const tool = tools.get(name);
  const value = await tool.execute(args, exec);
  assert.equal(isLossless(value).ok, true, `${name} 返回值不可无损往返`);
  const text = tool.output.render(args, value)[0].text;
  return { value, text, firstLine: text.split("\n")[0] };
}

test("能力要求：onMissing 默认 refuse，无法核对的字段一律拒绝", () => {
  const minimal = validateCapabilities({ kind: "dsh-agent-roster-capabilities/v1", roster: "core-review" }, {
    file: "core-review/capabilities.yaml",
    expectedId: "core-review",
  });
  assert.equal(minimal.ok, true);
  assert.equal(minimal.capabilities.onMissing, "refuse");
  assert.deepEqual(minimal.capabilities.requires, { skills: [], toolPolicies: [], documents: [] });
  assert.equal(minimal.capabilities.asOf, null);

  // 模型路由 / 插件版本没有证据源：写进来就是又一份"看起来声明了"的假绿。
  const withModels = validateCapabilities(capabilitiesDocument({ requires: { models: ["deepseek-flash"] } }), {
    expectedId: "core-review",
  });
  assert.equal(withModels.ok, false);
  assert.ok(withModels.diagnostics.some((item) => item.code === "unknown-field" && item.path === "requires.models"));

  const withTopLevel = validateCapabilities(capabilitiesDocument({ plugins: [] }), { expectedId: "core-review" });
  assert.equal(withTopLevel.ok, false);
});

test("能力要求：roster 必须等于目录名，重复声明要报错", () => {
  const mismatch = validateCapabilities(capabilitiesDocument({ roster: "other" }), {
    file: "core-review/capabilities.yaml",
    expectedId: "core-review",
  });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.diagnostics.some((item) => item.code === "roster-id-mismatch"));

  const duplicated = validateCapabilities(
    capabilitiesDocument({ requires: { skills: ["frontend-skill", { name: "frontend-skill" }] } }),
    { expectedId: "core-review" },
  );
  assert.equal(duplicated.ok, false);
  assert.ok(duplicated.diagnostics.some((item) => item.code === "duplicate-requirement"));
});

test("能力要求：asOf 只收日期，不收时分秒", () => {
  const withTime = validateCapabilities(capabilitiesDocument({ asOf: "2026-11-02T13:00:00Z" }), {
    expectedId: "core-review",
  });
  assert.equal(withTime.ok, false);
  assert.ok(withTime.diagnostics.some((item) => item.code === "invalid-as-of"));
});

test("核对：缺策略会拦下，核对不到不算缺", () => {
  const roster = { id: "core-review", version: "1.2.0" };
  const capabilities = validateCapabilities(
    capabilitiesDocument({
      requires: { skills: ["frontend-skill"], toolPolicies: ["member-safe"] },
    }),
    { expectedId: "core-review" },
  ).capabilities;

  // 没有任何证据源：两项都记 unchecked，既不拦也不冒充通过。
  const noEvidence = checkCapabilities([roster], { "core-review": capabilities }, {});
  assert.equal(noEvidence.summary.missing, 0);
  assert.equal(noEvidence.summary.unknown, 2);
  assert.equal(noEvidence.entries[0].blocked, false);
  assert.equal(noEvidence.entries[0].status, "unchecked");

  // 策略声明齐了、技能服务没挂：只有策略算核对过。
  const partial = checkCapabilities([roster], { "core-review": capabilities }, { knownToolPolicies: ["member-safe"] });
  assert.equal(partial.entries[0].missing.length, 0);
  assert.equal(partial.entries[0].unknown.length, 1);
  assert.equal(partial.entries[0].status, "unchecked");

  // 证据源说没有：refuse 下 blocked，degraded 下只记 degraded。
  const blocked = checkCapabilities([roster], { "core-review": capabilities }, {
    knownSkills: ["other-skill"],
    knownToolPolicies: ["member-safe"],
  });
  assert.equal(blocked.entries[0].blocked, true);
  assert.equal(blocked.summary.blocked, 1);

  const degraded = checkCapabilities([roster], { "core-review": { ...capabilities, onMissing: "degraded" } }, {
    knownSkills: ["other-skill"],
    knownToolPolicies: ["member-safe"],
  });
  assert.equal(degraded.entries[0].blocked, false);
  assert.equal(degraded.entries[0].status, "degraded");
  assert.equal(degraded.summary.degraded, 1);
});

test("roster_create：缺能力时拒绝出参数，并说清怎么补", async () => {
  const library = makeLibrary({
    "core-review/roster.json": rosterDocument(),
    "core-review/capabilities.yaml": [
      "kind: dsh-agent-roster-capabilities/v1",
      "roster: core-review",
      "onMissing: refuse",
      "requires:",
      "  toolPolicies:",
      "    - member-safe",
      "",
    ].join("\n"),
  });
  try {
    // knownToolPolicies 为空 ⇒ 证据源缺席 ⇒ 只记"核对不到"，不拦。
    const noEvidence = await call(register(), "roster_create", { ref: "core-review", path: library.rootDir });
    assert.equal(noEvidence.value.ok, true);
    assert.equal(noEvidence.value.capabilities.status, "unchecked");

    // 声明了策略、但部署里没有它 ⇒ 拦下，且不生成任何参数。
    const blocked = await call(register({ knownToolPolicies: ["readonly"] }), "roster_create", {
      ref: "core-review",
      path: library.rootDir,
    });
    assert.equal(blocked.value.ok, false);
    assert.equal(blocked.value.blocked, true);
    assert.equal(blocked.value.calls, undefined);
    assert.match(blocked.text, /能力闸门/);
    assert.match(blocked.text, /怎么补/);
    assert.match(blocked.text, /knownToolPolicies/);

    // 策略在位 ⇒ 照常出参数。
    const passed = await call(register({ knownToolPolicies: ["readonly", "member-safe"] }), "roster_create", {
      ref: "core-review",
      path: library.rootDir,
    });
    assert.equal(passed.value.ok, true);
    assert.equal(passed.value.calls.length, 2);
  } finally {
    library.cleanup();
  }
});

test("roster_create：onMissing: degraded 时出参数但留账", async () => {
  const library = makeLibrary({
    "core-review/roster.json": rosterDocument(),
    "core-review/capabilities.yaml": [
      "kind: dsh-agent-roster-capabilities/v1",
      "roster: core-review",
      "onMissing: degraded",
      "requires:",
      "  toolPolicies: [member-safe]",
      "",
    ].join("\n"),
  });
  try {
    const { value, text } = await call(register({ knownToolPolicies: [] }), "roster_create", {
      ref: "core-review",
      path: library.rootDir,
    });
    // knownToolPolicies 为空 ⇒ 核对不到，不是缺失 ⇒ 连 degraded 都不该记。
    assert.equal(value.ok, true);
    assert.equal(value.capabilities.status, "unchecked");

    const withEvidence = await call(register({ knownToolPolicies: ["readonly", "other"] }), "roster_create", {
      ref: "core-review",
      path: library.rootDir,
    });
    assert.equal(withEvidence.value.ok, true);
    assert.equal(withEvidence.value.capabilities.status, "degraded");
    assert.match(withEvidence.text, /缺 1 项/);
    void text;
  } finally {
    library.cleanup();
  }
});

test("roster_verify：能力要求进状态行与摘要", async () => {
  const library = makeLibrary({
    "core-review/roster.json": rosterDocument(),
    "core-review/capabilities.yaml": [
      "kind: dsh-agent-roster-capabilities/v1",
      "roster: core-review",
      "requires:",
      "  toolPolicies: [member-safe]",
      "",
    ].join("\n"),
  });
  const state = makeLibrary({});
  try {
    const { value, firstLine, text } = await call(register({ knownToolPolicies: ["readonly", "other"] }), "roster_verify", {
      path: library.rootDir,
      stateDir: state.rootDir,
    });
    assert.match(firstLine, /requires=1missing\/1/);
    assert.equal(value.summary.capabilityDeclared, 1);
    assert.equal(value.summary.capabilityMissing, 1);
    assert.equal(value.summary.capabilityBlocked, 1);
    assert.equal(value.capabilities.entries[0].rosterId, "core-review");
    assert.match(text, /能力要求 {2}要求 1 · 缺 1/);
  } finally {
    library.cleanup();
    state.cleanup();
  }
});

test("schema：capabilities.v1.schema.json 的取值来自运行时常量，不是另抄一份", () => {
  const schema = JSON.parse(readFileSync(path.join(root, "schema/capabilities.v1.schema.json"), "utf8"));
  assert.equal(schema.properties.kind.const, CAPABILITIES_KIND);
  assert.deepEqual(schema.properties.onMissing.enum, [...ON_MISSING]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.requires.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["$schema", "asOf", "kind", "notes", "onMissing", "requires", "roster"]);
  assert.deepEqual(Object.keys(schema.properties.requires.properties).sort(), ["documents", "skills", "toolPolicies"]);
  assert.equal(schema.properties.requires.properties.documents.items.$ref, "#/$defs/documentRequirement");
  assert.equal(schema.$defs.id.pattern, ID_PATTERN.source);
  assert.equal(schema.$defs.skillName.pattern, SKILL_PATTERN.source);
  assert.equal(schema.$defs.policyId.pattern, ID_PATTERN.source);
  assert.equal(schema.properties.requires.properties.skills.items.$ref, "#/$defs/skillRequirement");
  assert.equal(schema.properties.requires.properties.toolPolicies.items.$ref, "#/$defs/policyRequirement");
  const maxItems = schema.properties.requires.properties.skills.maxItems;
  assert.equal(maxItems, LIMITS.requirements);
  assert.equal(schema.properties.requires.properties.toolPolicies.maxItems, LIMITS.requirements);
  assert.equal(schema.properties.notes.maxLength, LIMITS.notesChars);
  const reason = schema.$defs.skillRequirement.oneOf[1].properties.reason;
  assert.equal(reason.maxLength, LIMITS.reasonChars);
});

test("扫描：能力文件写坏了不会连累档案本身", () => {
  const library = makeLibrary({
    "core-review/roster.json": rosterDocument(),
    "core-review/capabilities.yaml": "kind: dsh-agent-roster-capabilities/v1\nroster: core-review\nrequires:\n  models: [deepseek-flash]\n",
  });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir, knownToolPolicies: [] });
    // 档案照旧可用：缺的是"要求"这份文档，不是成员。
    assert.equal(scan.rosters.length, 1);
    assert.equal(scan.entries[0].capabilities, null);
    assert.equal(scan.capabilities["core-review"], undefined);
    const error = scan.diagnostics.find((item) => item.severity === "error");
    assert.equal(error.code, "unknown-field");
    assert.equal(error.file, "core-review/capabilities.yaml");
  } finally {
    library.cleanup();
  }
});

test("扫描：没有能力文件是正常状态，不产生任何诊断", () => {
  const library = makeLibrary({ "core-review/roster.json": rosterDocument() });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir, knownToolPolicies: ["readonly"] });
    assert.equal(scan.capabilities["core-review"], undefined);
    assert.deepEqual(scan.diagnostics, []);
  } finally {
    library.cleanup();
  }
});

test("面板诊断：缺策略时按 onMissing 给严重度（refuse=error / degraded=warn）", () => {
  const capabilities = {
    requires: { skills: [], toolPolicies: [{ name: "member-safe", reason: null }] },
    onMissing: "refuse",
  };
  const [refused] = capabilityDiagnostics({ "core-review": capabilities }, { "core-review": "core-review/capabilities.yaml" }, ["readonly"]);
  assert.equal(refused.code, "capability-policy-missing");
  assert.equal(refused.severity, "error");
  assert.equal(refused.file, "core-review/capabilities.yaml");
  assert.match(refused.reason, /member-safe/);
  assert.match(refused.reason, /建队会被拒绝/);

  const [degraded] = capabilityDiagnostics(
    { "core-review": { ...capabilities, onMissing: "degraded" } },
    {},
    ["readonly"],
  );
  assert.equal(degraded.severity, "warn");
  assert.match(degraded.reason, /建队照常/);

  // 策略齐备 ⇒ 不出诊断。
  assert.deepEqual(capabilityDiagnostics({ "core-review": capabilities }, {}, ["readonly", "member-safe"]), []);
});

test("面板诊断：技能要求只标「不判定」，不冒充通过也不算缺", () => {
  const [item] = capabilityDiagnostics(
    { "core-review": { requires: { skills: [{ name: "frontend-skill", reason: null }], toolPolicies: [] } } },
    {},
    [],
  );
  assert.equal(item.code, "capability-skills-unverified");
  assert.equal(item.severity, "info");
  assert.match(item.reason, /roster_verify/);
});

test("面板诊断：证据源缺席时汇总成一条，而不是逐档案刷噪音", () => {
  const capabilities = { requires: { skills: [], toolPolicies: [{ name: "member-safe", reason: null }] } };
  const items = capabilityDiagnostics({ a: capabilities, b: capabilities }, {}, null);
  assert.equal(items.length, 1);
  assert.equal(items[0].code, "capability-cross-check-skipped");
  assert.equal(items[0].severity, "info");
  assert.match(items[0].reason, /a/);
  assert.match(items[0].reason, /b/);
});

test("文档要求：在 / 缺 / 哈希不符 / 没有证据源，四种结果互不冒充", () => {
  const sha = "a".repeat(64);
  const doc = capabilitiesDocument({
    requires: { skills: [], toolPolicies: [], documents: [{ path: "docs/runbook.md", sha256: sha }] },
  });
  const validated = validateCapabilities(doc, { expectedId: "core-review" });
  assert.equal(validated.ok, true, JSON.stringify(validated.diagnostics, null, 2));
  assert.deepEqual(validated.capabilities.requires.documents, [{ path: "docs/runbook.md", sha256: sha, reason: null }]);

  const rosters = [{ id: "core-review", version: "1.0.0" }];
  const caps = { "core-review": validated.capabilities };

  const present = checkCapabilities(rosters, caps, {
    documents: { "core-review": { "docs/runbook.md": { exists: true, sha256: sha } } },
  });
  assert.equal(present.entries[0].blocked, false);
  assert.equal(present.summary.present, 1);
  assert.equal(present.summary.missing, 0);

  const missing = checkCapabilities(rosters, caps, {
    documents: { "core-review": { "docs/runbook.md": { exists: false, sha256: "" } } },
  });
  assert.equal(missing.entries[0].blocked, true);
  assert.equal(missing.entries[0].missing[0].why, "file-missing");

  const drifted = checkCapabilities(rosters, caps, {
    documents: { "core-review": { "docs/runbook.md": { exists: true, sha256: "b".repeat(64) } } },
  });
  assert.equal(drifted.entries[0].blocked, true);
  assert.equal(drifted.entries[0].missing[0].why, "sha-mismatch");

  // 没有证据源：不翻红，也不算过。
  const unchecked = checkCapabilities(rosters, caps, {});
  assert.equal(unchecked.entries[0].blocked, false);
  assert.equal(unchecked.summary.unknown, 1);
  assert.equal(unchecked.entries[0].status, "unchecked");
});

test("文档要求：路径必须是库内相对路径，拒绝对路径与 ../", () => {
  for (const bad of ["/etc/passwd", "../secret.md", "docs/../../x.md"]) {
    const doc = capabilitiesDocument({
      requires: { skills: [], toolPolicies: [], documents: [{ path: bad }] },
    });
    const result = validateCapabilities(doc, { expectedId: "core-review" });
    assert.equal(result.ok, false, `${bad} 应该被拒`);
    assert.ok(result.diagnostics.some((item) => item.code === "invalid-document-path"));
  }
});

test("文档要求：sha256 必须是 64 位小写十六进制", () => {
  const doc = capabilitiesDocument({
    requires: { skills: [], toolPolicies: [], documents: [{ path: "docs/runbook.md", sha256: "ABC" }] },
  });
  const result = validateCapabilities(doc, { expectedId: "core-review" });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === "invalid-document-sha"));
});
