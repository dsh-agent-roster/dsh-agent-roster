/**
 * 交接包投递核对：包写盘之后，队长有没有真的把它发给成员。
 *
 * 这些断言守的是「不把读不到说成没送到」——三种结果必须分得开：
 * 日志里出现包 → 已送达；日志读得到但没有 → 未送达；没有会话/日志 → 无法核对。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import zlib from "node:zlib";

import { packetDelivered, sessionLogText } from "../lib/member-context.js";
import { latestPacketFiles } from "../lib/handover.js";
import { verifyBindings } from "../lib/verify.js";

/** 造一个假会话目录：`<root>/--workspace-x--/<id>/session.v4.jsonl.zstd`。 */
function writeSession(root, sessionId, lines) {
  const dir = nodePath.join(root, "--workspace-x--", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  fs.writeFileSync(nodePath.join(dir, "session.v4.jsonl.zstd"), zlib.zstdCompressSync(Buffer.from(text, "utf8")));
  return dir;
}

test("sessionLogText：能解开 zstd 日志；找不到会话返回 null", () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "roster-session-"));
  writeSession(root, "s1", [{ type: "session", id: "s1" }, { type: "note", text: "hello" }]);
  assert.match(sessionLogText("s1", root) ?? "", /hello/);
  assert.equal(sessionLogText("no-such", root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("packetDelivered：出现包路径 → true；读得到但没有 → false；没有会话 → null", () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "roster-session-"));
  writeSession(root, "with-packet", [
    { type: "agent/inbox/spliced", data: { inserted: [{ content: [{ type: "text", text: "你的上一代交接包：/x/.dsh-handover/r-1-members/pipeline-dev.md" }] }] } },
  ]);
  writeSession(root, "without-packet", [{ type: "agent/inbox/spliced", data: { inserted: [{ content: [{ type: "text", text: "开始干活" }] }] } }]);

  assert.equal(packetDelivered("with-packet", "/x/.dsh-handover/r-1-members/pipeline-dev.md", root), true);
  assert.equal(packetDelivered("without-packet", "/x/.dsh-handover/r-1-members/pipeline-dev.md", root), false);
  assert.equal(packetDelivered("missing-session", "/x/p.md", root), null);
  assert.equal(packetDelivered("", "/x/p.md", root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("latestPacketFiles：取最新一代的成员包；没做过交接返回 null", () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "roster-handover-"));
  assert.equal(latestPacketFiles(root, "r"), null);
  const older = nodePath.join(root, ".dsh-handover", "r-20260101-000000-members");
  const newer = nodePath.join(root, ".dsh-handover", "r-20260102-000000-members");
  fs.mkdirSync(older, { recursive: true });
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(nodePath.join(older, "a.md"), "old");
  fs.writeFileSync(nodePath.join(newer, "a.md"), "new");
  fs.writeFileSync(nodePath.join(newer, "b.md"), "new");
  fs.utimesSync(older, new Date(2026, 0, 1), new Date(2026, 0, 1));
  fs.utimesSync(newer, new Date(2026, 0, 2), new Date(2026, 0, 2));
  const files = latestPacketFiles(root, "r");
  assert.deepEqual(Object.keys(files).sort(), ["a", "b"]);
  assert.match(files.a, /20260102-000000-members/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("verifyBindings：把投递结论带进成员记录，三种状态互不冒充", () => {
  const rosters = [
    {
      id: "r",
      version: "1.0.0",
      members: [
        { name: "a", role: { name: "x", version: "1.0.0" }, fields: {} },
        { name: "b", role: { name: "x", version: "1.0.0" }, fields: {} },
        { name: "c", role: { name: "x", version: "1.0.0" }, fields: {} },
      ],
    },
  ];
  const teams = [
    {
      id: "t",
      name: "t",
      members: [
        { name: "a", id: "s-a" },
        { name: "b", id: "s-b" },
        { name: "c", id: "" },
      ],
    },
  ];
  const report = verifyBindings(rosters, teams, {
    packets: {
      files: { r: { a: "/x/a.md", b: "/x/b.md", c: "/x/c.md" } },
      delivered: (sessionId) => (sessionId === "s-a" ? true : sessionId === "s-b" ? false : null),
    },
  });
  const byName = new Map(report.checks.map((check) => [check.member, check.packet]));
  assert.deepEqual(byName.get("a"), { file: "/x/a.md", delivered: true });
  assert.deepEqual(byName.get("b"), { file: "/x/b.md", delivered: false });
  assert.deepEqual(byName.get("c"), { file: "/x/c.md", delivered: null });

  const none = verifyBindings(rosters, teams, {});
  assert.ok(none.checks.every((check) => check.packet === null));
});
