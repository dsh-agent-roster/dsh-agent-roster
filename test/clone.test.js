/**
 * 空间拉取的契约测试。
 *
 * 一条主线：**拉下来以后必须能被本地编译器直接读懂**——
 * 不是"文件都在"，而是 `scanRosterLibrary` 能把它当成一座正常的 monorepo 空间，
 * 成员人设由 roles/ 拼出来。这就是"编辑和源文件对得上"的可验证形式。
 *
 * @module test/clone
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { cloneSpace, rolesOfRoster, snippetPathsOf, spaceCover } from "../lib/clone.js";
import { scanRosterLibrary } from "../lib/registry.js";

const AGENT = (name, parts = []) =>
  [
    "---",
    "kind: dsh-agent-roster/role@1",
    `name: ${name}`,
    "version: 1.0.0",
    `role: ${name} 的职称`,
    "route:",
    "  provider: deepseek",
    "  model: deepseek-v4.1-flash",
    parts.length > 0 ? "prompt:" : "",
    parts.length > 0 ? "  parts:" : "",
    ...parts.map((part) => `    - ${part}`),
    "---",
    "",
    `你是 ${name}。先给结论，再给依据。`,
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");

const ROSTER = {
  monorepo: (id, role) =>
    [
      "kind: dsh-agent-roster/roster@2",
      `id: ${id}`,
      "version: 1.0.0",
      `title: ${id} 的团队`,
      "defaults:",
      "  route:",
      "    provider: deepseek",
      "    model: deepseek-v4.1-flash",
      "targets:",
      "  - agent-teams/members",
      "members:",
      "  - as: lead",
      `    role: ${role}@1.0.0`,
      "",
    ].join("\n"),
};

/** 一张 URL 表就是一座假仓库；没登记的路径一律 404。 */
function fetchStub(files, repo = "demo/space", ref = "main") {
  const prefix = `https://raw.githubusercontent.com/${repo}/${ref}/`;
  return async (url) => {
    const key = url.replace(prefix, "");
    if (Object.hasOwn(files, key)) {
      return { ok: true, status: 200, text: async () => files[key] };
    }
    return { ok: false, status: 404, text: async () => "" };
  };
}

