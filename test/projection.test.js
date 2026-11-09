/**
 * 面板投影的"不许静默丢字段"守卫。
 *
 * 背景：captain 段曾整块从 serializeRoster 漏掉，面板因此显示"这份档案没有队长"，
 * 而工具层一直看得见——两边口径不一致，且没有任何测试会红。
 * 这里用真实样例（examples/ 与 orgs/）做判据：扫出来的每个字段要么进投影，
 * 要么在下面的清单里写明为什么不进。新增字段忘了投影，测试就会失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import nodePath from "node:path";

import { scanRosterLibrary } from "../lib/registry.js";
import { serializeRoster } from "../lib/library.js";

const REPO = nodePath.join(import.meta.dirname, "..");
const LIBRARIES = [nodePath.join(REPO, "examples"), nodePath.join(REPO, "orgs", "agent-roster-collective")];

/**
 * 有意不进面板投影的字段，每条都要写清原因。
 * 注意：这份清单是"决定"，不是"现状"——想加字段先改这里。
 */
const OMITTED = new Map([
  ["compiled", "编译产物，面板不展示；要看得走 CLI"],
  ["format", "v1/v2 的版本号，面板用不到"],
  ["license", "许可信息，只在 README/清单里"],
  ["notes", "整段备注，属于档案正文"],
  ["orchestration", "编排图只给编译/工具消费"],
  ["requires", "能力要求只进 capabilities 校验"],
  ["rolesDir", "内部路径，不外发"],
]);

/** 扫描仓库里的真实样例，逐份投影。 */
function realRosters() {
  const found = [];
  for (const rootDir of LIBRARIES) {
    const scan = scanRosterLibrary({ rootDir, knownToolPolicies: null, allowOrigin: true });
    for (const roster of scan.rosters) found.push({ rootDir, roster });
  }
  return found;
}

test("面板投影：真实样例的每个字段要么进投影，要么在忽略清单里写明理由", () => {
  const rosters = realRosters();
  assert.ok(rosters.length > 0, "真实样例一份都没扫到，测试本身失效");
  const unexpected = [];
  for (const { rootDir, roster } of rosters) {
    const projected = new Set(Object.keys(serializeRoster(roster, [])));
    for (const key of Object.keys(roster)) {
      if (projected.has(key) || OMITTED.has(key)) continue;
      unexpected.push(`${roster.id} (${rootDir}): ${key}`);
    }
  }
  assert.deepEqual(unexpected, [], `这些字段既没进面板投影，也没写明为什么不进：\n${unexpected.join("\n")}`);
});

test("面板投影：真实样例的队长段不会丢（role 式也算）", () => {
  const rosters = realRosters();
  const core = rosters.find(({ roster }) => roster.id === "core-review");
  assert.ok(core, "examples 里应当有 core-review");
  const projection = serializeRoster(core.roster, []);
  assert.ok(projection.captain, "core-review 声明了 captain，投影里不应为 null");
  assert.equal(projection.captain.roleRef, "core-review-lead-captain@1.0.0");
  assert.ok(projection.captain.personaChars > 0, "role 式队长的人设也要算进 personaChars");
  assert.equal(typeof projection.captain.provider, "string");
});

test("面板投影：没有队长的档案保持 null，而不是空对象", () => {
  const rosters = realRosters();
  const research = rosters.find(({ roster }) => roster.id === "research");
  assert.ok(research, "examples 里应当有 research");
  assert.equal(serializeRoster(research.roster, []).captain, null);
});
