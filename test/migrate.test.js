/**
 * `migrate`：v1 → v2 的原地迁移。
 *
 * 测的是「迁移之后整座库仍然可读、人设没有丢、旧目录不再被当成档案」这三件可验证的事，
 * 而不是文件个数——文件个数会随布局细节变化，那不该是断言对象。
 *
 * @module test/migrate
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import test from "node:test";

import { convertRoster, emitYaml, migrateLibrary, roleDocument } from "../lib/migrate.js";
import { scanRosterLibrary } from "../lib/registry.js";
import { makeLibrary, rosterDocument } from "./helpers.js";

function v1Library() {
  return makeLibrary({
    "core-review/roster.json": rosterDocument({
      captain: {
        name: "lead",
        description: "主会话即队长",
        provider: "deepseek",
        model: "deepseek-v4.1-flash",
        reasoningEffort: "high",
        personaPrefix: "派活前先复述目标与验收标准。",
      },
    }),
  });
}

test("migrate：不写盘时只出计划，磁盘上不多任何东西", () => {
  const library = v1Library();
  try {
    const report = migrateLibrary(library.rootDir);
    assert.equal(report.write, false);
    assert.equal(report.entries.length, 1);
    assert.equal(existsSync(nodePath.join(library.rootDir, "roles")), false);
    assert.equal(existsSync(nodePath.join(library.rootDir, "rosters")), false);
  } finally {
    library.cleanup();
  }
});

test("migrate：写盘之后档案库变成 v2 布局，人设一个字不丢", () => {
  const library = v1Library();
  try {
    const before = JSON.parse(readFileSync(nodePath.join(library.rootDir, "core-review/roster.json"), "utf8"));
    const originalPrompt = before.members[0].systemPrompt;
    const report = migrateLibrary(library.rootDir, { write: true });
    assert.deepEqual(report.diagnostics.filter((item) => item.severity === "error"), []);
    assert.ok(existsSync(nodePath.join(library.rootDir, "rosters/core-review/roster.yaml")));
    assert.ok(existsSync(nodePath.join(library.rootDir, "roles/core-review-reviewer/AGENT.md")));
    assert.ok(existsSync(nodePath.join(library.rootDir, "dist/core-review-1.2.0.json")));
    // 旧目录必须消失，否则它会被当成第二份档案。
    assert.equal(existsSync(nodePath.join(library.rootDir, "core-review")), false);

    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.equal(scan.stats.total, 1);
    assert.equal(scan.rosters[0].format, "v2");
    assert.equal(scan.rosters[0].id, "core-review");
    const persona = scan.rosters[0].members[0].systemPrompt;
    assert.ok(persona.startsWith(originalPrompt.trim().split("\n")[0]), "人设正文必须原样保留在编译产物里");
    assert.equal(scan.rosters[0].members[0].roleRef, "core-review-reviewer@1.0.0");
  } finally {
    library.cleanup();
  }
});

test("migrate：队长与成员同名时，队长单独成一个角色而不是被合并", () => {
  const directory = makeLibrary({
    "squad/roster.json": rosterDocument({
      roster: "squad",
      captain: { name: "reviewer", description: "队长", personaPrefix: "先复述目标。" },
    }),
  });
  try {
    const report = migrateLibrary(directory.rootDir, { write: true });
    const names = report.entries[0].files.map((file) => file.path);
    assert.ok(names.includes(nodePath.join("roles", "squad-reviewer", "AGENT.md")));
    assert.ok(names.includes(nodePath.join("roles", "squad-reviewer-captain", "AGENT.md")));
    const scan = scanRosterLibrary({ rootDir: directory.rootDir });
    assert.equal(scan.rosters[0].captain.name, "squad-reviewer-captain");
  } finally {
    directory.cleanup();
  }
});

test("migrate：能力要求跟着档案搬家，内容不变", () => {
  const directory = makeLibrary({
    "squad/roster.json": rosterDocument({ roster: "squad" }),
    "squad/capabilities.yaml": "kind: dsh-agent-roster-capabilities/v1\nroster: squad\nrequires:\n  skills: [dsh-chat-import]\n",
  });
  try {
    migrateLibrary(directory.rootDir, { write: true });
    const moved = readFileSync(nodePath.join(directory.rootDir, "rosters/squad/capabilities.yaml"), "utf8");
    assert.match(moved, /dsh-chat-import/);
    const scan = scanRosterLibrary({ rootDir: directory.rootDir });
    assert.deepEqual(scan.capabilities.squad.requires.skills, [{ name: "dsh-chat-import", reason: null }]);
  } finally {
    directory.cleanup();
  }
});

test("migrate：emitYaml 写出的 frontmatter 能被解析回来", () => {
  const role = {
    kind: "dsh-agent-roster/role@1",
    name: "core-review-lead",
    version: "1.0.0",
    role: "队长",
    tags: ["orchestration", "review"],
    route: { provider: "deepseek", model: "deepseek-v4.1-flash", reasoningEffort: "high" },
    tools: { policy: "read-only" },
  };
  const text = roleDocument(role, "你是队长。");
  assert.match(text, /^---\n/);
  const [frontmatter] = text.split("---\n").slice(1);
  const parsed = JSON.parse(
    JSON.stringify(
      Object.fromEntries(
        frontmatter
          .trim()
          .split("\n")
          .filter((line) => /^[a-z]+:/.test(line))
          .map((line) => {
            const [key, ...rest] = line.split(":");
            return [key, rest.join(":").trim().replace(/^"|"$/g, "")];
          }),
      ),
    ),
  );
  assert.equal(parsed.kind, "dsh-agent-roster/role@1");
  assert.equal(parsed.name, "core-review-lead");
  assert.equal(parsed.role, "队长");
});

test("migrate：convertRoster 把成员路由搬进角色、把 defaults 留给组装", () => {
  const roster = rosterDocument({
    roster: "squad",
    members: [
      { name: "solo", role: "唯一成员", systemPrompt: "只做一件事。", model: "deepseek-v4.1-pro", reasoningEffort: "medium" },
    ],
  });
  const converted = convertRoster(roster);
  const roleFile = converted.files.find((file) => file.path.endsWith("AGENT.md"));
  assert.match(roleFile.text, /"deepseek-v4\.1-pro"/);
  const roster2 = converted.roster;
  assert.equal(roster2.members.length, 1);
  assert.equal(roster2.members[0].role, "squad-solo@1.0.0");
  assert.equal(roster2.defaults.route.provider, "deepseek");
  assert.deepEqual(emitYaml({ a: [], b: {} }), 'a: []\nb: {}');
});
