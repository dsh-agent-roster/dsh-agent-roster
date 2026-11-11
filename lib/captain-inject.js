/**
 * 队长人设的会话级嵌入。
 *
 * dsh-agent-teams 只对**成员子会话**做人设注入：`lib/members.js` 在成员 ctx 上注册一个
 * 与部署 persona 同名的 `systemPrompt.section`（`deployment:persona-prefix`），
 * 靠同名遮蔽把部署 persona 换成人设。队长是顶层会话，不在它的管辖里，
 * 所以档案 `captain` 段写的人设过去只能进起始消息——一次性，压缩后就没了。
 *
 * 这层补上另一半：在队长会话自己的 ctx 上注册同一段 section。它与成员侧同构，
 * 用的是同一个宿主原语、同一个 section 名、同一个遮蔽语义；区别只在于归属解析：
 * 成员靠 team.json 的成员行，队长靠 `captainSessionId` + 团队 description 里的
 * `roster:<id>@<ver>#<sha8>` 溯源。
 *
 * 三条边界，都写在这里而不是散在调用点：
 *
 * 1. **只在解析出人设时才注册。** 注册即遮蔽：如果人设读不到却照样注册一个空 section，
 *    队长会连部署 persona 一起丢掉。所以宁可晚一步（等 team.json 落盘），也不抢跑。
 * 2. **每次装配重读文件。** `PromptSection.text` 允许传函数，宿主每个模型步都会求值；
 *    改档案立即生效，不用重启、不用重建会话。文件读失败时沿用上一次的好值。
 * 3. **插件禁用即失效。** 这是进程内的 contribution，不是写入磁盘的 preset；
 *    卸载/停用插件后，队长回到部署 persona。这与「预设」那种部署级落点是不同的取舍。
 *
 * @module dsh-agent-roster/captain-inject
 */
import fs from "node:fs";
import nodePath from "node:path";
import { createHash } from "node:crypto";

import YAML from "yaml";

import { parseProvenanceLine } from "./bridge.js";
import { nestedSpaceDirs } from "./space.js";
import { loadRoleAt } from "./role.js";
import { resolveStateDir } from "./teams-state.js";

/** 与 dsh-agent-teams 成员侧同名的 section：同名才会遮蔽部署 persona。 */
export const CAPTAIN_SECTION = "deployment:persona-prefix";

/** 部署 persona 的排序名（宿主 `PromptSectionOrderName` 里的固定项）。 */
const PERSONA_ORDER_NAME = "DEPLOYMENT_PERSONA_PREFIX";

/** 档案 id 要能安全当路径片段用；team.json 的 description 是外部输入。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

const ROSTER_FILES = ["roster.yaml", "roster.yml", "roster.json"];

/** 人设正文的单份上限：超过就截断并记一条警告，不把整份手册塞进系统提示词。 */
const MAX_PERSONA_CHARS = 20_000;


/**
 * 会话级绑定的持久化目录（每个库根一份）。
 *
 * section 注册在 live agent 上，宿主重启后 agent 重建就没了；团队队长能从
 * `.agent-teams/<team>/team.json` 找回归属，而「把某份档案应用到某个普通会话」没有
 * 团队记录可查——所以应用时写一份点文件，`agent/created` 时按它重挂。
 */
export const BINDING_DIR = ".dsh-roster-bindings";
export const BINDING_KIND = "dsh-agent-roster/session-binding@1";

/** 等 team.json 落盘的轮询间隔；只在"会话已建、团队还没建"的窗口里跑。 */
const WATCH_INTERVAL_MS = 1_500;

/** 一个团队最多等这么久还没落盘就放弃（apply 的队长一轮通常几十秒内就会建团）。 */
const WATCH_TIMEOUT_MS = 30 * 60 * 1_000;

/** 已嵌入的会话：sessionId → { rosterId, chars, sha, source, at }。 */
const attached = new Map();

