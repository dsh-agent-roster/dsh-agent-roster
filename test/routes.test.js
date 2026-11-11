/**
 * 路由契约测试：用桩上下文跑 `apply()`，直接调用四个 handler。
 *
 * 它验证的不是"路由存在"，而是"面板真的要用的那几条路径能走通"：
 * 快照、单份原文、保存、删除、导入、方法不符、词典型。
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

import { apply } from "../index.js";
import { sha256Of, writeOrigin } from "../lib/origin.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

// 路由会把"用过的库根"登记到全局偏好：测试必须落在临时 DSH_HOME 里，
// 否则每跑一次测试就往真实用户的登记表里塞一条。
let testHome = null;
const previousHome = process.env.DSH_HOME;
beforeEach(() => {
  testHome = mkdtempSync(nodePath.join(tmpdir(), "dsh-agent-roster-routes-home-"));
  process.env.DSH_HOME = testHome;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  if (testHome !== null) rmSync(testHome, { recursive: true, force: true });
  testHome = null;
});
const examples = nodePath.join(root, "examples");

/** 造一个宿主桩：注册的工具与路由都被收集起来，effect 可回收。 */
function makeHost(services = {}) {
  const routes = new Map();
  const tools = new Map();
  const cleanups = [];
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      // 快照需要一个工作区注册表，否则回退到 process.cwd()（在临时目录里跑会扫错地方）。
      if (name in services) return services[name];
      if (name in services) return services[name];
      if (name in services) return services[name];
      if (name in services) return services[name];
      if (name === "workspaceRegistry") return { list: () => [{ title: "test", path: root }] };
      return undefined;
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    },
    inject(_deps, callback) {
      callback({
        webServer: {
          register(entry) {
            routes.set(entry.path, entry.handler);
            return () => routes.delete(entry.path);
          },
        },
        // 没有 connection：闸门放行，正好测最简组合。
        effect: ctx.effect,
      });
    },
  };
  return { ctx, routes, tools, cleanups };
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: new Map(),
    body: "",
    ended: false,
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    writeHead(status, headers) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value);
    },
    end(payload) {
      this.body = payload === undefined ? "" : String(payload);
      this.ended = true;
    },
  };
  return res;
}

function makeReq({ method = "GET", url = "/", headers = {}, body } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")]);
  return Object.assign(stream, {
    method,
    url,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
  });
}

async function call(host, path, request) {
  const handler = host.routes.get(path);
  assert.ok(handler, `未注册路由 ${path}`);
  const res = makeRes();
  await handler(request, res);
  const parsed = res.body === "" ? null : JSON.parse(res.body);
  return { status: res.statusCode, headers: res.headers, body: parsed, raw: res.body };
}

const CONFIG = {
  rosterDirs: ["examples"],
  knownToolPolicies: [],
  agentTeamsStateDir: ".agent-teams",
  language: "auto",
  // 路由测试不打网络：`false` 明确表示“只在本机库工作”（空数组会启用官方源）。
  indexes: false,
  region: "auto",
};

test("library：200 + 快照里能看到示例库的两份档案", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const result = await call(host, "/plugins/dsh-agent-roster/library", makeReq());
  assert.equal(result.status, 200);
  assert.equal(result.body.summary.rosters, 2);
  assert.ok(result.body.workspaces.length >= 1);
  assert.deepEqual(
    result.body.workspaces[0].rosters.map((roster) => roster.id).sort(),
    ["core-review", "research"],
  );
  assert.equal(typeof result.body.hints, "object");
  assert.equal(typeof result.body.teams, "object");
  assert.equal(typeof result.body.captain, "object");
  assert.equal(typeof result.body.sessions, "object");
  // 团队引擎：面板下拉要知道装了哪些建团插件，而不是静默失败。
  assert.deepEqual(
    result.body.hostTeamTargets.map((item) => item.id),
    ["agent-teams"],
  );
  assert.equal(result.body.hostTeamTargets.every((item) => typeof item.available === "boolean"), true);
});

