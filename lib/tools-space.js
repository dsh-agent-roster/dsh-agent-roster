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
import { addFavorites } from "./favorites.js";
import { listHostModels, modelIsAvailable } from "./host-models.js";
import { applyCapture, captureTeam, pendingWrites } from "./capture.js";
import { readPreferences, rememberCaptureAutoApply, rememberLibraryDir, rememberPreference } from "./preferences.js";
import { parseProvenanceLine } from "./bridge.js";
import { buildHandoverPlan, handoverPath, renderArchiveHandover, renderHandover, renderIterationNotes, writeHandover } from "./handover.js";
import { collectMemberPackets, mergeMemberSummaries } from "./member-context.js";
import { readTeamStates, resolveStateDir } from "./teams-state.js";
import { compileRosterAt } from "./compile2.js";
import { checkOrigin, readOrigin } from "./origin.js";

import { fetchCollection } from "./remote.js";
import { searchRosters } from "./search.js";
import { loadRemotePanel } from "./service.js";
import { statusLine } from "./tool-output.js";
import { TEAM_TARGET_IDS } from "./team-targets.js";

const OUTPUT = { type: "object", additionalProperties: true };

/** 两种布局（v1 `<root>/<id>`、v2 `<root>/rosters/<id>`）里找到真实档案目录。 */
function rosterDirOf(rootDir, id) {
  const v1 = nodePath.join(rootDir, id);
  const v2 = nodePath.join(rootDir, "rosters", id);
  if (fs.existsSync(nodePath.join(v2, "roster.yaml")) || fs.existsSync(nodePath.join(v2, "roster.json"))) return v2;
  return v1;
}

/** 按溯源行挑团队：显式 team 优先；否则要求唯一匹配。 */
function pickTeam(teams, rosterId, explicit) {
  if (typeof explicit === "string" && explicit !== "") {
    const found = teams.find((team) => team.id === explicit || team.dirName === explicit);
    return found === undefined ? { team: null, code: "team-not-found" } : { team: found, code: null };
  }
  const matched = teams.filter((team) => parseProvenanceLine(team.description)?.id === rosterId);
  if (matched.length === 1) return { team: matched[0], code: null };
  if (matched.length === 0) return { team: null, code: "no-team-record" };
  return { team: null, code: "ambiguous-team", known: matched.map((team) => team.id) };
}

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {object} config
 * @param {{ version: string }} meta
 * @param {{ resolve: Function, scanAt: Function, remember?: Function, favorite?: Function }} helpers
 */
// 宿主把 AgentRegistry 注册成 "agents"；旧宿主退回 agentRegistry。
const agentRegistryOf = (ctx) => ctx.get?.("agents") ?? ctx.get?.("agentRegistry");

