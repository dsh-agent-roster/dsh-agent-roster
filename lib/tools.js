/**
 * 六个模型可见工具：列档案、看成员、生成桥接调用、核对运行时、比对两代档案、读公共档案源。
 * （roster_list / roster_show / roster_create / roster_verify / roster_diff / roster_index）
 *
 * 只读优先：`roster_list` / `roster_show` / `roster_verify` / `roster_diff` 只读文件系统；
 * `roster_create` 也不写任何东西——它输出的是**参数**，真正的成员创建仍由队长调用
 * dsh-agent-teams 的工具完成。插件不替运行时做决定，也不在背后改别人的状态。
 *
 * @module dsh-agent-roster/tools
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

import nodePath from "node:path";

import { buildMemberBinding, describeField, provenanceLine, summarizeBinding } from "./bridge.js";
import { diffRosters } from "./diff.js";
import { LIMITS } from "./format.js";
import { resolveDirSpec } from "./home.js";
import { lossless } from "./json.js";
import { findRoster, loadRosterAt, scanRosterLibrary } from "./registry.js";
import {
  renderBridgePlan,
  renderCaptainVerification,
  renderRosterDetail,
  renderRosterDiff,
  renderRosterList,
  renderVerifyReport,
} from "./render.js";
import { readDeployedCaptains, verifyCaptain } from "./captain.js";
import { readTeamStates, resolveStateDir } from "./teams-state.js";
import { filterChecks, memberVerdict, verifyBindings } from "./verify.js";

/** 工具输出统一的对象 schema：结构字段给程序，`text` 给人读。 */
const OUTPUT = { type: "object", additionalProperties: true };

/**
 * 模型可读内容 = `render()` 产出的文本块；结构化对象不会自动出现在里面。
 * 所以每个工具的首行都放一行 `k=v` 状态摘要：人扫一眼能懂，
 * 另一个模型也不必靠中文字样去猜这次调用是成功还是失败。
 */
function statusLine(tool, fields) {
  const body = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `[${tool}] ${body}`;
}

/**
 * 把工具注册进运行时。
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {object} config 由 index.js 的 Config 解析后的插件配置
 * @param {{ version: string }} meta 插件自身元信息（`roster_list` 里显示来源）
 * @returns {void}
 */
