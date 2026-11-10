/**
 * 组织档案（space.yaml）的契约测试。
 *
 * 三条主线：
 * 1. **校验**：未知键、目录名不符、重复登记、非法状态都必须报错——组织页不能比磁盘乐观；
 * 2. **交叉核对**：声明了却找不到 = error，目录在却没登记 = warn，已归档仍在 = info；
 * 3. **schema 对齐**：给编辑器看的 JSON Schema 与运行时权威校验不能各写一份。
 *
 * @module test/space
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import {
  SPACE_ID_PATTERN,
  SPACE_LIMITS,
  SPACE_FIELDS,
  SPACE_KIND,
  SPACE_ROSTER_FIELDS,
  checkSpace,
  spaceDiagnostics,
  validateSpace,
} from "../lib/space.js";
import { scanRosterLibrary } from "../lib/registry.js";
import { makeLibrary, rosterDocument } from "./helpers.js";

const root = nodePath.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

/** 造一份合法组织文档，再按需覆盖。 */
function orgDocument(overrides = {}) {
  return {
    kind: SPACE_KIND,
    space: "demo-org",
    title: "示例组织",
    description: "一份用来说明组织档案长什么样的示例。",
    maintainers: ["STofone"],
    rosters: [
      { id: "core-review", title: "核心评审组", status: "active", origin: "本仓库", note: "3 名成员" },
      { id: "research", status: "archived" },
    ],
    ...overrides,
  };
}

/** 取一组诊断的 code。 */
const codes = (diagnostics) => diagnostics.map((item) => item.code);

test("space：合法文档通过校验，缺省状态补成 active", () => {
  const report = validateSpace(orgDocument(), { expectedId: "demo-org" });
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
  assert.equal(report.diagnostics.length, 0);
  assert.equal(report.space.id, "demo-org");
  assert.equal(report.space.rosters[1].status, "archived");
  assert.equal(report.space.rosters[0].origin, "本仓库");
});

test("space：kind 不对时报 space-kind", () => {
  const report = validateSpace(orgDocument({ kind: "dsh-agent-roster/v1" }));
  assert.equal(report.ok, false);
  assert.equal(report.space, null);
  assert.ok(codes(report.diagnostics).includes("space-kind"));
});

test("space：id 必须等于所在目录名（位置即身份）", () => {
  const report = validateSpace(orgDocument(), { expectedId: "other-dir" });
  assert.equal(report.ok, false);
  assert.ok(codes(report.diagnostics).includes("space-id-mismatch"));
});

test("space：未知字段一律报错，不做静默忽略", () => {
  const report = validateSpace(orgDocument({ website: "https://example.com" }));
  assert.equal(report.ok, false);
  assert.ok(codes(report.diagnostics).includes("unknown-field"));
});

test("space：登记项字段闭集，regions 之类的自造键要报错", () => {
  const report = validateSpace(
    orgDocument({ rosters: [{ id: "core-review", region: "cn" }] }),
  );
  assert.equal(report.ok, false);
  assert.ok(codes(report.diagnostics).includes("unknown-field"));
});

test("space：rosters 必须非空，重复 id 与非法状态都报错", () => {
  assert.ok(codes(validateSpace(orgDocument({ rosters: [] })).diagnostics).includes("space-rosters"));

  const duplicate = validateSpace(orgDocument({ rosters: [{ id: "core-review" }, { id: "core-review" }] }));
  assert.equal(duplicate.ok, false);
  assert.ok(codes(duplicate.diagnostics).includes("space-duplicate-roster"));

  const badStatus = validateSpace(orgDocument({ rosters: [{ id: "core-review", status: "deleted" }] }));
  assert.equal(badStatus.ok, false);
  assert.ok(codes(badStatus.diagnostics).includes("space-roster-status"));
});

test("space：homepage 只收 http(s)，别的写法报错", () => {
  assert.ok(codes(validateSpace(orgDocument({ homepage: "ftp://example.com" })).diagnostics).includes("space-homepage"));
  assert.equal(validateSpace(orgDocument({ homepage: "https://example.com/rosters" })).ok, true);
});

