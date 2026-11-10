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
import { listHostModels, modelIsAvailable } from "./host-models.js";
import { applyCapture, captureTeam } from "./capture.js";
import { parseProvenanceLine } from "./bridge.js";
import { buildHandoverPlan, handoverPath, renderHandover, writeHandover } from "./handover.js";
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
            "从一份档案创建团队：新建一个会话（可选落在哪个空间、叫什么名字）或复用已有会话，把队长模型按档案或显式入参选好，再排入「按这份档案建团队」的提示。" +
            "团队引擎用 target 选（agent-teams / experimental-agent-team）；模型用 model 覆盖（模型必须真被本部署服务）。" +
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
            "默认只读（apply=false）；apply=true 时只把**机械字段**写回档案（版本号 patch+1，写完重编译 dist），" +
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
                .map((field) => `${field.field} ${field.declared ?? "-"} → ${field.runtime ?? "-"}`);
              if (changed.length > 0) lines.push(`- ${member.name}：${changed.join("；")}`);
              if (member.persona.status === "differ") {
                lines.push(
                  `- ${member.name} 人设：档案 ${member.persona.declaredChars} 字符 / 运行时 ${member.persona.runtimeChars} 字符（只报告，不写回）`,
                );
              }
            }
            if (differing.length === 0) lines.push("没有差异：运行时与档案一致。");
            if (capture.undeclared.length > 0) lines.push(`运行时多出未声明的成员：${capture.undeclared.join(", ")}`);

            let written = null;
            if (args.apply === true) {
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
              if (applied.ok && applied.written.length > 0) {
                lines.push("下一步：用新版本重建团队（roster_iterate 或面板的「创建团队」），旧团队保持原样。");
              }
            } else if (capture.summary.differ > 0) {
              lines.push("只读模式：要写回机械字段请在参数里传 apply: true。");
            }

            return {
              ok: true,
              roster: capture.roster,
              team: capture.team,
              members: capture.members,
              undeclared: capture.undeclared,
              summary: capture.summary,
              written,
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
            "从一份档案迭代出新一代：先算运行时差异（capture=true 时把机械字段写回档案），再新建一个会话并排入建团提示。" +
            "交接清单用 handover.steps 传入（定时器取消/新建、唤醒路由、归档、通知等），会写成 .dsh-handover/<roster>-<时间>.json 并附在起始消息里，" +
            "由新队长逐条执行——这些动作不在档案层的能力边界内，这里只承载、不代跑。旧团队保持原样，不自动删除。会真的建会话/排提示。",
          parameters: {
            id: { type: "string", required: true, description: "档案 id" },
            path: { type: "string", description: "档案库目录；省略则用配置的 rosterDirs 第一项" },
            teamName: { type: "string", description: "新团队名；缺省用 <旧团队名>-next" },
            sessionName: { type: "string", description: "新会话名；缺省同团队名" },
            workspace: { type: "string", description: "新会话落在哪个空间：工作区 id / 标题 / 路径都认" },
            target: { type: "string", description: '团队引擎："agent-teams" 或 "experimental-agent-team"' },
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
            capture: { type: "boolean", description: "true 时先把机械字段写回档案再建会话" },
            handover: {
              type: "object",
              additionalProperties: false,
              properties: {
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
            const state = readTeamStates({ stateDir });
            const picked = pickTeam(state.teams, roster.id, args.team);
            const current = picked.team;

            let capture = null;
            let applied = null;
            if (current !== null) {
              capture = captureTeam({
                rosterDir: dir,
                rootDir: rosterDir,
                id: roster.id,
                team: current,
                knownToolPolicies: config.knownToolPolicies ?? null,
              });
              if (args.capture === true && capture.ok) {
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
            let instructions = "";
            const steps = args.handover && Array.isArray(args.handover.steps) ? args.handover.steps : [];
            if (steps.length > 0) {
              const built = buildHandoverPlan({
                roster: {
                  id: roster.id,
                  version: capture?.roster?.version ?? roster.version ?? "",
                  sha256: capture?.roster?.sha256 ?? null,
                },
                from: { teamId: current?.id ?? null, captainSessionId: current?.captainSessionId ?? "" },
                to: {},
                steps,
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

            const result = await applyCaptain({
              sessionController: ctx.get?.("sessionController"),
              roster,
              rosterDir: dir,
              libraryRoot: rosterDir,
              mode: "new",
              sessionTitle: sessionName,
              teamName,
              workspaceId: place?.workspaceId ?? "",
              cwd: place?.path ?? workspace,
              workspaceRegistry: ctx.get?.("workspaceRegistry"),
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
              `旧团队：${current?.id ?? "（没有找到由这份档案建出的团队）"}`,
              `新会话：${result.sessionId}${result.sessionTitle ? `（${result.sessionTitle}）` : ""}`,
            ];
            if (applied !== null) {
              lines.push(
                applied.ok
                  ? `档案写回：${applied.written.length} 个字段，版本 ${applied.version}`
                  : `档案写回失败：${applied.code}（仍按现有档案建会话）`,
              );
            }
            if (plan !== null) {
              lines.push(`交接清单：${handoverFile}（${plan.steps.length} 条，已附在起始消息末尾）`);
            }
            lines.push("旧团队不会自动删除；确认新团队建好后，用 delete/存档按你的规矩收尾。");

            return {
              ok: true,
              sessionId: result.sessionId,
              sessionTitle: result.sessionTitle ?? null,
              teamName,
              from: current?.id ?? null,
              target: result.target ?? (target === "" ? "agent-teams" : target),
              captured: capture === null ? null : capture.summary,
              written: applied,
              handover: plan === null ? null : { file: handoverFile, steps: plan.steps.length },
              text: lines.join("\n"),
            };
          },
          presentCall: (args) => ({ card: "generic", title: `从档案 ${args.id} 迭代新一代` }),
        }),
      ),
    "dsh-agent-roster: roster_iterate",
  );
}
