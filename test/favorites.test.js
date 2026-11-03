import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import {
  FAVORITES_FILE,
  FAVORITES_KIND,
  addFavorites,
  favoriteDiagnostic,
  readFavorites,
  setFavorite,
  writeFavorites,
} from "../lib/favorites.js";

function tempRoot() {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), "roster-favorites-"));
}

test("收藏：写进去读出来是同几份，文件是固定形状", () => {
  const root = tempRoot();
  const written = writeFavorites(root, ["data-quality", "api-design"]);
  assert.equal(written.ok, true);
  assert.deepEqual(written.favorites, ["api-design", "data-quality"], "写盘时排序，diff 才稳定");

  const file = JSON.parse(fs.readFileSync(nodePath.join(root, FAVORITES_FILE), "utf8"));
  assert.equal(file.kind, FAVORITES_KIND);
  assert.deepEqual(file.favorites, ["api-design", "data-quality"]);

  const read = readFavorites(root);
  assert.deepEqual([...read.ids].sort(), ["api-design", "data-quality"]);
  assert.equal(read.broken, false);
});

test("收藏：没人点过就是空的，且不报错", () => {
  const root = tempRoot();
  const read = readFavorites(root);
  assert.equal(read.ids.size, 0);
  assert.equal(read.present, false);
  assert.equal(favoriteDiagnostic(root, read), null, "文件不存在不算问题，不该在体检里冒 warn");
});

test("收藏：坏文件按空处理，但必须留一条 warn", () => {
  const root = tempRoot();
  fs.writeFileSync(nodePath.join(root, FAVORITES_FILE), "{ 这不是 JSON", "utf8");
  const read = readFavorites(root);
  assert.equal(read.ids.size, 0);
  assert.equal(read.broken, true);
  const diagnostic = favoriteDiagnostic(root, read);
  assert.equal(diagnostic.severity, "warn");
  assert.equal(diagnostic.code, "favorites-unreadable");

  // 点一次收藏就把文件重写成标准形状：坏文件不该需要手工修。
  const fixed = setFavorite(root, "api-design", true);
  assert.equal(fixed.ok, true);
  assert.equal(readFavorites(root).broken, false);
});

test("收藏：手写数组也认，但不像 id 的值直接丢掉", () => {
  const root = tempRoot();
  fs.writeFileSync(nodePath.join(root, FAVORITES_FILE), JSON.stringify(["api-design", "../etc", "A B", "x"]), "utf8");
  const read = readFavorites(root);
  assert.deepEqual([...read.ids], ["api-design"], "只有合法的档案 id 才配当收藏");
});

test("收藏：取消与重复收藏都是幂等的", () => {
  const root = tempRoot();
  setFavorite(root, "api-design", true);
  setFavorite(root, "api-design", true);
  assert.deepEqual(readFavorites(root).ids.size, 1);
  setFavorite(root, "api-design", false);
  assert.deepEqual(readFavorites(root).ids.size, 0);
  // 取消一份本来就没收藏的：不报错，也不写坏。
  const again = setFavorite(root, "api-design", false);
  assert.equal(again.ok, true);
});

test("收藏：保存/导入后批量加，已有的不会被冲掉", () => {
  const root = tempRoot();
  setFavorite(root, "api-design", true);
  addFavorites(root, ["data-quality", "", "api-design"]);
  assert.deepEqual([...readFavorites(root).ids].sort(), ["api-design", "data-quality"]);
});

test("收藏：非法 id 直接拒绝，不写盘", () => {
  const root = tempRoot();
  const result = setFavorite(root, "../escape", true);
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid-id");
  assert.equal(fs.existsSync(nodePath.join(root, FAVORITES_FILE)), false);
});
