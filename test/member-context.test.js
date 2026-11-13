import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import test from "node:test";

import { MEMBER_PACKET_LIMITS, collectMemberPackets, mergeMemberSummaries, renderMemberPackets } from "../lib/member-context.js";

function fixture() {
  const sessions = fs.mkdtempSync(nodePath.join(os.tmpdir(), "member-packets-sessions-"));
  fs.mkdirSync(nodePath.join(sessions, "--workspace-money--", "8bad8912-cb57-46ab-9ba7-33f743688e22"), { recursive: true });
  const team = {
    id: "old-team",
    members: [
      { id: "8bad8912-cb57-46ab-9ba7-33f743688e22", name: "pipeline-dev", role: "pipeline-dev", status: "idle" },
      { id: "", name: "quant-auditor", role: "quant-auditor", status: "idle" },
      { id: "gone", name: "removed-one", role: "x", status: "removed" },
    ],
    tasks: [
      { id: "t1", subject: "采集器微服务化", status: "completed", assignee: "pipeline-dev", updatedAt: 2, output: "提交 094b8c9，11 文件" },
      { id: "t2", subject: "旧任务", status: "failed", assignee: "pipeline-dev", updatedAt: 1, output: "" },
      { id: "t3", subject: "别的成员", status: "completed", assignee: "quant-auditor", updatedAt: 3, output: "复核通过" },
    ],
  };
  return { sessions, team };
}

test("member-context：收集成员、最近任务与旧会话目录，移除的成员不进包", () => {
  const { sessions, team } = fixture();
  const { members } = collectMemberPackets(team, { sessionsRootDir: sessions });
  assert.equal(members.length, 2);
  const dev = members.find((item) => item.name === "pipeline-dev");
  assert.equal(dev.sessionId, "8bad8912-cb57-46ab-9ba7-33f743688e22");
  assert.ok(dev.sessionPath.endsWith("8bad8912-cb57-46ab-9ba7-33f743688e22"));
  assert.deepEqual(dev.tasks.map((item) => item.id), ["t1", "t2"]);
  assert.equal(dev.tasks[0].output, "提交 094b8c9，11 文件");
  const auditor = members.find((item) => item.name === "quant-auditor");
  assert.equal(auditor.sessionId, "");
  assert.equal(auditor.sessionPath, null);
});

test("member-context：总结按名合并，未知成员报警、超长报错、空总结报错", () => {
  const { sessions, team } = fixture();
  const { members } = collectMemberPackets(team, { sessionsRootDir: sessions });
  const ok = mergeMemberSummaries(members, [{ name: "pipeline-dev", summary: "做到 t1，t2 卡在缺表" }]);
  assert.equal(ok.diagnostics.length, 0);
  assert.equal(ok.members.find((item) => item.name === "pipeline-dev").summary, "做到 t1，t2 卡在缺表");

  const unknown = mergeMemberSummaries(members, [{ name: "pipeline-who", summary: "x" }]);
  assert.ok(unknown.diagnostics.some((item) => item.code === "member-summary-unknown" && item.severity === "warn"));

  const long = mergeMemberSummaries(members, [{ name: "pipeline-dev", summary: "x".repeat(MEMBER_PACKET_LIMITS.summaryChars + 1) }]);
  assert.ok(long.diagnostics.some((item) => item.code === "member-summary-too-long" && item.severity === "error"));

  const empty = mergeMemberSummaries(members, [{ name: "pipeline-dev", summary: "   " }]);
  assert.ok(empty.diagnostics.some((item) => item.code === "member-summary-empty"));
});

test("member-context：渲染写明「成员之间不共享对话」，没总结的如实标未写", () => {
  const { sessions, team } = fixture();
  const { members } = collectMemberPackets(team, { sessionsRootDir: sessions });
  mergeMemberSummaries(members, [{ name: "pipeline-dev", summary: "做到 t1" }]);
  const text = renderMemberPackets(members, { teamId: "old-team" });
  assert.match(text, /成员上下文包（来自旧团队 old-team，2 名成员）/);
  assert.match(text, /成员之间不共享对话记录/);
  assert.match(text, /pipeline-dev（角色 pipeline-dev，状态 idle，旧会话 8bad8912/);
  assert.match(text, /上一代总结：做到 t1/);
  assert.match(text, /最近任务：t1 采集器微服务化（completed）——提交 094b8c9/);
  assert.match(text, /quant-auditor[\s\S]*上一代总结：未写/);
});