test("library：方法不符返回 405 且声明 allow", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const result = await call(host, "/plugins/dsh-agent-roster/library", makeReq({ method: "POST" }));
  assert.equal(result.status, 405);
  assert.equal(result.headers.get("allow"), "GET");
});

test("document：取出原文与解析后的档案", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const result = await call(
    host,
    "/plugins/dsh-agent-roster/document",
    makeReq({ url: `/plugins/dsh-agent-roster/document?rootDir=${encodeURIComponent(examples)}&id=core-review` }),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.match(result.raw, /core-review/);
  assert.equal(result.body.roster.id, "core-review");
  assert.ok(result.body.roster.members.length >= 2);
});

test("document：不存在的档案是 404，越界 id 是 400", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const missing = await call(
    host,
    "/plugins/dsh-agent-roster/document",
    makeReq({ url: `/plugins/dsh-agent-roster/document?rootDir=${encodeURIComponent(examples)}&id=nope` }),
  );
  assert.equal(missing.status, 404);
  const unsafe = await call(
    host,
    "/plugins/dsh-agent-roster/document",
    makeReq({ url: "/plugins/dsh-agent-roster/document?id=..%2F..%2Fetc" }),
  );
  assert.equal(unsafe.status, 400);
});

test("locale：返回对应语言词典，未知语言回落到 en", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const expected = JSON.parse(readFileSync(nodePath.join(root, "locale", "zh.json"), "utf8"));
  const zh = await call(host, "/plugins/dsh-agent-roster/locale", makeReq({ url: "/plugins/dsh-agent-roster/locale?lang=zh" }));
  assert.equal(zh.status, 200);
  assert.equal(zh.body.settings.nav, expected.settings.nav);
  const fallback = await call(host, "/plugins/dsh-agent-roster/locale", makeReq({ url: "/plugins/dsh-agent-roster/locale?lang=xx" }));
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.settings.nav, "Agent Roster", "未知语言必须回落到 en");
});

test("rosters：保存、再读、删除一条龙", async () => {
  const temp = mkdtempSync(nodePath.join(tmpdir(), "roster-routes-"));
  try {
    mkdirSync(nodePath.join(temp, "mylib"), { recursive: true });
    const host = makeHost();
    apply(host.ctx, { ...CONFIG, rosterDirs: [temp] });

    const text = [
      "kind: dsh-agent-roster/v1",
      "roster: panel-made",
      "version: 1.0.0",
      "title: Panel made",
      "members:",
      "  - name: scribe",
      "    role: writer",
      "    systemPrompt: |",
      "      Write things down.",
      "",
    ].join("\n");

    const saved = await call(
      host,
      "/plugins/dsh-agent-roster/rosters",
      makeReq({ method: "POST", body: { action: "save", rootDir: temp, text, format: "yaml", overwrite: false } }),
    );
    assert.equal(saved.status, 200, saved.raw);
    assert.equal(saved.body.ok, true);
    assert.equal(readFileSync(nodePath.join(temp, "panel-made", "roster.yaml"), "utf8"), text);

    const again = await call(
      host,
      "/plugins/dsh-agent-roster/rosters",
      makeReq({ method: "POST", body: { action: "save", rootDir: temp, text, format: "yaml", overwrite: false } }),
    );
    assert.equal(again.status, 409, "重复保存必须撞 exists，而不是静默覆盖");

    const removed = await call(
      host,
      "/plugins/dsh-agent-roster/rosters",
      makeReq({ method: "POST", body: { action: "delete", rootDir: temp, id: "panel-made" } }),
    );
    assert.equal(removed.status, 200, removed.raw);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("rosters：非 JSON content-type 是 415，非法动作是 400", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const wrongType = await call(
    host,
    "/plugins/dsh-agent-roster/rosters",
    makeReq({ method: "POST", headers: { "content-type": "text/plain" }, body: { action: "save" } }),
  );
  assert.equal(wrongType.status, 415);

  const badAction = await call(
    host,
    "/plugins/dsh-agent-roster/rosters",
    makeReq({ method: "POST", body: { action: "rename" } }),
  );
  assert.equal(badAction.status, 400);
  assert.equal(badAction.body.error.code, "unknown-action");
});

test("rosters：越界的 rootDir 不会被当成路径信任", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const outside = await call(
    host,
    "/plugins/dsh-agent-roster/rosters",
    makeReq({
      method: "POST",
      body: { action: "save", rootDir: nodePath.join(root, "no-such-library"), text: "kind: dsh-agent-roster/v1", format: "yaml" },
    }),
  );
  assert.equal(outside.status, 403);
  assert.equal(outside.body.error.code, "unknown-root");
});

test("install：缺 collection 是 400，未知 collection 是 404", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);

  const missing = await call(host, "/plugins/dsh-agent-roster/install", makeReq({ method: "POST", body: {} }));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, "missing-collection");

  const unknown = await call(
    host,
    "/plugins/dsh-agent-roster/install",
    makeReq({ method: "POST", body: { collection: "no-such" } }),
  );
  // `indexes: false` 时没有远端源，任何 collection 都应当是“找不到”，而不是去猜。
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "collection-not-found");
});

