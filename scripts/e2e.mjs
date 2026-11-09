#!/usr/bin/env node
// End-to-end check for the plugin as the host actually loads it.
//
// The unit tests exercise our code against hand-written fixtures.  That is
// how nine host-contract bugs survived a green suite: the fixtures encoded
// what we *assumed* the host looked like.  This script boots a throwaway
// `dsh web` on a spare port, loads the packed plugin into a copy of a real
// profile, and asks the running host what it sees.
//
//   npm run e2e                    # panel depth: no model calls, ~15 s
//   npm run e2e -- --depth=apply   # also create a real team (slow, costs model calls)
//   npm run e2e -- --depth=persona # apply depth, then read the captain's system prompts
//
// Safety: the production profile is only read.  Everything is written under
// a temporary DSH_HOME that is deleted on exit unless --keep is passed.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import nodePath from "node:path";

const REPO = nodePath.resolve(nodePath.dirname(new URL(import.meta.url).pathname), "..");
const PROD_HOME = process.env.DSH_PROD_HOME ?? nodePath.join(os.homedir(), ".dsh");
const PROD_PROFILE = process.env.DSH_E2E_PROFILE ?? nodePath.join(PROD_HOME, "profiles", "web");

function arg(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const flag = (name) => process.argv.includes(`--${name}`);
const DEPTH = arg("depth", "panel");
if (!["panel", "apply", "persona"].includes(DEPTH)) {
  console.error(`e2e: unknown depth "${DEPTH}" (panel | apply | persona)`);
  process.exit(2);
}
const BUILDS_A_TEAM = DEPTH === "apply" || DEPTH === "persona";
const KEEP = flag("keep");
const TIMEOUT_MS = Number(arg("timeout", BUILDS_A_TEAM ? "1200000" : "120000"));

let activeHome = "";
let activeChild = null;

function cleanupProbe({ keep = false } = {}) {
  if (activeChild?.pid) {
    try {
      process.kill(-activeChild.pid, "SIGTERM");
    } catch {
      try {
        activeChild.kill("SIGTERM");
      } catch {}
    }
    activeChild = null;
  }
  if (activeHome !== "" && !keep) fs.rmSync(activeHome, { recursive: true, force: true });
  activeHome = "";
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // A killed run must not leave a host listening on a probe port.
    cleanupProbe();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

let passed = 0;
let failed = 0;
const checks = [];
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    checks.push(`  ok   ${name}`);
  } else {
    failed += 1;
    checks.push(`  FAIL ${name}${detail === "" ? "" : ` — ${detail}`}`);
  }
}


// The captain's persona is injected as a system-prompt section.  Reading the
// session log is the only way to tell that apart from the kick-off message,
// which carries a copy as a fallback: the section shows up in system/message,
// the message shows up once at the start.
const DEPLOYMENT_PREFIX = "You are a coding agent powered by";

function readSystemMessages(home, sessionId) {
  const sessions = nodePath.join(home, "sessions");
  if (!fs.existsSync(sessions)) return [];
  for (const entry of fs.readdirSync(sessions)) {
    const file = nodePath.join(sessions, entry, sessionId, "session.v4.jsonl.zstd");
    if (!fs.existsSync(file)) continue;
    const text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString("utf8");
    const messages = [];
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type !== "system/message") continue;
      const content = record.data?.message?.content ?? [];
      messages.push(content.map((part) => part.text ?? "").join("\n"));
    }
    return messages;
  }
  return [];
}


function lastToolCalls(home, sessionId, limit = 5) {
  const sessions = nodePath.join(home, "sessions");
  if (!fs.existsSync(sessions)) return "";
  for (const entry of fs.readdirSync(sessions)) {
    const file = nodePath.join(sessions, entry, sessionId, "session.v4.jsonl.zstd");
    if (!fs.existsSync(file)) continue;
    const text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString("utf8");
    const names = [];
    for (const line of text.split("\n")) {
      if (!line.includes('"tool/call"')) continue;
      const match = /"name":"([^"]+)"/.exec(line);
      if (match !== null) names.push(match[1]);
    }
    return names.slice(-limit).join(" → ");
  }
  return "";
}

