import test from "node:test";
import assert from "node:assert/strict";
import { searchRosters, searchableFields, tokenize } from "../lib/search.js";

function roster(overrides = {}) {
  return {
    id: "data-quality",
    title: "数据质量巡检",
    description: "盯住日线的空值、跳变与重复，产出可复现的体检单。",
    tags: ["data", "quality"],
    members: [{ name: "guard", role: "数据质量工程师", title: "查表的人" }],
    ...overrides,
  };
}

const local = (r) => ({ scope: "local", roster: r, libraryId: "/tmp/lib" });

test("搜索：id 命中排在描述命中前面", () => {
  const byId = searchRosters("data", [local(roster())]);
  const byDescription = searchRosters("复现", [
    local(roster({ id: "release-manager", title: "发布", description: "产出可复现的体检单" })),
  ]);
  assert.equal(byId.matches.length, 1);
  assert.equal(byId.matches[0].rosterId, "data-quality");
  assert.ok(byId.matches[0].score > byDescription.matches[0].score);
});

test("搜索：多个词是「且」，缺一个就不入选", () => {
  const hit = searchRosters("data quality", [local(roster())]);
  assert.equal(hit.matches.length, 1);
  const miss = searchRosters("data kubernetes", [local(roster())]);
  assert.equal(miss.matches.length, 0);
  assert.deepEqual(miss.tokens, ["data", "kubernetes"]);
});

test("搜索：命中要说出处，标签命中的是那一条标签", () => {
  const result = searchRosters("quality", [local(roster())]);
  assert.equal(result.matches.length, 1);
  const [first] = result.matches[0].hits;
  assert.equal(first.field, "tags");
  assert.equal(first.label, "标签");
  assert.equal(first.text, "quality");
});

test("搜索：成员角色也算能力线索", () => {
  const result = searchRosters("工程师", [local(roster())]);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].hits[0].field, "memberRole");
});

test("搜索：本地与远端一起排，远端带集合名", () => {
  const entries = [
    local(roster({ id: "data-quality-local" })),
    { scope: "remote", roster: roster({ id: "data-quality" }), collectionId: "collective", collectionTitle: "集体" },
  ];
  const result = searchRosters("data quality", entries);
  assert.equal(result.matches.length, 2);
  const remote = result.matches.find((item) => item.scope === "remote");
  assert.equal(remote.collectionTitle, "集体");
  // 同名匹配下短 id 先出：data-quality 比 data-quality-local 更可能是"那一个"。
  assert.equal(result.matches[0].rosterId, "data-quality");
});

test("搜索：上限与空查询", () => {
  const many = Array.from({ length: 40 }, (_, index) => local(roster({ id: `data-quality-${index}` })));
  assert.equal(searchRosters("data", many, { limit: 5 }).matches.length, 5);
  assert.equal(searchRosters("data", many).matches.length, 20);
  assert.deepEqual(searchRosters("   ", many).matches, []);
  assert.deepEqual(tokenize("数据、质量 quality"), ["数据", "质量", "quality"]);
  assert.deepEqual(searchableFields(null), []);
});