export function registerRosterTools(ctx, config, meta) {
  // args.path 是显式的档案库覆盖；没有就给配置里的 rosterDirs[0]。
  const resolve = (exec, override) => resolvePaths(config, exec, override);
  const scanAt = (rootDir) => scanRosterLibrary({ rootDir, knownToolPolicies: config.knownToolPolicies ?? null });
  // 档案文件内容的哈希：只有重新读一次那份文件才拿得到（扫描结果里不带字节）。
  const shaOf = (rootDir, roster) => {
    const loaded = loadRosterAt(nodePath.join(rootDir, roster.id), {
      expectedId: roster.id,
      knownToolPolicies: config.knownToolPolicies ?? null,
    });
    return loaded.ok && typeof loaded.contentSha === "string" ? loaded.contentSha : null;
  };

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_list",
          description:
            "列出一座本地档案库（roster 目录）里的全部成员档案，以及每份档案的校验结果。" +
            "档案是静态配置：写的是成员是谁、用什么模型、受哪些工具约束。" +
            "本工具只读不写；校验不通过的档案会单独列出原因，不会静默跳过。" +
            "需要看某个成员的完整人设时用 roster_show。",
          parameters: {
            path: {
              type: "string",
              description:
                "档案库目录；省略则用配置的 rosterDirs 第一项，留空时即全局库 $DSH_HOME/agent-roster（~/.dsh/agent-roster）",
            },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir, workspace } = resolve(exec, args.path);
            const scan = scanAt(rosterDir);
            const text = [
              statusLine("roster_list", {
                rootDir: rosterDir,
                total: scan.stats.total,
                ok: scan.stats.ok,
                failed: scan.stats.failed,
                members: scan.stats.members,
              }),
              renderRosterList(scan),
            ].join("\n\n");
            return lossless({
              source: `@stofone/dsh-agent-roster@${meta.version}`,
              workspace,
              rootDir: rosterDir,
              stats: scan.stats,
              rosters: scan.rosters.map((roster) => ({
                id: roster.id,
                version: roster.version,
                title: roster.title,
                file: roster.file,
                members: roster.members.map((member) => ({ name: member.name, role: member.role })),
                tags: roster.tags,
              })),
              diagnostics: scan.diagnostics,
              text,
            });
          },
          presentCall: () => ({ card: "generic", title: "档案列表" }),
          presentResult: (_args, result) => ({
            card: "generic",
            title: result.isError ? "档案列表失败" : "档案列表",
          }),
        }),
      ),
    "dsh-agent-roster: roster_list",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_show",
          description:
            "按档案 id 或成员名查看一份档案的完整内容：每个成员的模型路由、工具策略、声明层约束、人设长度与人设开头。" +
            "同时给出该成员的桥接字段清单（哪些字段运行时会真正接收、哪些只是声明）。" +
            "档案 id 与成员名冲突时返回歧义列表，不替你猜。",
          parameters: {
            ref: {
              type: "string",
              required: true,
              description: "档案 id（如 core-review）或其中某个成员名（如 reviewer）",
            },
            member: { type: "string", description: "只看这一名成员" },
            path: { type: "string", description: "档案库目录；省略时同 roster_list" },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir } = resolve(exec, args.path);
            const scan = scanAt(rosterDir);
            const hit = findRoster(scan.rosters, args.ref);
            if (hit === null) {
              const known = scan.rosters.map((roster) => `${roster.id}（${roster.members.map((m) => m.name).join(",")}）`);
              return lossless({
                found: false,
                text: [
                  statusLine("roster_show", { found: false, ref: args.ref }),
                  `没有档案或成员叫 "${args.ref}"。\n已知档案：${known.join("  ") || "（空）"}`,
                ].join("\n\n"),
                diagnostics: scan.diagnostics,
              });
            }
            if (hit.ambiguous !== undefined) {
              return lossless({
                found: false,
                ambiguous: hit.ambiguous.map((roster) => roster.id),
                text: [
                  statusLine("roster_show", {
                    found: false,
                    ambiguous: hit.ambiguous.map((roster) => roster.id).join(","),
                  }),
                  `成员名 "${args.ref}" 同时出现在多份档案里：${hit.ambiguous.map((roster) => roster.id).join(", ")}。\n` +
                    "请改用档案 id 指定要看哪一份。",
                ].join("\n\n"),
                diagnostics: scan.diagnostics,
              });
            }
            const roster = hit.roster;
            const only = args.member === undefined ? undefined : [args.member];
            const members = roster.members
              .filter((member) => only === undefined || only.includes(member.name))
              .map((member) => {
                const { binding } = buildMemberBinding(roster, member);
                return { member, fields: binding.fields, summary: summarizeBinding(binding) };
              });
            const text = [
              statusLine("roster_show", {
                found: true,
                roster: roster.id,
                version: roster.version,
                members: members.length,
                matchedBy: hit.via,
              }),
              renderRosterDetail(roster, only),
            ].join("\n\n");
            return lossless({
              found: true,
              matchedBy: hit.via,
              roster: {
                id: roster.id,
                version: roster.version,
                title: roster.title,
                description: roster.description,
                file: roster.file,
                tags: roster.tags,
                maintainers: roster.maintainers,
                defaults: roster.defaults,
              },
              members: members.map(({ member, fields, summary }) => ({
                name: member.name,
                role: member.role,
                description: member.description ?? "",
                aliases: member.aliases ?? [],
                skills: member.skills ?? [],
                examples: member.examples ?? [],
                provider: member.provider ?? null,
                model: member.model ?? null,
                reasoningEffort: member.reasoningEffort ?? null,
                toolPolicy: member.toolPolicy ?? null,
                systemPromptChars: member.systemPrompt.length,
                binding: fields,
                bindingSummary: summary,
              })),
              captain: roster.captain ?? null,
              diagnostics: scan.diagnostics,
              text,
            });
          },
          presentCall: (args) => ({ card: "generic", title: `查看档案 ${args.ref}` }),
          presentResult: (_args, result) => ({ card: "generic", title: result.isError ? "查看档案失败" : "档案详情" }),
        }),
      ),
    "dsh-agent-roster: roster_show",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_create",
          description:
            "把档案里的成员翻译成 dsh-agent-teams 的建员参数，逐个输出可直接使用的 agent_teams_add_member 调用（以及 agent_teams_create 的 plan.members 形式）。" +
            "本工具不创建成员、不写入团队状态；它只把档案翻译成参数，并逐个字段标注归宿：" +
            "运行时真正接收的、只作声明的、需要落部署配置的，分开写清楚。" +
            "拿到参数后由你原样调用 agent_teams_add_member；成员建好后用 roster_verify 核对实际值。",
          parameters: {
            ref: {
              type: "string",
              required: true,
              description: "档案 id 或成员名（成员名需在该档案中唯一）",
            },
            members: {
              type: "array",
              items: { type: "string" },
              description: "只桥接这些成员；省略则整份档案",
            },
            path: { type: "string", description: "档案库目录；省略时同 roster_list" },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir } = resolve(exec, args.path);
            const scan = scanAt(rosterDir);
            const hit = findRoster(scan.rosters, args.ref);
            const fail = (message) =>
              lossless({
                ok: false,
                text: [statusLine("roster_create", { ok: false, ref: args.ref }), message].join("\n\n"),
                diagnostics: scan.diagnostics,
              });
            if (hit === null) return fail(`没有档案或成员叫 "${args.ref}"。`);
            if (hit.ambiguous !== undefined) {
              return fail(`成员名 "${args.ref}" 在多份档案里都有，请改用档案 id：${hit.ambiguous.map((r) => r.id).join(", ")}`);
            }
            const roster = hit.roster;
            const wanted = Array.isArray(args.members) && args.members.length > 0 ? new Set(args.members) : null;
            const selected = roster.members.filter((member) => wanted === null || wanted.has(member.name));
            if (selected.length === 0) {
              return fail(
                `档案 ${roster.id} 里没有成员 ${[...(wanted ?? [])].join(", ")}；可用：${roster.members.map((m) => m.name).join(", ")}`,
              );
            }
            const entries = selected.map((member) => ({ member, ...buildMemberBinding(roster, member) }));
            // 团队状态里没有"由哪一版档案建成"，只能把出处写进 description。
            // 插件仍然不写 team.json：它只给出建议的那一行，由队长传进 agent_teams_create。
            const contentSha = shaOf(rosterDir, roster);
            const provenance = provenanceLine(roster, contentSha ?? undefined);
            const text = [
              statusLine("roster_create", {
                ok: true,
                roster: roster.id,
                version: roster.version,
                calls: entries.length,
              }),
              renderBridgePlan({ roster, entries }),
              `建团队时把这一行放进 agent_teams_create 的 description（插件不写团队状态）：\n  ${provenance}\n` +
                "之后 roster_verify 会把团队声明的这一行与当前档案内容比对；对不上就说明档案在建团队之后改过。",
            ].join("\n\n");
            return lossless({
              ok: true,
              rosterId: roster.id,
              rosterVersion: roster.version,
              provenance: { line: provenance, rosterId: roster.id, version: roster.version, contentSha },
              calls: entries.map((entry) => ({ tool: "agent_teams_add_member", arguments: entry.args })),
              planMembers: entries.map((entry) => entry.planMember),
              bindings: entries.map((entry) => ({
                member: entry.member.name,
                fields: entry.binding.fields,
                summary: summarizeBinding(entry.binding),
              })),
              nextStep: "把每个 calls[].arguments 原样传给 agent_teams_add_member；随后用 roster_verify 核对运行时实际值",
              diagnostics: scan.diagnostics,
              text,
            });
          },
          presentCall: (args) => ({ card: "generic", title: `桥接档案 ${args.ref}` }),
          presentResult: (_args, result) => ({ card: "generic", title: result.isError ? "桥接失败" : "桥接参数" }),
        }),
      ),
    "dsh-agent-roster: roster_create",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_verify",
          description:
            "核对档案是否真的进了运行时：读取 dsh-agent-teams 的 team.json，把每个成员持久化的 provider/model/reasoningEffort/toolPolicy/executionPrompt 与档案逐字段比对，报出一致、降级、缺失、未部署。" +
            "比对的是运行时实际记下的值，不是我们发出的参数，所以能发现被静默覆盖的模型或失效的工具策略。" +
            "运行时状态缺失时如实降级为「无法核对」，不会假装通过。本工具只读，不写团队状态。",
          parameters: {
            ref: { type: "string", description: "只核对这份档案（id 或成员名）；省略则核对整座档案库" },
            team: { type: "string", description: "只核对这个团队 id；省略则核对全部在用团队" },
            stateDir: {
              type: "string",
              description: "AgentTeams 状态目录；省略则用配置的 agentTeamsStateDir（默认 .agent-teams，相对当前工作区）",
            },
            path: { type: "string", description: "档案库目录；省略时同 roster_list" },
            members: {
              type: "array",
              items: { type: "string" },
              description: "只核对这些成员名",
            },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir, workspace } = resolve(exec, args.path);
            const scan = scanAt(rosterDir);
            let rosters = scan.rosters;
            let refRosterIds = [];
            if (args.ref !== undefined) {
              const hit = findRoster(rosters, args.ref);
              if (hit === null) {
                return lossless({
                  ok: false,
                  text: [statusLine("roster_verify", { ok: false, ref: args.ref }), `没有档案或成员叫 "${args.ref}"，无从核对。`].join(
                    "\n\n",
                  ),
                  diagnostics: scan.diagnostics,
                });
              }
              if (hit.ambiguous !== undefined) {
                return lossless({
                  ok: false,
                  text: [
                    statusLine("roster_verify", { ok: false, ambiguous: hit.ambiguous.map((r) => r.id).join(",") }),
                    `成员名 "${args.ref}" 在多份档案里都有，请改用档案 id：${hit.ambiguous.map((r) => r.id).join(", ")}`,
                  ].join("\n\n"),
                  diagnostics: scan.diagnostics,
                });
              }
              rosters = [hit.roster];
              refRosterIds = [hit.roster.id];
            }

            const stateDir = resolveStateDir(args.stateDir ?? config.agentTeamsStateDir ?? ".agent-teams", workspace);
            const state = readTeamStates({ stateDir, teamId: args.team });
            // 技能是声明层：只有宿主真的能列出技能目录时才核对，否则如实记成"无法核对"。
            const knownSkills = await readKnownSkills(ctx, workspace);
            const rosterShas = {};
            for (const roster of rosters) {
              const sha = shaOf(rosterDir, roster);
              if (sha !== null) rosterShas[roster.id] = sha;
            }
            let report = verifyBindings(rosters, state.teams, { knownSkills, rosterShas });
            // 队长不是成员行：只能拿实际的部署配置去比档案里的声明，读不到就记成“无法核对”。
            const deployedCaptains = readDeployedCaptains();
            const captainReports = rosters
              .filter((roster) => roster.captain !== undefined && roster.captain !== null)
              .map((roster) => ({ roster, verified: verifyCaptain(roster.captain, deployedCaptains) }));
            if (Array.isArray(args.members) && args.members.length > 0) {
              report = filterChecks(report, args.members);
            }
            // `ok` 只判"部署侧有没有漂移"。人设拿不到回执是上游 team.json 不持久化该键，
            // 那不是部署做错了——所以它单列成 unverified，绝不混进 ok，也不许悄悄消失。
            const ok = report.summary.drift === 0 && report.summary.missing === 0 && state.available;
            const summary = report.summary;
            const text = [
              statusLine("roster_verify", {
                ok,
                state: state.available ? "available" : "unavailable",
                members: summary.members,
                deployed: summary.deployed,
                faithful: summary.faithful,
                unverified: summary.unverified,
                drift: summary.drift,
                missing: summary.missing,
                unmanaged: summary.unmanaged,
                toolFilter: `${summary.toolFilterChecked}/${summary.toolFilterChecked + summary.toolFilterMissing}`,
                policyDrift: summary.policyDrift,
                provenance: `${summary.provenanceAbsent}absent/${summary.provenanceDiffer}differ`,
                skills: `${summary.skillsMissing}/${summary.skillsDeclared}`,
                captain: captainReports.length,
              }),
              renderVerifyReport(report, { rosterIds: refRosterIds }),
              ...(captainReports.length === 0
                ? []
                : [
                    captainReports
                      .map(({ verified }) => renderCaptainVerification(verified, { displayed: deployedCaptains.displayed }))
                      .join("\n\n"),
                  ]),
            ].join("\n\n");
            return lossless({
              ok,
              stateDir,
              teams: state.teams.map((team) => ({
                id: team.id,
                name: team.name,
                phase: team.phase,
                file: team.file,
                description: typeof team.description === "string" ? team.description : "",
              })),
              summary: report.summary,
              checks: report.checks.map((check) => ({
                rosterId: check.rosterId,
                rosterVersion: check.rosterVersion,
                member: check.member,
                found: check.found,
                teamId: check.teamId,
                faithful: check.faithful,
                verdict: memberVerdict(check),
                toolPolicy: check.toolPolicy ?? null,
                toolFilter: check.toolFilter ?? null,
                fields: check.binding === null ? [] : check.binding.fields,
              })),
              unmanaged: report.unmanaged,
              policyDrift: report.policyDrift,
              provenance: report.provenance,
              captain: captainReports.map(({ roster, verified }) => ({
                rosterId: roster.id,
                ok: verified.ok,
                checks: verified.checks,
              })),
              skills: report.skills,
              diagnostics: [...scan.diagnostics, ...state.diagnostics],
              text,
            });
          },
          presentCall: (args) => ({ card: "generic", title: args.ref === undefined ? "核对全部档案" : `核对 ${args.ref}` }),
          presentResult: (_args, result) => ({ card: "generic", title: result.isError ? "核对失败" : "档案核对报告" }),
        }),
      ),
    "dsh-agent-roster: roster_verify",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_diff",
          description:
            "比较两份档案的语义差异：换班时回答\"新一代改了什么\"。" +
            "成员按 name 对齐（aliases 只作提示，不自动合并，改名会显示成删一个、加一个）；" +
            "比的是有效值（defaults 已合进成员），并标注这个值来自成员还是 defaults。" +
            "人设只比长度与内容哈希，不把整段文字贴出来。本工具只读，不写任何东西。",
          parameters: {
            from: { type: "string", required: true, description: "旧档案所在目录：档案目录本身，或包含它的档案库目录" },
            to: { type: "string", required: true, description: "新档案所在目录：档案目录本身，或包含它的档案库目录" },
            id: {
              type: "string",
              description: "目录里有不止一份档案时，指明要比较哪一份（档案 id）；省略时要求目录里恰好只有一份",
            },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { workspace } = resolve(exec, undefined);
            const fail = (message, diagnostics = []) =>
              lossless({
                ok: false,
                text: [statusLine("roster_diff", { ok: false, from: args.from, to: args.to }), message].join("\n\n"),
                diagnostics,
              });

            const load = (spec) => {
              const dir = resolveDirSpec(spec, workspace);
              const direct = loadRosterAt(dir, { knownToolPolicies: config.knownToolPolicies ?? null });
              if (direct.ok) return { ok: true, dir, roster: direct.roster, contentSha: direct.contentSha, diagnostics: direct.diagnostics };
              const scan = scanRosterLibrary({ rootDir: dir, knownToolPolicies: config.knownToolPolicies ?? null });
              const candidates = args.id === undefined ? scan.rosters : scan.rosters.filter((item) => item.id === args.id);
              const diagnostics = [...direct.diagnostics, ...scan.diagnostics];
              if (candidates.length === 0) {
                return {
                  ok: false,
                  dir,
                  diagnostics,
                  reason:
                    `目录 "${dir}" 里没有可用的档案` +
                    (args.id === undefined ? "。" : `（id=${args.id}）。`) +
                    "请指向档案目录本身，或指向包含它的档案库目录。",
                };
              }
              if (candidates.length > 1) {
                return {
                  ok: false,
                  dir,
                  diagnostics,
                  reason: `目录 "${dir}" 里有 ${candidates.length} 份档案，请用 id 指明要比较哪一份：${candidates.map((item) => item.id).join(", ")}`,
                };
              }
              const only = candidates[0];
              const loaded = loadRosterAt(nodePath.join(dir, only.id), {
                expectedId: only.id,
                knownToolPolicies: config.knownToolPolicies ?? null,
              });
              return {
                ok: loaded.ok,
                dir,
                roster: loaded.roster,
                contentSha: loaded.contentSha,
                diagnostics: [...diagnostics, ...loaded.diagnostics],
                reason: loaded.ok ? undefined : `档案 ${only.id} 校验不通过，无法比较。`,
              };
            };

            const left = load(args.from);
            if (left.ok !== true) return fail(left.reason ?? "旧档案读不出来。", left.diagnostics);
            const right = load(args.to);
            if (right.ok !== true) return fail(right.reason ?? "新档案读不出来。", right.diagnostics);

            const diff = diffRosters(left.roster, right.roster);
            const labels = {
              from: { id: left.roster.id, version: left.roster.version, sha: left.contentSha },
              to: { id: right.roster.id, version: right.roster.version, sha: right.contentSha },
            };
            const sameFile =
              typeof left.contentSha === "string" && left.contentSha === right.contentSha
                ? "（两份是逐字节相同的文件）"
                : "";
            const text = [
              statusLine("roster_diff", {
                ok: true,
                from: `${left.roster.id}@${left.roster.version}`,
                to: `${right.roster.id}@${right.roster.version}`,
                added: diff.counts.added,
                removed: diff.counts.removed,
                changed: diff.counts.changed,
              }),
              renderRosterDiff(diff, labels) + (sameFile === "" ? "" : `\n${sameFile}`),
            ].join("\n\n");
            return lossless({
              ok: true,
              from: labels.from,
              to: labels.to,
              rosters: diff.rosters,
              members: diff.members,
              skills: diff.skills,
              counts: diff.counts,
              diagnostics: [...left.diagnostics, ...right.diagnostics],
              text,
            });
          },
          presentCall: (args) => ({ card: "generic", title: `比较档案 ${args.from} → ${args.to}` }),
          presentResult: (_args, result) => ({ card: "generic", title: result.isError ? "比较失败" : "档案差异" }),
        }),
      ),
    "dsh-agent-roster: roster_diff",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_index",
          description:
            "查看订阅的公共档案源（registry）：有哪些 collection、各自登记了几份档案、上次拉取时间与是否过期。" +
            "给了 collection 就把那一套档案真正拉下来（只读，不写本机档案库）并列出内容。" +
            "索引按 TTL 缓存（默认一小时）；网络失败会沿用上次缓存，并在诊断里说明原因，不会假装“没有档案”。",
          parameters: {
            collection: { type: "string", description: "collection id（如 agent-roster-examples）；省略则只列索引与目录" },
            source: { type: "string", description: "限定某个索引源 id；省略则在所有源里找该 collection" },
            refresh: { type: "boolean", description: "忽略 TTL 重新拉取（仍有 60 秒最短间隔，避免把配额烧光）" },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args) {
            const panel = await loadRemotePanel(config, { refresh: args.refresh === true });

            if (typeof args.collection !== "string" || args.collection === "") {
              const lines = [];
              lines.push(
                statusLine("roster_index", {
                  indexes: panel.indexes.length,
                  collections: panel.collections.length,
                  ok: panel.diagnostics.filter((item) => item.severity === "error").length === 0,
                }),
              );
              lines.push(renderIndexSummary(panel));
              return lossless({
                indexes: panel.indexes,
                collections: panel.collections,
                diagnostics: panel.diagnostics,
                text: lines.join("\n\n"),
              });
            }

            const collection = panel.collections.find(
              (item) => item.id === args.collection && (args.source === undefined || item.origin?.source === args.source),
            );
            if (collection === undefined) {
              return lossless({
                found: false,
                text: [
                  statusLine("roster_index", { found: false, collection: args.collection }),
                  `没有叫 "${args.collection}" 的 collection。已知：${
                    panel.collections.map((item) => item.id).join(", ") || "（无）"
                  }`,
                ].join("\n\n"),
              });
            }

            const fetched = await fetchCollection(collection);
            const scanLike = {
              rootDir: `${collection.repo}/${collection.ref}/${collection.path}`,
              missing: false,
              entries: fetched.rosters.map((roster) => ({ id: roster.id, roster, diagnostics: [] })),
              stats: {
                total: fetched.rosters.length,
                ok: fetched.rosters.length,
                failed: 0,
                members: fetched.rosters.reduce((total, roster) => total + roster.members.length, 0),
                errors: 0,
                warnings: 0,
                infos: 0,
              },
            };
            return lossless({
              found: true,
              collection: {
                id: collection.id,
                title: collection.title,
                repo: collection.repo,
                ref: collection.ref,
                path: collection.path,
                registered: collection.rosters,
                fetched: fetched.rosters.length,
              },
              rosters: fetched.rosters.map((roster) => ({
                id: roster.id,
                version: roster.version,
                title: roster.title,
                members: roster.members.map((member) => member.name),
                origin: roster.origin,
              })),
              diagnostics: [...panel.diagnostics, ...fetched.diagnostics],
              text: [
                statusLine("roster_index", {
                  collection: collection.id,
                  registered: collection.rosters.length,
                  fetched: fetched.rosters.length,
                }),
                renderRosterList(scanLike),
                fetched.diagnostics.length === 0 ? "" : renderDiagnostics(fetched.diagnostics),
              ]
                .filter(Boolean)
                .join("\n\n"),
            });
          },
          presentCall: (args) => ({
            card: "generic",
            title: args.collection === undefined ? "公共档案源" : `公共档案源 ${args.collection}`,
          }),
          presentResult: (_args, result) => ({ card: "generic", title: result.isError ? "读取公共档案源失败" : "公共档案源" }),
        }),
      ),
    "dsh-agent-roster: roster_index",
  );
}

