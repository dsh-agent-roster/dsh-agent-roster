/**
 * 1.5.0 的五个工具：空间、搜索、更新检查、编译预览、从档案建团队。
 *
 * 前四个只读；`roster_team` 是唯一会真的动运行时的工具——它建一个会话（或复用已有的），
 * 改会话名，选队长模型，再把"按这份档案建团队"的提示排进去。手工面板走的是同一条
 * `applyCaptain`，所以两边不会漂移。
 *
 * @module dsh-agent-roster/tools-space
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import fs from "node:fs";
import nodePath from "node:path";

import { applyCaptain, listHostWorkspaces, listSessions } from "./apply.js";
import { compileRosterAt } from "./compile2.js";
import { checkOrigin, readOrigin } from "./origin.js";

import { fetchCollection } from "./remote.js";
import { searchRosters } from "./search.js";
import { loadRemotePanel } from "./service.js";
import { statusLine } from "./tool-output.js";
import { TEAM_TARGET_IDS } from "./team-targets.js";

const OUTPUT = { type: "object", additionalProperties: true };

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {object} config
 * @param {{ version: string }} meta
 * @param {{ resolve: Function, scanAt: Function }} helpers
 */
export function registerExtraRosterTools(ctx, config, meta, helpers) {
  const { resolve, scanAt } = helpers;

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_space",
          description:
            "看一座本地档案空间（space.yaml）的现状：布局、登记了哪些档案、实际在库几份、缺哪份、角色几个、来源与拉取版本。" +
            "没有 space.yaml 的 v1 档案库也能看，会如实说明「这不是空间，是平铺库」。本工具只读。",
          parameters: { path: { type: "string", description: "空间目录；省略则用配置的 rosterDirs 第一项" } },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir } = resolve(exec, args.path);
            const scan = scanAt(rosterDir);
            const ledger = readOrigin(rosterDir);
            const space = scan.space;
            const present = new Set(scan.rosters.map((roster) => roster.id));
            const declared = Array.isArray(space?.rosters) ? space.rosters : [];
            const missing = declared.filter((entry) => !present.has(entry.id)).map((entry) => entry.id);
            const undeclared = [...present].filter((id) => !declared.some((entry) => entry.id === id)).sort();
            const lines = [];
            lines.push(
              statusLine("roster_space", {
                rootDir: rosterDir,
                space: space === null ? "none" : space.id,
                layout: space?.layout ?? "none",
                declared: declared.length,
                present: present.size,
                missing: missing.length,
              }),
            );
            if (space === null) {
              lines.push(`这个目录没有 space.yaml：它是平铺档案库，在库 ${present.size} 份档案。`);
            } else {
              lines.push(`空间 ${space.id}${space.title ? `（${space.title}）` : ""} · 布局 ${space.layout}`);
              lines.push(`登记 ${declared.length} 份 · 在库 ${present.size} 份 · 缺 ${missing.length} 份 · 未登记 ${undeclared.length} 份`);
              if (space.license || space.homepage) lines.push(`许可 ${space.license || "-"} · 主页 ${space.homepage || "-"}`);
              if (Array.isArray(space.roles) && space.roles.length > 0) lines.push(`角色 ${space.roles.length} 个：${space.roles.join(", ")}`);
              if (space.origin) lines.push(`来源 ${space.origin.repo}@${space.origin.ref}${space.origin.path ? `/${space.origin.path}` : ""}`);
              if (missing.length > 0) lines.push(`缺：${missing.join(", ")}`);
              if (undeclared.length > 0) lines.push(`未登记：${undeclared.join(", ")}`);
            }
            if (ledger !== null && ledger.broken !== true) {
              lines.push(`账本 ${ledger.commit === null ? "无 commit" : `commit ${ledger.commit.slice(0, 8)}`} · 拉取于 ${ledger.pulledAt ?? "-"} · ${Object.keys(ledger.files).length} 个文件有基线`);
            } else {
              lines.push("账本：无（不是 clone 拉的；更新检测没有基线）");
            }
            const problems = scan.diagnostics.filter((item) => item.severity !== "info");
            if (problems.length > 0) lines.push("", problems.map((item) => `${item.severity} ${item.code}: ${item.reason}`).join("\n"));
            return {
              source: `@stofone/dsh-agent-roster@${meta.version}`,
              rootDir: rosterDir,
              layout: space?.layout ?? null,
              space: space === null ? null : { id: space.id, title: space.title ?? "", license: space.license ?? "", homepage: space.homepage ?? "", roles: space.roles ?? [], origin: space.origin ?? null },
              declared: declared.map((entry) => entry.id),
              present: [...present].sort(),
              missing,
              undeclared,
              commit: ledger !== null && ledger.broken !== true ? ledger.commit : null,
              pulledAt: ledger !== null && ledger.broken !== true ? ledger.pulledAt : null,
              trackedFiles: ledger !== null && ledger.broken !== true ? Object.keys(ledger.files).length : 0,
              diagnostics: scan.diagnostics,
              text: lines.join("\n"),
            };
          },
          presentCall: () => ({ card: "generic", title: "档案空间" }),
          presentResult: (_args, result) => ({ card: "generic", title: result.isError ? "读取空间失败" : "档案空间" }),
        }),
      ),
    "dsh-agent-roster: roster_space",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_search",
          description:
            "按能力找档案：id / 标题 / 标签 / 技能 / 成员角色 / 成员名 / 描述 / 备注 一起搜，多词是「且」。" +
            "默认同时搜本机与订阅来源（远端是只读展开，不写本机档案库）。返回每条的命中字段与出处。",
          parameters: {
            query: { type: "string", required: true, description: '要找的能力，如 "数据质量"、"security review"' },
            path: { type: "string", description: "只搜这座本地档案库；省略则搜配置里的库" },
            remote: { type: "boolean", description: "是否连订阅来源一起搜（默认 true）" },
            limit: { type: "number", description: "最多返回几条（1..50，默认 10）" },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const query = typeof args.query === "string" ? args.query.trim() : "";
            const limit = Math.max(1, Math.min(50, Number.isFinite(args.limit) ? Number(args.limit) : 10));
            if (query === "") {
              return { ok: false, code: "empty-query", text: statusLine("roster_search", { ok: false, reason: "query 是空的" }) };
            }
            const { rosterDir } = resolve(exec, args.path);
            const entries = [];
            const scan = scanAt(rosterDir);
            for (const roster of scan.rosters) entries.push({ scope: "local", roster, source: rosterDir });
            let remoteCount = 0;
            const diagnostics = [...scan.diagnostics];
            if (args.remote !== false) {
              const panel = await loadRemotePanel(config, {});
              diagnostics.push(...panel.diagnostics);
              const collections = panel.collections.slice(0, 8);
              const truncated = panel.collections.length - collections.length;
              if (truncated > 0) {
                diagnostics.push({
                  severity: "info",
                  code: "search-sources-truncated",
                  params: { skipped: truncated },
                  reason: `来源太多，只搜了前 ${collections.length} 个；还有 ${truncated} 个没搜。`,
                });
              }
              for (const collection of collections) {
                try {
                  const fetched = await fetchCollection(collection);
                  for (const roster of fetched.rosters) {
                    entries.push({ scope: "remote", roster, source: collection.id, collectionId: collection.id });
                    remoteCount += 1;
                  }
                  diagnostics.push(...fetched.diagnostics);
                } catch (error) {
                  diagnostics.push({ severity: "warn", code: "search-source-failed", params: { source: collection.id }, reason: String(error?.message ?? error) });
                }
              }
            }
            const result = searchRosters(query, entries, { limit });
            const lines = [
              statusLine("roster_search", { query, local: scan.rosters.length, remote: remoteCount, hits: result.matches.length }),
            ];
            const truncatedNote = diagnostics.find((item) => item.code === "search-sources-truncated");
            if (truncatedNote !== undefined) lines.push(truncatedNote.reason);
            for (const hit of result.matches) {
              const where = hit.scope === "local" ? "本机" : `来源 ${hit.collectionId}`;
              const hits = hit.hits.map((item) => `${item.label}：${item.text}`).join(" · ");
              lines.push(`${hit.rosterId}  ${hit.title || hit.rosterId}  ·  ${hit.members} 名成员  ·  ${where}\n    ${hits}`);
            }
            if (result.matches.length === 0) lines.push("没有命中的档案。");
            return {
              ok: true,
              query,
              local: scan.rosters.length,
              remote: remoteCount,
              results: result.matches.map((hit) => ({
                id: hit.rosterId,
                title: hit.title,
                scope: hit.scope,
                source: hit.collectionId ?? null,
                members: hit.members,
                hits: hit.hits,
              })),
              diagnostics,
              text: lines.join("\n"),
            };
          },
          presentCall: (args) => ({ card: "generic", title: `找档案 ${args.query}` }),
          presentResult: (_args, result) => ({ card: "generic", title: result.isError ? "搜索失败" : "搜索结果" }),
        }),
      ),
    "dsh-agent-roster: roster_search",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_compile",
          description:
            "编译预览：把 v2 档案（roles + rosters）按当前源文件编译一遍，给出成员数、每段人设的字符数与 parts/includes 明细、诊断。" +
            "**不写 dist**；要落盘用 CLI `compile --write`。本工具只读。",
          parameters: {
            ref: { type: "string", required: true, description: "档案 id（v2 库）" },
            path: { type: "string", description: "档案库目录；省略则用配置的 rosterDirs 第一项" },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir } = resolve(exec, args.path);
            const scan = scanAt(rosterDir);
            const id = String(args.ref ?? "");
            const v2 = fs.existsSync(nodePath.join(rosterDir, "roles")) && fs.existsSync(nodePath.join(rosterDir, "rosters"));
            if (!v2) {
              return {
                ok: false,
                code: "not-a-space",
                text: statusLine("roster_compile", { ok: false, reason: "这不是 v2 库（没有 roles/ 与 rosters/ 两个目录）" }),
              };
            }
            const dir = nodePath.join(rosterDir, "rosters", id);
            const compiled = compileRosterAt(dir, {
              rolesDir: nodePath.join(rosterDir, "roles"),
              libraryRoot: rosterDir,
              expectedId: id,
              knownToolPolicies: config.knownToolPolicies ?? null,
            });
            const lines = [statusLine("roster_compile", { id, ok: compiled.ok === true, members: compiled.compiled?.members?.length ?? 0 })];
            if (!compiled.ok) {
              for (const item of compiled.diagnostics ?? []) lines.push(`${item.severity} ${item.code}: ${item.reason ?? ""}`);
            } else {
              for (const member of compiled.compiled.members) {
                const stats = member.promptStats ?? {};
                lines.push(`  ${member.name}  ${member.role}  ${stats.chars ?? 0} 字符  parts ${(stats.parts ?? []).length}`);
                for (const part of stats.parts ?? []) lines.push(`      ${part.kind}  ${part.path}${part.line === undefined ? "" : `:${part.line}`}`);
              }
              lines.push(`空间 ${scan.space.id} · 不写 dist（要落盘用 CLI compile --write）`);
            }
            return {
              ok: compiled.ok === true,
              id,
              members: compiled.compiled?.members?.map((member) => ({ name: member.name, role: member.role, promptStats: member.promptStats })) ?? [],
              diagnostics: compiled.diagnostics ?? [],
              text: lines.join("\n"),
            };
          },
          presentCall: (args) => ({ card: "generic", title: `编译预览 ${args.ref}` }),
          presentResult: (_args, result) => ({ card: "generic", title: result.isError ? "编译失败" : "编译预览" }),
        }),
      ),
    "dsh-agent-roster: roster_compile",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_changes",
          description:
            "检查拉下来的档案空间有没有变：逐文件比对「拉取时的摘要 / 当前本地 / 当前远端」，给出六态（clean / local-only / remote-only / diverged / remote-deleted / missing）。" +
            "只报告，不写；冲突不自动合并。要快进远端用 CLI `update --write` 或面板。",
          parameters: {
            path: { type: "string", description: "空间目录；省略则用配置的 rosterDirs 第一项" },
            refresh: { type: "boolean", description: "是否连远端一起比（默认 true；false 只看本地改没改）" },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir } = resolve(exec, args.path);
            const result = await checkOrigin(rosterDir, {
              fetchImpl: typeof globalThis.fetch === "function" ? globalThis.fetch : null,
              refresh: args.refresh !== false,
            });
            return {
              ok: result.ok,
              rootDir: rosterDir,
              code: result.code ?? null,
              origin: result.origin ?? null,
              commit: result.commit ?? null,
              entries: (result.entries ?? []).map((entry) => ({
                path: entry.path,
                state: entry.state,
                local: entry.local,
                remote: entry.remote,
              })),
              summary: result.summary ?? {},
              text: `${statusLine("roster_changes", {
                rootDir: rosterDir,
                ok: result.ok,
                pending: result.pending ?? 0,
              })}\n\n${result.text}`,
            };
          },
          presentCall: () => ({ card: "generic", title: "检查更新" }),
          presentResult: (_args, result) => ({ card: "generic", title: result.isError ? "检查失败" : "更新检查" }),
        }),
      ),
    "dsh-agent-roster: roster_changes",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_team",
          description:
            "从一份档案创建团队：新建一个会话（可选落在哪个空间、叫什么名字）或复用已有会话，把队长模型按档案选好，再排入「按这份档案建团队」的提示。" +
            "手工面板的「创建团队」走同一段实现，两边行为一致。会真的建会话/排提示，不是只读工具。",
          parameters: {
            id: { type: "string", required: true, description: "档案 id" },
            teamName: { type: "string", description: "团队名；缺省用档案 id" },
            mode: { type: "string", description: '"new"（默认）或 "existing"' },
            workspace: { type: "string", description: "新建会话时落在哪个空间：工作区 id / 标题 / 路径都认；缺省取包含这份档案的那个工作区" },
            sessionName: { type: "string", description: "新建会话的名字；缺省用团队名" },
            sessionId: { type: "string", description: 'mode="existing" 时必填' },
            target: {
              type: "string",
              description: '团队引擎："agent-teams"（默认）或 "experimental-agent-team"；未知值报 unknown-target',
            },
            path: { type: "string", description: "档案库目录；省略则用配置的 rosterDirs 第一项" },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir } = resolve(exec, args.path);
            const scan = scanAt(rosterDir);
            const roster = scan.rosters.find((item) => item.id === String(args.id ?? ""));
            if (roster === undefined) {
              return {
                ok: false,
                code: "roster-not-found",
                known: scan.rosters.map((item) => item.id),
                text: statusLine("roster_team", { ok: false, id: args.id, known: scan.rosters.length }),
              };
            }
            const workspaces = listHostWorkspaces(ctx.get?.("workspaceRegistry"));
            const wanted = typeof args.workspace === "string" ? args.workspace.trim() : "";
            const byName = (item) =>
              wanted !== "" &&
              (item.workspaceId === wanted ||
                item.title === wanted ||
                item.path === wanted ||
                nodePath.basename(item.path) === wanted);
            const workspace =
              workspaces.find(byName) ??
              workspaces.find((item) => rosterDir.startsWith(item.path)) ??
              workspaces[0];
            const mode = args.mode === "existing" ? "existing" : "new";
            const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
            if (mode === "existing" && sessionId === "") {
              return {
                ok: false,
                code: "missing-session",
                text: statusLine("roster_team", { ok: false, id: roster.id, mode, reason: 'mode="existing" 需要 sessionId' }),
              };
            }
            const target = typeof args.target === "string" ? args.target : "";
            if (target !== "" && !TEAM_TARGET_IDS.includes(target)) {
              return {
                ok: false,
                code: "unknown-target",
                known: TEAM_TARGET_IDS,
                text: statusLine("roster_team", { ok: false, id: roster.id, reason: `未知团队引擎：${target}` }),
              };
            }
            const teamName = typeof args.teamName === "string" ? args.teamName.trim().slice(0, 120) : "";
            const sessionName = typeof args.sessionName === "string" && args.sessionName.trim() !== ""
              ? args.sessionName.trim().slice(0, 120)
              : teamName !== ""
                ? teamName
                : `${roster.id}`;
            const result = await applyCaptain({
              sessionController: ctx.get?.("sessionController"),
              roster,
              rosterDir,
              mode,
              sessionId,
              workspaceId: mode === "new" ? workspace.workspaceId : "",
              workspaceRegistry: ctx.get?.("workspaceRegistry"),
              // 退回项没有 workspaceId（没有注册表时），那就把目录直接给宿主；
              // 否则 create({}) 会悄悄落到宿主自己的当前目录，与"选的空间"不是一回事。
              cwd: mode === "new" && workspace.workspaceId === "" ? workspace.path : "",
              sessionTitle: sessionName,
              teamName,
              target,
            });
            const lines = [
              statusLine("roster_team", {
                ok: result.ok === true,
                roster: roster.id,
                mode,
                session: result.sessionId ?? "-",
                queued: result.queued === true,
              }),
            ];
            if (result.ok) {
              lines.push(`已按 ${roster.id} 在「${workspace.title || nodePath.basename(workspace.path)}」${mode === "new" ? `新建会话「${sessionName}」` : `复用会话 ${sessionId}`} 并排入建团提示。`);
              if (result.sessionTitle) lines.push(`会话名：${result.sessionTitle}`);
              if (result.model) lines.push(`队长模型：${result.model.provider}/${result.model.model}`);
            } else {
              lines.push(`失败：${result.code}${result.reason ? ` — ${result.reason}` : ""}`);
            }
            return {
              ok: result.ok === true,
              code: result.code ?? null,
              roster: roster.id,
              teamName: teamName || roster.id,
              mode,
              sessionId: result.sessionId ?? null,
              sessionTitle: result.sessionTitle ?? null,
              workspace: { workspaceId: workspace.workspaceId, title: workspace.title, path: workspace.path },
              model: result.model ?? null,
              queued: result.queued === true,
              text: lines.join("\n"),
            };
          },
          presentCall: (args) => ({ card: "generic", title: `从档案 ${args.id} 建团队` }),
          presentResult: (_args, result) => ({ card: "generic", title: result.isError ? "建团失败" : "建团" }),
        }),
      ),
    "dsh-agent-roster: roster_team",
  );
}