/**
 * 本插件刚建出来的队长会话。
 *
 * 只有这些会话才值得等团队落盘：`agent/created` 对每个子会话也会触发，
 * 若不加区分，每建一个成员就会多一个 30 分钟的轮询。
 */
const candidates = new Map();

/**
 * 注入失败的原因（sessionId → { rosterId, roots, reason }）。
 *
 * 失败过去是完全静默的：`findRosterDir` 返回 null 就 `return false`，既不写日志、
 * 也不进任何读数。`roster_verify` 只能看到"没挂上"，于是把原因猜成"会话太老"。
 * 这里把真实原因留下来，verify 才有话可讲。
 */
const misses = new Map();

/** 见过的 agent（sessionId → agent）：`agent/created` 早于 `markCaptainCandidate` 时也能补挂。 */
const agents = new Map();

/** 安装时留下的运行时（roots/logger/轮询参数），`markCaptainCandidate` 补挂时用。 */
let runtime = null;

/** 正在等 team.json 的会话：stateDir → { timer, sessions: Map<sessionId, entry> }。 */
const watchers = new Map();

/** 短哈希：交付里只展示 8 位，和 `roster:<id>@<ver>#<sha8>` 的写法一致。 */
function sha8(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 角色库的位置：v2 的档案在 `<root>/rosters/<id>/`，角色在 `<root>/roles/<name>/`。
 * 只有 v2 布局才有角色库；v1 平铺库返回 null。
 */
function rolesRootOf(rosterDir) {
  const parent = nodePath.dirname(rosterDir);
  if (nodePath.basename(parent) !== "rosters") return null;
  const root = nodePath.dirname(parent);
  const roles = nodePath.join(root, "roles");
  return isDir(roles) ? { root, roles } : null;
}

/** 把 `captain.role`（`name@version`）解析成角色目录；不在角色库里就返回 null。 */
function roleDirOf(rosterDir, roleRef) {
  const name = String(roleRef ?? "").replace(/@[^@]*$/, "");
  if (!ID_PATTERN.test(name)) return null;
  const library = rolesRootOf(rosterDir);
  if (library === null) return null;
  const dir = nodePath.join(library.roles, name);
  return isDir(dir) ? { dir, libraryRoot: library.root } : null;
}

/**
 * 从档案目录里读出队长人设的来源。
 *
 * 三种写法，**只读文件本身**，不调用整库扫描——这段代码会在每个模型步上跑：
 *
 * 1. v2 `captain.persona`：档案目录内的人设正文文件；
 * 2. v2 `captain.role`：队长是角色引用时，人设就是那个角色的组装正文
 *    （`roles/<name>/AGENT.md` 的 body + parts + `{{> …}}`）。这不是可选项：
 *    真实样例（`examples/`、用户自己的库）里队长几乎都是角色引用，
 *    只认 `captain.persona` 会让这些档案一条人设都注入不进去；
 * 3. v1 `captain.systemPrompt` / `captain.personaPrefix`：内联正文。
 *
 * @param {string} rosterDir 档案目录
 * @returns {{ kind: "file", path: string } | { kind: "role", dir: string, libraryRoot: string } | { kind: "inline", text: string } | null}
 */
/** 把 captain.prompt 的两个相对路径解析成绝对路径；越界或缺失一律当"没写"。 */
function promptPathsOf(rosterDir, prompt) {
  const out = { prepend: null, append: null };
  if (prompt === null || typeof prompt !== "object") return out;
  for (const key of ["prepend", "append"]) {
    const relative = prompt[key];
    if (typeof relative !== "string" || relative.trim() === "") continue;
    const resolved = nodePath.resolve(rosterDir, relative.trim());
    if (nodePath.relative(rosterDir, resolved).startsWith("..")) continue;
    out[key] = resolved;
  }
  return out;
}

export function personaSourceOf(rosterDir) {
  for (const name of ROSTER_FILES) {
    const file = nodePath.join(rosterDir, name);
    const text = readText(file);
    if (text === null) continue;
    let value;
    try {
      value = name.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
    } catch {
      return null;
    }
    const captain = value?.captain;
    if (captain === null || typeof captain !== "object") return null;
    // 队长与成员共用「两端」语义：prepend / append 相对档案目录，拼在正文外。
    const prompt = promptPathsOf(rosterDir, captain.prompt);
    // v2：`captain.persona` 是人设正文文件的相对路径。
    if (typeof captain.persona === "string" && captain.persona.trim() !== "") {
      const relative = captain.persona.trim();
      const resolved = nodePath.resolve(rosterDir, relative);
      const inside = !nodePath.relative(rosterDir, resolved).startsWith("..");
      return inside ? { kind: "file", path: resolved, ...prompt } : null;
    }
    // v2 角色式队长：人设 = 角色正文（与成员同一套组装规则）。
    if (typeof captain.role === "string" && captain.role.trim() !== "") {
      const found = roleDirOf(rosterDir, captain.role.trim());
      if (found !== null) return { kind: "role", dir: found.dir, libraryRoot: found.libraryRoot, ...prompt };
    }
    // v1：`captain.systemPrompt` / `captain.personaPrefix` 是内联正文。
    for (const key of ["personaPrefix", "systemPrompt"]) {
      if (typeof captain[key] === "string" && captain[key].trim() !== "") {
        return { kind: "inline", text: captain[key].trim(), ...prompt };
      }
    }
    return null;
  }
  return null;
}

/**
 * 读取人设正文。
 *
 * @param {{ kind: "file", path: string } | { kind: "role", dir: string, libraryRoot: string } | { kind: "inline", text: string } | null} source
 * @returns {string} 正文；读不到（或只有空白）时返回 `""`，由调用方决定怎么退化。
 */
export function personaTextOf(source) {
  if (source === null || source === undefined) return "";
  let text;
  if (source.kind === "inline") {
    text = source.text;
  } else if (source.kind === "role") {
    // 角色正文要按同一套拼装规则展开（body + parts + `{{> …}}`），不能让队长和成员
    // 读到两份不同的人设。
    const loaded = loadRoleAt(source.dir, { libraryRoot: source.libraryRoot });
    // `loadRoleAt` 把拼好的正文放在返回值的 `prompt.text` 上（不是 role.prompt）。
    text = loaded.ok === true ? loaded.prompt?.text ?? "" : "";
  } else {
    text = readText(source.path) ?? "";
  }
  // 两端与正文之间用空行分隔，和成员侧 `assemblePrompt` 完全一致。
  const pieces = [];
  if (typeof source.prepend === "string") {
    const head = readText(source.prepend);
    if (head !== null && head.trim() !== "") pieces.push(head.trim());
  }
  if (typeof text === "string" && text.trim() !== "") pieces.push(text.trim());
  if (typeof source.append === "string") {
    const tail = readText(source.append);
    if (tail !== null && tail.trim() !== "") pieces.push(tail.trim());
  }
  const trimmed = pieces.join("\n\n");
  if (trimmed === "") return "";
  return trimmed.length > MAX_PERSONA_CHARS ? trimmed.slice(0, MAX_PERSONA_CHARS) : trimmed;
}

/**
 * 一次解析出人设正文与来源，供 `/apply` 的起始消息使用。
 *
 * 注入层每个模型步都会重读；`/apply` 只读一次，但必须与注入层同源，
 * 否则「起始消息里的人设」和「系统提示词里的人设」可能是两份不同的东西。
 *
 * @param {string} rosterDir
 * @returns {{ text: string, source: object } | null}
 */
export function resolveCaptainPersona(rosterDir) {
  if (typeof rosterDir !== "string" || rosterDir === "") return null;
  const source = personaSourceOf(rosterDir);
  const text = personaTextOf(source);
  return text === "" ? null : { text, source };
}

/**
 * 在档案库里按 id 找档案目录。
 *
 * 兼容两种布局：v2 的 `<root>/rosters/<id>/roster.yaml`，v1 的 `<root>/<id>/roster.yaml`。
 * 只做存在性判断，不解析内容——内容由 `personaSourceOf` 读。
 *
 * @param {{ rootDir: string, exists?: boolean }[]} roots
 * @param {string} id
 * @returns {string | null}
 */
export function findRosterDir(roots, id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  for (const root of Array.isArray(roots) ? roots : []) {
    if (root?.exists === false) continue;
    if (typeof root?.rootDir !== "string" || root.rootDir === "") continue;
    const dirs = [
      nodePath.join(root.rootDir, "rosters", id),
      nodePath.join(root.rootDir, id),
    ];
    for (const dir of dirs) {
      if (ROSTER_FILES.some((name) => fs.existsSync(nodePath.join(dir, name)))) return dir;
    }
  }
  return null;
}

/**
 * 读一个团队的 captain 绑定。
 *
 * @param {string} stateDir AgentTeams 状态目录（已按工作区解析成绝对路径）
 * @param {string} sessionId 会话 id
 * @returns {{ teamId: string, rosterId: string, version: string } | null}
 */
export function captainTeamOf(stateDir, sessionId) {
  if (typeof stateDir !== "string" || stateDir === "" || typeof sessionId !== "string" || sessionId === "") return null;
  let entries;
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const text = readText(nodePath.join(stateDir, entry.name, "team.json"));
    if (text === null) continue;
    let team;
    try {
      team = JSON.parse(text);
    } catch {
      continue;
    }
    if (team?.captainSessionId !== sessionId) continue;
    const provenance = parseProvenanceLine(team.description);
    if (provenance === null) continue;
    return { teamId: entry.name, rosterId: provenance.id, version: provenance.version };
  }
  return null;
}

