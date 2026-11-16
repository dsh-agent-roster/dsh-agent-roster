/**
 * 人设档案（captain-only roster）：`members: []` + `captain.persona|role`。
 *
 * 校验三条不变量：
 * 1. 没有成员时**必须**有队长人设，否则既建不出团队、也没有队长——报 `persona-without-captain`；
 * 2. 人设档案能编译，产物 `members` 为空、队长人设是拼装后的正文；
 * 3. 一座只有 `rosters/id>/roster.yaml`、没有任何角色目录的库，仍按 v2 读（否则会被当成散落目录扫成 0 份）。
 *
 * @module test/persona
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { compileRosterAt } from "../lib/compile2.js";
import { scanRosterLibrary } from "../lib/registry.js";
import { validateRoster2 } from "../lib/roster2.js";

function scratch() {
  return mkdtempSync(nodePath.join(tmpdir(), "dsh-persona-"));
}

function write(root, relative, content) {
  const file = nodePath.join(root, relative);
  mkdirSync(nodePath.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return file;
}

const BODY = "你只做一件事：按用户给的约束写代码，写完自己跑一遍测试。";

function personaRoster({ persona = "personas/self.md", members = [] } = {}) {
  return [
    'kind: "dsh-agent-roster/roster@2"',
    "id: solo",
    "version: 1.0.0",
    'title: "单人人设"',
    "captain:",
    persona === null ? "  role: null" : `  persona: ${persona}`,
    `members: ${JSON.stringify(members)}`,
    "",
  ].join("\n");
}

test("人设档案：空成员 + captain.persona 通过校验", () => {
  const result = validateRoster2(
    {
      kind: "dsh-agent-roster/roster@2",
      id: "solo",
      version: "1.0.0",
      captain: { persona: "personas/self.md" },
      members: [],
    },
    { file: "roster.yaml", expectedId: "solo" },
  );
  assert.equal(result.ok, true, result.diagnostics.map((item) => `${item.code}: ${item.reason}`).join("; "));
  assert.deepEqual(result.roster.members, []);
});

test("人设档案：既没有成员也没有队长人设 → persona-without-captain", () => {
  const result = validateRoster2(
    {
      kind: "dsh-agent-roster/roster@2",
      id: "solo",
      version: "1.0.0",
      members: [],
    },
    { file: "roster.yaml", expectedId: "solo" },
  );
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === "persona-without-captain"));
});

test("人设档案：编译产物 members 为空，队长人设是正文", () => {
  const root = scratch();
  write(root, "space.yaml", "kind: dsh-agent-roster/space@1\nspace: personas\nlayout: monorepo\nrosters:\n  - id: solo\n");
  write(root, "rosters/solo/roster.yaml", personaRoster());
  write(root, "rosters/solo/personas/self.md", BODY);

  const compiled = compileRosterAt(nodePath.join(root, "rosters", "solo"), { libraryRoot: root });
  assert.equal(compiled.ok, true, compiled.diagnostics.map((item) => `${item.code}: ${item.reason}`).join("; "));
  assert.deepEqual(compiled.compiled.members, []);
  assert.equal(compiled.compiled.captain.persona, BODY);
});

test("人设库：没有任何角色目录也按 v2 扫出一份档案", () => {
  const root = scratch();
  write(root, "space.yaml", "kind: dsh-agent-roster/space@1\nspace: personas\nlayout: monorepo\nrosters:\n  - id: solo\n");
  write(root, "rosters/solo/roster.yaml", personaRoster());
  write(root, "rosters/solo/personas/self.md", BODY);

  const scan = scanRosterLibrary({ rootDir: root, knownToolPolicies: null });
  assert.equal(scan.rosters.length, 1);
  assert.equal(scan.rosters[0].id, "solo");
  assert.equal(scan.rosters[0].members.length, 0);
});
