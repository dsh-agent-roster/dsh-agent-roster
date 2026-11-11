/**
 * @stofone/dsh-agent-roster —— 多 Agent 团队的静态成员档案层。
 *
 * 定位：**定义与校验 + 桥接参数生成 + 可管理它的面板**。本插件不运行团队、不调度任务、
 * 不替代任何团队运行时，也不写别人的状态。它做的事是：
 *
 * 1. 把成员档案（谁、能做什么、用什么模型、受什么工具约束）固化成可校验、可版本化的静态文件；
 * 2. 校验失败时 fail-loud：带文件路径与字段路径报错，不静默降级；
 * 3. 在 dsh-agent-teams 创建成员时，把档案翻译成建员参数，并如实标注每个字段的归宿
 *    （运行时接收 / 仅声明 / 需落部署配置），事后再拿 team.json 的实际值核对；
 * 4. 给用户一个能看到、能编辑、能新建/导入/删除档案，并能查看/核对团队的面板。
 *
 * @module dsh-agent-roster
 */
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import z from "@deepseek-ai/schemastery";

import { configView } from "./lib/config-view.js";
import { forgetLibraryDir, registeredLibraryDirs, rememberLibraryDir } from "./lib/preferences.js";
import { applyCaptain, listHostWorkspaces, listSessions } from "./lib/apply.js";
import { collectLibrary } from "./lib/library.js";
import { scanRosterLibrary } from "./lib/registry.js";
import { addFavorites, readFavorites, setFavorite } from "./lib/favorites.js";
import { acceptLocal, applyFastForward, checkOrigin } from "./lib/origin.js";
import { parseDocumentText } from "./lib/parse.js";
import { ROSTER2_KIND } from "./lib/format-v2.js";
import { validateRoster } from "./lib/validate.js";
import { validateRoster2 } from "./lib/roster2.js";
import { detectTeamTargets, TEAM_TARGET_IDS } from "./lib/team-targets.js";
import { sendError, sendJson, createAuthGate, readJsonBody, requireMethod } from "./lib/http.js";
import { buildPanelSnapshot, installCollection, installSpace, loadRemotePanel, resolveRoots } from "./lib/service.js";
import { listHostModels } from "./lib/host-models.js";
import { createTtlCache, fetchCollection } from "./lib/remote.js";
import { searchRosters } from "./lib/search.js";
import { registerRosterTools } from "./lib/tools.js";
import { installCaptainInjector } from "./lib/captain-inject.js";
import { deleteRosterDocument, findLibraryRoot, readRosterDocument, writeRosterDocument } from "./lib/write.js";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/** Cordis 插件名（出现在宿主日志与设置页）。 */
export const name = "agent-roster";

/** 只依赖工具注册表；档案库与团队状态都是普通文件，不依赖别的插件。 */
export const inject = ["tools"];

/**
 * 插件配置。
 *
 * 全部声明为 volatile：在设置页改完立即生效，不需要重启宿主——
 * 这些值只是"去哪读文件、界面说什么语言"，没有需要重建的生命周期资源。
 */
