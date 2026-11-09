/**
 * “应用队长档案”：把一份档案搬到某个会话里，让那个会话按档案去建团队。
 *
 * 为什么是这个形态：队长**不是**能被 `agent_teams_add_member` 创建出来的对象，
 * 它就是"创建团队的那个会话"。所以要"应用队长档案"，能做的只有三件事：
 *
 * 1. 选一个会话（已有的，或新建一个）；
 * 2. 把档案声明的模型选到那个会话上（`sessionController.selectModel`）；
 * 3. 往那个会话里排一条提示，让它按档案建团队（`sessionController.prompt`）。
 *
 * 第 2 步是**真的写进运行时**（模型选择是会话级持久投影），第 3 步只是让会话开始干活。
 * 人格（persona）：队员由 dsh-agent-teams 注入，队长由本插件的 `captain-inject`
 * 在同一个 `systemPrompt.section` 名上注入；起始消息里也带一份，作为无注入时的退路。
 *
 * 这一层不 import 任何宿主包：`sessionController` 由调用方传进来，方便测试。
 *
 * @module dsh-agent-roster/apply
 */
import { randomUUID } from "node:crypto";
import nodePath from "node:path";

import { markCaptainCandidate, resolveCaptainPersona } from "./captain-inject.js";

import { MEMBER_FIELDS } from "./format.js";
import { buildExperimentalPrompt } from "./team-targets.js";

/** 排一条提示给宿主的等待上限；到达上限只是"这次没排上"，重试即可。 */
const PROMPT_TIMEOUT_MS = 30_000;

/**
 * 会话头上的模型投影：`next` 是下一次请求要用的，`lastUsed` 是上一次真正用过的。
 *
 * @param {object | null | undefined} summary `SessionSummary`
 * @returns {{ provider: string, model: string, reasoningEffort: string } | null}
 */
export function pickSessionModel(summary) {
  const values = summary?.projections?.values;
  const projection = values?.modelSelection;
  const selection = projection?.next ?? projection?.lastUsed ?? null;
  if (selection === null || typeof selection !== "object") return null;
  return {
    provider: typeof selection.provider === "string" ? selection.provider : "",
    model: typeof selection.model === "string" ? selection.model : "",
    reasoningEffort: typeof selection.reasoningEffort === "string" ? selection.reasoningEffort : "",
  };
}

/**
 * 会话标题：宿主列表的 `SessionSummary` 不带 title，它只活在投影值里
 * （`projections.values.title`，最后一次 `session/title` 事件）。取不到就返回空串，
 * 由前端退回工作区目录名——不编造一个看起来像名字的东西。
 *
 * @param {object | null | undefined} summary
 * @returns {string}
 */
export function sessionTitleOf(summary) {
  const title = summary?.projections?.values?.title;
  return typeof title === "string" ? title.trim() : "";
}

/**
 * 列宿主的"空间"（工作区注册表）。新建会话时要选的就是它。
 *
 * 没有 `workspaceRegistry` 时退回当前进程目录一项——不假装"没有工作区"。
 *
 * @param {object | null | undefined} registry 宿主 `workspaceRegistry` 服务
 * @returns {{ workspaceId: string, title: string, path: string }[]}
 */
export function listHostWorkspaces(registry) {
  const items = typeof registry?.list === "function" ? registry.list() : [];
  const mapped = (Array.isArray(items) ? items : [])
    .map((item) => ({
      // 宿主 WorkspaceEntity 的字段是 `id`（`workspaceId` 只出现在 API 请求里）。
      // 只读 `workspaceId` 会让每一项都映射成 ""，面板退回用目录建会话——
      // 那样会话确实落在该目录，却不会被登记进工作区的 sessionIds。
      workspaceId: String(item?.id ?? item?.workspaceId ?? ""),
      title: typeof item?.title === "string" ? item.title : "",
      path: typeof item?.path === "string" ? item.path : "",
    }))
    .filter((item) => item.path !== "");
  if (mapped.length === 0) return [{ workspaceId: "", title: "", path: process.cwd() }];
  return mapped.sort((a, b) => (a.title || a.path).localeCompare(b.title || b.path));
}

/**
 * 列可选会话（剔除子代理会话，它们不是队长候选）。
 *
 * @param {object | null | undefined} sessionController 宿主 `sessionController` 服务
 * @returns {Promise<{ ok: boolean, code?: string, sessions: object[] }>}
 */
