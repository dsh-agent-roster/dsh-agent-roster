/**
 * 展开一个采集（collection）时的两件事：并发与缓存。
 *
 * 串行的代价是真实的：21 份档案依次往返实测 2.4 秒，点「展开」就是等这段时间。
 * 并发只改变等待的形状——结果的顺序、诊断的顺序都必须和串行版本逐字一致，
 * 否则"快了"就会以"顺序漂了"为代价。
 *
 * @module test/remote-parallel
 */
import assert from "node:assert/strict";
import test from "node:test";

import { FETCH_CONCURRENCY, createTtlCache, fetchCollection } from "../lib/remote.js";

function rosterDocument(id) {
  return JSON.stringify({
    kind: "dsh-agent-roster/v1",
    roster: id,
    version: "1.0.0",
    title: id,
    members: [{ name: "lead", role: "队长", systemPrompt: `你是 ${id} 的队长。` }],
  });
}

test("并发拉取：顺序与串行一致，且在飞请求不超过上限", async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `r${String(index).padStart(2, "0")}`);
  const collection = { id: "demo", repo: "github:someone/demo", path: "examples", rosters: ids };
  let inFlight = 0;
  let peak = 0;

  const fetched = await fetchCollection(collection, {
    concurrency: 4,
    fetchImpl: async (url) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      // 路径是 .../<id>/roster.yaml
      const parts = String(url).split("/");
      const id = parts[parts.length - 2];
      return { ok: true, status: 200, text: async () => rosterDocument(id) };
    },
  });

  assert.deepEqual(fetched.rosters.map((roster) => roster.id), ids, "顺序必须与索引一致");
  assert.equal(fetched.diagnostics.length, 0);
  assert.ok(peak <= 4, `并发上限被突破：${peak}`);
  assert.ok(peak > 1, "应当真的并发，而不是排成队列");
});

test("串行版本的等待可以被并发摊掉（12 份 × 20ms）", async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `s${index}`);
  const collection = { id: "demo", repo: "github:someone/demo", rosters: ids };
  const started = Date.now();
  await fetchCollection(collection, {
    fetchImpl: async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      // 路径是 .../<id>/roster.yaml
      const parts = String(url).split("/");
      const id = parts[parts.length - 2];
      return { ok: true, status: 200, text: async () => rosterDocument(id) };
    },
  });
  const serial = 12 * 20;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < serial / 2, `并发没有带来可测的收益：${elapsed}ms vs 串行 ${serial}ms`);
  assert.ok(FETCH_CONCURRENCY >= 2);
});

test("TTL 缓存：命中、过期、clear", () => {
  let clock = 0;
  const cache = createTtlCache({ ttlMs: 1000, now: () => clock });
  assert.equal(cache.get("a"), null);
  cache.set("a", { rosters: 1 });
  assert.deepEqual(cache.get("a"), { rosters: 1 });
  clock = 999;
  assert.deepEqual(cache.get("a"), { rosters: 1 }, "未到 TTL 仍应命中");
  clock = 1000;
  assert.equal(cache.get("a"), null, "到点即失效");
  cache.set("b", 2);
  cache.clear();
  assert.equal(cache.get("b"), null);
});