function fixturePersonaLine() {
  const file = nodePath.join(REPO, "examples", "roles", "core-review-lead-captain", "AGENT.md");
  if (!fs.existsSync(file)) return "";
  const text = fs.readFileSync(file, "utf8");
  const body = text.startsWith("---") ? text.replace(/^---[\s\S]*?\n---\n?/, "") : text;
  return body.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function copyTree(from, to) {
  fs.mkdirSync(nodePath.dirname(to), { recursive: true });
  // A real copy: the profile root is a mount point, so hardlinks across it
  // fail with EXDEV, and a copy of this size is only a couple of seconds.
  run("cp", ["-a", from, to]);
}

function appendPatchEntry(file, rosterDirs) {
  const quoted = rosterDirs.map((item) => JSON.stringify(item)).join(", ");
  fs.appendFileSync(
    file,
    `\n# e2e: point the plugin at the fixture library inside the throwaway home\n` +
      `- id: agent-roster\n  name: "@stofone/dsh-agent-roster"\n  config:\n    rosterDirs: [${quoted}]\n`,
  );
}

async function waitFor(check, timeoutMs, intervalMs = 250) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function main() {
  if (!fs.existsSync(nodePath.join(PROD_PROFILE, "package.json"))) {
    throw new Error(`profile not found: ${PROD_PROFILE}`);
  }
  const pkg = JSON.parse(fs.readFileSync(nodePath.join(REPO, "package.json"), "utf8"));
  // Must sit on the same filesystem as the profile: hardlink copies are what
  // keep the 550 MB probe fast, and `/tmp` is usually another (tmpfs) mount.
  const home = fs.mkdtempSync(nodePath.join(os.homedir(), ".dsh-e2e-"));
  activeHome = home;
  const profileDir = nodePath.join(home, "profiles");
  const profile = nodePath.join(profileDir, "web");
  const lib = nodePath.join(home, "lib");
  const port = Number(arg("port", "0")) || (await freePort());
  let child = null;

  console.log(`e2e: home=${home} profile=${PROD_PROFILE} port=${port} depth=${DEPTH}`);

  try {
    fs.mkdirSync(profileDir, { recursive: true });
    copyTree(PROD_PROFILE, profile);

    copyTree(nodePath.join(REPO, "examples"), lib);
    appendPatchEntry(nodePath.join(profile, "cordis.patch.yml"), [lib]);

    const tarball = run("npm", ["pack", "--silent", "--pack-destination", home], { cwd: REPO }).trim().split("\n").pop();
    const extract = nodePath.join(home, "pkg");
    fs.mkdirSync(extract, { recursive: true });
    run("tar", ["-xzf", nodePath.join(home, tarball), "-C", extract]);
    const installed = nodePath.join(profile, "node_modules", "@stofone", "dsh-agent-roster");
    fs.rmSync(installed, { recursive: true, force: true });
    run("cp", ["-a", nodePath.join(extract, "package"), installed]);

    if (BUILDS_A_TEAM) {
      const credentials = nodePath.join(PROD_HOME, ".credentials.yaml");
      if (fs.existsSync(credentials)) {
        fs.copyFileSync(credentials, nodePath.join(home, ".credentials.yaml"));
        fs.chmodSync(nodePath.join(home, ".credentials.yaml"), 0o600);
      }
    }

    const logFile = nodePath.join(home, "web.log");
    const log = fs.openSync(logFile, "a");
    child = spawn("dsh", ["web", "--port", String(port), "--no-open"], {
      cwd: home,
      env: { ...process.env, DSH_HOME: home, DSH_NO_OPEN: "1" },
      detached: true,
      stdio: ["ignore", log, log],
    });
    fs.closeSync(log);
    activeChild = child;

    const ready = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
        return response.status === 401 || response.status === 200 || response.status === 302 || response.status === 303;
      } catch {
        return false;
      }
    }, 60_000, 300);
    if (!ready) throw new Error("host did not become ready; see " + logFile);

    // The URL line prints once the loader settles, which is after the first
    // 401 from the listener — so wait for it instead of reading once.
    const token = await waitFor(() => {
      const text = fs.readFileSync(logFile, "utf8");
      return /token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? "";
    }, 45_000, 300);
    check("host prints a login token", typeof token === "string" && token !== "");
    const authToken = token ?? "";
    let cookie = "";
    if (authToken !== "") {
      const login = await fetch(`http://127.0.0.1:${port}/?token=${authToken}`, { redirect: "manual" });
      cookie = (login.headers.getSetCookie?.() ?? []).map((item) => item.split(";")[0]).join("; ");
    }
    const call = async (path, init = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), ...(cookie === "" ? {} : { cookie }), "content-type": "application/json" },
      });
      const body = await response.json().catch(() => ({}));
      return { status: response.status, body };
    };

    const library = await call("/plugins/dsh-agent-roster/library");
    check("GET /library is 200", library.status === 200, `status ${library.status}`);
    check("library reports the packed version", library.body.version === pkg.version, `got ${library.body.version}`);
    check("library lists the fixture library", Array.isArray(library.body.workspaces) && library.body.workspaces.some((workspace) => workspace.rootDir === lib));
    const space = (library.body.workspaces ?? []).find((workspace) => workspace.rootDir === lib);
    const core = (space?.rosters ?? []).find((roster) => roster.id === "core-review");
    check("fixture space has core-review", core !== undefined);
    check("projection carries the captain block", core?.captain !== null && core?.captain !== undefined, JSON.stringify(core?.captain));
    check("captain persona is non-empty", (core?.captain?.personaChars ?? 0) > 0, String(core?.captain?.personaChars));
    check("team targets are listed", Array.isArray(library.body.hostTeamTargets) && library.body.hostTeamTargets.some((target) => target.id === "agent-teams"));
    check("host models are listed", Array.isArray(library.body.hostModels) && library.body.hostModels.length > 0);

    const catalog = await call("/plugins/dsh-agent-roster/catalog");
    check("GET /catalog is 200", catalog.status === 200);
    check("catalog is non-empty", Array.isArray(catalog.body.entries) && catalog.body.entries.length > 0);

    const locale = await call("/plugins/dsh-agent-roster/locale");
    check("GET /locale is 200", locale.status === 200);

    const badTarget = await call("/plugins/dsh-agent-roster/apply", {
      method: "POST",
      body: JSON.stringify({ rosterId: "core-review", target: "no-such-engine", mode: "new" }),
    });
    check("unknown engine is rejected with 400", badTarget.status === 400, `status ${badTarget.status}`);
    check("unknown engine names the code", badTarget.body?.error?.code === "unknown-target", JSON.stringify(badTarget.body?.error));

    const badRoster = await call("/plugins/dsh-agent-roster/apply", { method: "POST", body: JSON.stringify({ rosterId: "no-such-roster", mode: "new" }) });
    check("unknown roster is rejected with 404", badRoster.status === 404, `status ${badRoster.status}`);

    const favorite = await call("/plugins/dsh-agent-roster/favorites", {
      method: "POST",
      body: JSON.stringify({ rootDir: lib, id: "core-review", favorite: true }),
    });
    check("favorite is accepted", favorite.status === 200 && (favorite.body.favorites ?? []).includes("core-review"));
    const afterFavorite = await call("/plugins/dsh-agent-roster/library");
    const coreAfter = (afterFavorite.body.workspaces ?? []).find((workspace) => workspace.rootDir === lib)?.rosters?.find((roster) => roster.id === "core-review");
    check("favorite shows up in the next snapshot", coreAfter?.favorite === true);

    if (BUILDS_A_TEAM) {
      const teamName = `e2e-${Date.now().toString(36)}`;
      const workspace = nodePath.join(home, "ws");
      fs.mkdirSync(workspace, { recursive: true });
      // Pick a model the deployment actually serves: the fixture's declared
      // route belongs to another machine, and selectModel fails closed.  Prefer
      // the provider that serves the roster's declared model — falling back to
      // "whatever is first" can land on a provider that accepts the call but
      // never drives the tool loop to completion.
      const declaredModel = core?.captain?.model ?? "";
      const providers = (library.body.hostModels ?? []).filter((provider) => (provider.models ?? []).length > 0);
      const matching = providers.find((provider) => provider.models.some((item) => item.id === declaredModel));
      const served = matching ?? providers[0];
      const model = served === undefined ? null : { provider: served.provider, model: (served.models.find((item) => item.id === declaredModel) ?? served.models[0]).id };
      check("a served model is chosen for the captain", model !== null, declaredModel);
      const applied = await call("/plugins/dsh-agent-roster/apply", {
        method: "POST",
        body: JSON.stringify({ rosterId: "core-review", target: "agent-teams", teamName, mode: "new", cwd: workspace, model }),
      });
      check("apply is queued", applied.status === 200 && applied.body.ok === true, JSON.stringify(applied.body));
      // team.json is written when the team is created; the members arrive one
      // add_member call at a time.  Member materialisation needs the deployment
      // to serve the roster's member route, which is a separate contract from
      // the captain persona — so only the apply depth insists on it.
      const expected = Array.isArray(core?.members) ? core.members.length : Number(core?.members ?? 0);
      check("fixture roster declares its members", expected > 0, String(expected));
      const teamFile = nodePath.join(workspace, ".agent-teams", teamName, "team.json");
      const team = await waitFor(() => {
        if (!fs.existsSync(teamFile)) return null;
        try {
          return JSON.parse(fs.readFileSync(teamFile, "utf8"));
        } catch {
          return null;
        }
      }, 300_000, 1_000);
      check("the captain session wrote team.json", team !== null);
      if (team !== null) {
        check("team records the captain session", typeof team.captainSessionId === "string" && team.captainSessionId.startsWith("session-"));
        check("team description carries the roster provenance", /roster:core-review@\d+\.\d+\.\d+#[0-9a-f]{8}/.test(team.description ?? ""), team.description);

        if (DEPTH === "apply") {
          const filled = await waitFor(() => {
            try {
              const parsed = JSON.parse(fs.readFileSync(teamFile, "utf8"));
              return (parsed.members ?? []).length >= expected ? parsed : null;
            } catch {
              return null;
            }
          }, TIMEOUT_MS, 2_000);
          const stalled = filled === null ? lastToolCalls(home, team.captainSessionId) : "";
          check("team has the roster's members", (filled?.members ?? []).length === expected, `${(filled?.members ?? []).length} of ${expected}${stalled === "" ? "" : `; last tool calls: ${stalled}`}`);
        }

        if (DEPTH === "persona") {
          const personaLine = fixturePersonaLine();
          check("the fixture declares a captain persona line", personaLine !== "", personaLine);
          // The section is attached when the team lands; the next assembled
          // prompt then carries it.  Wait for that prompt instead of guessing a
          // step number.
          const persona = await waitFor(() => {
            const messages = readSystemMessages(home, team.captainSessionId);
            return messages.some((text) => text.includes(personaLine)) ? messages : null;
          }, 600_000, 2_000);
          const messages = persona ?? readSystemMessages(home, team.captainSessionId);
          check("the captain session records system prompts", messages.length >= 2, String(messages.length));
          const carrying = messages.filter((text) => text.includes(personaLine));
          check("the roster persona reaches the captain's system prompt", carrying.length > 0, `${carrying.length} of ${messages.length}`);
          check("the roster persona is absent before the team exists", !(messages[0] ?? "").includes(personaLine));
          if ((messages[0] ?? "").includes(DEPLOYMENT_PREFIX)) {
            const stillDeployed = carrying.filter((text) => text.includes(DEPLOYMENT_PREFIX)).length;
            check("the injected persona replaces the deployment persona", carrying.length > 0 && stillDeployed === 0, `${stillDeployed} of ${carrying.length} still carry the deployment prefix`);
          }
        }
      }
    }
  } finally {
    const logTail = fs.existsSync(nodePath.join(home, "web.log"))
      ? fs.readFileSync(nodePath.join(home, "web.log"), "utf8").split("\n").slice(-20).join("\n")
      : "";
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    if (failed > 0) console.log(`\n--- host log tail ---\n${logTail}\n`);
    if (KEEP) console.log(`e2e: kept ${home}`);
    else fs.rmSync(home, { recursive: true, force: true });
    activeHome = "";
    activeChild = null;
  }

  console.log(`\n${checks.join("\n")}`);
  console.log(`\ne2e: ${passed} passed, ${failed} failed (${DEPTH})`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`e2e: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
