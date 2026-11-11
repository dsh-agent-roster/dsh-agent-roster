/**
 * 浏览器半边契约测试。
 *
 * `client.js` 是给模块加载器用的：它调用 `window.__ModuleLoader__.load({id, factory})`，
 * factory 拿到一个 `require` 再返回 `{ inject, apply }`。这里用一个最小加载器把它跑一遍，
 * 断言四件事——模块能加载、`apply()` 在宿主服务缺失时也不抛、三个槽位都登记了、
 * 面板与设置节的身份证对得上。它证明不了"像素长什么样"，但能挡住改坏入口、
 * 改错槽位名、两处 id 不一致、`apply` 里抛异常这类真故障。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** React 的最小替身：只够 factory 加载期用（组件函数此时不会被调用）。 */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  Fragment: "Fragment",
};

/**
 * 用最小替身跑一遍 client.js。
 *
 * @param {{ services?: Record<string, unknown> }} [options]
 * @returns {Promise<{ module: object, registrations: object[], slots: string[], disposers: Function[] }>}
 */
async function loadClient(options = {}) {
  const captured = { spec: null };
  const previousWindow = globalThis.window;
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        captured.spec = spec;
      },
    },
  };

  try {
    await import(`../client.js?probe=${Date.now()}`);
  } finally {
    globalThis.window = previousWindow;
  }

  assert.ok(captured.spec !== null, "client.js 必须调用 window.__ModuleLoader__.load");
  const module = captured.spec.factory((id) => {
    assert.equal(id, "react", "factory 只应 require('react')");
    return ReactStub;
  });

  const registrations = [];
  const slots = [];
  const disposers = [];
  const services = options.services ?? {};
  const ctx = {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
    },
    get(name) {
      return services[name];
    },
    slots: {
      inject(name, fn) {
        slots.push(name);
        return fn();
      },
      register(meta, component) {
        registrations.push({ meta, component });
        return () => {};
      },
    },
  };

  module.apply(ctx);
  return { module, registrations, slots, disposers };
}

test("档案行不会把标题挤成一条缝：统计另起一行", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf(".rstr-row-body {"), source.indexOf(".rstr-row-body {") + 700);
  // 1.27.0 的线上事故：统计列是 nowrap，grid 把标题列压到 1px。
  assert.match(body, /grid-template-areas:/);
  assert.match(body, /"id text actions"\s+"id stats actions"/);
  assert.match(source, /\.rstr-row-body > \.rstr-row-stats \{ grid-area: stats; justify-self: start; white-space: normal; flex-wrap: wrap; \}/);
});

test("档案页分组 memo 在 Panel 作用域里，且位于 filtered 之后", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const filtered = source.indexOf("const filtered = useMemo(() => {\n        const needle = query.trim().toLowerCase();");
  const groups = source.indexOf("const rosterGroups = useMemo(");
  assert.notEqual(filtered, -1);
  assert.notEqual(groups, -1);
  // 放进 CatalogTab 会让 Panel 渲染时抛 ReferenceError（1.27.0 的线上事故：面板整块黑）。
  assert.ok(groups > filtered, "rosterGroups 必须定义在 Panel 的 filtered 之后");
  assert.ok(source.indexOf("rosterGroups.map(") > groups);
  // 同一个事故的第二个漏点：渲染函数也必须落在 Panel 里，CatalogTab 里定义会让 Panel 抛 renderRoster is not defined。
  const panel = source.indexOf("    function Panel() {");
  const render = source.indexOf("      function renderRoster(roster) {");
  assert.ok(panel !== -1 && render > panel, "renderRoster 必须定义在 Panel 里");
  assert.ok(source.indexOf("renderRoster(roster)") > render);
});

test("模块 id 是包名，只注入 slots", async () => {
  const { module } = await loadClient();
  assert.deepEqual(module.inject, ["slots"], "语言与配置表单是可选服务，用 ctx.get 探测，不写进 inject");
});