/**
 * 记下一次"没挂上"的真实原因，并在第一次时写一行 warn。
 *
 * 轮询每秒都会重试，所以只在原因/根变化时告警一次；否则一次失败会刷满日志。
 */
function recordMiss(sessionId, rosterId, roots, reason, logger) {
  const searched = (Array.isArray(roots) ? roots : [])
    .map((root) => (typeof root?.rootDir === "string" ? root.rootDir : ""))
    .filter((dir) => dir !== "");
  const key = `${reason}|${searched.join("\n")}`;
  const previous = misses.get(sessionId);
  misses.set(sessionId, { rosterId, roots: searched, reason });
  if (previous !== undefined && `${previous.reason}|${previous.roots.join("\n")}` === key) return;
  if (reason === "roster-not-found") {
    logger?.warn?.(
      `captain persona not attached: roster "${rosterId}" not found in roots [${searched.join(", ")}] ` +
        `(session ${sessionId}); pass path= to the library that holds it, or add it to rosterDirs`,
    );
  } else if (reason === "persona-empty") {
    logger?.warn?.(`captain persona not attached: roster "${rosterId}" declares no persona text (session ${sessionId})`);
  }
}

/**
 * 一个会话上一次注入失败的真实原因（没有失败就返回 null）。
 *
 * @param {string} sessionId
 * @returns {{ rosterId: string, roots: string[], reason: "roster-not-found" | "persona-empty" } | null}
 */
