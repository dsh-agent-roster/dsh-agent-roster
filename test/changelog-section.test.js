/**
 * Release 正文的唯一来源是 CHANGELOG：这些断言守住「取哪一段」与「取不到就不发」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { changelogSection, normalizeVersion } from "../scripts/changelog-section.mjs";

const SAMPLE = `# Changelog

## [1.34.0] - 2026-11-16

### Added

- 交接文件写明旧会话在哪。

## [1.33.1] - 2026-11-16

### Fixed

- 人设档案能过 v1 校验。

[1.34.0]: https://example.com/compare/v1.33.1...v1.34.0
`;

test("normalizeVersion：只认带不带的 v 与三段版本号", () => {
  assert.equal(normalizeVersion("v1.34.0"), "1.34.0");
  assert.equal(normalizeVersion(" 1.2.3 "), "1.2.3");
  assert.equal(normalizeVersion("1.2"), "");
  assert.equal(normalizeVersion("main"), "");
});

test("changelogSection：标题行之后到下一个小节之前，且不带尾部链接定义", () => {
  const section = changelogSection(SAMPLE, "v1.34.0");
  assert.match(section, /### Added/);
  assert.match(section, /交接文件写明旧会话在哪/);
  assert.doesNotMatch(section, /1\.33\.1/);
  assert.doesNotMatch(section, /\[1\.34\.0\]:/);
});

test("changelogSection：取最后一节时停在链接定义前", () => {
  const section = changelogSection(SAMPLE, "1.33.1");
  assert.match(section, /人设档案能过 v1 校验/);
  assert.doesNotMatch(section, /^\[1\.33\.1\]:/m);
});

test("changelogSection：版本不存在就返回空串（调用方据此失败，不发空说明）", () => {
  assert.equal(changelogSection(SAMPLE, "v9.9.9"), "");
  assert.equal(changelogSection(SAMPLE, "not-a-version"), "");
});