test("clone：monorepo 空间按原布局落地，且本地能编译出人设", async () => {
  const rootDir = mkdtempSync(nodePath.join(tmpdir(), "dsh-clone-"));
  try {
    const files = {
      "space.yaml": [
        "kind: dsh-agent-roster/space@1",
        "space: demo-space",
        "title: 演示空间",
        "layout: monorepo",
        "rosters:",
        "  - id: core-review",
        "  - id: research",
        "roles:",
        "  - reviewer",
        "  - lead",
        "",
      ].join("\n"),
      "rosters/core-review/roster.yaml": ROSTER.monorepo("core-review", "reviewer"),
      "rosters/research/roster.yaml": ROSTER.monorepo("research", "reviewer"),
      "roles/reviewer/AGENT.md": AGENT("reviewer"),
      "roles/lead/AGENT.md": AGENT("lead"),
    };
    const result = await cloneSpace({
      rootDir,
      spaceId: "demo-space",
      repo: "demo/space",
      fetchImpl: fetchStub(files),
    });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.layout, "monorepo");
    for (const relative of [
      "space.yaml",
      "rosters/core-review/roster.yaml",
      "rosters/research/roster.yaml",
      "roles/reviewer/AGENT.md",
      "roles/lead/AGENT.md",
    ]) {
      assert.ok(existsSync(nodePath.join(rootDir, "demo-space", relative)), relative);
    }
    const cover = readFileSync(nodePath.join(rootDir, "demo-space", "space.yaml"), "utf8");
    assert.match(cover, /origin:/);
    assert.match(cover, /repo: demo\/space/);

    const scan = scanRosterLibrary({ rootDir: nodePath.join(rootDir, "demo-space"), knownToolPolicies: null });
    assert.equal(scan.rosters.length, 2, JSON.stringify(scan.diagnostics));
    assert.equal(scan.space?.id, "demo-space");
    assert.equal(scan.spaceCheck?.status, "ok");
    assert.equal(scan.rosters[0].format, "v2");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("clone：老仓库没有 space.yaml 时按 flat 落地，并补一份带 origin 的封面", async () => {
  const rootDir = mkdtempSync(nodePath.join(tmpdir(), "dsh-clone-flat-"));
  try {
    const roster = ["kind: dsh-agent-roster/v1", "roster: core-review", "version: 1.0.0", "members:", "  - name: lead", "    role: 评审", "    systemPrompt: 你是评审。", ""].join("\n");
    const result = await cloneSpace({
      rootDir,
      spaceId: "legacy",
      repo: "demo/legacy",
      rosterIds: ["core-review"],
      fetchImpl: async (url) =>
        url.endsWith("core-review/roster.yaml")
          ? { ok: true, status: 200, text: async () => roster }
          : { ok: false, status: 404, text: async () => "" },
    });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.layout, "flat");
    const cover = readFileSync(nodePath.join(rootDir, "legacy", "space.yaml"), "utf8");
    assert.match(cover, /layout: flat/);
    assert.match(cover, /- id: core-review/);
    const scan = scanRosterLibrary({ rootDir: nodePath.join(rootDir, "legacy"), knownToolPolicies: null });
    assert.equal(scan.rosters.length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("clone：读不到的档案记 warn 但不因此失败，缺的只是那一份", async () => {
  const rootDir = mkdtempSync(nodePath.join(tmpdir(), "dsh-clone-miss-"));
  try {
    const files = {
      "space.yaml": ["kind: dsh-agent-roster/space@1", "space: demo", "layout: flat", "rosters:", "  - id: present", "  - id: gone", ""].join("\n"),
      "present/roster.yaml": ["kind: dsh-agent-roster/v1", "roster: present", "version: 1.0.0", "members:", "  - name: lead", "    role: 评审", "    systemPrompt: 你是评审。", ""].join("\n"),
    };
    const result = await cloneSpace({ rootDir, spaceId: "demo", repo: "demo/x", fetchImpl: fetchStub(files, "demo/x") });
    assert.equal(result.ok, true);
    assert.ok(result.skipped.includes("gone/roster.yaml"));
    assert.ok(result.diagnostics.some((item) => item.code === "clone-roster-missing"));
    assert.equal(result.written.filter((item) => item.endsWith("roster.yaml")).length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("clone：角色引用与封面生成是纯函数，单独可测", () => {
  assert.deepEqual(rolesOfRoster({ members: [{ role: "reviewer@1.0.0" }, { role: "lead@2.0.0" }], captain: { role: "boss@0.1.0" } }), [
    "boss",
    "lead",
    "reviewer",
  ]);
  const cover = spaceCover({
    space: { title: "演示", maintainers: ["STofone"], roles: ["reviewer"] },
    spaceId: "demo",
    layout: "monorepo",
    rosterIds: ["core-review"],
    origin: { repo: "demo/space", ref: "main", path: "sub" },
  });
  assert.match(cover, /kind: dsh-agent-roster\/space@1/);
  assert.match(cover, /path: sub/);
  assert.match(cover, /- id: core-review/);
});

test("clone：正文引用到的 snippets 一并拉下来，本地编译才不缺文件", async () => {
  const rootDir = mkdtempSync(nodePath.join(tmpdir(), "dsh-clone-"));
  try {
    const files = {
      "space.yaml": [
        "kind: dsh-agent-roster/space@1",
        "space: demo-space",
        "layout: monorepo",
        "rosters:",
        "  - id: core-review",
        "roles:",
        "  - reviewer",
        "",
      ].join("\n"),
      "rosters/core-review/roster.yaml": ROSTER.monorepo("core-review", "reviewer"),
      "roles/reviewer/AGENT.md": `${AGENT("reviewer")}\n{{> snippets/units.md}}\n`,
      "snippets/units.md": "金额一律用整数分。\n",
    };
    const result = await cloneSpace({ rootDir, spaceId: "demo-space", repo: "demo/space", fetchImpl: fetchStub(files) });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.ok(result.written.includes("snippets/units.md"));
    assert.equal(readFileSync(nodePath.join(rootDir, "demo-space/snippets/units.md"), "utf8"), "金额一律用整数分。\n");

    const scanned = scanRosterLibrary({ rootDir: nodePath.join(rootDir, "demo-space"), knownToolPolicies: null, allowOrigin: true });
    assert.equal(scanned.diagnostics.filter((item) => item.severity === "error").length, 0, JSON.stringify(scanned.diagnostics));
    const member = scanned.rosters[0].members[0];
    assert.match(member.systemPrompt, /金额一律用整数分/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("snippetPathsOf：只收独占一行、且属于 snippets/ 的引用", () => {
  assert.deepEqual(snippetPathsOf("a\n{{> snippets/units.md}}\n{{> parts/x.md}}\n请读 {{> snippets/y.md}}\n"), ["snippets/units.md"]);
});

test("clone：registry 坐标带 `github:` 前缀时先归一，不会退化成空拉取", async () => {
  const rootDir = mkdtempSync(nodePath.join(tmpdir(), "dsh-clone-"));
  try {
    const files = {
      "space.yaml": [
        "kind: dsh-agent-roster/space@1",
        "space: demo-space",
        "layout: monorepo",
        "rosters:",
        "  - id: core-review",
        "",
      ].join("\n"),
      "rosters/core-review/roster.yaml": ROSTER.monorepo("core-review", "reviewer"),
      "roles/reviewer/AGENT.md": AGENT("reviewer"),
    };
    const inner = fetchStub(files, "demo/space");
    const seen = [];
    const result = await cloneSpace({
      rootDir,
      spaceId: "demo-space",
      repo: "github:demo/space",
      fetchImpl: async (url, init) => {
        seen.push(url);
        return inner(url, init);
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.layout, "monorepo");
    assert.ok(
      seen.every((url) => !url.includes("github:")),
      "拼给 raw.githubusercontent 的 URL 不该带 github: 前缀",
    );
    assert.ok(existsSync(nodePath.join(rootDir, "demo-space", "rosters", "core-review", "roster.yaml")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("clone：一份档案都没拉到就是失败，不是「成功但空」", async () => {
  const rootDir = mkdtempSync(nodePath.join(tmpdir(), "dsh-clone-"));
  try {
    const files = {
      "space.yaml": [
        "kind: dsh-agent-roster/space@1",
        "space: demo-space",
        "layout: monorepo",
        "rosters:",
        "  - id: core-review",
        "",
      ].join("\n"),
    };
    const result = await cloneSpace({
      rootDir,
      spaceId: "demo-space",
      repo: "demo/space",
      fetchImpl: fetchStub(files),
    });
    assert.equal(result.ok, false, "只拉到 space.yaml 不能算成功");
    assert.ok(result.diagnostics.some((item) => item.code === "clone-no-rosters"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
