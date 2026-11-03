/**
 * 远端取档案：索引怎么指路，取回来的东西怎么摊平。
 *
 * 两条硬约束：
 * 1. v2 组装（roster@2）的成员是角色引用，**单个文件拉不到角色目录**，索引必须指 dist/ 的编译产物；
 * 2. 取回来的编译产物要摊成 v1 内联档案，导入、桥接、面板才不用各写一套分支。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { collectionFileUrl, fetchCollection, validateRegistry } from "../lib/remote.js";
import { COMPILED_KIND, ROSTER2_KIND } from "../lib/format-v2.js";

const RAW = "https://raw.githubusercontent.com/dsh-agent-roster/dsh-agent-roster/main";

function collection(overrides = {}) {
  return {
    id: "demo",
    title: "演示集合",
    description: "",
    repo: "github:dsh-agent-roster/dsh-agent-roster",
    ref: "main",
    path: "examples",
    rosters: ["core-review"],
    files: {},
    tags: [],
    license: "",
    maintainers: [],
    homepage: "",
    ...overrides,
  };
}

function compiledDocument() {
  return {
    kind: COMPILED_KIND,
    source: { roster: "core-review", version: "1.0.0" },
    targets: ["agent-teams/members"],
    captain: {
      role: "core-review-lead-captain@1.0.0",
      provider: "deepseek",
      model: "deepseek-v4.1-flash",
      reasoningEffort: "high",
      persona: "你是队长，不写代码。",
    },
    members: [
      {
        name: "reviewer",
        role: "代码评审",
        roleRef: "core-review-reviewer@1.0.0",
        provider: "deepseek",
        model: "deepseek-v4.1-flash",
        reasoningEffort: "high",
        executionPrompt: "你是这个团队的代码评审。",
        promptStats: { chars: 12, parts: [], sha256: "a".repeat(64) },
        provenance: { role: "core-review-reviewer@1.0.0", sha256: "abcdef12" },
      },
    ],
    declarations: [],
  };
}

test("索引可以逐份指路：files 里的路径优先于 v1 的 <id>/roster.yaml", () => {
  const pinned = collection({ files: { "core-review": "dist/core-review-1.0.0.json" } });
  assert.equal(
    collectionFileUrl(pinned, "core-review", "roster.yaml"),
    `${RAW}/examples/dist/core-review-1.0.0.json`,
  );
  const fallback = collection();
  assert.equal(collectionFileUrl(fallback, "core-review", "roster.yaml"), `${RAW}/examples/core-review/roster.yaml`);
});

test("path 为空时不再拼出双斜杠", () => {
  assert.equal(collectionFileUrl(collection({ path: "" }), "core-review", "roster.yaml"), `${RAW}/core-review/roster.yaml`);
});

test("validateRegistry 读得懂 files：合法项保留，越界项告警并丢弃", () => {
  const value = {
    kind: "dsh-agent-roster-registry/v1",
    collections: [
      {
        id: "demo",
        repo: "github:dsh-agent-roster/dsh-agent-roster",
        path: "examples",
        rosters: ["core-review", "research"],
        files: { "core-review": "dist/core-review-1.0.0.json", ghost: "dist/ghost.json", research: "../secret.json" },
      },
    ],
  };
  const checked = validateRegistry(value);
  assert.equal(checked.ok, true);
  const entry = checked.registry.collections[0];
  assert.deepEqual(entry.files, { "core-review": "dist/core-review-1.0.0.json" });
  const codes = checked.diagnostics.map((item) => item.code).sort();
  assert.deepEqual(codes, ["collection-files-path", "collection-files-unknown"]);
});

test("取回编译产物：摊成 v1 内联档案，并记下它来自 compiled", async () => {
  const doc = compiledDocument();
  const seen = [];
  const fetched = await fetchCollection(collection({ files: { "core-review": "dist/core-review-1.0.0.json" } }), {
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify(doc) };
    },
  });
  assert.deepEqual(seen, [`${RAW}/examples/dist/core-review-1.0.0.json`]);
  assert.deepEqual(fetched.diagnostics, []);
  assert.equal(fetched.rosters.length, 1);
  const roster = fetched.rosters[0];
  assert.equal(roster.id, "core-review");
  assert.equal(roster.format, "compiled");
  assert.equal(roster.members[0].name, "reviewer");
  assert.equal(roster.members[0].systemPrompt, "你是这个团队的代码评审。");
  assert.equal(roster.members[0].model, "deepseek-v4.1-flash");
  assert.equal(roster.captain.name, "core-review-lead-captain");
  assert.equal(roster.captain.personaPrefix, "你是队长，不写代码。");
});

test("v2 组装单文件拉不到角色：给一条 warn，不假装取到了", async () => {
  const doc = { kind: ROSTER2_KIND, id: "core-review", version: "1.0.0", members: [{ as: "reviewer", role: "reviewer@1.0.0" }] };
  const fetched = await fetchCollection(collection(), {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(doc) }),
  });
  assert.equal(fetched.rosters.length, 0);
  assert.equal(fetched.diagnostics.length, 1);
  assert.equal(fetched.diagnostics[0].code, "collection-roster-needs-roles");
  assert.match(fetched.diagnostics[0].reason, /dist\/ 里的编译产物/);
});
