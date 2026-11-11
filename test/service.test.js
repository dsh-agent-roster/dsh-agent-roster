import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, test } from "node:test";

import { setFavorite } from "../lib/favorites.js";
import { globalRosterRoot } from "../lib/home.js";
import {
  buildCaptainSection,
  buildHints,
  buildPanelSnapshot,
  countDeployments,
  loadRemotePanel,
  resolveRoots,
} from "../lib/service.js";

const ROSTER = `kind: dsh-agent-roster/v1
roster: demo
version: 1.0.0
title: Demo
defaults:
  provider: deepseek
  model: deepseek-v4.1-flash
members:
  - name: alpha
    role: researcher
    systemPrompt: You are alpha.
  - name: beta
    role: reviewer
    systemPrompt: You are beta.
`;

const CONFIG = {
  rosterDirs: ["rosters"],
  knownToolPolicies: [],
  agentTeamsStateDir: ".agent-teams",
};

const META = { name: "@stofone/dsh-agent-roster", version: "9.9.9" };

function fakeCtx(workspace) {
  return {
    get: (key) => (key === "workspaceRegistry" ? { list: () => [{ title: "demo", path: workspace }] } : undefined),
  };
}

function writeTeam(workspace, id, state) {
  const dir = path.join(workspace, ".agent-teams", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify(state));
}