test("space：checkSpace 把缺、多、归档分三类", () => {
  const space = validateSpace(orgDocument(), { expectedId: "demo-org" }).space;
  const check = checkSpace(space, ["core-review", "research", "extra-one"]);
  assert.equal(check.declared, 2);
  assert.equal(check.present, 3);
  assert.deepEqual(check.missing, []);
  assert.deepEqual(check.undeclared, ["extra-one"]);
  assert.deepEqual(check.archived, ["research"]);
  assert.equal(check.status, "ok");

  const broken = checkSpace(space, ["core-review"]);
  assert.deepEqual(broken.missing, ["research"]);
  assert.equal(broken.status, "incomplete");
  assert.equal(checkSpace(null, ["core-review"]).status, "absent");
});

test("space：诊断严重度——缺是 error，多与归档不是 error", () => {
  const space = validateSpace(orgDocument(), { expectedId: "demo-org" }).space;
  const check = checkSpace(space, ["core-review", "extra-one"]);
  const diagnostics = spaceDiagnostics(space, check, "space.yaml");

  const missing = diagnostics.find((item) => item.code === "space-roster-missing");
  assert.equal(missing.severity, "error");
  assert.match(missing.reason, /research/);

  const undeclared = diagnostics.find((item) => item.code === "space-roster-undeclared");
  assert.equal(undeclared.severity, "warn");

  // 归档项要求目录真的在库里，才算 info。
  const withArchived = spaceDiagnostics(
    space,
    checkSpace(space, ["core-review", "research", "extra-one"]),
    "space.yaml",
  );
  assert.equal(withArchived.find((item) => item.code === "space-roster-archived").severity, "info");
});