export async function listSessions(sessionController) {
  if (sessionController === null || typeof sessionController !== "object" || typeof sessionController.list !== "function") {
    return { ok: false, code: "session-controller-unavailable", sessions: [] };
  }
  try {
    const page = await sessionController.list({});
    const items = Array.isArray(page?.items) ? page.items : [];
    const sessions = items
      .filter((item) => item?.origin !== "subagent")
      .map((item) => ({
        sessionId: String(item.sessionId ?? ""),
        // 会话标题在投影里（宿主列表本身不带 title）；没有标题就让前端退回工作区名。
        title: sessionTitleOf(item),
        cwd: typeof item.cwd === "string" ? item.cwd : "",
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
        running: item.running === true,
        blank: item.blank === true,
        model: pickSessionModel(item),
      }))
      .filter((item) => item.sessionId !== "");
    return { ok: true, sessions };
  } catch (error) {
    return { ok: false, code: "session-list-failed", reason: String(error?.message ?? error), sessions: [] };
  }
}

/**
 * 一段能给会话照着执行的提示词。
 *
 * 只写"要它做什么"和"从哪拿参数"，不复制成员人设原文：人设可能很长，
 * 而 `roster_show` 已经会把它和建员参数一起给出，重复一遍只会浪费上下文。
 *
 * @param {{ roster: object, teamName?: string }} input
 * @returns {string}
 */
export function buildCaptainPrompt(input) {
  const roster = input.roster;
  const id = String(roster?.id ?? "");
  const title = typeof roster?.title === "string" && roster.title !== "" ? roster.title : id;
  const teamName = typeof input.teamName === "string" && input.teamName !== "" ? input.teamName : id;
  const members = Array.isArray(roster?.members) ? roster.members : [];
  // 队长的人设是这份档案对“队长本人”的声明，和成员人设不是一回事：
  // 成员人设仍走 roster_show（避免把整份档案塞进上下文），队长人设必须直接给，
  // 否则新会话只能按部署的 preset persona 行动，档案里的 captain 段就白写了。
  // v1 把队长人设放在 `captain.systemPrompt`；v2 的角色式档案放在
  // `captain.personaPrefix`（编译产物里是 captain.persona 的正文）。两处都认，
  // 否则角色式档案的队长人设会被静默丢掉——那正是「发了档案却没生效」的假绿。
  const captainPersona = [roster?.captain?.systemPrompt, roster?.captain?.personaPrefix]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value !== "") ?? "";
  const personaBlock =
    captainPersona === ""
      ? []
      : [
          "你的队长人设（来自档案 captain 段，本次会话按它行动）：",
          "---",
          captainPersona,
          "---",
          "",
        ];
  const table = members
    .map((member) => {
      const bits = [`name: ${member.name}`, `role: ${member.role}`];
      for (const field of MEMBER_FIELDS) {
        if (field === "name" || field === "role" || field === "systemPrompt") continue;
        const value = member[field];
        if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
        bits.push(`${field}: ${Array.isArray(value) ? value.join(",") : value}`);
      }
      return `- ${bits.join(" | ")}`;
    })
    .join("\n");

  return [
    `请按档案 \`${id}\`（${title}）创建一个多 Agent 团队，队长就是你（当前会话）。`,
    "",
    ...personaBlock,
    "步骤：",
    `1. 调用 \`roster_show\`，参数 id: "${id}"。它会给出每个成员的字段归宿（哪些进运行时、哪些只是声明）。`,
    `2. 调用 \`roster_create\`，参数 id: "${id}"。它给出可直接使用的建员参数，以及一行团队溯源（形如 \`roster:${id}@<version>#<sha8>\`）。`,
    `3. 调用 \`agent_teams_create\`，参数 name: "${teamName}"，description 用档案的 description 或你自己概括，并把第 2 步的溯源行追加在最后，approval: "automatic"。`,
    `4. 对每个成员调用 \`agent_teams_add_member\`：参数按第 2 步给出的原样传（这个工具没有 provenance 参数，不要传）。`,
    `5. 成员都加上后调用 \`roster_verify\`（teamId 用第 3 步返回的团队 id），确认每个成员的字段是否如实进了运行时。`,
    "6. 把核对结果摘要给我（哪几个成员、哪些字段 not-carried），不要粘贴成员人设原文。",
    "",
    "本次要建的成员：",
    table === "" ? "- （档案里没有成员）" : table,
    "",
    captainPersona === ""
      ? "注意：这份档案的 captain 段没有人设，本次会话的行为以部署的 preset persona 为准；档案里的成员模型/provider 若与事实不符，以档案为准去 add_member，不要臆造。"
      : "注意：上面的人设是本档案声明的队长人格，建团队与后续工作都以它为准；模型仍由部署的 agent-default-model 决定，插件不写运行时。档案里的成员模型/provider 若与事实不符，以档案为准去 add_member，不要臆造。",
  ].join("\n");
}