describe("buildPanelSnapshot", () => {
  let workspace;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-agent-roster-service-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("projects rosters, teams and deployments in one payload", () => {
    fs.mkdirSync(path.join(workspace, "rosters", "demo"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "rosters", "demo", "roster.yaml"), ROSTER);
    writeTeam(workspace, "team-a", {
      id: "team-a",
      name: "Team A",
      phase: "running",
      members: [
        { name: "alpha", role: "researcher", provider: "deepseek", model: "deepseek-v4.1-flash" },
        { name: "stranger", role: "outsider" },
      ],
      tasks: [{ status: "completed" }, { status: "pending" }, { status: "in_progress" }],
    });

    const snapshot = buildPanelSnapshot(fakeCtx(workspace), CONFIG, META, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    assert.equal(snapshot.plugin, META.name);
    assert.equal(snapshot.version, "9.9.9");
    assert.equal(snapshot.generatedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(snapshot.summary.rosters, 1);
    assert.equal(snapshot.summary.members, 2);
    assert.equal(snapshot.summary.teams, 1);

    const [team] = snapshot.teams.teams;
    assert.equal(team.id, "team-a");
    assert.equal(team.phase, "running");
    assert.deepEqual(team.tasks, { total: 3, completed: 1, failed: 0, pending: 1, active: 1 });

    const [managed, outsider] = team.members;
    assert.equal(managed.rosterId, "demo");
    assert.equal(managed.faithful, true);
    assert.deepEqual(managed.drift, []);
    assert.equal(outsider.rosterId, null);
    assert.equal(outsider.faithful, false);

    assert.deepEqual(snapshot.deployments.demo, { deployed: 1, total: 2, drifted: 0, teams: ["Team A"] });
  });

  it("reports drift when the runtime disagrees with the roster", () => {
    fs.mkdirSync(path.join(workspace, "rosters", "demo"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "rosters", "demo", "roster.yaml"), ROSTER);
    writeTeam(workspace, "team-a", {
      id: "team-a",
      name: "Team A",
      members: [{ name: "alpha", provider: "deepseek", model: "deepseek-v4.1-pro" }],
      tasks: [],
    });

    const snapshot = buildPanelSnapshot(fakeCtx(workspace), CONFIG, META);
    const [alpha] = snapshot.teams.teams[0].members;

    assert.equal(alpha.faithful, false);
    assert.deepEqual(alpha.drift, [{ field: "model", roster: "deepseek-v4.1-flash", runtime: "deepseek-v4.1-pro" }]);
    assert.equal(snapshot.deployments.demo.drifted, 1);
  });

  it("keeps going when the state directory does not exist", () => {
    const snapshot = buildPanelSnapshot(fakeCtx(workspace), CONFIG, META);

    assert.equal(snapshot.teams.available, false);
    assert.equal(snapshot.teams.teams.length, 0);
    assert.ok(snapshot.hints.some((hint) => hint.code === "state-dir-missing"));
    assert.equal(
      snapshot.hints.some((hint) => hint.code === "roster-dir-missing" || hint.code === "no-rosters"),
      false,
      "空档案库不是问题，不该出提示",
    );
  });

  it("never leaks execution prompts into the payload", () => {
    writeTeam(workspace, "team-a", {
      id: "team-a",
      name: "Team A",
      members: [{ name: "alpha", executionPrompt: "SECRET PROMPT".repeat(100) }],
      tasks: [],
    });

    const snapshot = buildPanelSnapshot(fakeCtx(workspace), CONFIG, META);
    const serialized = JSON.stringify(snapshot);

    assert.equal(serialized.includes("SECRET PROMPT"), false);
    assert.equal(snapshot.teams.teams[0].members[0].promptChars, "SECRET PROMPT".length * 100);
  });

  it("reads teams from every host workspace, not only from library roots", () => {
    // 旧行为：只读"被登记成图书馆的库根"所在工作区 ⇒ 在别的目录里建的团队永远不可见。
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-agent-roster-other-"));
    try {
      writeTeam(other, "team-outside", {
        id: "team-outside",
        name: "outside",
        captainSessionId: "session-x",
        members: [{ id: "m1", name: "alpha", role: "researcher", status: "idle" }],
      });
      const registry = { list: () => [{ path: workspace, title: "here" }, { path: other, title: "elsewhere" }] };
      const snapshot = buildPanelSnapshot({ get: (key) => (key === "workspaceRegistry" ? registry : undefined) }, CONFIG, META);

      assert.ok(snapshot.teams.teams.some((team) => team.id === "team-outside"), "工作区里的团队要出现");
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("reports duplicate roster ids across libraries", () => {
    for (const dir of ["rosters", "shared"]) {
      fs.mkdirSync(path.join(workspace, dir, "demo"), { recursive: true });
      fs.writeFileSync(path.join(workspace, dir, "demo", "roster.yaml"), ROSTER);
    }

    const snapshot = buildPanelSnapshot(fakeCtx(workspace), { ...CONFIG, rosterDirs: ["rosters", "shared"] }, META);

    assert.equal(snapshot.summary.rosters, 2);
    assert.ok(snapshot.hints.some((hint) => hint.code === "duplicate-roster-id" && hint.params.count === 1));
  });
});

describe("resolveRoots", () => {
  it("expands configured directories across known workspaces", () => {
    const roots = resolveRoots(fakeCtx("C:\\work\\a"), { rosterDirs: ["rosters", "extra"] });

    assert.equal(roots.length, 2);
    assert.equal(roots[0].rootDir, path.resolve("C:\\work\\a", "rosters"));
    assert.equal(roots[1].rootDir, path.resolve("C:\\work\\a", "extra"));
  });

  it("defaults to the global library under DSH_HOME", () => {
    const roots = resolveRoots({ get: () => undefined }, { rosterDirs: [] });
    const base = roots.filter((root) => root.nested !== true);
    assert.equal(base.length, 1);
    assert.equal(base[0].rootDir, globalRosterRoot());
    assert.equal(base[0].workspacePath, "", "全局库不属于任何工作区");
    // 「拉取整个空间」会把空间落在 <root>/<space-id>/：这些也要进白名单，
    // 否则面板看得到、保存/应用却报 unknown-root。
    for (const nested of roots.filter((root) => root.nested === true)) {
      assert.equal(nested.parentRootDir, globalRosterRoot());
    }
  });
});

describe("countDeployments", () => {
  it("counts only members that really exist in the runtime", () => {
    const rosters = [{ id: "demo", members: [{ name: "alpha" }, { name: "beta" }] }];
    const teams = [
      {
        id: "t1",
        name: "Team",
        members: [
          { name: "alpha", rosterId: "demo", faithful: true },
          { name: "gamma", rosterId: null, faithful: false },
        ],
      },
    ];

    assert.deepEqual(countDeployments(rosters, teams), {
      demo: { deployed: 1, total: 2, drifted: 0, teams: ["Team"] },
    });
  });
});

describe("buildHints", () => {
  const base = {
    library: { workspaces: [] },
    roots: [],
    rosters: [],
    teams: { available: true, teams: [], stateDir: ".agent-teams", diagnostics: [] },
    config: { knownToolPolicies: [] },
  };

  it("is silent when there is nothing to say", () => {
    assert.deepEqual(buildHints(base), [{ code: "teams-none", severity: "info", params: { stateDir: ".agent-teams" } }]);
  });

  it("flags a workspace that fell back to the process directory", () => {
    const hints = buildHints({ ...base, library: { workspaces: [{ fallbackWorkspace: true }] } });
    assert.ok(hints.some((hint) => hint.code === "workspace-fallback"));
  });

  it("flags unknown tool policies only when nothing is configured", () => {
    const rosters = [{ members: [{ toolPolicy: "read-only" }] }];
    assert.ok(buildHints({ ...base, rosters }).some((hint) => hint.code === "tool-policies-unset"));

    const configured = buildHints({ ...base, rosters, config: { knownToolPolicies: ["read-only"] } });
    assert.equal(configured.some((hint) => hint.code === "tool-policies-unset"), false);
  });
});

it("buildCaptainSection：读不到部署配置时核对项是 unknown，不冒充通过", () => {
  const rosters = [{ id: "agent-teams", rootDir: "/lib", captain: { name: "lead", provider: "p", model: "m" } }];
  const section = buildCaptainSection(rosters, {
    readDeployed: () => ({ home: "/home", displayed: "$DSH_HOME", profiles: [], diagnostics: [] }),
  });

  assert.equal(section.deployed.displayed, "$DSH_HOME");
  assert.deepEqual(section.deployed.profiles, []);
  assert.equal(section.reports.length, 1);
  assert.equal(section.reports[0].rosterId, "agent-teams");
  // provider/model 声明了但读不到部署 → unknown；没声明的字段记 undeclared，不混作未知。
  assert.deepEqual(
    section.reports[0].checks.map((check) => [check.field, check.status]),
    [
      ["provider", "unknown"],
      ["model", "unknown"],
      ["reasoningEffort", "undeclared"],
      ["personaPrefix", "unknown"],
    ],
  );
  assert.equal(section.reports[0].ok, false);
});

it("buildCaptainSection：声明与部署一致时报 ok，且只收有 captain 段的档案", () => {
  const rosters = [
    { id: "with-captain", rootDir: "/lib", captain: { name: "lead", provider: "p", model: "m" } },
    { id: "no-captain", rootDir: "/lib" },
  ];
  const section = buildCaptainSection(rosters, {
    readDeployed: () => ({
      home: "/home",
      displayed: "~/.dsh",
      profiles: [
        {
          profile: "web",
          provider: "p",
          model: "m",
          reasoningEffort: "",
          personas: [{ preset: "preset-standard", prefix: "先读后写。" }],
        },
      ],
      diagnostics: [],
    }),
  });

  assert.equal(section.reports.length, 1);
  assert.equal(section.reports[0].ok, true);
  assert.equal(section.deployed.profiles[0].profile, "web");
  assert.equal(section.deployed.profiles[0].personas, 1);
});

it("buildCaptainSection：读部署抛错时降级成 captain-unreadable 诊断", () => {
  const section = buildCaptainSection([{ id: "x", rootDir: "/lib", captain: { name: "lead" } }], {
    readDeployed: () => {
      throw new Error("boom");
    },
  });
  assert.equal(section.deployed.diagnostics[0].code, "captain-unreadable");
  assert.equal(section.reports[0].ok, false);
});

it("buildPanelSnapshot：能力要求缺策略时角标变红，技能要求如实标成不判定", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-agent-roster-cap-"));
  try {
    fs.mkdirSync(path.join(workspace, "rosters", "demo"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "rosters", "demo", "roster.yaml"), ROSTER);
    fs.writeFileSync(
      path.join(workspace, "rosters", "demo", "capabilities.yaml"),
      `kind: dsh-agent-roster-capabilities/v1
roster: demo
onMissing: refuse
requires:
  skills: [frontend-skill]
  toolPolicies: [member-safe]
`,
    );

    const snapshot = buildPanelSnapshot(fakeCtx(workspace), CONFIG, META);
    const [roster] = snapshot.workspaces[0].rosters;

    const missing = roster.diagnostics.find((item) => item.code === "capability-policy-missing");
    assert.equal(missing?.severity, "error");
    assert.equal(missing?.file, "demo/capabilities.yaml");
    assert.equal(snapshot.summary.errors >= 1, true);

    const skills = roster.diagnostics.find((item) => item.code === "capability-skills-unverified");
    assert.equal(skills?.severity, "info");
    assert.equal(skills?.file, "demo/capabilities.yaml");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

describe("面板的远端索引投影", () => {
  it("保留每个 collection 的 files 映射（丢掉它，URL 就会退回不存在的 v1 路径）", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-panel-index-"));
    const panel = await loadRemotePanel(
      { indexes: [{ id: "demo", url: "https://example.com/registry.json" }] },
      {
        cacheDir,
        refresh: true,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () =>
            JSON.stringify({
              kind: "dsh-agent-roster-registry/v1",
              collections: [
                {
                  id: "demo",
                  repo: "github:someone/demo",
                  path: "examples",
                  rosters: ["core-review"],
                  files: { "core-review": "dist/core-review-1.0.0.json" },
                },
              ],
            }),
        }),
      },
    );
    fs.rmSync(cacheDir, { recursive: true, force: true });

    assert.equal(panel.collections.length, 1);
    assert.deepEqual(panel.collections[0].files, { "core-review": "dist/core-review-1.0.0.json" });
  });
});

test("快照：收藏按库根读，逐份标在档案上；坏文件只报一条 warn", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-agent-roster-service-fav-"));
  try {
    fs.mkdirSync(path.join(workspace, "rosters", "demo"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "rosters", "demo", "roster.yaml"), ROSTER);
    setFavorite(path.join(workspace, "rosters"), "demo", true);

    const snapshot = buildPanelSnapshot(fakeCtx(workspace), CONFIG, META);
    const entry = snapshot.workspaces[0].rosters.find((roster) => roster.id === "demo");
    assert.equal(entry.favorite, true, "档案行要带上收藏状态，前端才知道画实心还是空心");
    assert.deepEqual(snapshot.workspaces[0].favorites, ["demo"]);

    // 坏文件：不能把收藏状态搞成 undefined，也不能一声不吭。
    fs.writeFileSync(path.join(workspace, "rosters", ".dsh-roster-favorites.json"), "{ nope", "utf8");
    const broken = buildPanelSnapshot(fakeCtx(workspace), CONFIG, META);
    assert.equal(broken.workspaces[0].rosters.find((roster) => roster.id === "demo").favorite, false);
    const warn = broken.workspaces[0].diagnostics.find((item) => item.code === "favorites-unreadable");
    assert.equal(warn?.severity, "warn");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