/**
 * 索引与目录的文字摘要（`roster_index` 不带 collection 时用）。
 *
 * @param {object} panel `loadRemotePanel` 的产物
 * @returns {string}
 */
function renderIndexSummary(panel) {
  const lines = [];
  if (panel.indexes.length === 0) {
    lines.push("没有配置任何索引源（设置里的 indexes 为空时只用官方源）。");
    return lines.join("\n");
  }
  lines.push("索引源");
  for (const index of panel.indexes) {
    const state = index.ok ? (index.stale ? "缓存（拉取失败）" : "正常") : "不可用";
    lines.push(`  ${index.label}  ·  ${state}  ·  collection ${index.collections}  ·  拉取于 ${index.fetchedAt ?? "-"}`);
  }
  lines.push("");
  if (panel.collections.length === 0) {
    lines.push("目录里还没有 collection。");
  } else {
    lines.push("collection");
    for (const collection of panel.collections) {
      lines.push(
        `  ${collection.id}  ·  ${collection.title}  ·  ${collection.rosters.length} 份档案  ·  ${collection.repo}@${collection.ref}/${collection.path}`,
      );
      if (collection.description !== "") lines.push(`      ${collection.description}`);
    }
  }
  const problems = (panel.diagnostics ?? []).filter((item) => item.severity !== "info");
  if (problems.length > 0) lines.push("", renderDiagnostics(problems));
  return lines.join("\n");
}

