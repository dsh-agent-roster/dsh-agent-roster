/**
 * 角色作用域：库根的共享角色（shared-roles/，旧名 roles/）与档案本地角色
 * （rosters/<id>/roles/）。
 *
 * 要钉住的四条：
 * 1. 本地角色只被本档案解析得到，另一份档案看不到它；
 * 2. 同名时本地压过共享，并且这条覆盖要**说出来**（info），不能静默；
 * 3. 旧名 roles/ 继续能读，但要提示改名；
 * 4. 只有本地角色、没有共享目录的库也算 v2。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { compileRosterAt } from "../lib/compile2.js";
import { scanRosterLibrary } from "../lib/registry.js";

function scratch() {
  return mkdtempSync(nodePath.join(tmpdir(), "dsh-scope-"));
}

function write(root, relative, content) {
  const file = nodePath.join(root, relative);
  mkdirSync(nodePath.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

function role(name, body) {
  return `---\nkind: dsh-agent-roster/role@1\nname: ${name}\nversion: 1.0.0\nrole: ${name}\n---\n\n${body}\n`;
}

function roster(id, roleRefs) {
  const lines = [
    "---",
    "kind: dsh-agent-roster/roster@2",
    `id: ${id}`,
    "version: 1.0.0",
    `title: ${id}`,
    "members:",
  ];
  roleRefs.forEach((ref, index) => {
    lines.push(`  - as: member${index}`, `    role: ${ref}@1.0.0`);
  });
  return lines.join("\n") + "\n";
}

test("本地角色只属于本档案：另一份档案引用它会报 missing-role", () => {
  const root = scratch();
  write(root, "shared-roles/shared-reviewer/AGENT.md", role("shared-reviewer", "共享审查者"));
  write(root, "rosters/alpha/roles/alpha-writer/AGENT.md", role("alpha-writer", "甲档案自己的写手"));
  write(root, "rosters/alpha/roster.yaml", roster("alpha", ["shared-reviewer", "alpha-writer"]));
  write(root, "rosters/beta/roster.yaml", roster("beta", ["alpha-writer"]));

  const alpha = compileRosterAt(nodePath.join(root, "rosters/alpha"));
  assert.equal(alpha.ok, true);
  assert.equal(alpha.compiled.members.length, 2);
  assert.equal(alpha.localRoles, 1);
  assert.equal(alpha.rolesDir, "shared-roles");

  const beta = compileRosterAt(nodePath.join(root, "rosters/beta"));
  assert.equal(beta.ok, false);
  assert.ok(beta.diagnostics.some((item) => item.code === "unknown-role" && item.severity === "error"));
});

test("同名时本地覆盖共享，并报 role-local-overrides-shared", () => {
  const root = scratch();
  write(root, "shared-roles/reviewer/AGENT.md", role("reviewer", "共享版人设"));
  write(root, "rosters/demo/roles/reviewer/AGENT.md", role("reviewer", "本地版人设"));
  write(root, "rosters/demo/roster.yaml", roster("demo", ["reviewer"]));

  const compiled = compileRosterAt(nodePath.join(root, "rosters/demo"));
  assert.equal(compiled.ok, true);
  assert.match(compiled.compiled.members[0].executionPrompt, /^本地版人设/);
  const note = compiled.diagnostics.find((item) => item.code === "role-local-overrides-shared");
  assert.ok(note, "覆盖必须说出来");
  assert.equal(note.severity, "info");
});

test("旧名 roles/ 仍能读，并提示改成 shared-roles", () => {
  const root = scratch();
  write(root, "roles/reviewer/AGENT.md", role("reviewer", "旧目录人设"));
  write(root, "rosters/demo/roster.yaml", roster("demo", ["reviewer"]));

  const compiled = compileRosterAt(nodePath.join(root, "rosters/demo"));
  assert.equal(compiled.ok, true);
  assert.equal(compiled.rolesDir, "roles");
  assert.ok(compiled.diagnostics.some((item) => item.code === "legacy-roles-dir" && item.severity === "info"));
});

test("只有本地角色、没有共享目录的库也算 v2", () => {
  const root = scratch();
  write(root, "rosters/demo/roles/solo/AGENT.md", role("solo", "独自一人"));
  write(root, "rosters/demo/roster.yaml", roster("demo", ["solo"]));

  const scan = scanRosterLibrary({ rootDir: root });
  assert.equal(scan.stats.total, 1);
  assert.equal(scan.rosters[0].format, "v2");
  assert.equal(scan.rosters[0].members[0].systemPrompt.startsWith("独自一人"), true);
});