test("space：扫描时组织文件不算散落文件，且交叉核对进诊断", () => {
  // 组织 id 必须等于目录名，而 mkdtemp 的随机后缀含大写字母，不是合法 id；
  // 所以在临时目录里再建一层 demo-org 当作档案库根。
  const base = mkdtempSync(nodePath.join(tmpdir(), "dsh-org-"));
  const library = nodePath.join(base, "demo-org");
  try {
    mkdirSync(nodePath.join(library, "core-review"), { recursive: true });
    writeFileSync(nodePath.join(library, "core-review", "roster.json"), `${JSON.stringify(rosterDocument(), null, 2)}\n`);
    writeFileSync(
      nodePath.join(library, "space.yaml"),
      `kind: ${SPACE_KIND}\nspace: demo-org\ntitle: 临时库\nrosters:\n  - id: core-review\n  - id: ghost-roster\n`,
      "utf8",
    );

    const scan = scanRosterLibrary({ rootDir: library });
    assert.equal(scan.space.id, "demo-org");
    assert.equal(scan.spaceFile, "space.yaml");
    assert.deepEqual(scan.spaceCheck.missing, ["ghost-roster"]);
    // 关键：space.yaml 不该被当成"散落文件"告警。
    assert.equal(scan.diagnostics.filter((item) => item.code === "unexpected-file").length, 0);
    assert.ok(scan.diagnostics.some((item) => item.code === "space-roster-missing"));
    assert.ok(scan.stats.errors >= 1, "缺档案至少产生一条 error");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("space：没有组织文件时行为不变（少一个特性不等于少一层校验）", () => {
  const library = makeLibrary({ "core-review/roster.json": rosterDocument() });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.equal(scan.space, null);
    assert.equal(scan.spaceFile, null);
    assert.equal(scan.spaceCheck.status, "absent");
    // 其他诊断（比如未配置 knownToolPolicies 的 info）与本特性无关，这里只断言组织层不吭声。
    assert.equal(scan.diagnostics.filter((item) => item.code.startsWith("space")).length, 0);
  } finally {
    library.cleanup();
  }
});

test("space：schema 与运行时权威校验对齐", () => {
  const schema = JSON.parse(readFileSync(nodePath.join(root, "schema/space.v1.schema.json"), "utf8"));
  assert.deepEqual(Object.keys(schema.properties).filter((key) => key !== "$schema").sort(), [...SPACE_FIELDS].sort());
  assert.deepEqual(
    Object.keys(schema.properties.rosters.items.properties).sort(),
    [...SPACE_ROSTER_FIELDS].sort(),
  );
  assert.equal(schema.properties.kind.const, SPACE_KIND);
  assert.equal(schema.properties.rosters.maxItems, SPACE_LIMITS.rosters);
  assert.equal(schema.properties.maintainers.maxItems, SPACE_LIMITS.maintainers);
  const idPattern = new RegExp(schema.$defs.id.pattern);
  for (const sample of ["demo-org", "a1", "X-bad"]) {
    assert.equal(idPattern.test(sample), SPACE_ID_PATTERN.test(sample), `id 模式不一致：${sample}`);
  }
});

test("space：知识条目必须有 knowledge/ 前缀、合法哈希，不能重复", () => {
  const result = validateSpace(
    orgDocument({
      knowledge: [
        { path: "knowledge/guide.md", title: "项目指南" },
        { path: "../escape.md" },
        { path: "docs/notes.md" },
        { path: "knowledge/guide.md" },
        { path: "knowledge/bad.md", sha256: "not-a-hash" },
        { path: "knowledge/extra.md", unknown: true },
      ],
    }),
    { file: "space.yaml" },
  );
  const codes = result.diagnostics.map((item) => item.code);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("space-knowledge-path"), codes.join(","));
  assert.ok(codes.includes("space-knowledge-duplicate"), codes.join(","));
  assert.ok(codes.includes("space-knowledge-sha"), codes.join(","));
  assert.ok(codes.includes("unknown-field"), codes.join(","));
});

test("space：知识登记保留路径、标题与哈希", () => {
  const result = validateSpace(
    orgDocument({ knowledge: [{ path: "knowledge/guide.md", title: "项目指南", sha256: "a".repeat(64) }] }),
    { file: "space.yaml" },
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.space.knowledge, [{ path: "knowledge/guide.md", title: "项目指南", sha256: "a".repeat(64) }]);
});

test("space：登记的知识缺文件是 error，哈希不符是 warn，多出来的文件是 info", () => {
  const base = mkdtempSync(nodePath.join(tmpdir(), "dsh-knowledge-"));
  const library = nodePath.join(base, "demo-org");
  try {
    mkdirSync(nodePath.join(library, "core-review"), { recursive: true });
    mkdirSync(nodePath.join(library, "knowledge"), { recursive: true });
    writeFileSync(nodePath.join(library, "core-review", "roster.json"), `${JSON.stringify(rosterDocument(), null, 2)}\n`);
    writeFileSync(nodePath.join(library, "knowledge", "guide.md"), "项目指南正文\n");
    writeFileSync(nodePath.join(library, "knowledge", "extra.md"), "没登记的文件\n");
    writeFileSync(
      nodePath.join(library, "space.yaml"),
      [
        `kind: ${SPACE_KIND}`,
        "space: demo-org",
        "knowledge:",
        "  - path: knowledge/guide.md",
        "    title: 项目指南",
        `    sha256: ${"b".repeat(64)}`,
        "  - path: knowledge/missing.md",
        "rosters:",
        "  - id: core-review",
        "",
      ].join("\n"),
      "utf8",
    );

    const scan = scanRosterLibrary({ rootDir: library });
    const codes = scan.diagnostics.map((item) => item.code);
    assert.ok(codes.includes("space-knowledge-missing"), codes.join(","));
    assert.ok(codes.includes("space-knowledge-drift"), codes.join(","));
    assert.ok(codes.includes("space-knowledge-undeclared"), codes.join(","));
    const missing = scan.diagnostics.find((item) => item.code === "space-knowledge-missing");
    assert.equal(missing.severity, "error");
    const drift = scan.diagnostics.find((item) => item.code === "space-knowledge-drift");
    assert.equal(drift.severity, "warn");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
