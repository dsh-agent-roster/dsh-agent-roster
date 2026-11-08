/**
 * v2 格式常量：角色（role） / 组装（roster@2） / 编译产物（compiled）。
 *
 * 与 `format.js` 的关系：v1（`dsh-agent-roster/v1`）冻结，不再长新字段；
 * v2 是同一项目的下一个格式版本，两者共用 id / provider / model / semver 这些底层模式，
 * 但**不共用文档白名单**——v1 的字段以成员为中心，v2 的字段以「角色 + 引用 + 编排」为中心。
 *
 * 这里只有数据，没有逻辑；改这里等于改格式，必须同步 bump 对应的 `@N` 与三个 schema 文件。
 *
 * @module dsh-agent-roster/format-v2
 */

import { PATTERNS } from "./format.js";

const { id, semver, provider, model, tag, skill } = PATTERNS;

/**
 * 维护者句柄：这是「人/账号」，不是档案 id。
 *
 * 所以它允许大写与点（`STofone`、`first.last`），也允许长度 1——把人的 GitHub 账号
 * 强行塞进档案 id 的小写短横线规则里，只会让迁移去篡改真实姓名。
 */
const handle = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 角色文档（`roles/<任意目录>/AGENT.md` 的 frontmatter）。 */
export const ROLE_KIND = "dsh-agent-roster/role@1";

/** 组装文档（`rosters/<id>/roster.yaml`）。 */
export const ROSTER2_KIND = "dsh-agent-roster/roster@2";

/** 编译产物（`dist/<id>-<version>.json`，以及在内存里生成的 review 视图）。 */
export const COMPILED_KIND = "dsh-agent-roster/compiled@1";
/** 施工图：把编排摊成可执行的卡片清单，由队长会话去调用，插件自己不调。 */
export const PLAN_KIND = "dsh-agent-roster/plan@1";

/** 锁文件（`.agent-roster/lock.yaml`）。 */
export const LOCK_KIND = "dsh-agent-roster/lock@1";

/** 角色文件名（只有一个，不再按扩展名探测三种）。 */
export const ROLE_FILE_NAME = "AGENT.md";

/** 角色目录里允许出现的子目录：片段与示例。 */
export const ROLE_PARTS_DIR = "parts";

/** 库根下的共享片段目录：`{{> snippets/units.md}}` 相对它解析（跨角色复用）。 */
export const SNIPPETS_DIR = "snippets";

/** 组装文档文件名（与 v1 一致，靠 kind 区分版本）。 */
export const ROSTER2_FILE_NAMES = ["roster.yaml", "roster.yml", "roster.json"];

/** 上限。与 v1 的 `LIMITS` 分开：这些数字属于 v2 的语义，不是 v1 的放宽版。 */
export const LIMITS2 = {
  roleNameChars: 64,
  roleChars: 120,
  titleChars: 120,
  descriptionChars: 500,
  notesChars: 500,
  tagsPerRole: 16,
  maintainers: 16,
  skillsPerRole: 16,
  /** 一个角色正文（AGENT.md 的 markdown 部分）的上限。 */
  bodyChars: 8000,
  /** 一个片段的字符上限。 */
  partChars: 6000,
  /** 一个角色最多拆成几个片段。 */
  parts: 16,
  /** 正文里最多写几处引用（`{{> …}}`）。 */
  includes: 32,
  /** 一个被引用文件的字符上限（与片段同量级：都是拼进同一个人设的块）。 */
  includeChars: 6000,
  /** 拼装后 executionPrompt 的硬上限——这是运行时字段的上限，不是建议值。 */
  promptChars: 12_000,
  /** roster 层可以追加的字符上限。 */
  appendChars: 6000,
  members: 32,
  stages: 12,
  gates: 12,
  /** 一条验收判据的字符上限（它是句子，不是引用）。 */
  gateCriterionChars: 160,
  /** 一个门最多带几条可执行判据，以及一条命令的长度上限。 */
  gateVerifyCommands: 8,
  gateVerifyCommandChars: 500,
  maxRounds: 5,
  /** 一次编译最多解析多少个角色文件（防把仓库根当角色库扫）。 */
  roleFiles: 512,
};

