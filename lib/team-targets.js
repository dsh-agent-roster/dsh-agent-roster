/**
 * 团队引擎：一份档案可以被交给哪一类"建团队"插件执行。
 *
 * 为什么要有这一层：档案里的成员规格（模型、人设、toolPolicy）不是每个建团插件
 * 都接得住。把目标写成下拉菜单，选到哪个就按哪个的契约发提示，目标缺席时
 * 明确说"没装"，而不是让会话在缺工具的情况下静默失败——那正是用户抱怨的
 * "插件的依赖不会静默"。
 *
 * 本模块不 import 任何宿主包，也不 import 其他插件：探测只回答"这个 profile 里
 * 能不能解析到这个包"，运行时是否真的挂载由宿主决定（工具是否出现在会话里，
 * 只有会话自己知道）。所以 `available` 的语义是"装在这台机器上"，不是"已启用"。
 *
 * @module dsh-agent-roster/team-targets
 */
import { createRequire } from "node:module";

/**
 * 目标 id 的闭集。它们是「引擎」，不是「团队」——团队是运行时的产物。
 */
export const TEAM_TARGET_IDS = ["agent-teams", "experimental-agent-team"];

/**
 * 每个目标声明自己的包、能力与提示词构造器。
 *
 * 能力矩阵只描述"档案里的字段能不能被这个引擎接住"，不描述实现细节：
 * - `teamRecord`：有没有一个可被 `roster_verify` 读到的团队记录（team.json）。
 * - `memberSpecs`：建员时能不能逐字段指定 provider/model/persona/toolPolicy。
 * - `memberPersona`：成员人设能不能进运行时（agent-teams 通过 section 注入）。
 * - `perMemberModel`：能不能给单个成员选模型。
 * - `teamName`：团队有没有自己的名字（实验线的 TeamId 就是会话 id）。
 */
export const TEAM_TARGETS = [
  {
    id: "agent-teams",
    label: "Agent Teams",
    packages: ["@nanmicoder/dsh-agent-teams"],
    capabilities: {
      teamRecord: true,
      memberSpecs: true,
      memberPersona: true,
      perMemberModel: true,
      teamName: true,
    },
  },
  {
    id: "experimental-agent-team",
    label: "Experimental Agent Team",
    packages: [
      "@deepseek-ai/dsh-experimental-agent-team",
      "@deepseek-ai/dsh-experimental-tool-agent-team",
    ],
    capabilities: {
      teamRecord: false,
      memberSpecs: false,
      memberPersona: false,
      perMemberModel: false,
      teamName: false,
    },
  },
];

/**
 * 默认探测：从本包所在位置解析依赖。
 *
 * 插件与目标插件装在同一个 profile 的 node_modules 里，所以这里的解析结果
 * 与"这台机器的 profile 装没装它"一致。解析失败只代表装不上，不代表不能工作
 * （宿主也可能从别处加载），所以调用方要把 `available: false` 当提示，不要当闸门。
 *
 * @param {string} name
 * @returns {boolean}
 */
function defaultResolve(name) {
  try {
    createRequire(import.meta.url).resolve(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测所有目标。
 *
 * @param {{ resolve?: (name: string) => boolean }} [options]
 * @returns {Array<{ id: string, label: string, available: boolean, missing: string[], capabilities: object }>}
 */
export function detectTeamTargets(options = {}) {
  const resolve = typeof options.resolve === "function" ? options.resolve : defaultResolve;
  return TEAM_TARGETS.map((target) => {
    const missing = target.packages.filter((name) => {
      try {
        return resolve(name) !== true;
      } catch {
        return true;
      }
    });
    return {
      id: target.id,
      label: target.label,
      available: missing.length === 0,
      missing,
      capabilities: { ...target.capabilities },
    };
  });
}

/**
 * 已知目标；未知 id 返回 null（调用方负责报错，不要猜一个替代）。
 *
 * @param {string} id
 * @returns {object | null}
 */
export function teamTargetOf(id) {
  return TEAM_TARGETS.find((target) => target.id === id) ?? null;
}

/**
 * 官方实验线的建团提示。
 *
 * 与 agent-teams 的根本差异：没有"创建团队"这一步——每个 root 会话本身就是
 * 一支隐式团队的 Lead（TeamId = 会话 id）。所以这份提示只做两件事：
 * 让 Lead 按档案逐个 `spawn_teammate`，然后 `list_agents` 核对。
 *
 * 成员规格（模型/人设/toolPolicy）在这里传不进去，提示里如实说，不编造一个
 * "会生效"的错觉；队长人设仍由 captain-inject 注入，与引擎无关。
 *
 * @param {{ roster: object, teamName?: string, captainPersona?: string }} input
 * @returns {string}
 */
export function buildExperimentalPrompt(input) {
  const roster = input.roster;
  const id = String(roster?.id ?? "");
  const title = typeof roster?.title === "string" && roster.title !== "" ? roster.title : id;
  const members = Array.isArray(roster?.members) ? roster.members : [];
  const captainPersona =
    typeof input.captainPersona === "string" ? input.captainPersona.trim() : "";
  const personaBlock =
    captainPersona === ""
      ? []
      : ["你的队长人设（来自档案 captain 段，本次会话按它行动）：", "---", captainPersona, "---", ""];
  const knowledge = Array.isArray(input.knowledge) ? input.knowledge : [];
  const knowledgeBlock =
    knowledge.length === 0
      ? []
      : [
          "项目知识（只给指针，正文不在提示词里；要用时自己打开对应路径）：",
          ...knowledge.map(
            (item) => `- ${item.abs}${item.sha === "" ? "" : `  #${item.sha.slice(0, 8)}`}${item.title === "" ? "" : `  （${item.title}）`}`,
          ),
          "",
        ];
  const table = members
    .map((member) => {
      const name = String(member?.name ?? "");
      const role = String(member?.role ?? "");
      return role === "" ? `- ${name}` : `- ${name} | role: ${role}`;
    })
    .join("\n");

  return [
    `请按档案 \`${id}\`（${title}）建立一支多 Agent 团队。当前会话就是 Lead。`,
    "",
    ...personaBlock,
    ...knowledgeBlock,
    "引擎：官方实验线（dsh-experimental-agent-team）。每个 root 会话就是一支隐式团队的队长，TeamId 等于会话 id，所以**没有**“创建团队”这一步。",
    "",
    "步骤：",
    `1. 调用 \`roster_show\`，参数 id: "${id}"。它会给出每个成员的字段归宿（哪些进运行时、哪些只是声明）。`,
    "2. 对每个成员调用 `spawn_teammate`：",
    '   - `name`：成员名（小写 kebab-case，与档案一致）',
    '   - `description`：这个成员负责什么（一句话）',
    '   - `prompt`：它的初始任务（写清交付物与验收点；它会带着这条任务开始工作）',
    '   - `context`："fresh"（除非你确实需要它继承你已完成的对话）',
    "3. 全部 spawn 之后调用 `list_agents`，核对每个成员都在 roster 里、状态正常。",
    "4. 把结果摘要给我（成员名与职责），不要粘贴成员人设原文。",
    "",
    "本次要建的成员：",
    table === "" ? "- （档案里没有成员）" : table,
    "",
    "注意：这个引擎不支持给成员单独指定模型、人设或 toolPolicy，档案里的这些字段不会生效；会话名就是你在 roster 里看到的团队标识。队长人设仍由本插件注入，与引擎无关。",
  ].join("\n");
}