export function captainMiss(sessionId) {
  const hit = misses.get(sessionId);
  return hit === undefined ? null : { rosterId: hit.rosterId, roots: [...hit.roots], reason: hit.reason };
}

/**
 * 给一个队长会话挂上人设 section。
 *
 * @param {{ id: string, ctx: any }} agent 新建的 agent（`agent.ctx.systemPrompt` 是宿主服务）
 * @param {object} options
 * @param {string} options.stateDir
 * @param {{ rootDir: string, exists?: boolean }[]} options.roots
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @returns {boolean} 是否挂上
 */
function registerPersonaSection(agent, { rosterId, version, persona, source, logger }) {
  const sessionId = typeof agent?.id === "string" ? agent.id : "";
  const systemPrompt = agent?.ctx?.systemPrompt;
  if (sessionId === "" || systemPrompt === undefined || systemPrompt === null) return false;
  if (attached.has(sessionId)) return true;

  let lastGood = persona;
  let dispose;
  try {
    dispose = systemPrompt.section({
      name: CAPTAIN_SECTION,
      order: systemPrompt.getSectionOrder(PERSONA_ORDER_NAME),
      // 每个模型步求值：改档案立即生效；读失败沿用上一次的好值，绝不用空串遮蔽部署 persona。
      text: () => {
        const next = personaTextOf(source);
        if (next !== "") lastGood = next;
        return lastGood;
      },
    });
  } catch (error) {
    logger?.warn?.(`captain persona not attached to ${sessionId}: ${error?.message ?? error}`);
    return false;
  }

  attached.set(sessionId, {
    rosterId,
    version,
    chars: persona.length,
    sha: sha8(persona),
    source: source.kind,
    at: Date.now(),
    dispose,
  });
  logger?.info?.(
    `captain persona attached: session=${sessionId} roster=${rosterId ?? "?"} chars=${persona.length} ` +
      `sha=${sha8(persona)} source=${source.kind}`,
  );
  return true;
}