/**
 * 把一个目录解析成宿主工作区 id（找不到返回空串）。
 *
 * 只给目录创建会话时，宿主会照目录建，但**不会**把会话登记进任何工作区的
 * `sessionIds`——界面上看就是"没建在选中的空间里"。能解析出工作区时，
 * 宁可发 workspaceId，让宿主完成登记。
 *
 * @param {object | null | undefined} registry
 * @param {string | undefined} cwd
 * @returns {string}
 */
export function workspaceIdForPath(registry, cwd) {
  if (typeof cwd !== "string" || cwd === "") return "";
  const items = typeof registry?.list === "function" ? registry.list() : [];
  let best = null;
  for (const item of Array.isArray(items) ? items : []) {
    const path = typeof item?.path === "string" ? item.path : "";
    if (path === "") continue;
    if (!(cwd === path || cwd.startsWith(`${path}/`))) continue;
    if (best === null || path.length > best.path.length) {
      best = { path, id: String(item?.id ?? item?.workspaceId ?? "") };
    }
  }
  return best === null ? "" : best.id;
}

/**
 * 把档案“应用”到一个会话：新建或复用会话 → 选模型 → 排提示。
 *
 * @param {object} input
 * @param {object | null | undefined} input.sessionController 宿主 `sessionController` 服务
 * @param {object} input.roster 已校验的档案（含 captain 段）
 * @param {"new" | "existing"} input.mode
 * @param {string} [input.sessionId] `existing` 时必填
 * @param {string} [input.cwd] `new` 时可指定会话工作目录，缺省用当前工作区
 * @param {string} [input.requestId] 便于测试固定 requestId
 * @returns {Promise<object>}
 */
/**
 * 档案目录：`rootDir` + `file` 拼出来；拼不出来就返回空串。
 *
 * `file` 在 v2 是 `rosters/<id>/roster.yaml`，v1 是裸文件名，两种都落在 rootDir 之下。
 */
function rosterDirFrom(roster) {
  const rootDir = typeof roster?.rootDir === "string" ? roster.rootDir : "";
  const file = typeof roster?.file === "string" ? roster.file : "";
  if (rootDir === "" || file === "") return "";
  return nodePath.join(rootDir, nodePath.dirname(file));
}

