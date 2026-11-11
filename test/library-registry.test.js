/**
 * 自动登记的库根：工具用过的目录不该因为没写进配置就永远看不见。
 *
 * 用临时 DSH_HOME 隔离：偏好写在全局库根，测试不能碰真实用户目录。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { forgetLibraryDir, registeredLibraryDirs, rememberLibraryDir } from "../lib/preferences.js";
import { collectLibrary } from "../lib/library.js";
import { resolveRoots } from "../lib/service.js";

const ROSTER = `kind: dsh-agent-roster/v1
roster: demo
version: 1.0.0
title: Demo
defaults:
  provider: deepseek-official
  model: deepseek-flash
members:
  - name: alpha
    role: researcher
    systemPrompt: You are alpha.
`;

describe("自动登记的库根", () => {
  let home;
  let lib;
  const previous = process.env.DSH_HOME;

  beforeEach(() => {
    home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dsh-agent-roster-home-"));
    lib = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dsh-agent-roster-reg-"));
    fs.mkdirSync(nodePath.join(lib, "demo"), { recursive: true });
    fs.writeFileSync(nodePath.join(lib, "demo", "roster.yaml"), ROSTER);
    process.env.DSH_HOME = home;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(lib, { recursive: true, force: true });
  });

  it("记住、读到、忘掉：只收绝对路径，重复登记是幂等的", () => {
    assert.deepEqual(registeredLibraryDirs(), []);
    assert.equal(rememberLibraryDir("relative/dir").code, "invalid-dir");
    assert.deepEqual(rememberLibraryDir(lib), { ok: true, added: true, dirs: [lib] });
    assert.deepEqual(rememberLibraryDir(lib), { ok: true, added: false, dirs: [lib] });
    assert.deepEqual(registeredLibraryDirs(), [lib]);
    assert.equal(forgetLibraryDir(lib), true);
    assert.deepEqual(registeredLibraryDirs(), []);
  });

  it("面板快照把登记的库当成一座库，并标出来源", () => {
    rememberLibraryDir(lib);
    const ctx = { get: () => undefined };
    const config = { rosterDirs: [], knownToolPolicies: [], agentTeamsStateDir: ".agent-teams" };
    const snap = collectLibrary(ctx, config, { name: "x", version: "1" }, {
      registeredLibraryDirs: registeredLibraryDirs(),
    });
    const auto = snap.workspaces.find((workspace) => workspace.autoRegistered === true);
    assert.ok(auto, "登记的库要出现在快照里");
    assert.equal(auto.rootDir, lib);
    assert.equal(auto.dirSpec, "auto");
    assert.deepEqual(auto.rosters.map((roster) => roster.id), ["demo"]);
  });

  it("登记的库也进写入白名单，否则面板看得见却保存不了", () => {
    rememberLibraryDir(lib);
    const roots = resolveRoots({ get: () => undefined }, { rosterDirs: [] }, {
      registeredLibraryDirs: registeredLibraryDirs(),
    });
    assert.ok(roots.some((root) => root.rootDir === lib && root.dirSpec === "auto"));
  });
});