export function attachCaptainPersona(agent, { stateDir, roots, logger }) {
  const sessionId = typeof agent?.id === "string" ? agent.id : "";
  if (sessionId === "" || attached.has(sessionId)) return attached.has(sessionId);

  const team = captainTeamOf(stateDir, sessionId);
  if (team === null) return false;
  const rosterDir = findRosterDir(roots, team.rosterId);
  if (rosterDir === null) {
    recordMiss(sessionId, team.rosterId, roots, "roster-not-found", logger);
    return false;
  }
  const source = personaSourceOf(rosterDir);
  const persona = personaTextOf(source);
  if (persona === "") {
    recordMiss(sessionId, team.rosterId, roots, "persona-empty", logger);
    return false;
  }
  return registerPersonaSection(agent, { rosterId: team.rosterId, version: team.version, persona, source, logger });
}

/**
 * 把一座档案的队长人设直接挂到一个**已存在**的会话上。
 *
 * 建团之外还有第二种用法：这个会话本身就要按某份档案行事（比如维护者会话）。
 * 与建团无关——宿主没有「给已有会话换人设」的接口，但 section 是按 agent 注册、
 * 每步装配的，所以只要拿到 live agent 就能挂。绑定由调用方记录（谁、哪份档案、何时）。
 */
export function attachRosterToSession(agent, { rosterDir, rosterId = null, version = null, logger = null }) {
  if (typeof agent?.id !== "string" || agent.id === "") return { ok: false, code: "no-session" };
  const source = personaSourceOf(rosterDir);
  if (source === null) return { ok: false, code: "persona-missing" };
  const persona = personaTextOf(source);
  if (persona === "") return { ok: false, code: "persona-empty" };
  const ok = registerPersonaSection(agent, {
    rosterId: rosterId ?? nodePath.basename(rosterDir),
    version,
    persona,
    source,
    logger,
  });
  if (!ok) return { ok: false, code: "attach-failed" };
  return { ok: true, sessionId: agent.id, chars: persona.length, sha: sha8(persona), source: source.kind };
}

export function bindingPath(rootDir, sessionId) {
  return nodePath.join(rootDir, BINDING_DIR, `${sessionId}.json`);
}