test("apply 在 locale / configForms 缺失时不抛，槽位仍全部登记", async () => {
  const { registrations, slots } = await loadClient();
  assert.deepEqual(slots.slice().sort(), ["main", "sidebar.panellist"]);
  assert.equal(registrations.length, 2);
});

test("main 槽用键控登记，key 是面板 id", async () => {
  const { registrations } = await loadClient();
  const main = registrations.find(({ meta }) => meta.name === "main");
  assert.ok(main, "缺少 main 槽登记");
  assert.equal(main.meta.key, "agent-roster");
  assert.equal(main.meta.locale, "agent-roster");
  assert.equal(main.meta.id, undefined, "keyed 槽用 key 而不是 id");
  assert.equal(typeof main.component, "function");
});

test("sidebar.panellist 的 id 与 main 的 key 是同一个面板身份", async () => {
  const { registrations } = await loadClient();
  const main = registrations.find(({ meta }) => meta.name === "main");
  const entry = registrations.find(({ meta }) => meta.name === "sidebar.panellist");
  assert.ok(entry, "缺少 sidebar.panellist 登记");
  assert.equal(entry.meta.id, main.meta.key, "两处身份不一致时点击图标切不到面板");
  assert.equal(typeof entry.meta.order, "number");
  assert.equal(typeof entry.meta.label, "function");
  assert.equal(typeof entry.component, "function");
});

test("设置只在面板里：不再注册 DSH 设置页的 settings.section", async () => {
  const { registrations } = await loadClient();
  // 同一个设置表单不该出现在两处：面板的齿轮弹窗就是唯一入口。
  assert.equal(registrations.some(({ meta }) => meta.name === "settings.section"), false);
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /settings\.section/);
  // 设置控件本身仍在（语言/区域/档案目录），只是挂到面板弹窗里。
  assert.match(source, /function SettingsSection\(/);
  assert.match(source, /t\("settings\.language"\)/);
});

test("label() 走词典而不是硬编码文案", async () => {
  const { registrations } = await loadClient();
  const entry = registrations.find(({ meta }) => meta.name === "sidebar.panellist");
  const label = entry.meta.label();
  assert.equal(typeof label, "string");
  assert.equal(label.includes("Agent Roster") || label.includes("档案") || label.includes("settings.nav"), true);
});

test("有 locale / configForms 时 apply 会订阅并释放", async () => {
  const unsubscribed = [];
  const services = {
    locale: {
      getLocale: () => "zh-CN",
      subscribe: (fn) => {
        const off = () => unsubscribed.push("locale");
        return off;
      },
    },
    configForms: {
      get: () => ({
        getSnapshot: () => ({ value: { language: "zh" } }),
        subscribe: () => () => unsubscribed.push("form"),
      }),
    },
  };
  const { disposers } = await loadClient({ services });
  assert.equal(disposers.length >= 1, true);
  for (const dispose of disposers) dispose();
  assert.equal(unsubscribed.includes("locale"), true);
  assert.equal(unsubscribed.includes("form"), true);
});

test("面板样式只用宿主语义 token（不写死颜色）", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const css = source.match(/const CSS = `([\s\S]*?)`;/)[1];

  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hex, [], "CSS 里写了硬编码颜色；暗色主题下会白底白字，请改用 --dsw-alias-*");

  for (const match of css.matchAll(/var\((--[a-z0-9-]+)/g)) {
    assert.match(match[1], /^--dsw-alias-/, `只用语义层 token（静态色板随主题变）：${match[1]}`);
  }
});