export function registerExtraRosterTools(ctx, config, meta, helpers) {
  // remember 可注入：测试不该把临时目录写进真实用户的全局偏好。
  const { resolve, scanAt, remember = rememberLibraryDir, favorite = addFavorites } = helpers;

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_space",
          description:
            "看一座本地档案空间（space.yaml）的现状：布局、登记了哪些档案、实际在库几份、缺哪份、角色几个、来源与拉取版本。" +
            "没有 space.yaml 的 v1 档案库也能看，会如实说明「这不是空间，是平铺库」。本工具只读。",
          parameters: {
            path: { type: "string", description: "空间目录；省略则用配置的 rosterDirs 第一项" },
            refresh: { type: "boolean", description: "有来源账本时是否连远端比一次（默认 true；false 只比本地）" },
          },
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
            let changes = null;
            if (ledger !== null && ledger.broken !== true) {
              const refresh = args.refresh !== false;
              const result = await checkOrigin(rosterDir, {
                fetchImpl: typeof globalThis.fetch === "function" ? globalThis.fetch : null,
                refresh,
              });
              changes = {
                ok: result.ok,
                code: result.code ?? null,
                pending: result.pending ?? 0,
                fastForward: result.fastForward ?? 0,
                unverified: result.unverified ?? 0,
                summary: result.summary ?? {},
                entries: (result.entries ?? []).map((entry) => ({
                  path: entry.path,
                  state: entry.state,
                  local: entry.local,
                  remote: entry.remote,
                })),
              };
              lines.push(`账本 ${ledger.commit === null ? "无 commit" : `commit ${ledger.commit.slice(0, 8)}`} · 拉取于 ${ledger.pulledAt ?? "-"} · ${Object.keys(ledger.files).length} 个文件有基线`);
              lines.push(
                `更新：待快进 ${changes.fastForward} · 冲突 ${changes.summary.diverged ?? 0} · 只本地 ${changes.summary["local-only"] ?? 0} · 未变 ${changes.summary.clean ?? 0}` +
                  (refresh ? "" : "（只比本地；refresh: true 才连远端）"),
              );
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
              changes,
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
            model: {
              type: "object",
              description:
                '覆盖队长的路由（档案写的 provider/model 常常是作者那台部署的）。形状 {provider, model, reasoningEffort?}；' +
                "给出的模型必须真被这个部署服务，否则报 model-unavailable 并列出可选值；省略则按档案、由宿主决定。",
              additionalProperties: false,
              properties: {
                provider: { type: "string", description: "provider id" },
                model: { type: "string", description: "model id" },
                reasoningEffort: { type: "string", description: "可选，覆盖档案里的 effort" },
              },
            },
            path: { type: "string", description: "档案库目录；省略则用配置的 rosterDirs 第一项" },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir } = resolve(exec, args.path);
            const scan = scanAt(rosterDir);
            const id = String(args.ref ?? "");
            const v2 =
              fs.existsSync(nodePath.join(rosterDir, "rosters")) &&
              (fs.existsSync(nodePath.join(rosterDir, "shared-roles")) || fs.existsSync(nodePath.join(rosterDir, "roles")));
            if (!v2) {
              return {
                ok: false,
                code: "not-a-space",
                text: statusLine("roster_compile", { ok: false, reason: "这不是 v2 库（没有 roles/ 与 rosters/ 两个目录）" }),
              };
            }
            const dir = nodePath.join(rosterDir, "rosters", id);
            const compiled = compileRosterAt(dir, {
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
              lines.push(`空间 ${scan.space?.id ?? "（平铺库，无 space.yaml）"} · 不写 dist（要落盘用 CLI compile --write）`);
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
            "[deprecated] 改用 `roster_space`：它的 `changes` 段就是这里的六态结果（2.0 会移除本工具）。" +
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
            "从一份档案创建团队：新建一个会话（可选落在哪个空间、叫什么名字）或复用已有会话，把队长模型按档案或显式入参选好，再排入「按这份档案建团队」的提示。" +
            "团队引擎目前只支持 agent-teams（target 只接受这个值）；模型用 model 覆盖（模型必须真被本部署服务）。" +
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
              description: '团队引擎：目前只支持 "agent-teams"（默认）；其他值报 unknown-target',
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
            const requestedModel = args.model !== null && typeof args.model === "object" ? args.model : null;
            const modelRoute =
              requestedModel !== null && typeof requestedModel.provider === "string" && typeof requestedModel.model === "string"
                ? {
                    provider: requestedModel.provider.trim(),
                    model: requestedModel.model.trim(),
                    ...(typeof requestedModel.reasoningEffort === "string" && requestedModel.reasoningEffort.trim() !== ""
                      ? { reasoningEffort: requestedModel.reasoningEffort.trim() }
                      : {}),
                  }
                : null;
            if (modelRoute !== null && (modelRoute.provider === "" || modelRoute.model === "")) {
              return {
                ok: false,
                code: "invalid-model",
                text: statusLine("roster_team", { ok: false, id: roster.id, reason: "model 需要 provider 与 model 两个非空字符串" }),
              };
            }
            if (modelRoute !== null) {
              const catalog = await listHostModels(ctx.get?.("llm"));
              // 读不到目录（没有 llm 服务）时不做判断：如实说"无法核对"，不要把"不知道"当成"可用"。
              if (catalog.length > 0 && !modelIsAvailable(catalog, modelRoute)) {
                return {
                  ok: false,
                  code: "model-unavailable",
                  known: catalog.map((entry) => ({ provider: entry.provider, models: entry.models.map((item) => item.id) })),
                  text: statusLine("roster_team", {
                    ok: false,
                    id: roster.id,
                    reason: `本部署不服务 ${modelRoute.provider}/${modelRoute.model}`,
                  }),
                };
              }
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
              // rosterDir 是库根：显式交给注入层，别让它从目录形状反推。
              libraryRoot: rosterDir,
              mode,
              sessionId,
              workspaceId: mode === "new" ? workspace.workspaceId : "",
              workspaceRegistry: ctx.get?.("workspaceRegistry"),
            agentRegistry: agentRegistryOf(ctx),
              // 退回项没有 workspaceId（没有注册表时），那就把目录直接给宿主；
              // 否则 create({}) 会悄悄落到宿主自己的当前目录，与"选的空间"不是一回事。
              cwd: mode === "new" && workspace.workspaceId === "" ? workspace.path : "",
              sessionTitle: sessionName,
              teamName,
              target,
              ...(modelRoute === null ? {} : { model: modelRoute }),
            });
            const lines = [
              statusLine("roster_team", {
                ok: result.ok === true,
                roster: roster.id,
                mode,
                target: result.target ?? (target === "" ? "agent-teams" : target),
                session: result.sessionId ?? "-",
                queued: result.queued === true,
              }),
            ];
            if (result.ok) {
              // 用过的库根自动登记：它可能不在 rosterDirs 里，不记下来面板就永远看不到这份档案。
              remember(rosterDir);
              // 从档案建团即收藏：档案页默认只看收藏，工具用过的档案理应出现在那里。
              favorite(rosterDir, [roster.id]);
              lines.push(`已按 ${roster.id} 在「${workspace.title || nodePath.basename(workspace.path)}」${mode === "new" ? `新建会话「${sessionName}」` : `复用会话 ${sessionId}`} 并排入建团提示。`);
              if (result.sessionTitle) lines.push(`会话名：${result.sessionTitle}`);
              lines.push(`团队引擎：${result.target ?? (target === "" ? "agent-teams" : target)}`);
              if (result.model) lines.push(`队长模型：${result.model.provider}/${result.model.model}`);
              // 注入层读的是"建会话时用的这座库"；把根写出来，配置不一致在成功那一刻就可见。
              if (result.rosterRoot) lines.push(`人设注入根：${result.rosterRoot}`);
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
              target: result.target ?? (target === "" ? "agent-teams" : target),
              model: result.model ?? null,
              rosterRoot: result.rosterRoot ?? null,
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

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_capture",
          description:
            "算出运行时团队与档案的差异：逐个成员比 role/provider/model/reasoningEffort/toolPolicy，再比人设哈希。" +
            "role 比的是**展开后的角色名**（档案里是 name@version 引用），不一致时把引用一并写出，避免把引用与显示名当成差异。" +
            "默认只读（apply=false）并**主动问一句**：把可写回的字段列出来，等你确认后再调用一次带 apply=true；" +
            "apply=true（或设置里打开 captureAutoApply）时只把**机械字段**写回档案（版本号 patch+1，写完重编译 dist），" +
            "人设差异只报告、不写回——运行时存的是拼装后的整段正文，写回角色文件会把 parts/includes 的结构压平。" +
            "团队按 team.json 的 description 里 roster:<id>@ 溯源匹配；没有团队记录时如实报，不假装比对过。",
          parameters: {
            id: { type: "string", required: true, description: "档案 id" },
            path: { type: "string", description: "档案库目录；省略则用配置的 rosterDirs 第一项" },
            team: { type: "string", description: "只比对这支团队（team.json 的目录名）；省略则按溯源行自动匹配" },
            stateDir: { type: "string", description: "AgentTeams 状态目录；省略则用配置的 agentTeamsStateDir" },
            fields: {
              type: "array",
              items: { type: "string" },
              description: "apply 时写回哪些字段：provider / model / reasoningEffort / toolPolicy（默认全部）",
            },
            apply: { type: "boolean", description: "true 才写回档案（默认只读）" },
            remember: { type: "boolean", description: "写回的同时记住「以后都自动写回」：优先改部署配置 captureAutoApply，写不进配置时写进这个库的 .dsh-roster-preferences.json" },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir, workspace } = resolve(exec, args.path);
            const scan = scanAt(rosterDir);
            const roster = scan.rosters.find((item) => item.id === String(args.id ?? ""));
            if (roster === undefined) {
              return {
                ok: false,
                code: "roster-not-found",
                known: scan.rosters.map((item) => item.id),
                text: statusLine("roster_capture", { ok: false, id: args.id, known: scan.rosters.length }),
              };
            }
            const stateDir = resolveStateDir(args.stateDir ?? config.agentTeamsStateDir ?? ".agent-teams", workspace);
            const prefs = readPreferences(rosterDir);
            const autoByDefault = config.captureAutoApply === true || prefs.captureAutoApply === true;
            const state = readTeamStates({ stateDir });
            const picked = pickTeam(state.teams, roster.id, args.team);
            if (picked.team === null) {
              return {
                ok: false,
                code: picked.code,
                known: picked.known ?? state.teams.map((team) => team.id),
                text: statusLine("roster_capture", { ok: false, id: roster.id, reason: picked.code }),
              };
            }
            const dir = rosterDirOf(rosterDir, roster.id);
            const capture = captureTeam({
              rosterDir: dir,
              rootDir: rosterDir,
              id: roster.id,
              team: picked.team,
              knownToolPolicies: config.knownToolPolicies ?? null,
            });
            if (!capture.ok) {
              return {
                ok: false,
                code: capture.code ?? "capture-failed",
                diagnostics: capture.diagnostics ?? [],
                text: statusLine("roster_capture", { ok: false, id: roster.id, reason: capture.code ?? "capture-failed" }),
              };
            }

            const lines = [
              statusLine("roster_capture", {
                ok: true,
                roster: `${capture.roster.id}@${capture.roster.version}`,
                team: capture.team.id,
                match: capture.summary.match,
                differ: capture.summary.differ,
              }),
              `档案 ${capture.roster.id}@${capture.roster.version}  ↔  团队 ${capture.team.id ?? "-"}（${capture.team.phase ?? "?"}）`,
            ];
            const differing = capture.members.filter(
              (member) => member.fields.some((field) => field.status === "differ") || member.persona.status === "differ",
            );
            for (const member of differing) {
              const changed = member.fields
                .filter((field) => field.status === "differ")
                .map((field) =>
                  field.ref
                    ? `${field.field} ${field.ref}（展开 ${field.declared ?? "-"}）→ ${field.runtime ?? "-"}`
                    : `${field.field} ${field.declared ?? "-"} → ${field.runtime ?? "-"}`,
                );
              if (changed.length > 0) lines.push(`- ${member.name}：${changed.join("；")}`);
              if (member.persona.status === "differ") {
                lines.push(
                  `- ${member.name} 人设：档案 ${member.persona.declaredChars} 字符 / 运行时 ${member.persona.runtimeChars} 字符（只报告，不写回）`,
                );
              }
            }
            if (differing.length === 0) lines.push("没有差异：运行时与档案一致。");
            if (capture.undeclared.length > 0) lines.push(`运行时多出未声明的成员：${capture.undeclared.join(", ")}`);

            const pending = pendingWrites(capture, Array.isArray(args.fields) ? args.fields : null);
            const autoApply = args.apply !== true && autoByDefault && pending.length > 0;
            let written = null;
            let remembered = null;
            if (args.apply === true || autoApply) {
              const applied = applyCapture({
                rosterDir: dir,
                rootDir: rosterDir,
                id: roster.id,
                members: capture.members,
                fields: Array.isArray(args.fields) ? args.fields : undefined,
                knownToolPolicies: config.knownToolPolicies ?? null,
              });
              written = applied;
              lines.push(
                applied.ok
                  ? applied.written.length === 0
                    ? "写回：没有可写的字段（人设差异不算）。"
                    : `写回：${applied.written.map((item) => `${item.name}.${item.field}=${item.value}`).join(", ")}；版本 ${applied.version}${applied.dist === null ? "" : "，dist 已重编译"}`
                  : `写回失败：${applied.code}`,
              );
              if (autoApply && applied.ok && applied.written.length > 0) {
                lines.push("（captureAutoApply 已开启：直接写回，不再询问。）");
              }
              if (args.remember === true && applied.ok && applied.written.length > 0) {
                remembered = await rememberCaptureAutoApply(ctx, rosterDir);
                lines.push(
                  remembered === "config"
                    ? "已记住：以后都自动写回（写入部署配置 captureAutoApply）。"
                    : remembered === "library"
                      ? "已记住：以后都自动写回（写进这个库的 .dsh-roster-preferences.json）。"
                      : "没能记住「以后都自动」：配置与库偏好都写不进去。",
                );
              }
              if (applied.ok && applied.written.length > 0) {
                lines.push("下一步：用新版本重建团队（roster_iterate 或面板的「创建团队」），旧团队保持原样。");
              }
            } else if (pending.length > 0) {
              lines.push(
                `可写回 ${pending.length} 个字段：${pending.map((item) => `${item.name}.${item.field}=${item.runtime}`).join(", ")}。`,
              );
              lines.push("下一步三选一：");
              lines.push("  · 本次写回：apply: true");
              lines.push("  · 以后都自动写回：apply: true + remember: true（把配置 captureAutoApply 设为 true；写不进配置就记在这个库的偏好里）");
              lines.push("  · 不改：apply: false 或直接不写回。人设差异永远不会写回。");
            } else if (capture.summary.differ > 0) {
              lines.push("差异只在人设或不可写字段上：这些不写回，只报告。");
            }

            return {
              ok: true,
              roster: capture.roster,
              team: capture.team,
              members: capture.members,
              undeclared: capture.undeclared,
              summary: capture.summary,
              pending,
              needsConfirmation: written === null && pending.length > 0,
              written,
              remembered,
              diagnostics: capture.diagnostics,
              text: lines.join("\n"),
            };
          },
          presentCall: (args) => ({ card: "generic", title: `比对档案 ${args.id} 与运行时` }),
        }),
      ),
    "dsh-agent-roster: roster_capture",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_iterate",
          description:
            "从一份档案迭代出新一代：先算运行时差异（capture=true 时把机械字段写回档案），再按落点排入建团提示——" +
            "mode:\"new\" 新开会话（旧团队原样保留），mode:\"session\" 在当前/指定会话里换代（会话已有团队时先问是否归档，archiveOld:true 或配置 iterateArchive=replace 才动手）；" +
            "未传 mode 时按配置 iterateMode，默认先问。" +
            "handover.summary 承载队长上下文（新会话没有对话记录，这是唯一载体）、handover.members 承载每个成员的上一代总结（插件自动补旧会话 id 与任务回执），handover.steps 承载动作（定时器/唤醒路由/归档/通知等），写成 .dsh-handover/<roster>-<时间>.json 并附在起始消息里，" +
            "由新队长逐条执行——这些动作不在档案层的能力边界内，这里只承载、不代跑。旧团队保持原样，不自动删除。会真的建会话/排提示。",
          parameters: {
            id: { type: "string", required: true, description: "档案 id" },
            path: { type: "string", description: "档案库目录；省略则用配置的 rosterDirs 第一项" },
            teamName: { type: "string", description: "新团队名；缺省用 <旧团队名>-next" },
            sessionName: { type: "string", description: "新会话名；缺省同团队名" },
            workspace: { type: "string", description: "新会话落在哪个空间：工作区 id / 标题 / 路径都认" },
            target: { type: "string", description: '团队引擎：目前只接受 "agent-teams"（其他值报 unknown-target）' },
            model: {
              type: "object",
              additionalProperties: false,
              properties: {
                provider: { type: "string" },
                model: { type: "string" },
                reasoningEffort: { type: "string" },
              },
              description: "覆盖队长模型；必须是本部署真实服务的模型",
            },
            capture: { type: "boolean", description: "true=先写回机械字段再建会话；false=不改档案直接建。省略时：有可写回差异会先返回差异并询问（captureAutoApply=true 时自动写回）" },
            remember: { type: "boolean", description: "capture=true 时同时记住「以后都自动写回」：优先改部署配置 captureAutoApply，写不进配置时写进这个库的 .dsh-roster-preferences.json" },
            mode: { type: "string", description: '落点："new" 新开会话；"session" 在当前（或 sessionId 指定）会话里换代。省略时按配置 iterateMode（ask/new/session），默认询问' },
            sessionId: { type: "string", description: 'mode:"session" 时的目标会话；省略表示调用这个工具的会话' },
            archiveOld: { type: "boolean", description: '在当前会话换代、而该会话已领导一支团队时：true=先归档旧队（agent_teams_delete）再重建；false=强制询问。省略时按配置 iterateArchive（ask/replace）' },
            handover: {
              type: "object",
              additionalProperties: false,
              properties: {
                summary: {
                  type: "string",
                  description:
                    "交接摘要（≤2000 字符）：新会话没有旧会话的对话记录，这段是唯一的上下文载体。" +
                    "由当前会话（它有上下文）写下：做到哪了、结论与理由、未完成项、踩过的坑；具体动作仍写 steps",
                },
                members: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      name: { type: "string" },
                      summary: { type: "string" },
                    },
                  },
                  description:
                    "成员上下文（≤32 条，每条 ≤800 字符）：由旧会话为每名成员写「他做到哪、结论、坑」。插件自动补旧会话 id 与任务回执；新队长要把每名成员的包放进他第一个任务的 description——成员之间不共享对话记录",
                },
                steps: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      kind: { type: "string" },
                      detail: { type: "string" },
                      verify: { type: "string" },
                    },
                  },
                  description: "交接步骤：kind 取 capture/session.create/timer.cancel/timer.create/wake.update/archive/notify/verify/note",
                },
              },
              description: "交接清单；省略则不生成清单文件",
            },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir, workspace } = resolve(exec, args.path);
            const scan = scanAt(rosterDir);
            const roster = scan.rosters.find((item) => item.id === String(args.id ?? ""));
            if (roster === undefined) {
              return {
                ok: false,
                code: "roster-not-found",
                known: scan.rosters.map((item) => item.id),
                text: statusLine("roster_iterate", { ok: false, id: args.id, known: scan.rosters.length }),
              };
            }
            const dir = rosterDirOf(rosterDir, roster.id);
            const stateDir = resolveStateDir(args.stateDir ?? config.agentTeamsStateDir ?? ".agent-teams", workspace);
            const prefs = readPreferences(rosterDir);
            const autoByDefault = config.captureAutoApply === true || prefs.captureAutoApply === true;
            const state = readTeamStates({ stateDir });
            const picked = pickTeam(state.teams, roster.id, args.team);
            let current = picked.team;

            // 落点：新开会话，还是在当前（或指定）会话里换代。未指定时按配置，默认先问。
            const requestedMode = args.mode === "new" || args.mode === "session" ? args.mode : "";
            const configuredMode = config.iterateMode ?? prefs.iterateMode ?? "ask";
            const resolvedMode =
              requestedMode !== "" ? requestedMode : configuredMode === "new" || configuredMode === "session" ? configuredMode : "";
            if (resolvedMode === "") {
              const ask = [
                statusLine("roster_iterate", { ok: true, roster: `${roster.id}@${roster.version ?? ""}`, from: current?.id ?? "-", to: "-" }),
                `要从 ${roster.id} 迭代出新一代，先选落点：`,
                '  · 新开会话（旧团队原样保留）：mode: "new"',
                '  · 在当前会话里换代：mode: "session" + sessionId（省略 sessionId = 调用这个工具的会话）',
                "选定后可以加 remember: true，把 iterateMode 写进配置，以后不再问。",
                "（本次没有建会话，也没有改档案。）",
              ];
              return {
                ok: true,
                needsConfirmation: true,
                id: roster.id,
                options: ["new", "session"],
                text: ask.join("\n"),
              };
            }
            const sessionMode = resolvedMode === "session";
            const sessionId =
              sessionMode ? String(args.sessionId ?? "").trim() || String(exec?.agent?.id ?? "") : "";
            if (sessionMode && sessionId === "") {
              return {
                ok: false,
                code: "session-required",
                text: statusLine("roster_iterate", { ok: false, id: roster.id, reason: "session 模式需要一个会话 id（参数或调用会话）" }),
              };
            }
            const boundTeams =
              sessionMode && sessionId !== ""
                ? state.teams.filter((item) => item.captainSessionId === sessionId)
                : [];
            if (boundTeams.length > 1) {
              return {
                ok: false,
                code: "session-leads-multiple-teams",
                teams: boundTeams.map((item) => item.id),
                text: statusLine("roster_iterate", {
                  ok: false,
                  id: roster.id,
                  reason: `会话 ${sessionId} 同时领导 ${boundTeams.length} 支队（${boundTeams.map((item) => item.id).join(", ")}），先归档到只剩一支`,
                }),
              };
            }
            const boundTeam = boundTeams[0] ?? null;
            if (boundTeam !== null) {
              const bound = parseProvenanceLine(boundTeam.description);
              if (bound !== null && bound.id !== roster.id) {
                return {
                  ok: false,
                  code: "session-leads-other-team",
                  team: boundTeam.id,
                  roster: bound.id,
                  text: statusLine("roster_iterate", {
                    ok: false,
                    id: roster.id,
                    reason: `会话 ${sessionId} 已领导团队 ${boundTeam.id}（roster:${bound.id}），不能在这里换这份档案`,
                  }),
                };
              }
              if (bound === null && args.archiveOld !== true) {
                return {
                  ok: false,
                  code: "session-team-unverified",
                  team: boundTeam.id,
                  text: statusLine("roster_iterate", {
                    ok: false,
                    id: roster.id,
                    reason: `会话 ${sessionId} 领导的团队 ${boundTeam.id} 没有 roster 溯源，无法确认它来自这份档案；确认要替换就显式传 archiveOld: true`,
                  }),
                };
              }
            }
            // 会话绑定优先：会话里那一支队就是唯一那支。没有绑定时才轮到按溯源挑——
            // 多支队都声称来自这份档案时不能猜：猜错就会对着错的一支做比对、命名与归档。
            if (boundTeam === null && picked.code === "ambiguous-team") {
              return {
                ok: false,
                code: "ambiguous-team",
                teams: picked.known,
                text: statusLine("roster_iterate", {
                  ok: false,
                  id: roster.id,
                  reason: `${picked.known.length} 支队都声称来自这份档案（${picked.known.join(", ")}），先指定 team: "<id>" 再说换代哪一支`,
                }),
              };
            }
            if (boundTeam === null && picked.code === "team-not-found") {
              return {
                ok: false,
                code: "team-not-found",
                known: picked.known ?? state.teams.map((team) => team.id),
                text: statusLine("roster_iterate", { ok: false, id: roster.id, reason: `没有团队叫 ${args.team}` }),
              };
            }
            if (boundTeam === null) current = picked.team;

            let archiveOld = false;
            if (boundTeam !== null) {
              const archivePolicy =
                args.archiveOld === true
                  ? "replace"
                  : args.archiveOld === false
                    ? "ask"
                    : config.iterateArchive ?? prefs.iterateArchive ?? "ask";
              if (archivePolicy !== "replace") {
                const ask = [
                  statusLine("roster_iterate", {
                    ok: true,
                    roster: `${roster.id}@${roster.version ?? ""}`,
                    from: boundTeam.id,
                    to: "-",
                  }),
                  `会话 ${sessionId} 已经在领导团队 ${boundTeam.id}。会话模式的换代要先归档旧队：`,
                  "  · 归档 = 调用 agent_teams_delete：中断成员、把任务与邮箱移进 archive/（可复查），然后按这份档案重建",
                  `  · 确认替换：archiveOld: true（可加 remember: true，把 iterateArchive 设为 replace，以后不再问）`,
                  '  · 换成新开会话：mode: "new"（两条团队并存，旧队不动）',
                  "（本次没有归档、没有建会话。）",
                ];
                return {
                  ok: true,
                  needsConfirmation: true,
                  id: roster.id,
                  team: boundTeam.id,
                  sessionId,
                  options: ["archiveOld", "new"],
                  text: ask.join("\n"),
                };
              }
              archiveOld = true;
              current = boundTeam;
            }

            let capture = null;
            let applied = null;
            let pending = [];
            if (current !== null) {
              capture = captureTeam({
                rosterDir: dir,
                rootDir: rosterDir,
                id: roster.id,
                team: current,
                knownToolPolicies: config.knownToolPolicies ?? null,
              });
              pending = capture.ok ? pendingWrites(capture) : [];
              const mode =
                args.capture === true
                  ? "apply"
                  : args.capture === false
                    ? "skip"
                    : pending.length === 0
                      ? "skip"
                      : autoByDefault
                        ? "apply"
                        : "ask";
              if (mode === "ask") {
                const ask = [
                  statusLine("roster_iterate", {
                    ok: true,
                    roster: `${roster.id}@${capture.roster.version}`,
                    from: current.id,
                    to: "-",
                  }),
                  `档案 ${capture.roster.id}@${capture.roster.version} ↔ 团队 ${current.id}：有 ${pending.length} 个可写回字段`,
                ];
                for (const item of pending) ask.push(`- ${item.name}.${item.field}：${item.declared ?? "-"} → ${item.runtime}`);
                ask.push("下一步三选一：");
                ask.push("  · 先写回机械字段再换代：capture: true");
                ask.push("  · 以后都自动写回：capture: true + remember: true（把配置 captureAutoApply 设为 true；写不进配置就记在这个库的偏好里）");
                ask.push("  · 不改档案直接换代：capture: false");
                ask.push("（人设差异永远不会写回。）本次没有建会话。");
                return {
                  ok: true,
                  needsConfirmation: true,
                  id: roster.id,
                  from: current.id,
                  pending,
                  captured: capture.summary,
                  sessionId: null,
                  text: ask.join("\n"),
                };
              }
              if (mode === "apply" && capture.ok) {
                applied = applyCapture({
                  rosterDir: dir,
                  rootDir: rosterDir,
                  id: roster.id,
                  members: capture.members,
                  knownToolPolicies: config.knownToolPolicies ?? null,
                });
              }
            }

            const workspaces = listHostWorkspaces(ctx.get?.("workspaceRegistry"));
            const wanted = typeof args.workspace === "string" ? args.workspace.trim() : "";
            const byName = (item) =>
              wanted !== "" &&
              (item.workspaceId === wanted || item.title === wanted || item.path === wanted || nodePath.basename(item.path) === wanted);
            const place = workspaces.find(byName) ?? workspaces.find((item) => rosterDir.startsWith(item.path)) ?? workspaces[0];

            const target = typeof args.target === "string" ? args.target : "";
            if (target !== "" && !TEAM_TARGET_IDS.includes(target)) {
              return {
                ok: false,
                code: "unknown-target",
                known: TEAM_TARGET_IDS,
                text: statusLine("roster_iterate", { ok: false, id: roster.id, reason: `未知团队引擎：${target}` }),
              };
            }
            const requestedModel = args.model !== null && typeof args.model === "object" ? args.model : null;
            const modelRoute =
              requestedModel !== null && typeof requestedModel.provider === "string" && typeof requestedModel.model === "string"
                ? {
                    provider: requestedModel.provider.trim(),
                    model: requestedModel.model.trim(),
                    ...(typeof requestedModel.reasoningEffort === "string" && requestedModel.reasoningEffort.trim() !== ""
                      ? { reasoningEffort: requestedModel.reasoningEffort.trim() }
                      : {}),
                  }
                : null;
            if (modelRoute !== null) {
              const catalog = await listHostModels(ctx.get?.("llm"));
              if (catalog.length > 0 && !modelIsAvailable(catalog, modelRoute)) {
                return {
                  ok: false,
                  code: "model-unavailable",
                  known: catalog.map((entry) => ({ provider: entry.provider, models: entry.models.map((item) => item.id) })),
                  text: statusLine("roster_iterate", {
                    ok: false,
                    id: roster.id,
                    reason: `本部署不服务 ${modelRoute.provider}/${modelRoute.model}`,
                  }),
                };
              }
            }

            const baseName = (current?.name ?? roster.id).trim();
            const teamName = (typeof args.teamName === "string" && args.teamName.trim() !== "" ? args.teamName : `${baseName}-next`).trim();
            const sessionName = (typeof args.sessionName === "string" && args.sessionName.trim() !== "" ? args.sessionName : teamName).trim();

            let plan = null;
            let handoverFile = null;
            // 成员上下文包：客观事实（任务回执 + 旧会话 id）自动收集，总结由旧会话写在 handover.members 里。
            const collected = current === null ? { members: [], diagnostics: [] } : collectMemberPackets(current);
            const merged = mergeMemberSummaries(
              collected.members,
              args.handover && Array.isArray(args.handover.members) ? args.handover.members : [],
            );
            const memberDiagnostics = [...collected.diagnostics, ...merged.diagnostics];
            const memberError = memberDiagnostics.find((item) => item.severity === "error");
            if (memberError !== undefined) {
              return {
                ok: false,
                code: "handover-invalid",
                diagnostics: memberDiagnostics,
                text: statusLine("roster_iterate", { ok: false, id: roster.id, reason: `成员总结不合法：${memberError.reason}` }),
              };
            }
            let instructions = "";
            const steps = args.handover && Array.isArray(args.handover.steps) ? args.handover.steps : [];
            const summary = args.handover && typeof args.handover.summary === "string" ? args.handover.summary : "";
            if (steps.length > 0 || summary.trim() !== "" || merged.members.length > 0) {
              const built = buildHandoverPlan({
                roster: {
                  id: roster.id,
                  version: capture?.roster?.version ?? roster.version ?? "",
                  sha256: capture?.roster?.sha256 ?? null,
                },
                from: { teamId: current?.id ?? null, captainSessionId: current?.captainSessionId ?? "" },
                to: {},
                steps,
                summary,
                members: merged.members,
              });
              if (!built.ok) {
                return {
                  ok: false,
                  code: "handover-invalid",
                  diagnostics: built.diagnostics,
                  text: statusLine("roster_iterate", { ok: false, id: roster.id, reason: "交接清单不合法" }),
                };
              }
              plan = built.plan;
              handoverFile = handoverPath(rosterDir, roster.id, new Date(plan.createdAt));
              instructions = renderHandover(plan, handoverFile);
            }
            // 档案里的交接指南排在最前：它是这份档案对“怎么换代”的长期意见。
            const archiveGuide = renderArchiveHandover(Array.isArray(roster.handover) ? roster.handover : []);
            if (archiveGuide !== "") {
              instructions = instructions === "" ? archiveGuide : `${archiveGuide}\n\n${instructions}`;
            }
            // 既没有档案指南、也没有本次步骤时，给系统级兜底：迭代真正难的是“哪些东西带不过去”。
            if (instructions === "") instructions = renderIterationNotes();
            // 会话模式换代：先让会话自己归档旧队——只有队长有 agent_teams_delete 权限，插件不直接改状态目录。
            if (archiveOld && current !== null) {
              const head = [
                `第一步：先结束并归档当前团队 ${current.id}。调用 agent_teams_delete（它会中断成员、把任务与邮箱移进 archive/，原目录可复查），确认返回 deleted: true。`,
                "归档成功后，再执行下面的建队步骤；如果 delete 失败，停下来按原因回报，不要绕过它新建团队。",
              ].join("\n");
              instructions = `${head}\n\n${instructions}`;
            }

            const result = await applyCaptain({
              sessionController: ctx.get?.("sessionController"),
              roster,
              rosterDir: dir,
              libraryRoot: rosterDir,
              ...(sessionMode
                ? { mode: "existing", sessionId }
                : { mode: "new", sessionTitle: sessionName, workspaceId: place?.workspaceId ?? "", cwd: place?.path ?? workspace }),
              teamName,
              workspaceRegistry: ctx.get?.("workspaceRegistry"),
            agentRegistry: agentRegistryOf(ctx),
              target,
              model: modelRoute,
              instructions,
            });
            if (!result.ok) {
              return {
                ok: false,
                code: result.code ?? "iterate-failed",
                sessionId: result.sessionId ?? null,
                text: statusLine("roster_iterate", { ok: false, id: roster.id, reason: result.code ?? "iterate-failed" }),
              };
            }
            // 迭代用的库根同样登记：它可以不在 rosterDirs 里。
            remember(rosterDir);
            favorite(rosterDir, [roster.id]);
            if (plan !== null) {
              plan.to = {
                sessionId: result.sessionId,
                sessionTitle: result.sessionTitle ?? sessionName,
                teamName,
              };
              writeHandover(rosterDir, plan);
            }

            const lines = [
              statusLine("roster_iterate", {
                ok: true,
                roster: `${roster.id}@${capture?.roster?.version ?? roster.version ?? "-"}`,
                from: current?.id ?? "-",
                to: result.sessionId,
                steps: plan === null ? 0 : plan.steps.length,
              }),
              archiveOld && current !== null
                ? `已排队归档旧团队：${current.id} —— 新队长第一步会调 agent_teams_delete；在那之前旧团队仍在 .agent-teams/ 下`
                : `旧团队：${current?.id ?? "（没有找到由这份档案建出的团队）"}`,
              `新会话：${result.sessionId}${result.sessionTitle ? `（${result.sessionTitle}）` : ""}`,
            ];
            let remembered = null;
            if (applied !== null) {
              lines.push(
                applied.ok
                  ? `档案写回：${applied.written.length} 个字段，版本 ${applied.version}${args.capture === true ? "" : "（按 captureAutoApply 自动写回）"}`
                  : `档案写回失败：${applied.code}（仍按现有档案建会话）`,
              );
              if (args.remember === true && applied.ok && applied.written.length > 0) {
                remembered = await rememberCaptureAutoApply(ctx, rosterDir);
                lines.push(
                  remembered === "config"
                    ? "已记住：以后都自动写回（写入部署配置 captureAutoApply）。"
                    : remembered === "library"
                      ? "已记住：以后都自动写回（写进这个库的 .dsh-roster-preferences.json）。"
                      : "没能记住「以后都自动」：配置与库偏好都写不进去。",
                );
              }
            }
            if (plan !== null) {
              lines.push(
                `交接清单：${handoverFile}（${plan.steps.length} 条${plan.summary === "" ? "" : " + 摘要"}${plan.members.length === 0 ? "" : ` + ${plan.members.length} 名成员包`}，已附在起始消息末尾）`,
              );
            }
            if (args.remember === true) {
              const patch = {};
              if (requestedMode !== "") patch.iterateMode = requestedMode;
              if (archiveOld) patch.iterateArchive = "replace";
              if (Object.keys(patch).length > 0) {
                const where = await rememberPreference(ctx, rosterDir, patch);
                lines.push(
                  where === "config"
                    ? `已记住：${Object.keys(patch).join(", ")} 写入部署配置，以后不再问。`
                    : where === "library"
                      ? `已记住：${Object.keys(patch).join(", ")} 写进这个库的 .dsh-roster-preferences.json。`
                      : "没能记住这次的落点选择：配置与库偏好都写不进去。",
                );
              }
            }
            lines.push(
              sessionMode
                ? "上下文：换代发生在当前会话，对话记录保留；新团队仍从零开始建。"
                : "上下文：新会话没有旧会话的对话记录——handover.summary 是唯一的上下文载体，没写摘要就只能靠清单与档案。",
            );
            lines.push(
              archiveOld
                ? "归档尚未发生：它由新队长执行；完成前旧队不会消失，别按「已归档」去核对磁盘。"
                : "旧团队不会自动删除；确认新团队建好后，用 delete/存档按你的规矩收尾。",
            );

            return {
              ok: true,
              sessionId: result.sessionId,
              sessionTitle: result.sessionTitle ?? null,
              teamName,
              from: current?.id ?? null,
              target: result.target ?? (target === "" ? "agent-teams" : target),
              captured: capture === null ? null : capture.summary,
              written: applied,
              remembered,
              archiveQueued: archiveOld && current !== null,
              archivedNow: false,
              handover: plan === null ? null : { file: handoverFile, steps: plan.steps.length, summaryChars: plan.summary.length, members: plan.members.length },
              text: lines.join("\n"),
            };
          },
          presentCall: (args) => ({ card: "generic", title: `从档案 ${args.id} 迭代新一代` }),
        }),
      ),
    "dsh-agent-roster: roster_iterate",
  );
}
