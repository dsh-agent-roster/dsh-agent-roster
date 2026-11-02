import assert from "node:assert/strict";
import test from "node:test";

import { parseProvenanceLine, provenanceLine } from "../lib/bridge.js";
import { sha256Hex, shortSha, toolFilterDigest } from "../lib/digest.js";
import { memberVerdict, verifyBindings } from "../lib/verify.js";
import { validateRoster } from "../lib/validate.js";
import { rosterDocument } from "./helpers.js";

/** 校验一份档案。 */
function rosterOf(overrides = {}) {
  const result = validateRoster(rosterDocument(overrides), { file: "core-review/roster.yaml" });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.roster;
}

/** 上游 team.json 里成员记录的真实形状：九个键，**没有** executionPrompt。 */
function persistedMember(overrides = {}) {
  return {
    id: "member-1",
    name: "reviewer",
    role: "代码评审",
    provider: "deepseek",
    model: "deepseek-v4.1-flash",
    reasoningEffort: "high",
    toolPolicy: "readonly",
    joinedAt: "2026-11-02T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

/** 一份只有单个成员的团队。 */
function teamOf(members, overrides = {}) {
  return { id: "team-1", name: "demo", phase: "running", file: ".agent-teams/team-1/team.json", members, ...overrides };
}

test("digest：toolFilter 摘要与元素顺序无关，缺字段时返回 null", () => {
  const left = toolFilterDigest({ deny: ["b", "a"], allow: [] });
  const right = toolFilterDigest({ deny: ["a", "b"], allow: [] });
  assert.equal(left.deny, 2);
  assert.equal(left.sha, right.sha);
  assert.equal(toolFilterDigest(null), null);
  assert.equal(toolFilterDigest({}), null);
  assert.equal(toolFilterDigest([]), null);
  assert.equal(sha256Hex("x").length, 64);
  assert.equal(shortSha(sha256Hex("x")).length, 8);
});

test("溯源串：能往返，且拒绝把 `+继承` 后缀读成版本号", () => {
  const roster = rosterOf();
  const sha = sha256Hex("whatever\n");
  assert.equal(provenanceLine(roster, sha), `roster:core-review@1.2.0#${sha.slice(0, 8)}`);
  assert.deepEqual(parseProvenanceLine(`这是团队描述。\n${provenanceLine(roster, sha)}`), {
    id: "core-review",
    version: "1.2.0",
    sha: sha.slice(0, 8),
    raw: `roster:core-review@1.2.0#${sha.slice(0, 8)}`,
  });
  // `1.2.0+provider,model` 不是版本号，读不出来比读成错的版本更好。
  assert.equal(parseProvenanceLine("roster:core-review@1.2.0+provider,model"), null);
  assert.equal(parseProvenanceLine("没有溯源串的一段字"), null);
  assert.equal(provenanceLine(roster), "roster:core-review@1.2.0");
});

test("核对：真实 team.json（无 executionPrompt）落进未核实桶，不算降级", () => {
  const roster = rosterOf();
  const report = verifyBindings([roster], [teamOf([persistedMember()])]);
  const reviewer = report.checks.find((check) => check.member === "reviewer");
  assert.equal(reviewer.found, true);
  assert.equal(reviewer.faithful, false);
  assert.equal(memberVerdict(reviewer), "unverified");
  assert.equal(report.summary.unverified, 1);
  assert.equal(report.summary.drift, 0);
  assert.equal(report.summary.faithful, 0);
});

test("核对：运行时真的换了模型 → 落进降级桶", () => {
  const roster = rosterOf();
  const report = verifyBindings([roster], [teamOf([persistedMember({ model: "deepseek-v4.1-mini" })])]);
  const reviewer = report.checks.find((check) => check.member === "reviewer");
  assert.equal(memberVerdict(reviewer), "drift");
  assert.equal(report.summary.drift, 1);
  assert.equal(report.summary.unverified, 0);
});

test("策略漂移：同一 toolPolicy 物化成两份 deny 列表就要报出来", () => {
  const roster = rosterOf();
  const members = [
    persistedMember({ name: "reviewer", toolFilter: { deny: ["a", "b"] } }),
    persistedMember({ id: "member-2", name: "release-manager", toolFilter: { deny: ["a"] } }),
  ];
  const report = verifyBindings([roster], [teamOf(members)]);
  assert.equal(report.summary.policyDrift, 1);
  assert.equal(report.policyDrift[0].toolPolicy, "readonly");
  assert.equal(report.policyDrift[0].variants.length, 2);
  assert.deepEqual(report.policyDrift[0].variants.map((variant) => variant.deny).sort(), [1, 2]);
  // 同一份 deny 列表则不报漂移。
  const ok = verifyBindings([roster], [teamOf([persistedMember({ toolFilter: { deny: ["a", "b"] } })])]);
  assert.equal(ok.summary.policyDrift, 0);
});

test("溯源核对：内容一致 / 内容已变 / 缺少哈希 / 没有溯源串", () => {
  const roster = rosterOf();
  const sha = sha256Hex("v1");
  const withLine = (description) => [teamOf([persistedMember()], { description })];
  const rosters = { [roster.id]: sha };

  const match = verifyBindings([roster], withLine(`团队描述\n${provenanceLine(roster, sha)}`), { rosterShas: rosters });
  assert.equal(match.provenance[0].status, "match");
  assert.equal(match.summary.provenanceDiffer, 0);

  const differ = verifyBindings([roster], withLine(`团队描述\n${provenanceLine(roster, sha256Hex("v2"))}`), {
    rosterShas: rosters,
  });
  assert.equal(differ.provenance[0].status, "differ");
  assert.equal(differ.summary.provenanceDiffer, 1);

  const idOnly = verifyBindings([roster], withLine(provenanceLine(roster)), { rosterShas: rosters });
  assert.equal(idOnly.provenance[0].status, "id-only");

  const absent = verifyBindings([roster], withLine("这个团队没有出处"), { rosterShas: rosters });
  assert.equal(absent.provenance[0].status, "absent");
  assert.equal(absent.summary.provenanceAbsent, 1);

  const unknown = verifyBindings([roster], withLine(provenanceLine(roster, sha)), { rosterShas: {} });
  assert.equal(unknown.provenance[0].status, "unknown-roster");
});