/** 角色 frontmatter 允许的键（未知键一律拒绝）。 */
export const ROLE_FIELDS = [
  "$schema",
  "kind",
  "name",
  "version",
  "role",
  "title",
  "description",
  "tags",
  "maintainers",
  "license",
  "route",
  "tools",
  "prompt",
  "skills",
  "examples",
  "requires",
  "onMissing",
  "notes",
];

/** 角色必填键。`prompt` 可省略（表示正文即全部）。 */
export const ROLE_REQUIRED = ["kind", "name", "version", "role"];

/** `route` 允许的键：与 v1 的 direct 路由字段一一对应，只是嵌套了一层。 */
export const ROUTE_FIELDS = ["provider", "model", "reasoningEffort"];

/** `tools` 允许的键。`policy` 是 direct，`scope` 是 declaration。 */
export const TOOLS_FIELDS = ["policy", "scope"];

/** `tools.scope` 允许的键。 */
export const TOOL_SCOPE_FIELDS = ["allow", "deny"];

/** `prompt` 允许的键。`parts` 是有序片段，`budget` 是字符预算。 */
export const PROMPT_FIELDS = ["parts", "budget"];

/** `requires` 允许的键：只收有证据源的两类。 */
export const REQUIRES_FIELDS = ["skills", "toolPolicies"];

/** `onMissing` 的枚举。 */
export const ON_MISSING = ["refuse", "degraded"];
export const DEFAULT_ON_MISSING = "refuse";

/** 组装文档允许的顶层键。 */
export const ROSTER2_FIELDS = [
  "$schema",
  "kind",
  "id",
  "version",
  "title",
  "description",
  "license",
  "maintainers",
  "tags",
  "defaults",
  "targets",
  "members",
  "captain",
  "orchestration",
  "requires",
  "onMissing",
  "notes",
];

/** 组装文档必填键。 */
export const ROSTER2_REQUIRED = ["kind", "id", "version", "members"];

/** `defaults` 允许的键：只放能被成员继承的**桥接字段**。 */
export const DEFAULTS2_FIELDS = ["route", "tools"];

/** 一个成员引用允许的键。 */
export const MEMBER2_FIELDS = ["as", "role", "route", "tools", "prompt", "requires", "notes"];

/** 成员 `prompt` 允许的键：只能 prepend / append，不能替换角色片段。 */
export const MEMBER_PROMPT_FIELDS = ["prepend", "append"];

/** 队长段允许的键。 */
export const CAPTAIN2_FIELDS = ["role", "route", "persona", "notes"];

/** 编排段允许的键。 */
export const ORCHESTRATION_FIELDS = ["shape", "stages", "gates"];

/** 一个阶段允许的键。 */
export const STAGE_FIELDS = ["id", "parallel", "join", "on", "role", "maxRounds", "serial"];

/** 一个门允许的键。 */
/**
 * 门的字段。
 *
 * `after` 是「等哪些阶段结束」——机器可校验（必须是存在的 stage）。
 * `requires` 是「验收判据」——是给人读的句子，编译器只做长度与条数上限，不假装能验它。
 * `by` 是「谁来判」，必须是这个组装里的成员名。
 */
export const GATE_FIELDS = ["id", "after", "requires", "verify", "by", "onFail"];

/** 失败回边允许的键：回到哪个阶段、最多重试几轮。 */
export const ONFAIL_FIELDS = ["to", "maxRounds"];

/** 门的一条可执行判据：跑什么、期望退出码是什么。 */
export const VERIFY_FIELDS = ["command", "expectExit"];

/** 编排形态。只有一种被实现；其余留给未来而不是写一个假开关。 */
export const ORCHESTRATION_SHAPES = ["gate-pipeline"];

/** 编译目标：决定字段落到哪个面。 */
export const TARGETS = [
  "agent-teams/members",
  "agent-teams/orchestration",
  "profile/agent-preset",
];

/** 角色引用：`name@1.2.3`。 */
export const ROLE_REF = new RegExp(`^(${id.source.slice(1, -1)})@(${semver.source.slice(1, -1)})$`);

/** 拼装分隔符——写进格式，不留在代码里。 */
export const PROMPT_SEPARATOR = "\n\n";

export const PATTERNS2 = { id, semver, provider, model, tag, skill, handle, roleRef: ROLE_REF };
