/**
 * 来源账本与更新检测。
 *
 * 这里锁的是"六态"与"不自动合并"：本地改、远端改、两边都改、远端删除、本地缺失，
 * 必须各自给出不同状态；快进只碰 remote-only，冲突一律不动。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acceptLocal,
  applyFastForward,
  changeState,
  checkOrigin,
  ORIGIN_FILE,
  readOrigin,
  sha256Of,
  writeOrigin,
} from "../lib/origin.js";

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-origin-"));
  fs.mkdirSync(path.join(dir, "rosters", "demo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "rosters", "demo", "roster.yaml"), "id: demo\nversion: 1.0.0\n");
  return dir;
}

/** 假的 raw fetch：按 URL 尾部路径回放给定内容；没有的给 404。 */
function fakeFetch(files) {
  return async (url) => {
    const marker = "/main/";
    const at = String(url).indexOf(marker);
    const relative = at >= 0 ? String(url).slice(at + marker.length) : "";
    const decoded = decodeURIComponent(relative);
    if (Object.hasOwn(files, decoded)) {
      return { ok: true, status: 200, async text() { return files[decoded]; } };
    }
    return { ok: false, status: 404, async text() { return ""; } };
  };
}

test("账本：写读往返、坏文件与缺文件都不抛", () => {
  const dir = tempDir();
  const relative = "rosters/demo/roster.yaml";
  const text = fs.readFileSync(path.join(dir, ...relative.split("/")), "utf8");
  assert.equal(writeOrigin(dir, { origin: { repo: "o/r", ref: "main", path: "" }, files: { [relative]: { sha256: sha256Of(text) } } }).ok, true);
  const ledger = readOrigin(dir);
  assert.equal(ledger.kind, "dsh-agent-roster/origin@1");
  assert.equal(ledger.files[relative].sha256, sha256Of(text));
  assert.equal(readOrigin(path.join(dir, "nope")), null);

  fs.writeFileSync(path.join(dir, ORIGIN_FILE), "{ not json");
  assert.equal(readOrigin(dir).broken, true);
});

test("六态：本地改、远端改、两边改、远端删、本地缺", () => {
  assert.equal(changeState("a", "x", "x", { sha256: "x", status: 200 }), "clean");
  assert.equal(changeState("a", "x", "y", { sha256: "x", status: 200 }), "local-only");
  assert.equal(changeState("a", "x", "x", { sha256: "y", status: 200 }), "remote-only");
  assert.equal(changeState("a", "x", "y", { sha256: "y", status: 200 }), "diverged");
  assert.equal(changeState("a", "x", "x", { sha256: null, status: 404 }), "remote-deleted");
  assert.equal(changeState("a", "x", null, { sha256: "x", status: 200 }), "missing");
});

test("检查更新：远端没动就是干净；远端改了是 remote-only 并可快进", async () => {
  const dir = tempDir();
  const relative = "rosters/demo/roster.yaml";
  const base = fs.readFileSync(path.join(dir, ...relative.split("/")), "utf8");
  writeOrigin(dir, { origin: { repo: "o/r", ref: "main", path: "" }, files: { [relative]: { sha256: sha256Of(base) } } });

  const clean = await checkOrigin(dir, { fetchImpl: fakeFetch({ [relative]: base }) });
  assert.equal(clean.ok, true);
  assert.equal(clean.summary.clean, 1);
  assert.equal(clean.pending, 0);

  const next = `${base}title: 新版\n`;
  const changed = await checkOrigin(dir, { fetchImpl: fakeFetch({ [relative]: next }) });
  assert.equal(changed.summary["remote-only"], 1);

  const applied = applyFastForward(dir, changed.entries);
  assert.deepEqual(applied.applied, [relative]);
  assert.equal(fs.readFileSync(path.join(dir, ...relative.split("/")), "utf8"), next);

  const after = await checkOrigin(dir, { fetchImpl: fakeFetch({ [relative]: next }) });
  assert.equal(after.summary.clean, 1, "快进后账本要跟着更新，否则下次还会报同一处更新");
});

test("冲突：两边都改时不停在本地，快进不碰它", async () => {
  const dir = tempDir();
  const relative = "rosters/demo/roster.yaml";
  const base = fs.readFileSync(path.join(dir, ...relative.split("/")), "utf8");
  writeOrigin(dir, { origin: { repo: "o/r", ref: "main", path: "" }, files: { [relative]: { sha256: sha256Of(base) } } });
  fs.writeFileSync(path.join(dir, ...relative.split("/")), `${base}# local\n`);

  const checked = await checkOrigin(dir, { fetchImpl: fakeFetch({ [relative]: `${base}# remote\n` }) });
  assert.equal(checked.summary.diverged, 1);
  const applied = applyFastForward(dir, checked.entries);
  assert.deepEqual(applied.applied, []);
  assert.match(fs.readFileSync(path.join(dir, ...relative.split("/")), "utf8"), /# local/);
});

test("认账：把本地内容接受为新的基线", async () => {
  const dir = tempDir();
  const relative = "rosters/demo/roster.yaml";
  const base = fs.readFileSync(path.join(dir, ...relative.split("/")), "utf8");
  writeOrigin(dir, { origin: { repo: "o/r", ref: "main", path: "" }, files: { [relative]: { sha256: sha256Of(base) } } });
  const edited = `${base}# mine\n`;
  fs.writeFileSync(path.join(dir, ...relative.split("/")), edited);

  assert.equal((await checkOrigin(dir, { fetchImpl: fakeFetch({ [relative]: base }) })).summary["local-only"], 1);
  assert.deepEqual(acceptLocal(dir, [relative]).updated, [relative]);
  assert.equal((await checkOrigin(dir, { fetchImpl: fakeFetch({ [relative]: edited }) })).summary.clean, 1);
});

test("没有账本时明确说「没有基线」，不假装干净", async () => {
  const dir = tempDir();
  const result = await checkOrigin(dir, { fetchImpl: fakeFetch({}) });
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-origin-ledger");
});

test("远端没回话：记为无法核对，不算干净，也不算可快进", async () => {
  const dir = tempDir();
  const relative = "rosters/demo/roster.yaml";
  const base = fs.readFileSync(path.join(dir, ...relative.split("/")), "utf8");
  writeOrigin(dir, { origin: { repo: "o/r", ref: "main", path: "" }, files: { [relative]: { sha256: sha256Of(base) } } });

  const offline = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  const checked = await checkOrigin(dir, { fetchImpl: offline });
  assert.equal(checked.ok, true);
  assert.equal(checked.summary.unverified, 1, "网络失败必须显式记成 unverified");
  assert.equal(checked.summary.clean, 0, "没核对上不能算干净");
  assert.equal(checked.fastForward, 0);
  assert.match(checked.text, /无法核对/);
});

test("可快进数与待处理数分开：冲突进 pending，不进 fastForward", async () => {
  const dir = tempDir();
  const relative = "rosters/demo/roster.yaml";
  const base = fs.readFileSync(path.join(dir, ...relative.split("/")), "utf8");
  writeOrigin(dir, { origin: { repo: "o/r", ref: "main", path: "" }, files: { [relative]: { sha256: sha256Of(base) } } });
  fs.writeFileSync(path.join(dir, ...relative.split("/")), `${base}# local\n`);

  const checked = await checkOrigin(dir, { fetchImpl: fakeFetch({ [relative]: `${base}# remote\n` }) });
  assert.equal(checked.summary.diverged, 1);
  assert.equal(checked.pending, 1);
  assert.equal(checked.fastForward, 0, "冲突不能被面板当成「一键应用」");
});