export const Config = z.object({
  rosterDirs: z
    .array(z.string())
    .default([])
    .description(
      "档案库目录。留空 = 全局默认目录 $DSH_HOME/agent-roster（默认 ~/.dsh/agent-roster，" +
        "docker 下就是被挂载的数据卷），与工作区无关。填绝对路径或 ~ 开头路径同样是全局的；" +
        "只有填相对路径（如 examples）才按工作区解析。第一项是各工具默认读取的档案库。",
    )
    .volatile(),
  knownToolPolicies: z
    .array(z.string())
    .default([])
    .description("部署已声明的 toolPolicy id 列表：填了就能在校验期发现档案里写错的策略 id。留空表示不做交叉校验。")
    .volatile(),
  agentTeamsStateDir: z
    .string()
    .default(".agent-teams")
    .description("dsh-agent-teams 的状态目录（只读，用于核对成员实际字段）。相对路径以工作区为基准。")
    .volatile(),
  captureAutoApply: z
    .boolean()
    .default(false)
    .description(
      "比对运行时团队与档案时，发现可写回的机械字段（provider/model/reasoningEffort/toolPolicy）就直接写回：" +
        "版本号 patch+1、重编译 dist，不再询问。默认 false：工具只报告差异，等一次明确的 apply / capture 参数。",
    )
    .volatile(),
  injectCaptainPersona: z
    .boolean()
    .default(true)
    .description(
      "把档案 captain 段的人设嵌进队长会话的 system prompt（与 dsh-agent-teams 给成员做的是同一件事，" +
        "同名 section 遮蔽部署 persona，每个模型步重读档案）。关掉后队长只拿到起始消息里的那份人设，" +
        "长会话压缩后可能丢失。",
    )
    .volatile(),
  language: z
    .union([z.const("auto"), z.const("zh"), z.const("en")])
    .default("auto")
    .description("面板与设置项的语言：auto 跟随 DSH 当前语言，zh/en 固定中文或英文。")
    .volatile(),
  indexes: z
    .array(z.string())
    .default([])
    .description(
      "公共档案源（registry）列表，可填 https URL 或 npm:pkg。留空 = 只用官方源 " +
        "STofone/dsh-agent-roster 的 index/registry.json。拉取按 TTL 缓存（默认一小时一次），" +
        "网络失败时沿用上次缓存，不会把“没拉到”当成“没有档案”。",
    )
    .volatile(),
  region: z
    .union([z.const("auto"), z.const("global"), z.const("china")])
    .default("auto")
    .description("下载区：china 用腾讯 npm 镜像读 npm 形式的目录包；auto 等同 global（不自动探测，避免额外的出网请求）。")
    .volatile(),
  registryMirror: z
    .string()
    .default("")
    .description(
      "自定义 npm 镜像地址（如 https://registry.npmmirror.com 或公司 Nexus 的 /repository/npm 子路径）：" +
        "填了就优先于下载区的预置，用于按 npm 包形式发布的公共档案源。留空 = 用下载区的预置。",
    )
    .volatile(),
});

/**
 * 挂载插件。
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {object} config
 * @returns {void}
 */
// 宿主把 AgentRegistry 注册成 "agents"（dsh-agent 的 Service 名）；旧宿主没有它时退回 agentRegistry。
function agentRegistryOf(ctx) {
  return ctx.get?.("agents") ?? ctx.get?.("agentRegistry");
}