test("长内容只由面板根滚动：账本与两级展开区都不许自建小滚动盒", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const css = source.match(/const CSS = `([\s\S]*?)`;/)[1];
  /** 取一条 CSS 规则的声明体（规则体可能跨多行，按花括号配平读取）。 */
  const ruleOf = (selector) => {
    const lines = css.split("\n");
    const at = lines.findIndex((item) => item.startsWith(`${selector} {`) || item.startsWith(`${selector}{`));
    assert.ok(at >= 0, `缺少 ${selector} 规则`);
    const body = [];
    let depth = 0;
    for (let index = at; index < lines.length; index += 1) {
      const line = lines[index];
      const opens = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;
      const text = index === at ? line.slice(line.indexOf("{") + 1) : line;
      if (text.trim() !== "") body.push(text);
      depth += opens - closes;
      if (depth <= 0) break;
    }
    return body.join("\n").replace(/\}\s*$/, "");
  };

  const page = ruleOf(".rstr-page");
  assert.match(page, /height:\s*100%/, "面板根要占满高度：宿主 centerCol 是 overflow:hidden，不会替我们滚");
  assert.match(page, /overflow-y:\s*auto/, "面板根必须自己滚动，否则下半截内容直接看不见");

  // 列表是单列账本：一份档案一行。多列卡片网格在窄面板里会被横向裁掉，
  // 而且 21 份档案就是 21 张同样大小的卡片——扫不动。
  const list = ruleOf(".rstr-cards");
  assert.match(list, /display:\s*flex/, "档案列表必须是单列账本，不再是卡片网格");
  assert.match(list, /flex-direction:\s*column/, "列表要竖着排，一行一份档案");

  const body = ruleOf(".rstr-row-body");
  assert.match(body, /minmax\(0,\s*1fr\)/, "行内文字列必须能被压缩，否则窄面板里会把右侧状态挤出去");
  const row = ruleOf(".rstr-row");
  assert.match(row, /min-width:\s*0/, "行自己也要允许收缩");

  // 展开区不是一个独立的小滚动盒：曾经给它 max-height:320px + overflow-y:auto，
  // 21 份档案的集合被关进 320px 的盒子里，用户看到的就是"展开后显示不全"。
  // 现在只有 .rstr-page 一个滚动容器，展开区只负责把高度撑开。
  const rowDetail = ruleOf(".rstr-row-detail");
  assert.doesNotMatch(rowDetail, /max-height:/, "成员展开区同样不能有高度上限");
  assert.doesNotMatch(rowDetail, /overflow/, "成员展开区同样不该自己滚");

  // 档案源页签已删除：用户的原话是「没啥用」。订阅仍然生效，档案库照样按来源分组，
  // 少的是那一页「订阅管理」——它能做的事，档案库的空间头已经做了。
  assert.doesNotMatch(source, /function SourcesTab\(/, "档案源页签应当整块删掉，而不是隐藏");
  assert.doesNotMatch(source, /t\("panel\.tabsSources"\)/, "页签表里不能再有档案源");
  assert.doesNotMatch(source, /className: "rstr-card(-|")/, "不许再用已无样式的 rstr-card 类名");

  // 空库 / 空团队时页签里只剩一句空状态。它原来直接挂在页面根下（页面 padding 为 0），
  // 于是「还没有档案」四个字贴着窗口左上角——列表有留白、空状态没有，看着就是没做完。
  const emptyWrap = ruleOf(".rstr-empty-wrap");
  assert.match(emptyWrap, /padding:\s*16px 28px/, "空状态要占与列表同一块版心");
  assert.ok(
    (source.match(/className: "rstr-empty-wrap"/g) ?? []).length >= 2,
    "空档案与空团队两处都要包进版心，不能只包一处",
  );

  // 删掉一页，不该把样式留成孤儿。
  const styleText = source.match(/const CSS = `([\s\S]*?)`;/)[1];
  assert.ok(!styleText.includes(".rstr-sources"), "档案源的样式要跟着页签一起删");
  assert.ok(!styleText.includes(".rstr-source-detail"), "档案源展开清单的样式也要删");
});

