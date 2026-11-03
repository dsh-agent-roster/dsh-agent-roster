/**
 * v2 三个 schema 与运行时权威常量的对齐测试。
 *
 * 这些 schema 是给编辑器和外部工具看的，**权威实现是 lib/role.js / lib/roster2.js / lib/compile2.js**。
 * 两份东西各写一遍必然漂移（v1 的 registry schema 就悬空过整整两周），所以这里把
 * 「字段集合 / required / 枚举 / 上限 / 判别键」逐条钉死：改常量不改 schema 会红，反之亦然。
 *
 * @module test/v2-schema
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { PATTERNS, REASONING_EFFORTS } from "../lib/format.js";
import {
  CAPTAIN2_FIELDS,
  COMPILED_KIND,
  DEFAULTS2_FIELDS,
  DEFAULT_ON_MISSING,
  GATE_FIELDS,
  LIMITS2,
  MEMBER2_FIELDS,
  MEMBER_PROMPT_FIELDS,
  ON_MISSING,
  ORCHESTRATION_FIELDS,
  ORCHESTRATION_SHAPES,
  PROMPT_FIELDS,
  REQUIRES_FIELDS,
  ROLE_FIELDS,
  ROLE_KIND,
  ROLE_REF,
  ROLE_REQUIRED,
  ROSTER2_FIELDS,
  ROSTER2_KIND,
  ROSTER2_REQUIRED,
  ROUTE_FIELDS,
  STAGE_FIELDS,
  TARGETS,
  TOOLS_FIELDS,
  TOOL_SCOPE_FIELDS,
} from "../lib/format-v2.js";

const root = nodePath.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const readJson = (relative) => JSON.parse(readFileSync(nodePath.join(root, relative), "utf8"));
const keysOf = (object) => Object.keys(object).sort();
const sameSet = (actual, expected, label) =>
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label} 字段集合不一致`);

const role = readJson("schema/role.v1.schema.json");
const roster = readJson("schema/roster.v2.schema.json");
const compiled = readJson("schema/compiled.v1.schema.json");

test("v2 schema：三个文件都存在，$id 指向本仓同路径，判别键与常量一致", () => {
  for (const [file, schema, kind] of [
    ["schema/role.v1.schema.json", role, ROLE_KIND],
    ["schema/roster.v2.schema.json", roster, ROSTER2_KIND],
    ["schema/compiled.v1.schema.json", compiled, COMPILED_KIND],
  ]) {
    assert.ok(existsSync(nodePath.join(root, file)), `${file} 不存在`);
    assert.ok(schema.$id.endsWith(`/${file}`), `${file} 的 $id 必须指向自己：${schema.$id}`);
    assert.equal(schema.properties.kind.const, kind, `${file} 的判别键与常量不一致`);
    assert.equal(schema.additionalProperties, false, `${file} 必须是闭集`);
  }
});

test("role schema：顶层字段、required、子结构与常量一致", () => {
  sameSet(keysOf(role.properties), ROLE_FIELDS, "role 顶层");
  sameSet(role.required, ROLE_REQUIRED, "role required");
  sameSet(keysOf(role.$defs.route.properties), ROUTE_FIELDS, "route");
  sameSet(keysOf(role.$defs.tools.properties), TOOLS_FIELDS, "tools");
  sameSet(keysOf(role.$defs.scope.properties), TOOL_SCOPE_FIELDS, "tools.scope");
  sameSet(keysOf(role.$defs.prompt.properties), PROMPT_FIELDS, "prompt");
  sameSet(keysOf(role.$defs.requires.properties), REQUIRES_FIELDS, "requires");
  sameSet(role.properties.onMissing.enum, ON_MISSING, "onMissing");
  sameSet(role.$defs.effort.enum, REASONING_EFFORTS, "reasoningEffort");
  assert.equal(role.$defs.id.pattern, PATTERNS.id.source, "id pattern 与 PATTERNS.id 不一致");
  assert.equal(role.$defs.semver.pattern, PATTERNS.semver.source, "semver pattern 不一致");
  assert.equal(role.$defs.provider.pattern, PATTERNS.provider.source, "provider pattern 不一致");
  assert.equal(role.$defs.model.pattern, PATTERNS.model.source, "model pattern 不一致");
  assert.equal(
    role.properties.onMissing.description.includes(DEFAULT_ON_MISSING),
    true,
    "onMissing 的描述必须写出默认值",
  );
});

test("roster schema：顶层字段、required、成员/队长/编排子结构与常量一致", () => {
  sameSet(keysOf(roster.properties), ROSTER2_FIELDS, "roster 顶层");
  sameSet(roster.required, ROSTER2_REQUIRED, "roster required");
  sameSet(keysOf(roster.$defs.defaults.properties), DEFAULTS2_FIELDS, "defaults");
  sameSet(keysOf(roster.$defs.member.properties), MEMBER2_FIELDS, "member");
  sameSet(keysOf(roster.$defs.memberPrompt.properties), MEMBER_PROMPT_FIELDS, "member.prompt");
  sameSet(keysOf(roster.$defs.captain.properties), CAPTAIN2_FIELDS, "captain");
  sameSet(keysOf(roster.$defs.orchestration.properties), ORCHESTRATION_FIELDS, "orchestration");
  sameSet(keysOf(roster.$defs.stage.properties), STAGE_FIELDS, "orchestration.stages[]");
  sameSet(keysOf(roster.$defs.gate.properties), GATE_FIELDS, "orchestration.gates[]");
  sameSet(roster.properties.targets.items.enum, TARGETS, "targets");
  sameSet(roster.$defs.orchestration.properties.shape.enum, ORCHESTRATION_SHAPES, "orchestration.shape");
  assert.equal(roster.$defs.roleRef.pattern, ROLE_REF.source, "角色引用 pattern 与 ROLE_REF 不一致");
});

test("roster schema：上限与 LIMITS2 同值（不各写一个数）", () => {
  assert.equal(roster.properties.members.maxItems, LIMITS2.members);
  assert.equal(roster.properties.members.minItems, 1);
  assert.equal(roster.properties.title.maxLength, LIMITS2.titleChars);
  assert.equal(roster.properties.description.maxLength, LIMITS2.descriptionChars);
  assert.equal(roster.properties.notes.maxLength, LIMITS2.notesChars);
  assert.equal(roster.properties.maintainers.maxItems, LIMITS2.maintainers);
  assert.equal(roster.properties.tags.maxItems, LIMITS2.tagsPerRole);
  assert.equal(roster.$defs.orchestration.properties.stages.maxItems, LIMITS2.stages);
  assert.equal(roster.$defs.orchestration.properties.gates.maxItems, LIMITS2.gates);
  assert.equal(roster.$defs.stage.properties.parallel.maxItems, LIMITS2.members);
  assert.equal(roster.$defs.stage.properties.serial.maxItems, LIMITS2.members);
  assert.equal(roster.$defs.stage.properties.maxRounds.maximum, LIMITS2.maxRounds);
  assert.equal(role.$defs.prompt.properties.parts.maxItems, LIMITS2.parts);
  assert.equal(role.properties.title.maxLength, LIMITS2.titleChars);
  assert.equal(role.properties.description.maxLength, LIMITS2.descriptionChars);
  assert.equal(role.properties.notes.maxLength, LIMITS2.notesChars);
  assert.equal(role.properties.maintainers.maxItems, LIMITS2.maintainers);
  assert.equal(role.properties.tags.maxItems, LIMITS2.tagsPerRole);
  assert.equal(role.properties.skills.maxItems, LIMITS2.skillsPerRole);
});

test("compiled schema：产物必备字段与声明状态（编排不伪装成已执行）", () => {
  sameSet(compiled.required, ["kind", "source", "members", "declarations"], "compiled required");
  sameSet(
    compiled.$defs.member.required,
    ["name", "role", "executionPrompt", "promptStats", "provenance"],
    "compiled member required",
  );
  sameSet(
    keysOf(compiled.$defs.member.properties.promptStats.properties.parts.items.properties),
    ["path", "kind"],
    "promptStats.parts[]",
  );
  assert.equal(
    compiled.$defs.member.properties.promptStats.properties.sha256.pattern,
    "^[0-9a-f]{64}$",
    "人设哈希是全量 sha256，不是短码",
  );
  assert.equal(
    compiled.$defs.member.properties.provenance.properties.sha256.pattern,
    "^[0-9a-f]{8}$",
    "provenance 用 8 位短码，和 team.description 里的溯源串同形",
  );
  assert.equal(compiled.properties.orchestration.properties.status.const, "declaration");
  sameSet(
    keysOf(compiled.properties.declarations.items.properties),
    ["scope", "member", "field", "note"],
    "declarations[]",
  );
  sameSet(compiled.properties.declarations.items.required, ["field", "note"], "declarations required");
  assert.equal(compiled.properties.kind.const, COMPILED_KIND);
});