test("install：GET 是 405", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const result = await call(host, "/plugins/dsh-agent-roster/install", makeReq());
  assert.equal(result.status, 405);
  assert.equal(result.headers.get("allow"), "POST");
});

test("collection：没有远端源时明确 404 并列出已知项", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const result = await call(
    host,
    "/plugins/dsh-agent-roster/collection",
    makeReq({ url: "/plugins/dsh-agent-roster/collection?id=demo" }),
  );
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, "collection-not-found");
  assert.deepEqual(result.body.known, []);
});

test("工具：apply() 之后十三个工具都在注册表里", () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  assert.deepEqual(
    [...host.tools.keys()].sort(),
    [
      "roster_capture",
      "roster_changes",
      "roster_compile",
      "roster_create",
      "roster_diff",
      "roster_index",
      "roster_iterate",
      "roster_list",
      "roster_search",
      "roster_show",
      "roster_space",
      "roster_team",
      "roster_verify",
    ],
  );
});

test("POST /space-update：没有账本如实报，越界目录 403", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);

  const noLedger = await call(
    host,
    "/plugins/dsh-agent-roster/space-update",
    makeReq({ method: "POST", body: { rootDir: examples, action: "check" } }),
  );
  assert.equal(noLedger.status, 200);
  assert.equal(noLedger.body.ok, false);
  assert.equal(noLedger.body.code, "no-origin-ledger");

  const outside = await call(
    host,
    "/plugins/dsh-agent-roster/space-update",
    makeReq({ method: "POST", body: { rootDir: "/etc", action: "check" } }),
  );
  assert.equal(outside.status, 403);
  assert.equal(outside.body.error.code, "unknown-root");
});