export function writeSessionBinding(rootDir, { sessionId, rosterId, version, rosterDir }) {
  if (typeof rootDir !== "string" || rootDir === "") return { ok: false, code: "no-root" };
  if (typeof sessionId !== "string" || sessionId === "") return { ok: false, code: "no-session" };
  if (typeof rosterDir !== "string" || rosterDir === "") return { ok: false, code: "persona-missing" };
  const file = bindingPath(rootDir, sessionId);
  const value = {
    kind: BINDING_KIND,
    sessionId,
    rosterId: typeof rosterId === "string" ? rosterId : "",
    version: typeof version === "string" ? version : "",
    rosterDir,
    boundAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (error) {
    return { ok: false, code: "write-failed", reason: String(error?.message ?? error) };
  }
}

export function readSessionBinding(rootDir, sessionId) {
  if (typeof rootDir !== "string" || rootDir === "" || typeof sessionId !== "string" || sessionId === "") return null;
  try {
    const value = JSON.parse(fs.readFileSync(bindingPath(rootDir, sessionId), "utf8"));
    if (value?.kind !== BINDING_KIND || value?.sessionId !== sessionId) return null;
    if (typeof value?.rosterDir !== "string" || value.rosterDir === "") return null;
    return value;
  } catch {
    return null;
  }
}

/** 在所有已知库里找这个会话的绑定（先根，再根下挂着的空间）。 */
export function findSessionBinding(roots, sessionId) {
  const dirs = [];
  for (const root of Array.isArray(roots) ? roots : []) {
    const rootDir = typeof root === "string" ? root : root?.rootDir;
    if (typeof rootDir !== "string" || rootDir === "" || dirs.includes(rootDir)) continue;
    dirs.push(rootDir);
    for (const nested of nestedSpaceDirs(rootDir)) if (!dirs.includes(nested)) dirs.push(nested);
  }
  for (const dir of dirs) {
    const binding = readSessionBinding(dir, sessionId);
    if (binding !== null) return { rootDir: dir, binding };
  }
  return null;
}

/**
 * 一个候选会话的根：建会话时用的 `path` 优先，再退回配置的 `rosterDirs`。
 *
 * 这就是"按哪个库建队，人设就从哪个库读"——`roster_team({path})` 允许指向任意库，
 * 而注入层过去只认 `rosterDirs`，于是同一个档案"建档按 A、注入按 B"，B 里没有就静默跳过。
 *
 * @param {string} sessionId
 * @param {{ rootDir: string, exists?: boolean }[]} fallback
 * @returns {{ rootDir: string, exists?: boolean }[]}
 */
function candidateRoots(sessionId, fallback) {
  const roots = [];
  const hint = candidates.get(sessionId)?.rosterRoot;
  if (typeof hint === "string" && hint !== "") {
    roots.push({ rootDir: hint });
    // 库根下可能挂着拉取下来的空间（`<root>/<space-id>/`），与 resolveRoots 一样展开一层。
    for (const dir of nestedSpaceDirs(hint)) roots.push({ rootDir: dir });
  }
  for (const root of Array.isArray(fallback) ? fallback : []) {
    if (typeof root?.rootDir === "string" && !roots.some((item) => item.rootDir === root.rootDir)) roots.push(root);
  }
  return roots;
}

/** 登记一个"刚建出来的队长会话"，让注入层知道值得等它的团队落盘。 */
export function markCaptainCandidate(sessionId, { rosterRoot, agent } = {}) {
  if (typeof sessionId !== "string" || sessionId === "") return;
  candidates.set(sessionId, {
    rosterRoot: typeof rosterRoot === "string" && rosterRoot !== "" ? rosterRoot : "",
  });
  // 已有会话也能建团：它不会等下一次 `agent/created`（那个会话早就创建过了），
  // 所以调用方把 live agent 一起传进来，这里直接补挂 / 起轮询。
  if (agent !== undefined && agent !== null && typeof agent.id === "string" && agent.id !== "") {
    agents.set(agent.id, agent);
  }
  // `agent/created` 可能在建会话的调用内部就触发了（那时还没有登记），
  // 所以登记时补一刀：先把已知的 agent 找回来，团队一落盘就挂上。
  const known = agents.get(sessionId);
  if (known !== undefined && runtime !== null) {
    const stateDir = resolveStateDir(runtime.settings.agentTeamsStateDir ?? ".agent-teams", known.session?.header?.cwd);
    const available = candidateRoots(sessionId, runtime.roots());
    if (!attachCaptainPersona(known, { stateDir, roots: available, logger: runtime.logger })) {
      watchForTeam(known, {
        stateDir,
        roots: available,
        logger: runtime.logger,
        intervalMs: runtime.watchIntervalMs,
        timeoutMs: runtime.watchTimeoutMs,
      });
    }
  }
}

/** 这个会话是否被登记过（建团队期间注入层会等它的团队）。 */
export function isCaptainCandidate(sessionId) {
  return candidates.has(sessionId);
}

/** 取消登记（建团队失败、会话销毁、测试）。 */
export function unmarkCaptainCandidate(sessionId) {
  candidates.delete(sessionId);
  misses.delete(sessionId);
}

/**
 * 已嵌入的队长人设。
 *
 * @param {string} sessionId
 * @returns {{ rosterId: string, version: string, chars: number, sha: string, source: string, at: number } | null}
 */
export function attachedCaptain(sessionId) {
  const hit = attached.get(sessionId);
  if (hit === undefined) return null;
  return { rosterId: hit.rosterId, version: hit.version, chars: hit.chars, sha: hit.sha, source: hit.source, at: hit.at };
}

/** 忘掉一个会话（agent 销毁或测试复位）。section 的 disposer 由宿主 effect 回收。 */
export function forgetCaptain(sessionId) {
  const hit = attached.get(sessionId);
  if (hit === undefined) return false;
  hit.dispose?.();
  attached.delete(sessionId);
  misses.delete(sessionId);
  return true;
}

/** 测试与插件卸载用：清空所有记录与轮询。 */
export function resetCaptainInjector() {
  runtime = null;
  agents.clear();
  candidates.clear();
  misses.clear();
  for (const [sessionId] of attached) forgetCaptain(sessionId);
  for (const [stateDir, watcher] of watchers) {
    clearInterval(watcher.timer);
    watchers.delete(stateDir);
  }
}

function stopWatching(stateDir, sessionId) {
  const watcher = watchers.get(stateDir);
  if (watcher === undefined) return;
  watcher.sessions.delete(sessionId);
  if (watcher.sessions.size === 0) {
    clearInterval(watcher.timer);
    watchers.delete(stateDir);
  }
}

/**
 * 等团队落盘。
 *
 * 新会话的时序是「先建会话，队长再调 agent_teams_create」——创建那一刻 team.json 还不存在，
 * 所以不能只看 `agent/created`。这里按工作区起一个短轮询，团队一出现就挂上，
 * 挂上即停；超时后静默放弃（会话仍按开场消息里的那段人设工作，只是不持久）。
 *
 * @param {{ id: string }} agent
 * @param {object} options
 * @param {string} options.stateDir
 * @param {{ rootDir: string, exists?: boolean }[]} options.roots
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 */
function watchForTeam(agent, { stateDir, roots, logger, intervalMs = WATCH_INTERVAL_MS, timeoutMs = WATCH_TIMEOUT_MS }) {
  const sessionId = typeof agent?.id === "string" ? agent.id : "";
  if (sessionId === "") return;
  let watcher = watchers.get(stateDir);
  if (watcher === undefined) {
    const state = { sessions: new Map(), timer: null };
    state.timer = setInterval(() => {
      for (const [id, entry] of state.sessions) {
        // 轮询是旁路：任何一处抛错都不该把宿主带走（真实事故：日志行里的
        // 未定义变量在 timer 里抛 ReferenceError，宿主 fatal）。
        let ok = false;
        try {
          ok = attachCaptainPersona(entry.agent, { stateDir, roots, logger });
        } catch (error) {
          logger?.warn?.(`captain persona watch failed for ${id}: ${error?.message ?? error}`);
        }
        if (ok) {
          state.sessions.delete(id);
        } else if (Date.now() - entry.since > timeoutMs) {
          state.sessions.delete(id);
        }
      }
      if (state.sessions.size === 0) {
        clearInterval(state.timer);
        watchers.delete(stateDir);
      }
    }, intervalMs);
    // 不拽住进程退出：这是尽力而为的旁路，主流程结束就该结束。
    state.timer.unref?.();
    watchers.set(stateDir, state);
    watcher = state;
  }
  if (!watcher.sessions.has(sessionId)) {
    watcher.sessions.set(sessionId, { agent, since: Date.now() });
  }
}

/**
 * 装上会话钩子。
 *
 * @param {{ on: Function }} ctx 插件上下文（根作用域，能收到所有 agent 的事件）
 * @param {object} settings 插件配置视图
 * @param {object} deps
 * @param {() => { rootDir: string, exists?: boolean }[]} deps.roots 档案库根（按当前配置解析）
 * @param {{ info?: Function, warn?: Function }} [deps.logger]
 * @returns {() => void} 卸载
 */
function attachBoundSession(agent, roots, logger) {
  const found = findSessionBinding(roots, agent.id);
  if (found === null) return false;
  const { binding } = found;
  if (!isDir(binding.rosterDir)) {
    recordMiss(agent.id, binding.rosterId, roots, "roster-not-found", logger);
    return false;
  }
  const result = attachRosterToSession(agent, {
    rosterDir: binding.rosterDir,
    rosterId: binding.rosterId,
    version: binding.version,
    logger,
  });
  return result.ok;
}

export function installCaptainInjector(ctx, settings, { roots, logger, watchIntervalMs, watchTimeoutMs } = {}) {
  // 事件是增强能力：最小宿主（或测试桩）没有 `ctx.on` 时静默跳过，不影响工具与路由。
  if (typeof ctx?.on !== "function") return () => {};
  runtime = { settings, roots, logger, watchIntervalMs, watchTimeoutMs };
  const resolveRootsNow = () => (typeof roots === "function" ? roots() : []);

  const onCreate = ({ agent } = {}) => {
    if (typeof agent?.id !== "string" || agent.id === "") return;
    agents.set(agent.id, agent);
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd !== "string" || cwd === "") return;
    const stateDir = resolveStateDir(settings?.agentTeamsStateDir ?? ".agent-teams", cwd);
    // 候选会话优先用它自己的根：agent/created 可能早于 mark，先按配置根试，mark 时会补刀。
    const available = candidateRoots(agent.id, resolveRootsNow());
    if (attachCaptainPersona(agent, { stateDir, roots: available, logger })) return;
    // 没有团队记录时，看它是不是被「应用到会话」绑定过：绑定记录比团队记录更直接。
    if (attachBoundSession(agent, available, logger)) return;
    // 只有本插件刚建出来的队长会话才等团队落盘；子会话不排队。
    if (candidates.has(agent.id)) {
      watchForTeam(agent, { stateDir, roots: available, logger, intervalMs: watchIntervalMs, timeoutMs: watchTimeoutMs });
    }
  };

  const onDisposed = ({ agent } = {}) => {
    const sessionId = typeof agent?.id === "string" ? agent.id : "";
    if (sessionId === "") return;
    forgetCaptain(sessionId);
    candidates.delete(sessionId);
    agents.delete(sessionId);
    for (const [stateDir] of watchers) stopWatching(stateDir, sessionId);
  };

  ctx.on("agent/created", onCreate);
  ctx.on("agent/disposed", onDisposed);

  return () => {
    ctx.off?.("agent/created", onCreate);
    ctx.off?.("agent/disposed", onDisposed);
    resetCaptainInjector();
  };
}