/**
 * 读宿主技能目录（可选服务）。
 *
 * 拿不到就返回 `null`：调用方会把技能核对标成"无法核对"，而不是把"没读到"说成"都没装"。
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {string} workspace
 * @returns {Promise<string[] | null>}
 */
async function readKnownSkills(ctx, workspace) {
  try {
    const skills = ctx.get?.("skills") ?? ctx.skills;
    if (skills === null || skills === undefined || typeof skills.list !== "function") return null;
    const list = await skills.list({ cwd: workspace });
    if (!Array.isArray(list)) return null;
    return list
      .map((item) => (item !== null && typeof item === "object" ? item.name : undefined))
      .filter((name) => typeof name === "string" && name !== "");
  } catch {
    return null;
  }
}

/**
 * 解析档案库与工作区路径。
 *
 * 档案库默认**全局**：`<DSH_HOME>/agent-roster`，不随工作区变化。只有配置里写了相对路径
 * （或调用时传了相对 `path`）才按会话工作区解析——那是显式例外，不是默认行为。
 * 拿不到会话时退回进程工作目录，并在诊断里说明。
 *
 * 工具参数里的 `path` 是**显式覆盖**：给了就只信它，不再回落配置，避免"传了参数却
 * 静默读默认目录"这种最难查的行为（真机验证里正是这个 bug）。
 *
 * @param {object} config
 * @param {{ agent?: object }} exec
 * @param {string | undefined} override 工具参数里的档案库目录
 * @returns {{ rosterDir: string, workspace: string, workspaceKnown: boolean, overridden: boolean }}
 */
export function resolvePaths(config, exec, override) {
  const fromSession = exec?.agent?.session?.header?.cwd;
  const workspaceKnown = typeof fromSession === "string" && fromSession !== "";
  const workspace = workspaceKnown ? fromSession : process.cwd();
  const hasOverride = typeof override === "string" && override !== "";
  const configured = hasOverride
    ? override
    : Array.isArray(config.rosterDirs) && config.rosterDirs.length > 0
      ? config.rosterDirs[0]
      : "";
  const rosterDir = resolveDirSpec(configured, workspace);
  return { rosterDir, workspace, workspaceKnown, overridden: hasOverride };
}

/** 供 CLI 与测试复用：把诊断折成一行摘要。 */
export function summarizeDiagnostics(diagnostics) {
  const list = diagnostics ?? [];
  const errors = list.filter((item) => item.severity === "error").length;
  const warnings = list.filter((item) => item.severity === "warn").length;
  return { errors, warnings, total: list.length, maxChars: LIMITS.descriptionChars };
}

/** 供 CLI 复用的字段说明行。 */
export { describeField };