export function apply(ctx, config) {
  // volatile 字段在运行时是引用对象，必须走视图按当前值读，见 lib/config-view.js。
  const settings = configView(config);

  registerRosterTools(ctx, settings, { version: pkg.version });
  ctx.logger?.info?.(`dsh-agent-roster ${pkg.version}: registered 13 tools`);

  // 队长人设的会话级嵌入：与成员侧同构，补上 agent-teams 结构上不管的那一半。
  // 失败只记日志、绝不阻断会话创建——注入是增强，不是建会话的前置条件。
  const stopInjector = installCaptainInjector(ctx, settings, {
    roots: () => resolveRoots(ctx, settings, { registeredLibraryDirs: registeredLibraryDirs() }),
    logger: ctx.logger,
  });
  ctx.effect?.(() => stopInjector, "dsh-agent-roster: captain persona injector");

  // 面板路由：读快照 / 读单份档案原文 / 保存 / 删除 / 导入。
  // 没有 webServer 也不影响工具可用性。
  ctx.inject(["webServer", "connection"], (webCtx) => {
    const guard = createAuthGate(webCtx);
    const register = (path, handler, label) =>
      webCtx.effect(() => webCtx.webServer.register({ kind: "exact", path, handler }), `dsh-agent-roster: ${label}`);

    register(
      "/plugins/dsh-agent-roster/library",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "GET")) return;
        const snapshot = buildPanelSnapshot(ctx, settings, { name: pkg.name, version: pkg.version }, { registeredLibraryDirs: registeredLibraryDirs() });
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        // 远程源是“附属信息”：拉不到也不能让本地档案库的响应失败，所以失败只体现在 remote.diagnostics 里。
        const remote = await loadRemotePanel(settings, { refresh: query.get("refresh") === "1" });
        // 会话列表也是“附属信息”：没有 sessionController（或它报错）时面板仍要能用。
        const sessions = await listSessions(ctx.get?.("sessionController"));
        // 新建团队会话要选"空间"：这是宿主的工作区注册表，不是档案空间（space.yaml）。
        const hostWorkspaces = listHostWorkspaces(ctx.get?.("workspaceRegistry"));
        // 团队引擎：下拉菜单要知道"这台机器上装了哪些建团插件"，而不是静默失败。
        const hostTeamTargets = detectTeamTargets();
        // 模型目录也是"附属信息"：读不到就返回空数组，界面显示"读不到"，不要编。
        const hostModels = await listHostModels(ctx.get?.("llm"));
        sendJson(res, 200, { ...snapshot, remote, sessions, hostWorkspaces, hostTeamTargets, hostModels });
      },
      "library route",
    );

    // 同一份 collection 一分钟内被展开两次，第二次不该再打一轮请求。
    // 缓存的是**已校验的结果**，不是响应体，所以不存在"把非法内容缓存下来"的问题。
    const collectionCache = createTtlCache({ ttlMs: 60_000 });

    register(
      "/plugins/dsh-agent-roster/collection",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "GET")) return;
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        const id = query.get("id") ?? "";
        const source = query.get("source") ?? "";
        const remote = await loadRemotePanel(settings, { refresh: query.get("refresh") === "1" });
        const collection = remote.collections.find(
          (item) => item.id === id && (source === "" || item.origin?.source === source),
        );
        if (collection === undefined) {
          sendJson(res, 404, { ok: false, error: { code: "collection-not-found" }, known: remote.collections.map((item) => item.id) });
          return;
        }
        const cacheKey = `${source}::${id}`;
        const cached = query.get("refresh") === "1" ? null : collectionCache.get(cacheKey);
        const fetched = cached ?? collectionCache.set(cacheKey, await fetchCollection(collection));
        sendJson(res, 200, {
          ok: fetched.diagnostics.every((item) => item.severity !== "error"),
          collection: {
            id: collection.id,
            title: collection.title,
            description: collection.description,
            repo: collection.repo,
            ref: collection.ref,
            path: collection.path,
            rosters: collection.rosters,
            license: collection.license,
            homepage: collection.homepage,
            origin: collection.origin,
          },
          rosters: fetched.rosters,
          diagnostics: fetched.diagnostics,
        });
      },
      "collection route",
    );

    // 「档案库」与「搜索」共用同一次摊平动作：本机 + 所有订阅来源。
    // 两条路由各写一遍，缓存口径、并发上限与诊断文案迟早会分叉。
    const gatherEntries = async ({ refresh = false } = {}) => {
      // 自动登记的库根也要进档案库，否则"面板档案页有、档案库没有"——两处口径必须同一份。
      const library = collectLibrary(ctx, settings, { name: pkg.name, version: pkg.version }, {
        registeredLibraryDirs: registeredLibraryDirs(),
      });
      const entries = [];
      let localCount = 0;
      // 远端条目也要知道自己"是不是已经在本机、有没有被收藏"，否则档案库只能显示一半事实。
      const localById = new Map();
      for (const workspace of library.workspaces) {
        const favorites = readFavorites(workspace.rootDir).ids;
        for (const roster of workspace.rosters) {
          const entry = {
            scope: "local",
            roster,
            libraryId: workspace.rootDir ?? null,
            rootDir: workspace.rootDir,
            file: roster.file ?? null,
            favorite: favorites.has(roster.id),
          };
          entries.push(entry);
          if (!localById.has(roster.id)) localById.set(roster.id, entry);
          localCount += 1;
        }
      }

      const diagnostics = [];
      const collections = [];
      try {
        const remote = await loadRemotePanel(settings, { refresh });
        for (const item of remote.diagnostics ?? []) if (item.severity !== "info") diagnostics.push(item);
        for (const collection of remote.collections ?? []) collections.push(collection);
      } catch (error) {
        diagnostics.push({
          severity: "warn",
          code: "index-unavailable",
          message: `订阅索引拉不到，这次只显示本机档案：${error instanceof Error ? error.message : String(error)}`,
        });
      }

      // 来源两两并发：一个慢集合不该把所有来源都拖住，也不该一次打三十个请求。
      const sourceConcurrency = 2;
      let cursor = 0;
      const fetchNext = async () => {
        while (cursor < collections.length) {
          const collection = collections[cursor];
          cursor += 1;
          const key = `${collection.source ?? ""}::${collection.id}`;
          try {
            const cached = collectionCache.get(key);
            const fetched = cached ?? collectionCache.set(key, await fetchCollection(collection));
            for (const roster of fetched.rosters ?? []) {
              entries.push({
                scope: "remote",
                roster,
                collectionId: collection.id,
                collectionTitle: collection.title ?? null,
                file: roster.file ?? null,
                local: localById.get(roster.id) ?? null,
              });
            }
            for (const item of fetched.diagnostics ?? []) if (item.severity === "error") diagnostics.push(item);
          } catch (error) {
            diagnostics.push({
              severity: "warn",
              code: "source-failed",
              message: `${collection.id} 拉取失败：${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(sourceConcurrency, collections.length) }, fetchNext));

      return { entries, diagnostics: diagnostics.slice(0, 20), counts: { local: localCount, remote: entries.length - localCount } };
    };

    const catalogEntry = (entry) => {
      const roster = entry.roster;
      return {
        scope: entry.scope,
        rosterId: typeof roster.id === "string" ? roster.id : "",
        title: typeof roster.title === "string" ? roster.title : "",
        description: typeof roster.description === "string" ? roster.description : "",
        tags: Array.isArray(roster.tags) ? roster.tags : [],
        members: Array.isArray(roster.members) ? roster.members.length : 0,
        memberRoles: (Array.isArray(roster.members) ? roster.members : [])
          .map((member) => (typeof member?.role === "string" ? member.role : ""))
          .filter((role) => role !== "")
          .slice(0, 4),
        libraryId: entry.libraryId ?? null,
        collectionId: entry.collectionId ?? null,
        collectionTitle: entry.collectionTitle ?? null,
        file: entry.file ?? null,
        // 收藏写在哪座库、收藏状态是什么：远端条目借用本机同名档案的那份收藏。
        rootDir: entry.rootDir ?? entry.local?.rootDir ?? null,
        favorite: entry.favorite === true || entry.local?.favorite === true,
        installed: entry.scope === "local" || entry.local !== null,
      };
    };

    // 档案库：像插件市场那样「全部摊开」，供浏览、按标签筛选、按来源聚合。
    register(
      "/plugins/dsh-agent-roster/catalog",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "GET")) return;
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        const gathered = await gatherEntries({ refresh: query.get("refresh") === "1" });
        sendJson(res, 200, {
          ok: true,
          entries: gathered.entries.map(catalogEntry),
          counts: gathered.counts,
          diagnostics: gathered.diagnostics,
        });
      },
      "catalog route",
    );

    // 搜索：同一个「摊平」结果上做排序，回车即可打开。空查询不做无谓的摊平。
    register(
      "/plugins/dsh-agent-roster/search",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "GET")) return;
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        const q = (query.get("q") ?? "").trim();
        if (q === "") {
          sendJson(res, 200, { ok: true, q: "", tokens: [], total: 0, matches: [], counts: { local: 0, remote: 0 }, diagnostics: [] });
          return;
        }
        const gathered = await gatherEntries();
        const result = searchRosters(q, gathered.entries);
        sendJson(res, 200, { ...result, counts: gathered.counts, diagnostics: gathered.diagnostics });
      },
      "search route",
    );

    register(
      "/plugins/dsh-agent-roster/locale",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "GET")) return;
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        const lang = query.get("lang") === "zh" ? "zh" : "en";
        try {
          const text = readFileSync(new URL(`./locale/${lang}.json`, import.meta.url), "utf8");
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(text);
        } catch {
          sendError(res, 500, "locale-unavailable");
        }
      },
      "locale route",
    );

    register(
      "/plugins/dsh-agent-roster/document",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "GET")) return;
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        const result = readRosterDocument({
          roots: resolveRoots(ctx, settings, { registeredLibraryDirs: registeredLibraryDirs() }),
          rootDir: query.get("rootDir") ?? "",
          id: query.get("id") ?? "",
        });
        if (!result.ok) {
          sendError(res, result.code === "not-found" ? 404 : 400, result.code);
          return;
        }
        // 编辑表单需要人设原文：解析一份给编辑器用，解析失败也不挡"看源码"这条路。
        const parsed = parseDocumentText(result.text, { file: result.file, format: result.format });
        const isV2 = parsed.ok && parsed.value?.kind === ROSTER2_KIND;
        const validated = parsed.ok
          ? isV2
            ? validateRoster2(parsed.value, { file: result.file })
            : validateRoster(parsed.value, { file: result.file })
          : null;
        sendJson(res, 200, {
          ok: true,
          file: result.file,
          format: result.format,
          text: result.text,
          roster: validated?.ok ? validated.roster : null,
        });
      },
      "document route",
    );

    register(
      "/plugins/dsh-agent-roster/install",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendError(res, body.status, body.code);
          return;
        }
        const input = body.value !== null && typeof body.value === "object" ? body.value : {};
        if (typeof input.collection !== "string" || input.collection === "") {
          sendError(res, 400, "missing-collection");
          return;
        }
        const result = await installCollection(settings, {
          collectionId: input.collection,
          source: typeof input.source === "string" && input.source !== "" ? input.source : undefined,
          overwrite: input.overwrite === true,
        });
        if (result.ok !== true && result.code !== undefined) {
          sendJson(res, result.code === "collection-not-found" ? 404 : 400, {
            ok: false,
            error: { code: result.code },
            known: result.known ?? [],
            diagnostics: result.diagnostics ?? [],
          });
          return;
        }
        sendJson(res, 200, result);
      },
      "install route",
    );

    register(
      "/plugins/dsh-agent-roster/install-space",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendError(res, body.status, body.code);
          return;
        }
        const input = body.value !== null && typeof body.value === "object" ? body.value : {};
        if (typeof input.collection !== "string" || input.collection === "") {
          sendError(res, 400, "missing-collection");
          return;
        }
        const result = await installSpace(settings, {
          collectionId: input.collection,
          source: typeof input.source === "string" && input.source !== "" ? input.source : undefined,
          spaceId: typeof input.space === "string" && input.space !== "" ? input.space : undefined,
        });
        if (result.code === "collection-not-found") {
          sendJson(res, 404, { ok: false, error: { code: result.code }, known: result.known ?? [], diagnostics: result.diagnostics ?? [] });
          return;
        }
        sendJson(res, 200, result);
      },
      "install-space route",
    );

    // 收藏：档案行上的星标与档案库里的星标都打到这里。
    // 只写库根下的点文件，不碰档案本体，也不碰团队状态——取消收藏不该改动任何定义。
    register(
      "/plugins/dsh-agent-roster/library-registry",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendError(res, body.status, body.code);
          return;
        }
        const input = body.value !== null && typeof body.value === "object" ? body.value : {};
        const dir = typeof input.dir === "string" ? input.dir : "";
        if (dir === "") {
          sendError(res, 400, "missing-dir");
          return;
        }
        if (input.action === "add") {
          const result = rememberLibraryDir(dir);
          if (!result.ok) {
            sendError(res, result.code === "invalid-dir" ? 400 : 500, result.code);
            return;
          }
          sendJson(res, 200, { ok: true, dirs: registeredLibraryDirs() });
          return;
        }
        if (input.action === "forget") {
          // forgetLibraryDir 返回 boolean（true = 已不在表里或写成功），不是 result 对象。
          if (forgetLibraryDir(dir) !== true) {
            sendError(res, 500, "write-failed");
            return;
          }
          sendJson(res, 200, { ok: true, dirs: registeredLibraryDirs() });
          return;
        }
        sendError(res, 400, "unknown-action");
      },
      "library registry route",
    );

    register(
      "/plugins/dsh-agent-roster/favorites",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendError(res, body.status, body.code);
          return;
        }
        const input = body.value !== null && typeof body.value === "object" ? body.value : {};
        const roots = resolveRoots(ctx, settings, { registeredLibraryDirs: registeredLibraryDirs() });
        const root = findLibraryRoot(roots, typeof input.rootDir === "string" ? input.rootDir : "");
        if (root === null) {
          sendError(res, 403, "unknown-root");
          return;
        }
        const result = setFavorite(root.rootDir, typeof input.id === "string" ? input.id : "", input.favorite === true);
        if (!result.ok) {
          sendError(res, result.code === "invalid-id" ? 400 : 500, result.code);
          return;
        }
        sendJson(res, 200, { ok: true, favorites: result.favorites });
      },
      "favorites route",
    );

    register(
      "/plugins/dsh-agent-roster/apply",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendError(res, body.status, body.code);
          return;
        }
        const input = body.value !== null && typeof body.value === "object" ? body.value : {};
        // 团队引擎是闭集：未知 id 直接 400，不猜一个替代去建团。
        const target = typeof input.target === "string" ? input.target : "";
        if (target !== "" && !TEAM_TARGET_IDS.includes(target)) {
          sendError(res, 400, "unknown-target");
          return;
        }
        const rosterId = typeof input.rosterId === "string" ? input.rosterId : "";
        if (rosterId === "") {
          sendError(res, 400, "missing-roster");
          return;
        }
        // 只允许对“档案库里真实存在且校验通过”的档案动手：输入不构造路径，也不走缓存。
        const library = collectLibrary(ctx, settings, { name: pkg.name, version: pkg.version });
        // 库里的 roster 不带 rootDir（它属于 workspace），这里补上——否则按库消歧永远不命中。
        const rosters = library.workspaces.flatMap((workspace) =>
          workspace.rosters.map((roster) => ({ ...roster, rootDir: workspace.rootDir })),
        );
        // 同一 id 可能同时存在于多座库；面板知道自己在看哪一座（rootDir），按它消歧，
        // 拿不到才退回"第一个同名"——不猜用户指的是哪一份。
        const wantedRoot = typeof input.rootDir === "string" ? input.rootDir : "";
        const roster =
          (wantedRoot === "" ? undefined : rosters.find((item) => item.id === rosterId && item.rootDir === wantedRoot)) ??
          rosters.find((item) => item.id === rosterId);
        if (roster === undefined) {
          sendJson(res, 404, { ok: false, error: { code: "roster-not-found" }, known: rosters.map((item) => item.id) });
          return;
        }
        // 面板快照里的 roster 是给界面用的（不含 captain 正文与 route）；应用队长要用磁盘上
        // 那一份，否则角色式队长的 route/persona 会在这一跳被丢掉——那正是「发了档案却没生效」。
        const scanned = scanRosterLibrary({
          rootDir: roster.rootDir,
          knownToolPolicies: settings.knownToolPolicies ?? null,
        });
        const raw = scanned.rosters.find((item) => item.id === rosterId) ?? roster;
        const rosterDir =
          typeof raw.file === "string" && raw.file !== ""
            ? nodePath.join(roster.rootDir, nodePath.dirname(raw.file))
            : "";
        const result = await applyCaptain({
          sessionController: ctx.get?.("sessionController"),
          roster: { ...raw, rootDir: roster.rootDir },
          rosterDir,
          libraryRoot: roster.rootDir,
          mode: input.mode === "new" ? "new" : "existing",
          sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
          cwd: typeof input.cwd === "string" ? input.cwd : "",
          // 新会话落在哪个空间（工作区）与叫什么名字；两者都只用于建会话，不写团队状态。
          workspaceId: typeof input.workspaceId === "string" ? input.workspaceId : "",
          // 只给了目录时也把会话登记进对应工作区（否则界面上看不到它落在那）。
          workspaceRegistry: ctx.get?.("workspaceRegistry"),
          // 已有会话建团时不会再触发 agent/created：把 live agent 一起交给注入层。
          agentRegistry: agentRegistryOf(ctx),
          sessionTitle: typeof input.sessionTitle === "string" ? input.sessionTitle.trim().slice(0, 120) : "",
          // 团队名只进提示词，不写任何团队状态；超长按 120 截断，与档案标题同量级。
          teamName: typeof input.teamName === "string" ? input.teamName.trim().slice(0, 120) : "",
          // 引擎只影响提示词（怎么建团队），不影响会话/模型/团队状态。
          target,
          // 队长模型可以被面板覆盖：档案写的是作者那台部署的 provider/model，
          // 换机器后可能不存在；覆盖项来自 /library 的 hostModels。
          model: input.model && typeof input.model === "object"
            ? {
                provider: typeof input.model.provider === "string" ? input.model.provider : "",
                model: typeof input.model.model === "string" ? input.model.model : "",
                reasoningEffort:
                  typeof input.model.reasoningEffort === "string" ? input.model.reasoningEffort : "",
              }
            : null,
        });
        // 用过的库根自动登记：工具/面板建的库不在配置根下面，不登记就永远看不见。
        if (result.ok) rememberLibraryDir(roster.rootDir);
        // 从档案建团即收藏：档案页默认只看收藏，工具用过的档案理应出现在那里。
        if (result.ok) addFavorites(roster.rootDir, [roster.id]);
        const status = result.ok ? 200 : result.code === "session-controller-unavailable" ? 503 : 400;
        sendJson(res, status, result);
      },
      "apply route",
    );

    // 更新检查：账本在空间根目录；冲突不自动合并，只把两边摘要摆出来。
    register(
      "/plugins/dsh-agent-roster/space-update",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendError(res, body.status, body.code);
          return;
        }
        const input = body.value !== null && typeof body.value === "object" ? body.value : {};
        const rootDir = findLibraryRoot(resolveRoots(ctx, settings, { registeredLibraryDirs: registeredLibraryDirs() }), input.rootDir);
        if (rootDir === null) {
          sendError(res, 403, "unknown-root");
          return;
        }
        const action = input.action === "apply" || input.action === "accept" ? input.action : "check";
        const checked = await checkOrigin(rootDir.rootDir, {
          fetchImpl: typeof globalThis.fetch === "function" ? globalThis.fetch : null,
          refresh: true,
        });
        if (!checked.ok) {
          sendJson(res, 200, { ok: false, code: checked.code ?? "check-failed", text: checked.text ?? "" });
          return;
        }
        const entries = checked.entries.map((entry) => ({
          path: entry.path,
          state: entry.state,
          local: entry.local,
          remote: entry.remote,
        }));
        if (action === "check") {
          sendJson(res, 200, {
            ok: true,
            origin: checked.origin,
            commit: checked.commit,
            entries,
            summary: checked.summary,
            pending: checked.pending,
            fastForward: checked.fastForward,
            unverified: checked.unverified,
          });
          return;
        }
        if (action === "accept") {
          const paths = Array.isArray(input.paths) ? input.paths.filter((item) => typeof item === "string") : [];
          const accepted = acceptLocal(rootDir.rootDir, paths);
          sendJson(res, 200, { ok: accepted.ok, accepted: accepted.updated });
          return;
        }
        const applied = applyFastForward(rootDir.rootDir, checked.entries);
        sendJson(res, 200, { ok: applied.ok, applied: applied.applied, skipped: applied.skipped });
      },
      "space update route",
    );

    register(
      "/plugins/dsh-agent-roster/rosters",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendError(res, body.status, body.code);
          return;
        }
        const input = body.value !== null && typeof body.value === "object" ? body.value : {};
        const roots = resolveRoots(ctx, settings, { registeredLibraryDirs: registeredLibraryDirs() });

        if (input.action === "delete") {
          const result = deleteRosterDocument({ roots, rootDir: input.rootDir, id: input.id });
          if (!result.ok) {
            sendError(res, result.code === "not-found" ? 404 : 400, result.code);
            return;
          }
          setFavorite(input.rootDir, String(input.id ?? ""), false);
          sendJson(res, 200, { ok: true, removed: result.removed });
          return;
        }

        if (input.action !== "save" && input.action !== "import") {
          sendError(res, 400, "unknown-action");
          return;
        }

        const result = writeRosterDocument({
          roots,
          rootDir: input.rootDir,
          text: input.text,
          format: input.format,
          // import 语义上就是"往库里放一份"，默认允许覆盖同名档案；save 必须由用户确认。
          overwrite: input.action === "import" ? input.overwrite !== false : input.overwrite === true,
          knownToolPolicies: settings.knownToolPolicies,
        });
        if (!result.ok) {
          const status =
            result.code === "exists" || result.code === "format-conflict" ? 409 : result.code === "unknown-root" ? 403 : 422;
          sendJson(res, status, {
            ok: false,
            error: { code: result.code },
            existing: result.existing ?? null,
            diagnostics: result.diagnostics ?? [],
          });
          return;
        }
        // 你动手保存/导入过的档案，默认就是你想看的：否则它一存就从「档案」页里消失。
        const favorited = addFavorites(typeof input.rootDir === "string" ? input.rootDir : "", [result.roster?.id ?? ""]);
        if (!favorited.ok) {
          // 收藏写不进去不该让保存失败：档案已经落盘，这里只降级成不收藏。
          result.favoriteFailed = favorited.code;
        }
        sendJson(res, 200, result);
      },
      "rosters route",
    );
  });
}

// 面板快照逻辑在 lib/library.js 与 lib/service.js：纯数据投影，可脱离宿主单测。
export { collectLibrary, markDuplicateIds, serializeRoster } from "./lib/library.js";
export { buildPanelSnapshot } from "./lib/service.js";
