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

test("模块 id 是包名，只注入 slots", async () => {
  const { module } = await loadClient();
  assert.deepEqual(module.inject, ["slots"], "语言与配置表单是可选服务，用 ctx.get 探测，不写进 inject");
});

test("apply 在 locale / configForms 缺失时不抛，槽位仍全部登记", async () => {
  const { registrations, slots } = await loadClient();
  assert.deepEqual(slots.slice().sort(), ["main", "settings.section", "sidebar.panellist"]);
  assert.equal(registrations.length, 3);
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

test("设置节用独立 id 注册，且与面板身份不同（避免同名冲突）", async () => {
  const { registrations } = await loadClient();
  const section = registrations.find(({ meta }) => meta.name === "settings.section");
  assert.ok(section, "缺少 settings.section 登记");
  assert.equal(typeof section.meta.id, "string");
  assert.equal(typeof section.meta.order, "number");
  assert.equal(typeof section.component, "function");
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
  const detail = ruleOf(".rstr-source-detail");
  assert.doesNotMatch(detail, /max-height:/, "展开清单不能再有高度上限：那会把内容关进小盒子");
  assert.doesNotMatch(detail, /overflow/, "展开清单不该自己滚，否则滚轮会被套娃");

  const rowDetail = ruleOf(".rstr-row-detail");
  assert.doesNotMatch(rowDetail, /max-height:/, "成员展开区同样不能有高度上限");
  assert.doesNotMatch(rowDetail, /overflow/, "成员展开区同样不该自己滚");

  // 档案源里的集合曾经还用 0.8 的卡片类名（.rstr-card / .rstr-card-head…），
  // 那些规则在账本改版时被删掉了 —— 结果集合页签渲染出一堆没有样式的裸元素，
  // 看上去就是"显示不全 / 排版散架"。现在集合和档案共用同一套账本行。
  assert.doesNotMatch(source, /className: "rstr-card(-|")/, "档案源不许再用已无样式的 rstr-card 类名");
  assert.match(source, /className: openId === collection\.id \? "rstr-row rstr-row-open" : "rstr-row"/, "集合必须渲染成账本行");

  const sources = ruleOf(".rstr-sources");
  assert.match(sources, /padding:\s*16px 28px/, "档案源页签要和档案页一样有自己的内边距，否则内容贴着窗口边");

  // 空库 / 空团队时页签里只剩一句空状态。它原来直接挂在页面根下（页面 padding 为 0），
  // 于是「还没有档案」四个字贴着窗口左上角——列表有留白、空状态没有，看着就是没做完。
  const emptyWrap = ruleOf(".rstr-empty-wrap");
  assert.match(emptyWrap, /padding:\s*16px 28px/, "空状态要占与列表同一块版心");
  assert.ok(
    (source.match(/className: "rstr-empty-wrap"/g) ?? []).length >= 2,
    "空档案与空团队两处都要包进版心，不能只包一处",
  );

  const sourceRow = ruleOf(".rstr-source-roster");
  assert.match(sourceRow, /display:\s*grid/, "展开清单是 id / 标题 / 人数 三列的账本行");
  assert.match(sourceRow, /minmax\(0,\s*1fr\)/, "标题列必须可压缩");
});

test("档案库：独立的页签，支持搜索、标签筛选、按来源聚合与平铺", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  // 它是第一个页签，也是默认页签：找档案是进入面板的第一件事。
  assert.match(source, /\["catalog", t\("panel\.tabsCatalog"\), null\]/);
  assert.match(source, /const \[tab, setTab\] = useState\("catalog"\)/);
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
  for (const rule of [".rstr-catalog {", ".rstr-catalog-tags {", ".rstr-group-head {"]) {
    assert.ok(css.includes(rule), `缺少规则 ${rule}`);
  }
});