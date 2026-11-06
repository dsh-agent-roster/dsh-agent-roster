/**
 * 工具层契约测试。
 *
 * 这里锁的是两件在真机上翻过车的事：
 * 1. 模型读到的是 `render()` 产出的文本，不是返回对象——所以每个工具的首行必须是
 *    可解析的 `k=v` 状态行，否则"成功没有"只能靠中文措辞去猜。
 * 2. 返回值必须能无损往返 JSON，否则运行时会整次拒绝（`value is not lossless JSON`）。
 *
 * 依赖 `@deepseek-ai/dsh-tools`（devDependency）提供真实的 `defineTool`；
 * 版本与宿主未必一致，所以这里只断言形状契约，不断言宿主内部行为。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isLossless } from "../lib/json.js";
import { registerRosterTools } from "../lib/tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examples = path.join(root, "examples");

/** 用最小的假 ctx 注册工具，返回 name → tool 的映射。 */
function register(overrides = {}) {
  const tools = new Map();
  const disposers = [];
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    effect(fn) {
      disposers.push(fn());
    },
  };
  registerRosterTools(ctx, { rosterDirs: ["rosters"], knownToolPolicies: [], agentTeamsStateDir: ".agent-teams", ...overrides }, { version: "0.1.0" });
  return { tools, disposers };
}

const exec = { agent: { session: { header: { cwd: root } } } };

/** 调一次工具，返回返回值与首行文本；顺带断言无损与渲染形状。 */
async function call(tools, name, args) {
  const tool = tools.get(name);
  assert.ok(tool, `未注册 ${name}`);
  const value = await tool.execute(args, exec);

  const losslessCheck = isLossless(value);
  assert.equal(losslessCheck.ok, true, `${name} 返回值不可无损往返：${losslessCheck.reason}`);

  const blocks = tool.output.render(args, value);
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} 必须渲染出内容块`);
  assert.equal(typeof blocks[0].text, "string");
  const firstLine = blocks[0].text.split("\n")[0];
  assert.match(firstLine, new RegExp(`^\\[${name}\\] `), `${name} 首行应是 [${name}] 状态行，实际：${firstLine}`);
  return { value, firstLine, text: blocks[0].text };
}

test("注册十一个工具，旧的六个能在 examples 上执行", async () => {
  const { tools } = register();
  assert.deepEqual([...tools.keys()].sort(), [
    "roster_changes",
    "roster_compile",
    "roster_create",
    "roster_diff",
    "roster_index",
    "roster_list",
    "roster_search",
    "roster_show",
    "roster_space",
    "roster_team",
    "roster_verify",
  ]);

  const list = await call(tools, "roster_list", { path: examples });
  assert.match(list.firstLine, /total=2/);
  assert.match(list.firstLine, /ok=2/);

  const show = await call(tools, "roster_show", { ref: "core-review", path: examples });
  assert.match(show.firstLine, /found=true/);
  assert.match(show.firstLine, /members=3/);

  const create = await call(tools, "roster_create", { ref: "research", path: examples });
  assert.match(create.firstLine, /ok=true/);
  assert.match(create.firstLine, /calls=2/);
  // v2 库里的档案也要拿得到内容哈希：少了 #sha，团队溯源只能对到"哪一版"，对不到"哪一份"。
  assert.match(create.value.text, /roster:research@\d+\.\d+\.\d+#[0-9a-f]{8}/);

  const verify = await call(tools, "roster_verify", { path: examples, stateDir: path.join(root, "test", "no-such-state") });
  assert.match(verify.firstLine, /state=unavailable/);
  assert.match(verify.firstLine, /missing=5/);
});

test("新工具：空间、搜索、编译预览、更新检查、建团队", async () => {
  const { tools } = register();

  const space = await call(tools, "roster_space", { path: examples });
  assert.match(space.firstLine, /space=examples/);
  assert.match(space.firstLine, /layout=monorepo/);
  assert.equal(space.value.missing.length, 0);

  const found = await call(tools, "roster_search", { query: "review", path: examples, remote: false });
  assert.match(found.firstLine, /hits=\d+/);
  assert.ok(Array.isArray(found.value.results));

  const preview = await call(tools, "roster_compile", { ref: "core-review", path: examples });
  assert.match(preview.firstLine, /id=core-review/);
  assert.equal(preview.value.ok, true);

  const changes = await call(tools, "roster_changes", { path: examples, refresh: false });
  assert.match(changes.firstLine, /ok=false|ok=true/);

  // 没有 sessionController 时如实报 unavailable，而不是假装建了团队。
  const team = await call(tools, "roster_team", { id: "core-review", path: examples });
  assert.equal(team.value.ok, false);
  assert.match(team.firstLine, /ok=false/);

  // existing 模式缺 sessionId 时先拦住，不去碰 sessionController。
  const noSession = await call(tools, "roster_team", { id: "core-review", mode: "existing", path: examples });
  assert.equal(noSession.value.code, "missing-session");

  // 索引：collection 上要能看出本机有没有对应副本（这里没拉过，就是 false）。
  const index = await call(tools, "roster_index", {});
  assert.equal(index.value.collections.length > 0, true);
  assert.equal(index.value.collections[0].pulled.present, false);
});

test("找不到档案时也是同一套状态行，而不是自由文本", async () => {
  const { tools } = register();
  const show = await call(tools, "roster_show", { ref: "no-such-roster", path: examples });
  assert.equal(show.value.found, false);
  assert.match(show.firstLine, /found=false/);

  const create = await call(tools, "roster_create", { ref: "no-such-roster", path: examples });
  assert.equal(create.value.ok, false);
  assert.match(create.firstLine, /ok=false/);
});

test("显式 path 覆盖配置目录（真机回归点）", async () => {
  const { tools } = register();
  const byDefault = await call(tools, "roster_list", {});
  assert.equal(byDefault.value.rootDir, path.resolve(root, "rosters"), "默认应走配置的 rosters");

  const overridden = await call(tools, "roster_list", { path: examples });
  assert.equal(overridden.value.rootDir, path.resolve(examples));
  assert.match(overridden.firstLine, /total=2/);
});

test("释放后不残留工具", () => {
  const { tools, disposers } = register();
  assert.equal(tools.size, 11);
  for (const dispose of disposers) dispose();
  assert.equal(tools.size, 0);
});

test("roster_index 能真的跑起来：工具体里引用的函数都 import 了", async () => {
  // 这条针对 0.10.2 的事故：execute() 里用了 loadRemotePanel / fetchCollection，
  // 文件顶部却没 import，模块加载期不报错，一调用就 ReferenceError。
  const { tools } = register({ indexes: false });
  const { value, firstLine } = await call(tools, "roster_index", {});
  assert.match(firstLine, /^\[roster_index\] /);
  assert.deepEqual(value.collections, []);
  assert.deepEqual(value.indexes, []);
});