test("POST /space-update：check 把可快进、冲突、无法核对分开报", async () => {
  const host = makeHost();
  const dir = mkdtempSync(nodePath.join(tmpdir(), "roster-update-route-"));
  // 路由只认配置里的库根：把临时目录登记成唯一的库，白名单才放行。
  apply(host.ctx, { ...CONFIG, rosterDirs: [dir] });

  const relative = "rosters/demo/roster.yaml";
  mkdirSync(nodePath.join(dir, "rosters", "demo"), { recursive: true });
  const text = "id: demo\nversion: 1.0.0\n";
  writeFileSync(nodePath.join(dir, ...relative.split("/")), text);
  writeOrigin(dir, {
    origin: { repo: "o/r", ref: "main", path: "" },
    files: { [relative]: { sha256: sha256Of(text) } },
  });

  const original = globalThis.fetch;
  // 远端读得到、但内容没变 ⇒ 干净，且两个计数都为 0。
  globalThis.fetch = async () => ({ ok: true, status: 200, async text() { return text; } });
  try {
    const clean = await call(
      host,
      "/plugins/dsh-agent-roster/space-update",
      makeReq({ method: "POST", body: { rootDir: dir, action: "check" } }),
    );
    assert.equal(clean.status, 200);
    assert.equal(clean.body.ok, true);
    assert.equal(clean.body.fastForward, 0);
    assert.equal(clean.body.unverified, 0);

    // 远端回 500 ⇒ 没核对上，必须计入 unverified 而不是 clean。
    globalThis.fetch = async () => ({ ok: false, status: 500, async text() { return ""; } });
    const offline = await call(
      host,
      "/plugins/dsh-agent-roster/space-update",
      makeReq({ method: "POST", body: { rootDir: dir, action: "check" } }),
    );
    assert.equal(offline.body.ok, true);
    assert.equal(offline.body.unverified, 1);
    assert.equal(offline.body.summary.clean, 0);
    assert.equal(offline.body.fastForward, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("apply：方法不符是 405，缺 rosterId 是 400", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const wrongMethod = await call(host, "/plugins/dsh-agent-roster/apply", makeReq());
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");

  const missing = await call(host, "/plugins/dsh-agent-roster/apply", makeReq({ method: "POST", body: {} }));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, "missing-roster");
});

test("apply：未知团队引擎是 400，不猜一个替代", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const result = await call(
    host,
    "/plugins/dsh-agent-roster/apply",
    makeReq({ method: "POST", body: { rosterId: "core-review", target: "swarm-nope" } }),
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "unknown-target");

  // 第二个引擎已经整个删掉：它的 id 现在与任意未知 id 一样被拒绝。
  const removed = await call(
    host,
    "/plugins/dsh-agent-roster/apply",
    makeReq({ method: "POST", body: { rosterId: "core-review", target: "experimental-agent-team" } }),
  );
  assert.equal(removed.status, 400);
  assert.equal(removed.body.error.code, "unknown-target");
});

test("apply：不存在的档案是 404，并列出已知档案", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const result = await call(
    host,
    "/plugins/dsh-agent-roster/apply",
    makeReq({ method: "POST", body: { rosterId: "nope" } }),
  );
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, "roster-not-found");
  assert.deepEqual([...result.body.known].sort(), ["core-review", "research"]);
});

test("apply：没有 sessionController 时如实 503，不假装成功", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const result = await call(
    host,
    "/plugins/dsh-agent-roster/apply",
    makeReq({ method: "POST", body: { rosterId: "core-review", mode: "new" } }),
  );
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "session-controller-unavailable");
});

