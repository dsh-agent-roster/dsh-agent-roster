/**
 * 索引缓存的两条纪律。
 *
 * 1. 缓存存的是**索引的形状**，形状会随版本变（0.10.3 给 collection 加了 `files`）。
 *    不认版本号的缓存会在升级后继续喂旧形状 —— 用户看到的是"装了新版仍然 404"。
 * 2. 拉取失败时要说人话：没有 `files` 映射却回退到 v1 路径，最可能的原因是索引旧了。
 *
 * @module test/cache
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CACHE_VERSION, cachePathFor, fetchCollection, loadRegistry } from "../lib/remote.js";

const REGISTRY = {
  kind: "dsh-agent-roster-registry/v1",
  collections: [
    { id: "demo", repo: "github:someone/demo", path: "examples", rosters: ["core-review"], files: { "core-review": "dist/core-review-1.0.0.json" } },
  ],
};

function source(id = "demo") {
  return { id, kind: "url", url: "https://example.com/registry.json", ttlMs: 3_600_000 };
}

test("缓存版本不匹配时重取，而不是继续用旧形状的索引", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cache-version-"));
  try {
    const file = cachePathFor(cacheDir, "demo");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ cacheVersion: CACHE_VERSION - 1, fetchedAt: Date.now(), document: { kind: "dsh-agent-roster-registry/v1", collections: [] } }));

    let calls = 0;
    const loaded = await loadRegistry(source(), {
      cacheDir,
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify(REGISTRY), headers: { get: () => "application/json" } };
      },
    });

    assert.equal(calls, 1, "旧版本的缓存应当被当成没有缓存");
    assert.equal(loaded.collections.length, 1);
    assert.deepEqual(loaded.collections[0].files, { "core-review": "dist/core-review-1.0.0.json" });
    // 新缓存带上当前版本号。
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).cacheVersion, CACHE_VERSION);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("索引没有 files 又拉取失败：提示索引可能旧了，而不是只说 404", async () => {
  const fetched = await fetchCollection(
    { id: "demo", repo: "github:someone/demo", path: "examples", rosters: ["core-review"] },
    { fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" }) },
  );
  const codes = fetched.diagnostics.map((item) => item.code);
  assert.ok(codes.includes("collection-fetch-failed"));
  assert.ok(codes.includes("index-may-be-stale"), `实际诊断：${codes.join(", ")}`);
  const hint = fetched.diagnostics.find((item) => item.code === "index-may-be-stale");
  assert.match(hint.reason, /\.index-cache|刷新/);
  assert.equal(fetched.rosters.length, 0);
});