test("档案库：独立的页签，支持搜索、标签筛选、按来源聚合与平铺", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  // 首屏是本机档案；档案库是第二个页签，负责"去外面找"。
  assert.match(source, /\["rosters", t\("panel\.tabsRosters"\), favorites\.length\],\n\s*\["catalog", t\("panel\.tabsCatalog"\), null\]/);
  assert.match(source, /const \[tab, setTab\] = useState\("rosters"\)/);
  assert.match(source, /function CatalogTab\(/);
  assert.match(source, /className: "rstr-catalog"/);
  // 两条路由各司其职：catalog 摊开全部，search 负责排序。
  assert.match(source, /CATALOG_ROUTE = "\/plugins\/dsh-agent-roster\/catalog"/);
  assert.match(source, /SEARCH_ROUTE = "\/plugins\/dsh-agent-roster\/search"/);
  // 聚合 / 平铺 是视图开关，不是两套数据。
  assert.match(source, /t\("catalog\.modeSource"\)/);
  assert.match(source, /t\("catalog\.modeFlat"\)/);
  assert.match(source, /if \(mode === "flat"\) return \[\{ key: "flat"/);
  // 标签是"且"：勾两个就要求两个都在。
  assert.match(source, /for \(const tag of selected\) if \(!\(entry\.tags \?\? \[\]\)\.includes\(tag\)\) return false/);
  // 输入停止后才问后端；旧请求要取消。
  assert.match(source, /setTimeout\(\(\) => \{[\s\S]{0,400}?SEARCH_ROUTE/, "搜索应当在防抖之后发出");
  assert.match(source, /controller\.abort\(\)/, "新的输入要取消上一次请求");
  const css = source.match(/const CSS = `([\s\S]*?)`;/)[1];
  for (const rule of [".rstr-catalog {", ".rstr-catalog-tags {", ".rstr-space-head {", ".rstr-space-id {"]) {
    assert.ok(css.includes(rule), `缺少规则 ${rule}`);
  }
});
test("空间：档案库能整空间拉取，并标出本机已有的档案", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  assert.match(source, /INSTALL_SPACE_ROUTE = "\/plugins\/dsh-agent-roster\/install-space"/);
  assert.match(source, /function CatalogTab\(\{ onOpen, onPullSpace, onFavorite, onToast \}\)/);
  assert.match(source, /t\("catalog\.pullSpace"\)/);
  assert.match(source, /t\("catalog\.here"\)/);
  // 已经在本机的那份，按钮必须是「打开」；没装的只说明状态，不再给单份拉取。
  assert.match(source, /here\n\s*\? h\("button", \{ type: "button", className: "rstr-btn rstr-btn-sm", onClick: \(\) => onOpen\(entry\.rosterId\) \}/);
  assert.match(source, /t\("catalog\.notInstalled"\)/);
  // 空间头在窄面板上必须折成两行，否则长空间名会被挤成竖排。
  const css = source.match(/const CSS = `([\s\S]*?)`;/)[1];
  const narrow = css.slice(css.indexOf("@media (max-width: 860px)"));
  for (const rule of [".rstr-space-head {", "grid-area: 1 / 1;", ".rstr-space-facts { grid-area: 2 / 2"]) {
    assert.ok(narrow.includes(rule), `窄屏缺少 ${rule}`);
  }
  // 本机行不再重复写「本机」——分组头已经说了。
  assert.match(source, /entry\.scope === "local"\s*\?\s*null/);
  const zh = JSON.parse(readFileSync(new URL("../locale/zh.json", import.meta.url), "utf8"));
  const en = JSON.parse(readFileSync(new URL("../locale/en.json", import.meta.url), "utf8"));
  for (const key of ["installed", "here", "facts", "pullSpace", "pulledSpace"]) {
    assert.equal(typeof zh.catalog[key], "string", key);
    assert.equal(typeof en.catalog[key], "string", key);
  }
});

test("从档案创建团队：行上有入口，对话框默认新会话，团队名与档案 id 一起发给 apply", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  assert.match(source, /t\("roster\.createTeam"\)/);
  assert.match(source, /onClick: \(\) => onCreateTeam\(roster\)/);
  assert.match(source, /function TeamCreateDialog\(\{ roster, sessions, workspaces, targets, models, onClose, onToast, onCreated \}\)/);
  // 快速建团不该劫持用户正在聊的会话：默认必须是新会话。
  assert.match(source, /const \[mode, setMode\] = useState\("new"\)/);
  assert.match(source, /const payload = \{ rosterId: roster\.id, teamName: teamName\.trim\(\), mode, target: targetId \}/);
  // 引擎：只剩一个，不再做下拉；写成一行事实，缺包时写"未安装"（依赖不静默）。
  assert.match(source, /label: t\("teamCreate\.engine"\)/);
  assert.match(source, /const engine = targetList\.find\(\(item\) => item\.id === "agent-teams"\)/);
  assert.match(source, /teamCreate\.engineMissing/);
  assert.doesNotMatch(source, /disabled: unsupported \|\| missing/);
  assert.match(source, /targetHasMemberSpecs/);
  assert.match(source, /teamCreate\.noMemberSpecs/);
  assert.match(source, /creatingTeam !== null[\s\S]{0,200}?TeamCreateDialog/);
  const zh = JSON.parse(readFileSync(new URL("../locale/zh.json", import.meta.url), "utf8"));
  const en = JSON.parse(readFileSync(new URL("../locale/en.json", import.meta.url), "utf8"));
  for (const key of ["title", "hint", "teamName", "target", "newSession", "existingSession", "submit", "queued", "failed", "noCaptain", "engine", "engineHint", "engineNone", "engineMissing", "noTeamName", "noMemberSpecs"]) {
    assert.equal(typeof zh.teamCreate[key], "string", key);
    assert.equal(typeof en.teamCreate[key], "string", key);
  }
  assert.equal(typeof zh.roster.createTeam, "string");
  assert.equal(typeof en.roster.createTeam, "string");
});

test("选已有会话：显示会话标题与工作区名，而不是一串 id", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  assert.match(source, /function sessionLabel\(session, workspaces\)/);
  // 标题来自宿主投影；取不到时退回工作区目录名，再退回短 id（三层兜底，不编造名字）。
  assert.match(source, /session\.title\.trim\(\)/);
  assert.match(source, /path\.split\("\/"\)\.filter\(Boolean\)\.pop\(\)/);
  // 两个入口（应用队长 / 创建团队）都必须用它，且不再直接拼 sessionId。
  assert.ok((source.match(/sessionLabel\(session, workspaces\)/g) ?? []).length >= 2);
  assert.doesNotMatch(source, /session\.sessionId\.slice\(0, 12\) · /);
});

test("新建会话：要选空间与名字，两个入口发的是同一组字段", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  // 空间（宿主工作区）是下拉框，不是自由文本目录：名字与落点都不该由用户拼路径。
  assert.match(source, /const defaultWorkspace = useMemo\(\(\) => \{/);
  assert.match(source, /workspaceList\.map\(\(item, index\) =>/);
  assert.match(source, /t\("captain\.sessionName"\)/);
  assert.match(source, /payload\.sessionTitle = sessionName\.trim\(\)/);
  assert.match(source, /workspaceKeyOf\(defaultWorkspace\)/);
  assert.match(source, /value: workspaceKeyOf\(item\)/);
  assert.match(source, /chosen\.workspaceId !== ""/);
  // 空间选项只写工作区名字，不附路径：路径对“选哪个空间”没有帮助，还会把名字挤掉。
  assert.match(source, /function workspaceLabels\(workspaces\)/);
  assert.match(source, /workspaceLabels\(workspaces\)\[index\]/, "空间名重名时要能分开");
  assert.doesNotMatch(source, /\} · \$\{item\.path\}/, "空间选项不要再拼路径");
  // 两个入口都要把"哪一份档案"带上，否则同名档案跨库时后台只能猜。
  assert.ok((source.match(/payload\.rootDir = roster\.rootDir/g) ?? []).length >= 2);
});

test("只应用人设：选已有会话时可勾选，走 apply-session 而不是建团", () => {
  const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  assert.match(client, /APPLY_SESSION_ROUTE = "\/plugins\/dsh-agent-roster\/apply-session"/);
  assert.match(client, /const \[attachOnly, setAttachOnly\] = useState\(false\)/);
  assert.match(client, /mode === "existing" && attachOnly/);
  assert.match(client, /teamCreate\.attachOnly/);
  assert.match(client, /teamCreate\.applied/);
  assert.match(client, /className: "rstr-toggle"/);
});

test("空间下拉：没有 host id 的工作区也能选中（用路径当值）", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  // 旧注册表/退回项没有 workspaceId。若 <option value="">，两个工作区就是同一个值——
  // 选了等于没选，界面上表现为"另一个选不上"。
  assert.match(source, /function workspaceKeyOf\(workspace\)/);
  assert.match(source, /value: workspaceKeyOf\(item\)/);
  assert.doesNotMatch(source, /value: item\.workspaceId/);
  assert.match(source, /chosen\.path !== ""\) payload\.cwd = chosen\.path/);
});

test("更新按钮：冲突、无法核对、无基线各有各的说法，不一律显示「已是最新」", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  assert.match(source, /updates\.fastForward > 0/);
  assert.match(source, /updates\.pending > 0/);
  assert.match(source, /updates\.unverified > 0/);
  assert.match(source, /updates\.unledgered > 0/);
  assert.match(source, /t\("catalog\.conflicts"/);
  assert.match(source, /t\("catalog\.unverified"/);
  assert.match(source, /t\("catalog\.noBaseline"\)/);
  // 没有可应用项时按钮要禁用，不能让人点了没反应。
  assert.match(source, /disabled: updates !== null && updates\.fastForward === 0/);
});

test("收藏：档案页只列收藏，星标能切换，复制一份会回填", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  // 收藏只写库根的点文件：取消收藏不该改动任何定义，也不该碰团队状态。
  assert.match(source, /FAVORITES_ROUTE = "\/plugins\/dsh-agent-roster\/favorites"/);
  assert.match(source, /JSON\.stringify\(\{ rootDir: target\.rootDir, id, favorite: target\.favorite !== true \}\)/);
  // 默认只看收藏：拉一整个空间会带来二十份，全铺在首屏等于没有首屏。
  assert.match(source, /const \[favOnly, setFavOnly\] = useState\(true\)/);
  assert.match(source, /if \(favOnly && roster\.favorite !== true\) return false/);
  assert.match(source, /t\("panel\.favOnly", \{ count: String\(favorites\.length\) \}\)/);
  assert.match(source, /t\("panel\.emptyFavoritesTitle"\)/);
  // 行上的星标：实心/空心由收藏状态决定，且是 aria-pressed 的开关而不是普通按钮。
  assert.match(source, /className: `rstr-star\$\{roster\.favorite === true \? " rstr-star-on" : ""\}`/);
  assert.match(source, /"aria-pressed": roster\.favorite === true/);
  // 档案库：没装的行不再给单份拉取，只说明状态。
  assert.match(source, /t\("catalog\.notInstalled"\)/);
  assert.doesNotMatch(source, /t\("catalog\.pull"\)/, "单份拉取已经取消：拉取只发生在空间这一级");
  // 复制一份必须回填内容（否则复制出来的是空表单），只换 id。
  assert.match(source, /const next = draftFromRoster\(result\.body\.roster\);\n\s*if \(duplicate\) next\.id = `\$\{existing\.id\}-copy`/);
  assert.doesNotMatch(source, /result\.body\.roster && !duplicate/, "复制模式曾因这条判断跳过回填");

  const zh = JSON.parse(readFileSync(new URL("../locale/zh.json", import.meta.url), "utf8"));
  const en = JSON.parse(readFileSync(new URL("../locale/en.json", import.meta.url), "utf8"));
  for (const key of ["favorite", "unfavorite"]) {
    assert.equal(typeof zh.roster[key], "string", key);
    assert.equal(typeof en.roster[key], "string", key);
    assert.equal(typeof zh.catalog[key], "string", key);
    assert.equal(typeof en.catalog[key], "string", key);
  }
  for (const key of ["favOnly", "favAll", "emptyFavoritesTitle", "emptyFavoritesBody", "emptyFavoritesCta", "favFilter"]) {
    assert.equal(typeof zh.panel[key], "string", key);
    assert.equal(typeof en.panel[key], "string", key);
  }
  assert.equal(zh.roster.copyCreate, "复制成员参数", "「复制建团队载荷」这个名字没人看得懂");
});

test("应用失败时把宿主给的 reason 也显示出来，不只报一个 code", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  assert.match(source, /reason: typeof response\.body\?\.reason === "string" \? response\.body\.reason : ""/);
  assert.match(source, /result\.reason \? `\$\{result\.code\} — \$\{result\.reason\}` : result\.code/);
});