export async function applyCaptain(input) {
  const sessionController = input.sessionController;
  if (
    sessionController === null ||
    typeof sessionController !== "object" ||
    typeof sessionController.create !== "function" ||
    typeof sessionController.prompt !== "function"
  ) {
    return { ok: false, code: "session-controller-unavailable" };
  }

  const roster = input.roster;
  const captain = roster?.captain ?? {};
  const mode = input.mode === "new" ? "new" : "existing";
  // 队长人设可能不在 roster 对象里（面板快照不带 captain；v2 角色式队长也不带正文）。
  // 起始消息与注入层必须同源，所以这里按档案目录再解析一次。
  const rosterDir = typeof input.rosterDir === "string" && input.rosterDir !== ""
    ? input.rosterDir
    : rosterDirFrom(roster);
  const declaredPersona = [captain.systemPrompt, captain.personaPrefix]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value !== "") ?? "";
  const resolvedPersona = declaredPersona === "" ? resolveCaptainPersona(rosterDir) : null;
  const captainPersona = declaredPersona !== "" ? declaredPersona : resolvedPersona?.text ?? "";

  let sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  let renamed = null;
  if (mode === "new") {
    // 新会话可以落在某个"空间"（工作区）里，也可以直接给一个目录；
    // 两者互斥（宿主 SessionCreateRequest 就是这么定义的），优先 workspaceId。
    const request = {};
    const requested = typeof input.workspaceId === "string" ? input.workspaceId : "";
    const resolved = requested !== "" ? requested : workspaceIdForPath(input.workspaceRegistry, input.cwd);
    if (resolved !== "") request.workspaceId = resolved;
    else if (input.cwd) request.cwd = input.cwd;
    try {
      const created = await sessionController.create(request);
      sessionId = String(created?.sessionId ?? "");
    } catch (error) {
      return { ok: false, code: "session-create-failed", reason: String(error?.message ?? error) };
    }
    if (sessionId === "") return { ok: false, code: "session-create-failed" };
    // 队长人设的注入挂在团队落盘之后；先登记这个会话，注入层才会等它的团队。
    markCaptainCandidate(sessionId);
    // 会话名字：宿主 create 不接受 title，只能建完再改名（一次事件，可追溯）。
    const title = typeof input.sessionTitle === "string" ? input.sessionTitle.trim().slice(0, 120) : "";
    if (title !== "" && typeof sessionController.rename === "function") {
      try {
        const value = await sessionController.rename({ sessionId, title });
        renamed = typeof value?.title === "string" ? value.title : title;
      } catch (error) {
        // 改名失败不该让已经建好的会话作废；如实报告，交给调用方提示。
        return { ok: false, code: "session-rename-failed", sessionId, reason: String(error?.message ?? error) };
      }
    }
  } else if (sessionId === "") {
    return { ok: false, code: "missing-session" };
  }

  let model = null;
  // 档案里的 route 是"档案作者那台部署"的模型；调用方可以用 input.model 覆盖它
  // （面板在提交前会把宿主真实可用的模型列出来，选中的那一项走这里）。
  const override = input.model && typeof input.model === "object" ? input.model : null;
  const provider =
    typeof override?.provider === "string" && override.provider !== ""
      ? override.provider
      : typeof captain.provider === "string"
        ? captain.provider
        : "";
  const modelId =
    typeof override?.model === "string" && override.model !== ""
      ? override.model
      : typeof captain.model === "string"
        ? captain.model
        : "";
  if (provider !== "" && modelId !== "") {
    if (typeof sessionController.selectModel !== "function") {
      return { ok: false, code: "model-selection-unavailable", sessionId };
    }
    const selection = { sessionId, provider, model: modelId };
    const effort =
      typeof override?.reasoningEffort === "string" && override.reasoningEffort !== ""
        ? override.reasoningEffort
        : typeof captain.reasoningEffort === "string"
          ? captain.reasoningEffort
          : "";
    if (effort !== "" && effort !== "default") selection.reasoningEffort = effort;
    try {
      const applied = await sessionController.selectModel(selection);
      model = applied?.selected ?? { provider, model: modelId, reasoningEffort: selection.reasoningEffort ?? "" };
    } catch (error) {
      // 选不上就**不要**继续排提示：那样会建出一个模型与档案不符的团队，比直接失败更难查。
      return { ok: false, code: "model-not-applied", sessionId, reason: String(error?.message ?? error) };
    }
  }

  const rosterForPrompt =
    captainPersona === ""
      ? roster
      : { ...roster, captain: { ...captain, personaPrefix: captainPersona } };
  // 引擎决定"让会话怎么建团队"：agent-teams 走 agent_teams_* 工具；
  // 官方实验线没有"创建团队"这一步，走 spawn_teammate + list_agents。
  // 未知 id 在这里退回默认，校验（400）由 HTTP 层做。
  const target = input.target === "experimental-agent-team" ? "experimental-agent-team" : "agent-teams";
  const text =
    target === "experimental-agent-team"
      ? buildExperimentalPrompt({ roster: rosterForPrompt, teamName: input.teamName, captainPersona })
      : buildCaptainPrompt({ roster: rosterForPrompt, teamName: input.teamName });

  try {
    // 宿主的 `sessionController.prompt(request, signal)` 第二个参数是 **AbortSignal**，
    // 进来第一句就是 `signal.throwIfAborted()`。少传这个参数，宿主会抛
    // `Cannot read properties of undefined (reading 'throwIfAborted')`，
    // 被我们包成 `prompt-not-queued`——排队失败的真实原因跟"队列"无关。
    await sessionController.prompt(
      {
        requestId: typeof input.requestId === "string" && input.requestId !== "" ? input.requestId : randomUUID(),
        sessionId,
        mode: "queue",
        content: [{ type: "text", text }],
      },
      AbortSignal.timeout(PROMPT_TIMEOUT_MS),
    );
  } catch (error) {
    return { ok: false, code: "prompt-not-queued", sessionId, reason: String(error?.message ?? error) };
  }

  return { ok: true, sessionId, sessionTitle: renamed, model, queued: true, mode, target };
}
