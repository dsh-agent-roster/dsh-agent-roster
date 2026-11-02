/**
 * registry schema 与运行时权威校验的对齐测试。
 *
 * 索引文件的 `$schema` 曾指向一个不存在的文件（`schema/registry.v1.schema.json` 根本没建），
 * 编辑器与外部工具因此拿不到任何提示。这个测试钉住三件事：
 * 1. `index/registry.json` 的 `$schema` 真的能解析到仓库里的一份文件；
 * 2. schema 里出现的字段集合与 `REGISTRY_FIELDS` / `COLLECTION_FIELDS` 一致（不多不少）；
 * 3. 关键 pattern 与上限跟 `PATTERNS` / `LIMITS` 同义（不各写一份正则）。
 *
 * @module test/registry-schema
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { COLLECTION_FIELDS, LIMITS, PATTERNS, REGISTRY_FIELDS, REGISTRY_KIND } from "../lib/format.js";

const root = nodePath.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const readJson = (relative) => JSON.parse(readFileSync(nodePath.join(root, relative), "utf8"));

test("registry：索引里的 $schema 指向仓库内真实存在的文件", () => {
  const registry = readJson("index/registry.json");
  assert.equal(typeof registry.$schema, "string");
  const resolved = nodePath.resolve(root, "index", registry.$schema);
  assert.doesNotThrow(() => readFileSync(resolved, "utf8"), `$schema 指向的文件不存在：${registry.$schema}`);
});

test("registry schema：字段集合与运行时常量一致", () => {
  const schema = readJson("schema/registry.v1.schema.json");
  const top = Object.keys(schema.properties).sort();
  const expectedTop = ["$schema", ...REGISTRY_FIELDS.filter((key) => key !== "$schema")].sort();
  assert.deepEqual(top, expectedTop);

  const collection = Object.keys(schema.properties.collections.items.properties).sort();
  assert.deepEqual(collection, [...COLLECTION_FIELDS].sort());
  assert.equal(schema.properties.kind.const, REGISTRY_KIND);
});

test("registry schema：上限与运行时 LIMITS 一致", () => {
  const schema = readJson("schema/registry.v1.schema.json");
  const item = schema.properties.collections.items;
  assert.equal(schema.properties.collections.maxItems, LIMITS.collections);
  assert.equal(item.properties.rosters.maxItems, LIMITS.rostersPerCollection);
  assert.equal(item.properties.tags.maxItems, LIMITS.tagsPerEntry);
  assert.equal(item.properties.tags.items.pattern, PATTERNS.tag.source);
  assert.equal(item.properties.homepage.pattern, "^https?://\\S+$");
});

test("registry schema：id / repo / ref / path 的正则与运行时同义", () => {
  const schema = readJson("schema/registry.v1.schema.json");
  const item = schema.properties.collections.items;

  const pairs = [
    ["id", new RegExp(schema.$defs.id.pattern), PATTERNS.id, ["core-review", "a1", "Bad-Id", "x", "-y"]],
    ["repo", new RegExp(item.properties.repo.pattern), PATTERNS.repo, ["github:STofone/dsh-agent-roster", "owner/repo", "no-slash", "github:/x"]],
    ["ref", new RegExp(item.properties.ref.pattern), PATTERNS.ref, ["main", "v0.7.0", "0123456789abcdef0123456789abcdef01234567", "..", "a b"]],
    ["path", new RegExp(item.properties.path.pattern), PATTERNS.relPath, ["rosters", "orgs/agent-roster-collective", "", "../escape", "a\\b"]],
  ];

  for (const [label, fromSchema, fromRuntime, samples] of pairs) {
    for (const sample of samples) {
      assert.equal(fromSchema.test(sample), fromRuntime.test(sample), `${label} 正则不一致：${sample}`);
    }
  }
});
