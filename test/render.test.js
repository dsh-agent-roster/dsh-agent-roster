/**
 * 人读渲染的汇总契约。
 *
 * 锁两件在实机上出过问题的事：
 * 1. 汇总行只数成员字段 ⇒ 档案写了队长人设、部署没落时仍报「需落配置：0」；
 * 2. 人设差距被报成「不一致」⇒ 一条永远红、且没有可执行修复路径的判据。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildMemberBinding } from "../lib/bridge.js";
import { renderBridgePlan, renderCaptainVerification } from "../lib/render.js";

const member = {
  name: "lead",
  role: "队长",
  systemPrompt: "你是研究队的队长。",
  tools: { scope: { allow: ["read"] } },
};

const roster = {
  id: "team",
  version: "2.0.0",
  captain: {
    provider: "tsingmicro",
    model: "deepseek-v4.1-flash",
    reasoningEffort: "high",
    personaPrefix: "你是研究队的队长。",
  },
  members: [member],
  orchestration: null,
};

const entries = [{ member, ...buildMemberBinding(roster, member) }];

test("桥接计划：汇总行算上档案级声明（captain.route / captain.persona / tools.scope）", () => {
  const text = renderBridgePlan({ roster, entries, declarations: null });
  assert.match(text, /需落配置：2（captain\.persona、captain\.route）/);
  assert.match(text, /仅声明：1（member\.tools\.scope）/);
});

test("桥接计划：编译产物给了 declarations 时用同一套口径，不重复计数", () => {
  const declarations = [
    { scope: "captain", field: "route", note: "config：只能由 profile 落地" },
    { scope: "captain", field: "persona", note: "config：需要落到 profile preset 的 persona" },
    { scope: "member", member: "lead", field: "tools.scope", note: "declaration：运行时不生效" },
  ];
  const text = renderBridgePlan({ roster, entries, declarations });
  assert.match(text, /需落配置：2（captain\.persona、captain\.route）/);
  assert.match(text, /仅声明：1（member\.tools\.scope）/);
});

test("队长核对：人设差距显示为需落配置，并给出文件与 preset", () => {
  const text = renderCaptainVerification({
    checks: [
      {
        field: "personaPrefix",
        status: "needs-config",
        declared: "你是研究队的队长，先划边界再要结论。",
        actual: "You are a helpful assistant.",
        fix: { file: "profiles/web/cordis.patch.yml", preset: "preset-standard", restart: true },
      },
    ],
  });
  assert.match(text, /⚠ 需落配置 personaPrefix/);
  assert.match(text, /profiles\/web\/cordis\.patch\.yml/);
  assert.match(text, /preset-standard/);
  assert.doesNotMatch(text, /✗ 不一致/);
});