test("apply：有 sessionController 时切模型并把建团队提示词排进会话", async () => {
  const calls = [];
  const sessionController = {
    async create() {
      calls.push(["create"]);
      return { sessionId: "s-new" };
    },
    async selectModel(request) {
      calls.push(["selectModel", request]);
      return { selected: { provider: request.provider, model: request.model } };
    },
    async prompt(request) {
      calls.push(["prompt", request]);
      return { accepted: true };
    },
    async list() {
      return { items: [] };
    },
  };
  // 用临时副本：应用成功会给档案写收藏点文件，不能写进仓库的 examples/。
  const dir = mkdtempSync(nodePath.join(tmpdir(), "roster-routes-apply-"));
  try {
    cpSync(examples, dir, { recursive: true });
    const host = makeHost({ sessionController });
    apply(host.ctx, { ...CONFIG, rosterDirs: [dir] });
    const result = await call(
      host,
      "/plugins/dsh-agent-roster/apply",
      makeReq({ method: "POST", body: { rosterId: "core-review", mode: "new" } }),
    );
    assert.equal(result.status, 200, result.raw);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.sessionId, "s-new");
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["create", "selectModel", "prompt"],
      "core-review 的队长 route 来自角色库，应用时必须切模型",
    );
    // 用过的档案自动收藏：档案页默认只看收藏。
    const favorites = JSON.parse(readFileSync(nodePath.join(dir, ".dsh-roster-favorites.json"), "utf8"));
    assert.deepEqual(favorites.favorites ?? favorites, ["core-review"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply：已有会话但没给 sessionId 是 400 missing-session", async () => {
  const sessionController = {
    async create() {
      return { sessionId: "s" };
    },
    async prompt() {
      return { accepted: true };
    },
    async list() {
      return { items: [] };
    },
  };
  const host = makeHost({ sessionController });
  apply(host.ctx, CONFIG);
  const result = await call(
    host,
    "/plugins/dsh-agent-roster/apply",
    makeReq({ method: "POST", body: { rosterId: "core-review", mode: "existing" } }),
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "missing-session");
});

test("收藏：POST /favorites 写库根的点文件，下一次快照就带 favorite", async () => {
  const workspace = mkdtempSync(nodePath.join(tmpdir(), "roster-routes-fav-"));
  try {
    mkdirSync(nodePath.join(workspace, "demo"), { recursive: true });
    writeFileSync(
      nodePath.join(workspace, "demo", "roster.yaml"),
      "kind: dsh-agent-roster/v1\nroster: demo\nversion: 1.0.0\ntitle: Demo\nmembers:\n  - name: alpha\n    role: researcher\n    systemPrompt: hi\n",
    );
    const host = makeHost();
    apply(host.ctx, { ...CONFIG, rosterDirs: [workspace] });

    const before = await call(host, "/plugins/dsh-agent-roster/library", makeReq());
    const entry = before.body.workspaces[0].rosters.find((roster) => roster.id === "demo");
    assert.equal(entry.favorite, false, "没人收藏时是 false，不是 undefined");

    const wrote = await call(
      host,
      "/plugins/dsh-agent-roster/favorites",
      makeReq({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { rootDir: workspace, id: "demo", favorite: true },
      }),
    );
    assert.equal(wrote.status, 200);
    assert.deepEqual(wrote.body.favorites, ["demo"]);

    const after = await call(host, "/plugins/dsh-agent-roster/library", makeReq());
    assert.equal(after.body.workspaces[0].rosters.find((roster) => roster.id === "demo").favorite, true);

    // 不在白名单里的库根一律拒绝：收藏不能变成"往任意目录写文件"的入口。
    const denied = await call(
      host,
      "/plugins/dsh-agent-roster/favorites",
      makeReq({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { rootDir: "/etc", id: "demo", favorite: true },
      }),
    );
    assert.equal(denied.status, 403);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("自动登记：library-registry 能加、能撤销，登记的库出现在快照里", async () => {
  const workspace = mkdtempSync(nodePath.join(tmpdir(), "roster-routes-reg-"));
  try {
    mkdirSync(nodePath.join(workspace, "demo"), { recursive: true });
    writeFileSync(
      nodePath.join(workspace, "demo", "roster.yaml"),
      "kind: dsh-agent-roster/v1\nroster: demo\nversion: 1.0.0\ntitle: Demo\nmembers:\n  - name: alpha\n    role: researcher\n    systemPrompt: hi\n",
    );
    const host = makeHost();
    apply(host.ctx, { ...CONFIG, rosterDirs: [] });

    const added = await call(
      host,
      "/plugins/dsh-agent-roster/library-registry",
      makeReq({ method: "POST", headers: { "content-type": "application/json" }, body: { action: "add", dir: workspace } }),
    );
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.dirs, [workspace]);

    const snapshot = await call(host, "/plugins/dsh-agent-roster/library", makeReq());
    const auto = snapshot.body.workspaces.find((item) => item.rootDir === workspace);
    assert.ok(auto, "登记的库要真的出现在快照里");
    assert.equal(auto.autoRegistered, true);
    assert.equal(auto.rosters.find((roster) => roster.id === "demo") !== undefined, true);

    // 档案库必须用同一份口径：自动登记的库根也要出现在 /catalog 里。
    const catalog = await call(host, "/plugins/dsh-agent-roster/catalog", makeReq());
    assert.equal(catalog.status, 200);
    const entry = catalog.body.entries.find((item) => item.scope === "local" && item.rootDir === workspace);
    assert.ok(entry, "自动登记的库要进档案库");
    assert.equal(entry.rosterId, "demo");

    const forgot = await call(
      host,
      "/plugins/dsh-agent-roster/library-registry",
      makeReq({ method: "POST", headers: { "content-type": "application/json" }, body: { action: "forget", dir: workspace } }),
    );
    assert.equal(forgot.status, 200);
    assert.deepEqual(forgot.body.dirs, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
