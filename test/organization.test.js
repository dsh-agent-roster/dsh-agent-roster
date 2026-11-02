/**
 * 组织档案（organization.yaml）的契约测试。
 *
 * 三条主线：
 * 1. **校验**：未知键、目录名不符、重复登记、非法状态都必须报错——组织页不能比磁盘乐观；
 * 2. **交叉核对**：声明了却找不到 = error，目录在却没登记 = warn，已归档仍在 = info；
 * 3. **schema 对齐**：给编辑器看的 JSON Schema 与运行时权威校验不能各写一份。
 *
 * @module test/organization
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import {
  ID_PATTERN,
  LIMITS,
  ORGANIZATION_FIELDS,
  ORGANIZATION_KIND,
  ORGANIZATION_ROSTER_FIELDS,
  checkOrganization,
  organizationDiagnostics,
  validateOrganization,
} from "../lib/organization.js";
import { scanRosterLibrary } from "../lib/registry.js";
import { makeLibrary, rosterDocument } from "./helpers.js";

const root = nodePath.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

/** 造一份合法组织文档，再按需覆盖。 */
function orgDocument(overrides = {}) {
  return {
    kind: ORGANIZATION_KIND,
    organization: "demo-org",
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

test("organization：合法文档通过校验，缺省状态补成 active", () => {
  const report = validateOrganization(orgDocument(), { expectedId: "demo-org" });
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
  assert.equal(report.diagnostics.length, 0);
  assert.equal(report.organization.id, "demo-org");
  assert.equal(report.organization.rosters[1].status, "archived");
  assert.equal(report.organization.rosters[0].origin, "本仓库");
});

test("organization：kind 不对时报 organization-kind", () => {
  const report = validateOrganization(orgDocument({ kind: "dsh-agent-roster/v1" }));
  assert.equal(report.ok, false);
  assert.equal(report.organization, null);
  assert.ok(codes(report.diagnostics).includes("organization-kind"));
});

test("organization：id 必须等于所在目录名（位置即身份）", () => {
  const report = validateOrganization(orgDocument(), { expectedId: "other-dir" });
  assert.equal(report.ok, false);
  assert.ok(codes(report.diagnostics).includes("organization-id-mismatch"));
});

test("organization：未知字段一律报错，不做静默忽略", () => {
  const report = validateOrganization(orgDocument({ website: "https://example.com" }));
  assert.equal(report.ok, false);
  assert.ok(codes(report.diagnostics).includes("unknown-field"));
});

test("organization：登记项字段闭集，regions 之类的自造键要报错", () => {
  const report = validateOrganization(
    orgDocument({ rosters: [{ id: "core-review", region: "cn" }] }),
  );
  assert.equal(report.ok, false);
  assert.ok(codes(report.diagnostics).includes("unknown-field"));
});

test("organization：rosters 必须非空，重复 id 与非法状态都报错", () => {
  assert.ok(codes(validateOrganization(orgDocument({ rosters: [] })).diagnostics).includes("organization-rosters"));

  const duplicate = validateOrganization(orgDocument({ rosters: [{ id: "core-review" }, { id: "core-review" }] }));
  assert.equal(duplicate.ok, false);
  assert.ok(codes(duplicate.diagnostics).includes("organization-duplicate-roster"));

  const badStatus = validateOrganization(orgDocument({ rosters: [{ id: "core-review", status: "deleted" }] }));
  assert.equal(badStatus.ok, false);
  assert.ok(codes(badStatus.diagnostics).includes("organization-roster-status"));
});

test("organization：homepage 只收 http(s)，别的写法报错", () => {
  assert.ok(codes(validateOrganization(orgDocument({ homepage: "ftp://example.com" })).diagnostics).includes("organization-homepage"));
  assert.equal(validateOrganization(orgDocument({ homepage: "https://example.com/rosters" })).ok, true);
});

test("organization：checkOrganization 把缺、多、归档分三类", () => {
  const organization = validateOrganization(orgDocument(), { expectedId: "demo-org" }).organization;
  const check = checkOrganization(organization, ["core-review", "research", "extra-one"]);
  assert.equal(check.declared, 2);
  assert.equal(check.present, 3);
  assert.deepEqual(check.missing, []);
  assert.deepEqual(check.undeclared, ["extra-one"]);
  assert.deepEqual(check.archived, ["research"]);
  assert.equal(check.status, "ok");

  const broken = checkOrganization(organization, ["core-review"]);
  assert.deepEqual(broken.missing, ["research"]);
  assert.equal(broken.status, "incomplete");
  assert.equal(checkOrganization(null, ["core-review"]).status, "absent");
});

test("organization：诊断严重度——缺是 error，多与归档不是 error", () => {
  const organization = validateOrganization(orgDocument(), { expectedId: "demo-org" }).organization;
  const check = checkOrganization(organization, ["core-review", "extra-one"]);
  const diagnostics = organizationDiagnostics(organization, check, "organization.yaml");

  const missing = diagnostics.find((item) => item.code === "organization-roster-missing");
  assert.equal(missing.severity, "error");
  assert.match(missing.reason, /research/);

  const undeclared = diagnostics.find((item) => item.code === "organization-roster-undeclared");
  assert.equal(undeclared.severity, "warn");

  // 归档项要求目录真的在库里，才算 info。
  const withArchived = organizationDiagnostics(
    organization,
    checkOrganization(organization, ["core-review", "research", "extra-one"]),
    "organization.yaml",
  );
  assert.equal(withArchived.find((item) => item.code === "organization-roster-archived").severity, "info");
});

test("organization：扫描时组织文件不算散落文件，且交叉核对进诊断", () => {
  // 组织 id 必须等于目录名，而 mkdtemp 的随机后缀含大写字母，不是合法 id；
  // 所以在临时目录里再建一层 demo-org 当作档案库根。
  const base = mkdtempSync(nodePath.join(tmpdir(), "dsh-org-"));
  const library = nodePath.join(base, "demo-org");
  try {
    mkdirSync(nodePath.join(library, "core-review"), { recursive: true });
    writeFileSync(nodePath.join(library, "core-review", "roster.json"), `${JSON.stringify(rosterDocument(), null, 2)}\n`);
    writeFileSync(
      nodePath.join(library, "organization.yaml"),
      `kind: ${ORGANIZATION_KIND}\norganization: demo-org\ntitle: 临时库\nrosters:\n  - id: core-review\n  - id: ghost-roster\n`,
      "utf8",
    );

    const scan = scanRosterLibrary({ rootDir: library });
    assert.equal(scan.organization.id, "demo-org");
    assert.equal(scan.organizationFile, "organization.yaml");
    assert.deepEqual(scan.organizationCheck.missing, ["ghost-roster"]);
    // 关键：organization.yaml 不该被当成"散落文件"告警。
    assert.equal(scan.diagnostics.filter((item) => item.code === "unexpected-file").length, 0);
    assert.ok(scan.diagnostics.some((item) => item.code === "organization-roster-missing"));
    assert.ok(scan.stats.errors >= 1, "缺档案至少产生一条 error");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("organization：没有组织文件时行为不变（少一个特性不等于少一层校验）", () => {
  const library = makeLibrary({ "core-review/roster.json": rosterDocument() });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.equal(scan.organization, null);
    assert.equal(scan.organizationFile, null);
    assert.equal(scan.organizationCheck.status, "absent");
    // 其他诊断（比如未配置 knownToolPolicies 的 info）与本特性无关，这里只断言组织层不吭声。
    assert.equal(scan.diagnostics.filter((item) => item.code.startsWith("organization")).length, 0);
  } finally {
    library.cleanup();
  }
});

test("organization：schema 与运行时权威校验对齐", () => {
  const schema = JSON.parse(readFileSync(nodePath.join(root, "schema/organization.v1.schema.json"), "utf8"));
  assert.deepEqual(Object.keys(schema.properties).filter((key) => key !== "$schema").sort(), [...ORGANIZATION_FIELDS].sort());
  assert.deepEqual(
    Object.keys(schema.properties.rosters.items.properties).sort(),
    [...ORGANIZATION_ROSTER_FIELDS].sort(),
  );
  assert.equal(schema.properties.kind.const, ORGANIZATION_KIND);
  assert.equal(schema.properties.rosters.maxItems, LIMITS.rosters);
  assert.equal(schema.properties.maintainers.maxItems, LIMITS.maintainers);
  const idPattern = new RegExp(schema.$defs.id.pattern);
  for (const sample of ["demo-org", "a1", "X-bad"]) {
    assert.equal(idPattern.test(sample), ID_PATTERN.test(sample), `id 模式不一致：${sample}`);
  }
});