test("创建团队：队长模型可以在提交前改，档案声明的模型不在部署里时当场说明", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  // 目录由 /library 的 hostModels 提供；读不到时显示"读不到"，不编选项。
  assert.match(source, /models: snapshot\?\.hostModels \?\? \[\]/);
  assert.match(source, /const modelList = useMemo\(\(\) => \{/);
  assert.match(source, /t\("teamCreate\.modelUnknown"\)/);
  // 档案声明但没有的模型：选项禁选 + 警示，而不是提交后报 model-not-applied。
  assert.match(source, /value: declaredModel, disabled: true/);
  assert.match(source, /t\("teamCreate\.modelMissing", \{ model: declaredModel \}\)/);
  // 选中项随 payload 发给 /apply。
  assert.match(source, /payload\.model = \{ provider: pickedModel\.provider, model: pickedModel\.model \}/);
});

test("档案详情说出磁盘形态：v1 单文件与 v2 空间不再隐形", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  assert.match(source, /roster\.documentFormat \?\? "roster@1"/);
  assert.match(source, /t\("roster\.formatLine", \{ format:/);
  const zh = JSON.parse(readFileSync(new URL("../locale/zh.json", import.meta.url), "utf8"));
  const en = JSON.parse(readFileSync(new URL("../locale/en.json", import.meta.url), "utf8"));
  assert.match(zh.roster.formatLine, /格式 \{format\}/);
  assert.match(en.roster.formatLine, /Format \{format\}/);
});

test("导入：选文件或拖拽，不在界面上编辑；自动登记的库在设置里能看见", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  assert.match(source, /type: "file"/);
  assert.match(source, /onDrop: drop/);
  assert.match(source, /file\.text\(\)/);
  // 导入弹窗里不该再有可编辑的文本域：粘贴改文本是编辑器的活。
  const start = source.indexOf("function ImportDialog(");
  const end = source.indexOf("function DeleteDialog(");
  const dialog = source.slice(start, end);
  assert.doesNotMatch(dialog, /TextArea/);
  assert.match(dialog, /rstr-drop/);
  // 设置里列出自动登记的库，并能撤销（走 library-registry 路由）。
  assert.match(source, /autoDirs\.length === 0/);
  assert.match(source, /LIBRARY_REGISTRY_ROUTE/);
  assert.match(source, /\{ action: "forget", dir \}/);
});

test("多库：档案页可按路径分组或平铺，档案库的本机也按库根分组", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  assert.match(source, /useState\("path"\)/);
  assert.match(source, /rosterMode === "flat"/);
  assert.match(source, /t\("panel\.groupByPath"\)/);
  assert.match(source, /t\("panel\.groupFlat"\)/);
  assert.match(source, /`local:\$\{entry\.rootDir \?\? ""\}`/);
  const zh = JSON.parse(readFileSync(new URL("../locale/zh.json", import.meta.url), "utf8"));
  assert.equal(zh.panel.groupByPath, "按路径");
  assert.equal(zh.panel.groupFlat, "平铺");
});
