#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 取出某个版本的段落，给 GitHub Release 当正文。
 *
 * 用法：node scripts/changelog-section.mjs v1.34.0   （也接受 1.34.0）
 *
 * 为什么要有它：发版时 tag、npm、profile 都是机械动作，只有「Release 说明」容易被忘；
 * 一旦忘了，标签堆在 GitHub 上却没有一条能读的发布记录。正文只认 CHANGELOG 一处，
 * 不另写一份会漂移的说明。
 */
import fs from "node:fs";
import nodePath from "node:path";

const file = nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname), "..", "CHANGELOG.md");

/** `v1.34.0` / `1.34.0` → `1.34.0`；不是版本号就返回空串。 */
export function normalizeVersion(input) {
  const text = String(input ?? "").trim().replace(/^v/, "");
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text) ? text : "";
}

/**
 * 取 `## [x.y.z] …` 到下一个 `## [` 之间的正文（去掉标题行、去掉尾部空行）。
 * 找不到这一版返回空串——调用方据此决定是报错还是用空正文。
 */
export function changelogSection(markdown, version) {
  const wanted = normalizeVersion(version);
  if (wanted === "") return "";
  const lines = String(markdown ?? "").split("\n");
  const start = lines.findIndex((line) => new RegExp(`^## \\[${wanted.replace(/[.+]/g, "\\$&")}\\]`).test(line));
  if (start === -1) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## \[/.test(lines[index]) || /^## /.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

if (process.argv[1] && process.argv[1].endsWith("changelog-section.mjs")) {
  const version = process.argv[2];
  if (normalizeVersion(version) === "") {
    process.stderr.write("用法：node scripts/changelog-section.mjs v1.2.3\n");
    process.exit(2);
  }
  const section = changelogSection(fs.readFileSync(file, "utf8"), version);
  if (section === "") {
    process.stderr.write(`CHANGELOG 里没有 ${normalizeVersion(version)} 的段落，拒绝生成空说明\n`);
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
}
