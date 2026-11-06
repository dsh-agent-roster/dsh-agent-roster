/**
 * 浏览器半边：Agent 档案面板 + 设置页里的语言节。
 *
 * 三个页签对应三类"用户真正关心的事"：
 * - 档案：看得见、改得动。新建/编辑/复制/删除/导入/导出都在这里完成，不再只能靠工具。
 * - 团队：agent-teams 建出来的团队到底长什么样、成员是不是真的来自档案、字段有没有漂移。
 * - 体检：档案库、目录、状态目录、工具策略这些"配置有没有指对"的问题集中在这里，
 *   面板顶部只放一条"有几件事需要处理"的横幅，避免把配置噪声堆到首屏。
 *
 * 写操作一律走 Host 的 `/plugins/dsh-agent-roster/rosters`（同源 + 宿主 connection 围栏 +
 * 档案库根目录白名单）。客户端不做权威校验：它只做"少一次无谓往返"的本地提示，
 * 真正的校验仍在 Host 侧，失败时把诊断原样摆出来。
 *
 * 位置：`main` 键控槽 + `sidebar.panellist` 列表槽，同一个 PANEL_ID 关联；
 * 语言与偏好只放在面板自己的设置弹窗里：不再往 DSH 设置页另注册一节，
 * 免得同一个表单出现在两处、两边还可能不同步。
 */
window.__ModuleLoader__.load({
  id: "@stofone/dsh-agent-roster",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** 本插件在配置表单里的命名空间（与 cordis.patch.yml 的插件 id 一致）。 */
    const NS = "agent-roster";

    /** 主面板身份：`main` 槽的 key 与 `sidebar.panellist` 的 id 必须一致。 */
    const PANEL_ID = "agent-roster";

    const LIBRARY_ROUTE = "/plugins/dsh-agent-roster/library";
    const LOCALE_ROUTE = "/plugins/dsh-agent-roster/locale";
    const DOCUMENT_ROUTE = "/plugins/dsh-agent-roster/document";
    const ROSTERS_ROUTE = "/plugins/dsh-agent-roster/rosters";
    const INSTALL_SPACE_ROUTE = "/plugins/dsh-agent-roster/install-space";
    const COLLECTION_ROUTE = "/plugins/dsh-agent-roster/collection";
    const APPLY_ROUTE = "/plugins/dsh-agent-roster/apply";
    const SEARCH_ROUTE = "/plugins/dsh-agent-roster/search";
    const CATALOG_ROUTE = "/plugins/dsh-agent-roster/catalog";
    const SPACE_UPDATE_ROUTE = "/plugins/dsh-agent-roster/space-update";
  const FAVORITES_ROUTE = "/plugins/dsh-agent-roster/favorites";

    const EFFORTS = ["low", "medium", "high", "default"];
    const LANGUAGES = ["auto", "zh", "en"];
    const REGIONS = ["auto", "global", "china"];
    const FORMATS = ["yaml", "json"];
    const STYLE_ID = "dsh-agent-roster-style";

    /* ------------------------------------------------------------------ */
    /* i18n                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 词典运行时。语言来源有两处：插件设置里的 language，与 DSH 自己的当前语言。
     * `auto` 时跟随 DSH；用户显式选择后以插件设置为准。
     */
    const i18n = {
      preference: "auto",
      activeLocale: "",
      dicts: {},
      listeners: new Set(),

      language() {
        if (this.preference === "zh" || this.preference === "en") return this.preference;
        return String(this.activeLocale).toLowerCase().startsWith("zh") ? "zh" : "en";
      },

      dict() {
        return this.dicts[this.language()] ?? {};
      },

      emit() {
        for (const listener of [...this.listeners]) listener();
      },

      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },

      /** 词典来自 Host 的只读路由，静态文件，取一次即可；失败时静默降级为 key。 */
      async load() {
        await Promise.all(
          ["en", "zh"].map(async (language) => {
            if (this.dicts[language]) return;
            try {
              const response = await fetch(`${LOCALE_ROUTE}?lang=${language}`, {
                credentials: "same-origin",
                cache: "no-store",
              });
              if (response.ok) this.dicts[language] = await response.json();
            } catch {
              /* 词典拿不到不是致命错误：界面退化成 key 名。 */
            }
          }),
        );
        this.emit();
      },
    };

    /**
     * 取词：支持点号路径与 `{name}` 插值，缺失时退回英文，再退回 key 本身。
     *
     * @param {string} key
     * @param {Record<string, unknown>} [params]
     * @returns {string}
     */
    function t(key, params) {
      const value = readPath(i18n.dict(), key) ?? readPath(i18n.dicts.en ?? {}, key) ?? key;
      if (typeof value !== "string") return key;
      if (params === undefined) return value;
      return value.replace(/\{(\w+)\}/g, (match, name) =>
        params[name] === undefined || params[name] === null ? match : String(params[name]),
      );
    }

    function readPath(object, path) {
      let node = object;
      for (const part of path.split(".")) {
        if (node === null || typeof node !== "object") return undefined;
        node = node[part];
      }
      return typeof node === "string" ? node : undefined;
    }

    /** 订阅词典与语言变化：语言一切换，所有用它的组件重渲染。 */
    function useTranslation() {
      const [, setVersion] = useState(0);
      useEffect(() => i18n.subscribe(() => setVersion((value) => value + 1)), []);
    }

    /* ------------------------------------------------------------------ */
    /* 数据访问                                                            */
    /* ------------------------------------------------------------------ */

    async function readJson(url, init) {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
      const text = await response.text();
      let body = null;
      if (text !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, ok: response.ok, body };
    }

    /**
     * 写操作：POST JSON 到 rosters 路由。
     *
     * @param {object} payload
     * @returns {Promise<{ ok: boolean, status: number, body: any }>}
     */
    function mutate(payload) {
      return readJson(ROSTERS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    function useLibrary() {
      const [state, setState] = useState({ status: "loading", data: null, error: false });
      const load = useCallback(async (options) => {
        // 只有档案源那处会传 { refresh: true }：绕过 registry 的 TTL，强制回源。
        const forced = options !== null && typeof options === "object" && options.refresh === true;
        setState((current) => ({ ...current, status: current.data === null ? "loading" : "refreshing" }));
        try {
          const result = await readJson(forced ? `${LIBRARY_ROUTE}?refresh=1` : LIBRARY_ROUTE);
          if (!result.ok || result.body === null) throw new Error(String(result.status));
          setState({ status: "ready", data: result.body, error: false });
        } catch {
          setState((current) => ({ ...current, status: "error", error: true }));
        }
      }, []);
      useEffect(() => {
        load();
      }, [load]);
      return { ...state, reload: () => load(), refresh: () => load({ refresh: true }) };
    }

    /* ------------------------------------------------------------------ */
    /* YAML 生成（表单 → 源码）                                            */
    /* ------------------------------------------------------------------ */

    /**
     * YAML 标量：能裸写就裸写，可能被误读的一律加双引号。
     *
     * @param {unknown} value
     * @returns {string}
     */
    function quote(value) {
      const text = String(value ?? "");
      const plain = /^[A-Za-z0-9\u4e00-\u9fa5][^\n:#"']*$/.test(text) && !/\s$/.test(text);
      return plain ? text : JSON.stringify(text);
    }

    /**
     * 把草稿渲染成档案源码。缩进固定两格：与 README 里的样例保持一致，人读得动。
     *
     * @param {object} draft 表单草稿
     * @returns {string}
     */
    function renderDocument(draft) {
      const lines = [];
      const push = (indent, text) => lines.push(" ".repeat(indent) + text);
      const scalar = (key, value, indent = 0) => {
        if (value === undefined || value === null || value === "") return;
        push(indent, `${key}: ${quote(value)}`);
      };

      push(0, "kind: dsh-agent-roster/v1");
      scalar("roster", draft.id);
      scalar("version", draft.version || "0.1.0");
      scalar("title", draft.title);
      scalar("description", draft.description);

      for (const [key, raw] of [
        ["tags", draft.tags],
        ["maintainers", draft.maintainers],
      ]) {
        const values = splitList(raw);
        if (values.length === 0) continue;
        push(0, `${key}:`);
        for (const value of values) push(2, `- ${quote(value)}`);
      }

      push(0, "members:");
      for (const member of draft.members) {
        push(2, `- name: ${quote(member.name)}`);
        scalarAt(push, 4, "role", member.role);
        scalarAt(push, 4, "title", member.title);
        scalarAt(push, 4, "description", member.description);
        scalarAt(push, 4, "provider", member.provider);
        scalarAt(push, 4, "model", member.model);
        scalarAt(push, 4, "reasoningEffort", member.reasoningEffort);
        scalarAt(push, 4, "toolPolicy", member.toolPolicy);
        listAt(push, 4, "aliases", splitList(member.aliases));
        listAt(push, 4, "skills", splitList(member.skills));
        listAt(push, 4, "examples", splitList(member.examples));
        const tools = splitList(member.tools);
        if (tools.length > 0) {
          push(4, "toolScope:");
          push(6, "allow:");
          for (const tool of tools) push(8, `- ${quote(tool)}`);
        }
        const prompt = String(member.systemPrompt ?? "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
        if (prompt !== "") {
          // 人设几乎都是多行：用块标量，避免把用户的长文压成一整行转义串。
          push(4, "systemPrompt: |");
          for (const line of prompt.split("\n")) push(6, line);
        }
        scalarAt(push, 4, "notes", member.notes);
      }

      const captain = draft.captain;
      if (captain !== null && typeof captain === "object" && String(captain.name ?? "").trim() !== "") {
        push(0, "captain:");
        scalarAt(push, 2, "name", captain.name);
        scalarAt(push, 2, "description", captain.description);
        scalarAt(push, 2, "provider", captain.provider);
        scalarAt(push, 2, "model", captain.model);
        scalarAt(push, 2, "reasoningEffort", captain.reasoningEffort);
        const persona = String(captain.personaPrefix ?? "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
        if (persona !== "") {
          push(2, "personaPrefix: |");
          for (const line of persona.split("\n")) push(4, line);
        }
      }

      return `${lines.join("\n")}\n`;
    }

    /** 一列块状数组：空数组不写，避免产出 `aliases:` 后面什么都没有的残缺 YAML。 */
    function listAt(push, indent, key, values) {
      if (!Array.isArray(values) || values.length === 0) return;
      push(indent, `${key}:`);
      for (const value of values) push(indent + 2, `- ${quote(value)}`);
    }

    function scalarAt(push, indent, key, value) {
      if (value === undefined || value === null || value === "") return;
      push(indent, `${key}: ${quote(value)}`);
    }

    /**
     * 把草稿渲染成 JSON。字段与人读的 YAML 一致，方便机器读、diff。
     *
     * @param {object} draft
     * @returns {string}
     */
    function renderJson(draft) {
      const members = draft.members.map((member) => {
        const tools = splitList(member.tools);
        const entry = { name: member.name || "" };
        for (const field of ["role", "title", "description", "provider", "model", "reasoningEffort", "toolPolicy"]) {
          if (member[field]) entry[field] = member[field];
        }
        for (const field of ["aliases", "skills", "examples"]) {
          const values = splitList(member[field]);
          if (values.length > 0) entry[field] = values;
        }
        if (tools.length > 0) entry.toolScope = { allow: tools };
        entry.systemPrompt = String(member.systemPrompt ?? "");
        if (member.notes) entry.notes = member.notes;
        return entry;
      });
      const document = {
        kind: "dsh-agent-roster/v1",
        roster: draft.id || "",
        version: draft.version || "0.1.0",
        title: draft.title || "",
        description: draft.description || "",
        tags: splitList(draft.tags),
        maintainers: splitList(draft.maintainers),
        members,
      };
      const captain = draft.captain;
      if (captain !== null && typeof captain === "object" && String(captain.name ?? "").trim() !== "") {
        const block = { name: captain.name };
        for (const field of ["description", "provider", "model", "reasoningEffort"]) {
          if (captain[field]) block[field] = captain[field];
        }
        if (String(captain.personaPrefix ?? "").trim() !== "") block.personaPrefix = captain.personaPrefix;
        document.captain = block;
      }
      return `${JSON.stringify(document, null, 2)}\n`;
    }

    function splitList(value) {
      if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item !== "");
      if (typeof value !== "string") return [];
      return value
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter((item) => item !== "");
    }

    /* ------------------------------------------------------------------ */
    /* 小组件                                                              */
    /* ------------------------------------------------------------------ */

    function Chip({ children, tone }) {
      return h("span", { className: `rstr-chip${tone === undefined ? "" : ` rstr-chip-${tone}`}` }, children);
    }

    function Badge({ tone, children }) {
      return h("span", { className: `rstr-badge rstr-badge-${tone ?? "info"}` }, children);
    }

    function EmptyState({ title, body, cta, onCta }) {
      return h(
        "div",
        { className: "rstr-empty" },
        h("p", { className: "rstr-empty-title" }, title),
        h("p", { className: "rstr-muted" }, body),
        cta ? h("button", { type: "button", className: "rstr-btn rstr-btn-primary", onClick: onCta }, cta) : null,
      );
    }

    /**
     * 对话框：遮罩 + 居中卡片。Esc 关闭，打开时锁住 body 滚动。
     */
    function Modal({ title, children, footer, onClose, width }) {
      const ref = useRef(null);
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [onClose]);

      return h(
        "div",
        {
          className: "rstr-overlay",
          onMouseDown: (event) => {
            if (event.target === ref.current) onClose();
          },
          ref,
        },
        h(
          "div",
          {
            className: "rstr-modal",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": title,
            style: width === undefined ? undefined : { width },
          },
          h(
            "div",
            { className: "rstr-modal-head" },
            h("h2", { className: "rstr-modal-title" }, title),
            h("button", { type: "button", className: "rstr-icon-btn", onClick: onClose, "aria-label": t("editor.cancel") }, "×"),
          ),
          h("div", { className: "rstr-modal-body" }, children),
          footer ? h("div", { className: "rstr-modal-foot" }, footer) : null,
        ),
      );
    }

    function Field({ label, hint, children }) {
      return h(
        "label",
        { className: "rstr-field" },
        h("span", { className: "rstr-label" }, label),
        children,
        hint ? h("span", { className: "rstr-hint" }, hint) : null,
      );
    }

    function TextInput({ value, onChange, placeholder, mono, disabled }) {
      return h("input", {
        className: `rstr-input${mono ? " rstr-mono" : ""}`,
        value: value ?? "",
        placeholder: placeholder ?? "",
        disabled: disabled === true,
        onChange: (event) => onChange(event.target.value),
      });
    }

    function TextArea({ value, onChange, rows, mono, placeholder }) {
      return h("textarea", {
        className: `rstr-input rstr-textarea${mono ? " rstr-mono" : ""}`,
        value: value ?? "",
        rows: rows ?? 4,
        placeholder: placeholder ?? "",
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
      });
    }

    function Select({ value, onChange, options }) {
      return h(
        "select",
        { className: "rstr-input", value: value ?? "", onChange: (event) => onChange(event.target.value) },
        options.map((option) =>
          h("option", { key: option.value, value: option.value }, option.label),
        ),
      );
    }

    /** 诊断列表：严重度 + code + 位置 + 说明。说明来自 Host，界面不翻译它。 */
    function DiagnosticList({ items }) {
      if (!Array.isArray(items) || items.length === 0) return null;
      return h(
        "ul",
        { className: "rstr-diagnostics" },
        items.filter(Boolean).map((item, index) =>
          h(
            "li",
            { key: `${item.code ?? "item"}-${index}`, className: `rstr-diag rstr-diag-${item.severity ?? "info"}` },
            h(Badge, { tone: item.severity }, t(`diagnostics.severity${capitalize(item.severity ?? "info")}`)),
            h("code", { className: "rstr-code" }, item.code ?? ""),
            item.path ? h("span", { className: "rstr-code" }, item.path) : null,
            h("span", { className: "rstr-diag-reason" }, item.reason ?? ""),
            item.file ? h("span", { className: "rstr-muted rstr-small" }, item.file) : null,
          ),
        ),
      );
    }

    function capitalize(value) {
      return String(value).charAt(0).toUpperCase() + String(value).slice(1);
    }

    /* ------------------------------------------------------------------ */
    /* 档案卡片                                                            */
    /* ------------------------------------------------------------------ */

    function MemberBlock({ member }) {
      // 四列由 .rstr-members 的 subgrid 统一给宽度：姓名 / 说明 / 策略 / 模型。
      // 说明与策略即使为空也占位，否则后面的列会整体左移，表格就对不齐了。
      const notes = [];
      if (Array.isArray(member.aliases) && member.aliases.length > 0) {
        notes.push(`${t("member.aliases")}: ${member.aliases.join(", ")}`);
      }
      if (Array.isArray(member.skills) && member.skills.length > 0) {
        notes.push(`${t("member.skills")}: ${member.skills.join(", ")}（${t("member.skillsHint")}）`);
      }
      if (Array.isArray(member.inherited) && member.inherited.length > 0) {
        notes.push(`inherited: ${member.inherited.join(", ")}`);
      }
      if (member.notes) notes.push(member.notes);

      return h(
        "div",
        { className: "rstr-member" },
        h(
          "div",
          { className: "rstr-member-head" },
          h("strong", { className: "rstr-member-name" }, member.name),
          member.role ? h(Chip, null, member.role) : null,
        ),
        h("p", { className: "rstr-member-desc" }, member.description ?? ""),
        h(
          "span",
          { className: "rstr-member-policy" },
          member.toolPolicy ? h(Chip, { tone: "policy" }, member.toolPolicy) : null,
        ),
        h(
          "div",
          { className: "rstr-member-meta" },
          member.model ? h("span", null, member.model) : null,
          member.reasoningEffort ? h("span", null, member.reasoningEffort) : null,
          member.fallback ? h("span", null, `${t("member.fallback")}: ${member.fallback}`) : null,
          member.toolScope?.allow?.length
            ? h("span", null, `${t("member.tools")}: ${member.toolScope.allow.join(", ")}`)
            : null,
          h("span", { className: "rstr-muted" }, t("team.promptChars", { count: member.systemPromptChars })),
        ),
        notes.map((text, index) => h("p", { key: `note-${index}`, className: "rstr-member-note" }, text)),
      );
    }

    /**
     * 队长卡：显示档案里声明的队长 + 与部署实际值的核对结果 + “应用”入口。
     *
     * 应用只做两件事：切会话模型、往会话里排一段建团队提示词。它不会、也不能
     * 直接改部署配置——provider/model 不一致时，界面如实说“要改部署”，而不是假装成功。
     */
    /**
     * 会话在“选已有会话”里的显示名：标题（来自投影）→ 工作区目录名 → 短 id。
     * 只显示 id 时人根本认不出那是哪个会话，所以标题缺失也要退回工作区。
     */
    function workspaceNameOf(cwd, workspaces) {
      const path = typeof cwd === "string" ? cwd.replace(/\/+$/, "") : "";
      const list = Array.isArray(workspaces) ? workspaces : [];
      const exact = path === "" ? undefined : list.find((item) => item.path === path);
      const owner = exact ?? (path === "" ? undefined : list.find((item) => path.startsWith(`${item.path}/`)));
      if (owner !== undefined) return owner.title || owner.path.split("/").filter(Boolean).pop() || "";
      return path === "" ? "" : path.split("/").filter(Boolean).pop() ?? "";
    }

    /**
     * 会话在"选已有会话"里的显示名：空间 · 会话名。
     * 空间取宿主工作区的标题（退回目录名），会话名取投影标题（退回短 id）。
     */
    function sessionLabel(session, workspaces) {
      const space = workspaceNameOf(session?.cwd, workspaces);
      const title = typeof session?.title === "string" ? session.title.trim() : "";
      const name = title !== "" ? title : String(session?.sessionId ?? "").slice(0, 12);
      return space === "" ? name : `${space} · ${name}`;
    }

    function CaptainPanel({ roster, report, sessions, workspaces, onToast }) {
      useTranslation();
      const captain = roster.captain ?? {};
      const [mode, setMode] = useState("existing");
      const [sessionId, setSessionId] = useState("");
      // 新会话要落在某个"空间"（宿主工作区）里，并且有名字；缺省取包含这份档案的那个工作区。
      const workspaceList = Array.isArray(workspaces) ? workspaces : [];
      const defaultWorkspace = useMemo(() => {
        const root = typeof roster.rootDir === "string" ? roster.rootDir : "";
        return workspaceList.find((item) => root === item.path || root.startsWith(`${item.path}/`)) ?? workspaceList[0] ?? null;
      }, [workspaces, roster.rootDir]);
      const [workspaceId, setWorkspaceId] = useState(defaultWorkspace?.workspaceId ?? "");
      const [sessionName, setSessionName] = useState(roster.id);
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);

      useEffect(() => {
        if (sessionId === "" && sessions.length > 0) setSessionId(sessions[0].sessionId);
      }, [sessions, sessionId]);

      const checks = report?.checks ?? [];
      const canApply = mode === "new" ? sessionName.trim() !== "" : sessionId !== "";

      async function apply() {
        if (!canApply || busy) return;
        setBusy(true);
        setResult(null);
        try {
          const payload = { rosterId: roster.id, mode };
          if (typeof roster.rootDir === "string" && roster.rootDir !== "") payload.rootDir = roster.rootDir;
          if (mode === "existing") payload.sessionId = sessionId;
          else {
            payload.sessionTitle = sessionName.trim();
            if (workspaceId !== "") payload.workspaceId = workspaceId;
            else if (defaultWorkspace !== null) payload.cwd = defaultWorkspace.path;
          }
          const response = await readJson(APPLY_ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!response.ok || response.body?.ok !== true) {
            setResult({
              ok: false,
              code: response.body?.code ?? response.body?.error?.code ?? String(response.status),
              // 宿主给的 reason 往往才是可行动的那句话（例如少参数、模型不可用）；
              // 只显示一个 code 会把"哪里错了"藏起来。
              reason: typeof response.body?.reason === "string" ? response.body.reason : "",
            });
            onToast(t("captain.applyFailed"));
            return;
          }
          setResult({ ok: true, sessionId: response.body.sessionId });
          onToast(t("captain.applied"));
        } catch {
          setResult({ ok: false, code: "network" });
          onToast(t("misc.failed"));
        } finally {
          setBusy(false);
        }
      }

      return h(
        "section",
        { className: "rstr-captain" },
        h("div", { className: "rstr-section-title rstr-mt" }, t("captain.title")),
        h("p", { className: "rstr-hint" }, t("captain.hint")),
        h(
          "div",
          { className: "rstr-meta-grid" },
          h("span", { className: "rstr-label" }, t("captain.declared")),
          h("span", { className: "rstr-mono" }, captain.provider || "?") ,
          h("span", { className: "rstr-mono" }, captain.model || "?"),
          h("span", { className: "rstr-mono" }, captain.reasoningEffort || t("captain.effortDefault")),
          h(
            "span",
            { className: "rstr-muted" },
            String(captain.personaPrefix ?? "").trim() === "" ? t("captain.noPersona") : t("captain.hasPersona"),
          ),
        ),
        checks.length === 0
          ? h("p", { className: "rstr-hint" }, t("captain.noChecks"))
          : h(
              "ul",
              { className: "rstr-checks" },
              checks.map((check) =>
                h(
                  "li",
                  { key: check.field, className: "rstr-check" },
                  h("span", null, t(`captain.check.${check.field}`)),
                  h(
                    "span",
                    { className: check.status === "match" ? "rstr-ok" : check.status === "differ" ? "rstr-bad" : "rstr-muted" },
                    t(`captain.status.${check.status}`, { declared: check.declared || "?", actual: check.actual || "?" }),
                  ),
                ),
              ),
            ),
        h(
          "div",
          { className: "rstr-apply" },
          h("div", { className: "rstr-label" }, t("captain.applyTo")),
          h(
            "div",
            { className: "rstr-segmented" },
            h(
              "button",
              { type: "button", className: mode === "existing" ? "rstr-seg rstr-seg-on" : "rstr-seg", onClick: () => setMode("existing") },
              t("captain.modeExisting"),
            ),
            h(
              "button",
              { type: "button", className: mode === "new" ? "rstr-seg rstr-seg-on" : "rstr-seg", onClick: () => setMode("new") },
              t("captain.modeNew"),
            ),
          ),
          mode === "existing"
            ? h(
                "select",
                {
                  className: "rstr-select",
                  value: sessionId,
                  onChange: (event) => setSessionId(event.target.value),
                },
                sessions.length === 0
                  ? h("option", { value: "" }, t("captain.noSessions"))
                  : sessions.map((session) =>
                      h(
                        "option",
                        { key: session.sessionId, value: session.sessionId },
                        sessionLabel(session, workspaces),
                      ),
                    ),
              )
            : h(
                "div",
                { className: "rstr-field-stack" },
                workspaceList.length === 0
                  ? null
                  : h(
                      "select",
                      {
                        className: "rstr-select",
                        value: workspaceId,
                        onChange: (event) => setWorkspaceId(event.target.value),
                      },
                      workspaceList.map((item) =>
                        h(
                          "option",
                          { key: item.workspaceId || item.path, value: item.workspaceId },
                          workspaceNameOf(item.path, workspaceList),
                        ),
                      ),
                    ),
                h("input", {
                  className: "rstr-input",
                  placeholder: t("captain.sessionName"),
                  value: sessionName,
                  onChange: (event) => setSessionName(event.target.value),
                }),
              ),
          h(
            "button",
            { type: "button", className: "rstr-btn rstr-btn-primary", disabled: !canApply || busy, onClick: apply },
            busy ? t("captain.applying") : t("captain.apply"),
          ),
        ),
        result !== null && result.ok === false
          ? h(
              "p",
              { className: "rstr-bad rstr-small" },
              t("captain.applyFailedCode", {
                code: result.reason ? `${result.code} — ${result.reason}` : result.code,
              }),
            )
          : null,
        result !== null && result.ok === true
          ? h("p", { className: "rstr-ok rstr-small" }, t("captain.appliedTo", { session: result.sessionId }))
          : null,
      );
    }

    /**
     * 从档案创建团队：挑一个队长会话，把建团提示排进去。
     *
     * 为什么不是“插件直接建”：团队只能由队长会话里的 `agent_teams_create` 建，插件没有这个权限。
     * 所以这个对话框做的是端到端的前半段——把成员、队长模型、建团步骤一次交给一个会话，
     * 后半段（建队、加成员、核对）在那个会话里发生；结果回团队页签与 `roster_verify` 看。
     */
    function TeamCreateDialog({ roster, sessions, workspaces, onClose, onToast, onCreated }) {
      useTranslation();
      // 默认新会话：快速建团不该劫持用户正在聊的这个。
      const [mode, setMode] = useState("new");
      const [sessionId, setSessionId] = useState(sessions[0]?.sessionId ?? "");
      const [teamName, setTeamName] = useState(roster.id);
      const [sessionName, setSessionName] = useState(roster.id);
      // 新建会话要落在一个"空间"（宿主工作区）里：默认取包含这份档案的那个。
      const defaultWorkspace = useMemo(() => {
        const list = Array.isArray(workspaces) ? workspaces : [];
        const root = typeof roster.rootDir === "string" ? roster.rootDir : "";
        return list.find((item) => root === item.path || root.startsWith(`${item.path}/`)) ?? list[0] ?? null;
      }, [workspaces, roster.rootDir]);
      const [workspaceId, setWorkspaceId] = useState(defaultWorkspace?.workspaceId ?? "");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const captain = roster.captain ?? null;
      const declaredModel =
        captain !== null && captain.provider !== undefined && captain.model !== undefined && captain.provider !== "" && captain.model !== ""
          ? `${captain.provider}/${captain.model}`
          : null;
      // 宿主没有工作区注册表时 defaultWorkspace 为 null：仍然允许建会话（落宿主默认目录），
      // 但绝不因此静默换一个"空间"——payload 里既没有 workspaceId 也没有 cwd，由宿主决定。
      const canSubmit = !busy && (mode === "new" ? sessionName.trim() !== "" : sessionId !== "");

      async function submit() {
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        try {
          const payload = { rosterId: roster.id, teamName: teamName.trim(), mode };
          if (typeof roster.rootDir === "string" && roster.rootDir !== "") payload.rootDir = roster.rootDir;
          if (mode === "existing") payload.sessionId = sessionId;
          else {
            payload.sessionTitle = sessionName.trim();
            if (workspaceId !== "") payload.workspaceId = workspaceId;
            else if (defaultWorkspace !== null) payload.cwd = defaultWorkspace.path;
          }
          const response = await readJson(APPLY_ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!response.ok || response.body?.ok !== true) {
            setError(response.body?.code ?? response.body?.error?.code ?? String(response.status));
            return;
          }
          onToast(t("teamCreate.queued", { session: response.body.sessionId }));
          onCreated?.(response.body.sessionId);
          onClose();
        } catch {
          setError("network");
        } finally {
          setBusy(false);
        }
      }

      return h(
        Modal,
        {
          title: t("teamCreate.title", { roster: roster.id }),
          onClose,
          footer: h(
            "div",
            { className: "rstr-modal-foot-actions" },
            h("button", { type: "button", className: "rstr-btn", onClick: onClose }, t("teamCreate.cancel")),
            h(
              "button",
              { type: "button", className: "rstr-btn rstr-btn-primary", disabled: !canSubmit, onClick: submit },
              busy ? t("teamCreate.creating") : t("teamCreate.submit"),
            ),
          ),
        },
        h("p", { className: "rstr-hint" }, t("teamCreate.hint")),
        h(
          Field,
          { label: t("teamCreate.teamName") },
          h("input", {
            className: "rstr-input",
            value: teamName,
            onChange: (event) => setTeamName(event.target.value),
            placeholder: roster.id,
          }),
        ),
        h(
          Field,
          { label: t("teamCreate.target") },
          h(
            "div",
            { className: "rstr-segmented" },
            h(
              "button",
              { type: "button", className: mode === "new" ? "rstr-seg rstr-seg-on" : "rstr-seg", onClick: () => setMode("new") },
              t("teamCreate.newSession"),
            ),
            h(
              "button",
              {
                type: "button",
                className: mode === "existing" ? "rstr-seg rstr-seg-on" : "rstr-seg",
                onClick: () => setMode("existing"),
              },
              t("teamCreate.existingSession"),
            ),
          ),
          mode === "existing"
            ? h(
                "select",
                { className: "rstr-select", value: sessionId, onChange: (event) => setSessionId(event.target.value) },
                sessions.length === 0
                  ? h("option", { value: "" }, t("teamCreate.noSessions"))
                  : sessions.map((session) =>
                      h(
                        "option",
                        { key: session.sessionId, value: session.sessionId },
                        sessionLabel(session),
                      ),
                    ),
              )
            : h(
                "div",
                { className: "rstr-field-stack" },
                h(
                  "select",
                  {
                    className: "rstr-select",
                    value: workspaceId,
                    "aria-label": t("teamCreate.workspace"),
                    onChange: (event) => setWorkspaceId(event.target.value),
                  },
                  (Array.isArray(workspaces) ? workspaces : []).map((item) =>
                    h(
                      "option",
                      { key: item.workspaceId || item.path, value: item.workspaceId },
                      `${item.title || item.path.split("/").filter(Boolean).pop() || item.path} · ${item.path}`,
                    ),
                  ),
                ),
                h("input", {
                  className: "rstr-input",
                  placeholder: t("teamCreate.sessionNamePlaceholder"),
                  "aria-label": t("teamCreate.sessionName"),
                  value: sessionName,
                  onChange: (event) => setSessionName(event.target.value),
                }),
              ),
        ),
        h(
          "p",
          { className: "rstr-hint" },
          t("teamCreate.summary", {
            count: roster.members.length,
            model: declaredModel ?? t("teamCreate.noModel"),
          }),
        ),
        captain === null ? h("p", { className: "rstr-hint" }, t("teamCreate.noCaptain")) : null,
        error !== null ? h("p", { className: "rstr-bad rstr-small" }, t("teamCreate.failed", { code: error })) : null,
      );
    }

    /**
     * 一行 = 一份档案。
     *
     * 名册是列表不是画廊：id 立在第一列当"脊"，状态长在左沿，操作平时只露两个入口。
     * 复制/建队/删除这些低频且危险的动作收进展开区——否则 21 份档案就是 105 个按钮。
     */
    function RosterCard({ roster, deployment, captainReport, sessions, workspaces, onToast, onEdit, onDuplicate, onDelete, onCopy, onCreateTeam, onFavorite }) {
      const [open, setOpen] = useState(false);
      const diagnostics = roster.diagnostics ?? [];
      const errors = diagnostics.filter((item) => item?.severity === "error").length;
      const warnings = diagnostics.filter((item) => item?.severity === "warn").length;
      const deployed = deployment !== undefined && deployment.deployed > 0;
      const drifted = deployment !== undefined ? deployment.drifted : 0;

      const tone = errors > 0 ? " rstr-row-error" : warnings > 0 ? " rstr-row-warn" : "";

      return h(
        "article",
        { className: `rstr-row${tone}${open ? " rstr-row-open" : ""}` },
        h(
          "div",
          { className: "rstr-row-body" },
          h("code", { className: "rstr-row-id", title: roster.id }, roster.id),
          h(
            "div",
            { className: "rstr-row-text" },
            h(
              "h3",
              { className: "rstr-row-title" },
              roster.title || roster.id,
              h(Chip, null, t("roster.version", { version: roster.version })),
              errors > 0 ? h(Badge, { tone: "error" }, t("roster.diagnostics", { count: errors })) : null,
            ),
            roster.description ? h("p", { className: "rstr-row-desc" }, roster.description) : null,
          ),
          h(
            "div",
            { className: "rstr-row-stats" },
            h("span", null, t("roster.members", { count: roster.members.length })),
            errors > 0
              ? h("span", { className: "rstr-stat-error" }, t("roster.diagnostics", { count: errors }))
              : warnings > 0
                ? h("span", { className: "rstr-stat-warn" }, t("roster.warnings", { count: warnings }))
                : null,
            h(
              "span",
              { className: deployed ? "rstr-stat-ok" : undefined },
              deployed
                ? drifted > 0
                  ? t("roster.deployedDrifted", { teams: (deployment.teams ?? []).join(", "), count: drifted })
                  : t("roster.deployed", { teams: (deployment.teams ?? []).join(", ") })
                : t("roster.notDeployed"),
            ),
          ),
          h(
            "div",
            { className: "rstr-row-actions" },
            h(
              "button",
              {
                type: "button",
                className: `rstr-star${roster.favorite === true ? " rstr-star-on" : ""}`,
                "aria-pressed": roster.favorite === true,
                "aria-label": roster.favorite === true ? t("roster.unfavorite") : t("roster.favorite"),
                title: roster.favorite === true ? t("roster.unfavorite") : t("roster.favorite"),
                onClick: () => onFavorite(roster),
              },
              roster.favorite === true ? "\u2605" : "\u2606",
            ),
            h(
              "button",
              { type: "button", className: "rstr-btn rstr-btn-sm", onClick: () => onCreateTeam(roster) },
              t("roster.createTeam"),
            ),
            h("button", { type: "button", className: "rstr-btn rstr-btn-sm rstr-btn-quiet", onClick: () => onEdit(roster) }, t("roster.edit")),
            h(
              "button",
              {
                type: "button",
                className: "rstr-btn rstr-btn-sm rstr-btn-quiet",
                "aria-expanded": open,
                onClick: () => setOpen(!open),
              },
              open ? t("roster.hideMembers") : t("roster.showMembers"),
              h("span", { className: "rstr-caret", "aria-hidden": "true" }, open ? "\u25b4" : "\u25be"),
            ),
          ),
        ),
        open
          ? h(
              "div",
              { className: "rstr-row-detail" },
              roster.members.length === 0
                ? h("p", { className: "rstr-muted" }, t("roster.noMembers"))
                : h(
                    "div",
                    { className: "rstr-members" },
                    roster.members.map((member) => h(MemberBlock, { key: member.name, member })),
                  ),
              roster.captain === null || roster.captain === undefined
                ? null
                : h(CaptainPanel, { roster, report: captainReport, sessions: sessions ?? [], workspaces, onToast }),
              h(DiagnosticList, { items: diagnostics }),
              h("p", { className: "rstr-hint" }, `roster.file: ${roster.file}`),
              h(
                "div",
                { className: "rstr-row-detail-actions" },
                h("button", { type: "button", className: "rstr-btn rstr-btn-sm", onClick: () => onDuplicate(roster) }, t("roster.duplicate")),
                h("button", { type: "button", className: "rstr-btn rstr-btn-sm", onClick: () => onCopy(roster) }, t("roster.copyCreate")),
                h("button", { type: "button", className: "rstr-btn rstr-btn-sm rstr-btn-danger", onClick: () => onDelete(roster) }, t("roster.delete")),
              ),
            )
          : null,
      );
    }

    /* ------------------------------------------------------------------ */
    /* 团队视图                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * 一行 = 一个团队。默认收起：团队页是用来"看谁在跑、有没有偏"的，不是用来读成员清单的。
     */
    function TeamCard({ team }) {
      const [open, setOpen] = useState(false);
      const phase = team.phase === "staged" ? t("team.phaseStaged") : t("team.phaseRunning");
      const tone = team.escalated ? " rstr-row-error" : team.halted || team.phase === "staged" ? " rstr-row-warn" : "";

      return h(
        "article",
        { className: `rstr-row${tone}${open ? " rstr-row-open" : ""}` },
        h(
          "div",
          { className: "rstr-row-body" },
          h("code", { className: "rstr-row-id", title: team.id }, team.id),
          h(
            "div",
            { className: "rstr-row-text" },
            h(
              "h3",
              { className: "rstr-row-title" },
              team.name || team.id,
              h(Badge, { tone: team.phase === "staged" ? "warn" : "ok" }, phase),
              team.halted ? h(Badge, { tone: "warn" }, t("team.halted")) : null,
              team.escalated ? h(Badge, { tone: "error" }, t("team.escalated")) : null,
            ),
            team.description ? h("p", { className: "rstr-row-desc" }, team.description) : null,
          ),
          h(
            "div",
            { className: "rstr-row-stats" },
            h("span", null, t("team.taskCount", { count: team.tasks.total })),
            h("span", null, t("roster.members", { count: team.members.length })),
          ),
          h(
            "div",
            { className: "rstr-row-actions" },
            h(
              "button",
              {
                type: "button",
                className: "rstr-btn rstr-btn-sm rstr-btn-quiet",
                "aria-expanded": open,
                onClick: () => setOpen(!open),
              },
              open ? t("team.hideMembers") : t("team.showMembers"),
              h("span", { className: "rstr-caret", "aria-hidden": "true" }, open ? "\u25b4" : "\u25be"),
            ),
          ),
        ),
        open
          ? h(
              "div",
              { className: "rstr-row-detail" },
              h(
                "div",
                { className: "rstr-members" },
                team.members.map((member) =>
                  h(
                    "div",
                    { key: member.name, className: "rstr-member" },
                    h(
                      "div",
                      { className: "rstr-member-head" },
                      h("strong", null, member.name),
                      member.role ? h(Chip, null, member.role) : null,
                      member.rosterId === null
                        ? h(Badge, { tone: "muted" }, t("team.unmanaged"))
                        : h(Badge, { tone: member.faithful ? "ok" : "warn" }, t(member.faithful ? "team.faithful" : "team.drift")),
                    ),
                    h(
                      "div",
                      { className: "rstr-member-meta" },
                      member.model ? h("span", null, `${t("member.model")}: ${member.model}`) : null,
                      member.reasoningEffort ? h("span", null, `${t("member.effort")}: ${member.reasoningEffort}`) : null,
                      member.toolPolicy ? h("span", null, `${t("member.policy")}: ${member.toolPolicy}`) : null,
                      member.rosterId !== null ? h("span", { className: "rstr-muted" }, t("team.managed", { roster: member.rosterId })) : null,
                      h("span", { className: "rstr-muted" }, t("team.promptChars", { count: member.promptChars })),
                    ),
                    member.drift.length > 0
                      ? h(
                          "ul",
                          { className: "rstr-drift" },
                          member.drift.map((item) =>
                            h(
                              "li",
                              { key: item.field },
                              t("team.driftDetail", { field: item.field, wanted: item.roster, actual: item.runtime }),
                            ),
                          ),
                        )
                      : null,
                  ),
                ),
              ),
              h("p", { className: "rstr-hint" }, `${t("team.file")}: ${team.file}`),
            )
          : null,
      );
    }

    /* ------------------------------------------------------------------ */
    /* 编辑器                                                              */
    /* ------------------------------------------------------------------ */

    /** 空草稿：新建时给一个"改完就能存"的起点，而不是一张空表单。 */
    function blankDraft() {
      return {
        id: "",
        title: "",
        version: "0.1.0",
        description: "",
        tags: "",
        maintainers: "",
        members: [{ name: "", role: "", title: "", description: "", provider: "", model: "", reasoningEffort: "", toolPolicy: "", aliases: "", skills: "", examples: "", tools: "", systemPrompt: "", notes: "" }],
        captain: null,
      };
    }

    function draftFromRoster(roster) {
      return {
        id: roster.id ?? "",
        title: roster.title ?? "",
        version: roster.version ?? "0.1.0",
        description: roster.description ?? "",
        tags: (roster.tags ?? []).join(", "),
        maintainers: (roster.maintainers ?? []).join(", "),
        members: (roster.members ?? []).map((member) => ({
          name: member.name ?? "",
          role: member.role ?? "",
          title: member.title ?? "",
          description: member.description ?? "",
          provider: member.provider ?? "",
          model: member.model ?? "",
          reasoningEffort: member.reasoningEffort ?? "",
          toolPolicy: member.toolPolicy ?? "",
          aliases: (member.aliases ?? []).join(", "),
          skills: (member.skills ?? []).join(", "),
          examples: (member.examples ?? []).join("\n"),
          tools: (member.toolScope?.allow ?? []).join(", "),
          systemPrompt: member.systemPrompt ?? "",
          notes: member.notes ?? "",
        })),
        captain:
          roster.captain === null || roster.captain === undefined
            ? null
            : {
                name: roster.captain.name ?? "",
                description: roster.captain.description ?? "",
                personaPrefix: roster.captain.personaPrefix ?? "",
                provider: roster.captain.provider ?? "",
                model: roster.captain.model ?? "",
                reasoningEffort: roster.captain.reasoningEffort ?? "",
              },
      };
    }

    function Editor({ target, onClose, onSaved }) {
      useTranslation();
      const existing = target.roster;
      const duplicate = target.duplicate === true;
      const [mode, setMode] = useState("form");
      const [format, setFormat] = useState(existing?.file?.endsWith(".json") ? "json" : "yaml");
      const [draft, setDraft] = useState(() => {
        if (existing === null) return blankDraft();
        const base = draftFromRoster(existing);
        if (duplicate) {
          // 复制出来的档案必须换 id，否则保存时会撞名——这里先替用户想好一个。
          base.id = `${existing.id}-copy`;
        }
        return base;
      });
      const [source, setSource] = useState("");
      const [busy, setBusy] = useState(false);
      const [failure, setFailure] = useState(null);
      const [confirmOverwrite, setConfirmOverwrite] = useState(null);
      const [loaded, setLoaded] = useState(existing === null);

      // 编辑已有档案：先拉原文，表单与源码两个视图共用同一份内容。
      useEffect(() => {
        if (existing === null) return;
        let cancelled = false;
        (async () => {
          const result = await readJson(
            `${DOCUMENT_ROUTE}?rootDir=${encodeURIComponent(existing.rootDir)}&id=${encodeURIComponent(existing.id)}`,
          );
          if (cancelled) return;
          if (result.ok && result.body) {
            setSource(result.body.text ?? "");
            // 复制模式也要回填：内容照抄原档案，id 保持自己生成的那个。
            // （之前这里用 `!duplicate` 跳过回填，而列表里的档案只是摘要，于是"复制一份"出来的表单是全空的。）
            if (result.body.roster) {
              const next = draftFromRoster(result.body.roster);
              if (duplicate) next.id = `${existing.id}-copy`;
              setDraft(next);
            }
            setFormat(result.body.format ?? format);
          } else {
            setFailure({ code: "document-unreadable" });
          }
          setLoaded(true);
        })();
        return () => {
          cancelled = true;
        };
      }, [existing?.id, existing?.rootDir]);

      const text = mode === "source" ? source : format === "json" ? renderJson(draft) : renderDocument(draft);

      useEffect(() => {
        if (mode === "form") setSource(format === "json" ? renderJson(draft) : renderDocument(draft));
      }, [mode, format, draft]);

      const validation = validateDraft(draft);

      async function save(overwrite) {
        setBusy(true);
        setFailure(null);
        const result = await mutate({
          action: "save",
          rootDir: existing?.rootDir ?? target.rootDir,
          text: mode === "source" ? source : text,
          format,
          overwrite: overwrite === true,
        });
        setBusy(false);
        if (result.ok) {
          onSaved(result.body?.file ?? `${draft.id}/${format === "json" ? "roster.json" : "roster.yaml"}`);
          return;
        }
        const code = result.body?.error?.code ?? "save-failed";
        if (code === "exists" || code === "format-conflict") {
          setConfirmOverwrite({ code, existing: result.body?.existing ?? null });
          return;
        }
        setFailure({ code, diagnostics: result.body?.diagnostics ?? [] });
      }

      const update = (patch) => setDraft((current) => ({ ...current, ...patch }));
      const updateMember = (index, patch) =>
        setDraft((current) => ({
          ...current,
          members: current.members.map((member, position) => (position === index ? { ...member, ...patch } : member)),
        }));

      const body = [];
      body.push(
        h(
          "div",
          { className: "rstr-editor-toolbar" },
          h(
            "div",
            { className: "rstr-segmented", role: "group", "aria-label": t("editor.source") },
            h(
              "button",
              { type: "button", className: `rstr-seg${mode === "form" ? " rstr-seg-on" : ""}`, onClick: () => setMode("form") },
              t("editor.form"),
            ),
            h(
              "button",
              { type: "button", className: `rstr-seg${mode === "source" ? " rstr-seg-on" : ""}`, onClick: () => setMode("source") },
              t("editor.source"),
            ),
          ),
          h(Select, {
            value: format,
            onChange: setFormat,
            options: FORMATS.map((value) => ({ value, label: value.toUpperCase() })),
          }),
        ),
      );

      if (mode === "source") {
        body.push(
          h("p", { className: "rstr-hint" }, t("editor.sourceHint")),
          h(TextArea, { value: source, onChange: setSource, rows: 22, mono: true }),
        );
      } else {
        body.push(
          h(
            "div",
            { className: "rstr-grid" },
            h(Field, { label: t("editor.id"), hint: t("editor.idHint") }, h(TextInput, { value: draft.id, onChange: (value) => update({ id: value }), mono: true })),
            h(Field, { label: t("editor.titleField") }, h(TextInput, { value: draft.title, onChange: (value) => update({ title: value }) })),
            h(Field, { label: t("editor.version") }, h(TextInput, { value: draft.version, onChange: (value) => update({ version: value }), mono: true })),
            h(Field, { label: t("editor.tags"), hint: t("editor.tagsHint") }, h(TextInput, { value: draft.tags, onChange: (value) => update({ tags: value }) })),
          ),
          h(Field, { label: t("editor.description") }, h(TextArea, { value: draft.description, onChange: (value) => update({ description: value }), rows: 2 })),
          h("div", { className: "rstr-section-title rstr-mt" }, t("editor.members")),
        );

        draft.members.forEach((member, index) => {
          body.push(
            h(
              "div",
              { key: index, className: "rstr-member-editor" },
              h(
                "div",
                { className: "rstr-member-editor-head" },
                h("span", { className: "rstr-step" }, String(index + 1)),
                h(TextInput, { value: member.name, placeholder: t("editor.memberName"), mono: true, onChange: (value) => updateMember(index, { name: value }) }),
                draft.members.length > 1
                  ? h(
                      "button",
                      { type: "button", className: "rstr-btn rstr-btn-danger rstr-btn-sm", onClick: () => setDraft((current) => ({ ...current, members: current.members.filter((_, position) => position !== index) })) },
                      t("editor.removeMember"),
                    )
                  : null,
              ),
              h(
                "div",
                { className: "rstr-grid" },
                h(Field, { label: t("editor.memberRole") }, h(TextInput, { value: member.role, onChange: (value) => updateMember(index, { role: value }) })),
                h(Field, { label: t("editor.memberTitle") }, h(TextInput, { value: member.title, onChange: (value) => updateMember(index, { title: value }) })),
                h(Field, { label: t("editor.memberProvider") }, h(TextInput, { value: member.provider, mono: true, onChange: (value) => updateMember(index, { provider: value }) })),
                h(Field, { label: t("editor.memberModel") }, h(TextInput, { value: member.model, mono: true, onChange: (value) => updateMember(index, { model: value }) })),
                h(
                  Field,
                  { label: t("editor.memberEffort") },
                  h(Select, {
                    value: member.reasoningEffort,
                    onChange: (value) => updateMember(index, { reasoningEffort: value }),
                    options: [{ value: "", label: "—" }, ...EFFORTS.map((value) => ({ value, label: value }))],
                  }),
                ),
                h(Field, { label: t("editor.memberPolicy") }, h(TextInput, { value: member.toolPolicy, mono: true, onChange: (value) => updateMember(index, { toolPolicy: value }) })),
              ),
              h(Field, { label: t("editor.memberScope"), hint: t("editor.memberScopeHint") }, h(TextInput, { value: member.tools, mono: true, onChange: (value) => updateMember(index, { tools: value }) })),
              h(Field, { label: t("editor.memberDescription") }, h(TextInput, { value: member.description, onChange: (value) => updateMember(index, { description: value }) })),
              h(Field, { label: t("editor.memberAliases"), hint: t("editor.listHint") }, h(TextInput, { value: member.aliases, mono: true, onChange: (value) => updateMember(index, { aliases: value }) })),
              h(Field, { label: t("editor.memberSkills"), hint: t("editor.skillsHint") }, h(TextInput, { value: member.skills, mono: true, onChange: (value) => updateMember(index, { skills: value }) })),
              h(Field, { label: t("editor.memberExamples"), hint: t("editor.examplesHint") }, h(TextArea, { value: member.examples, rows: 3, onChange: (value) => updateMember(index, { examples: value }) })),
              h(Field, { label: t("editor.memberPrompt") }, h(TextArea, { value: member.systemPrompt, rows: 8, onChange: (value) => updateMember(index, { systemPrompt: value }) })),
            ),
          );
        });

        body.push(
          h(
            "button",
            { type: "button", className: "rstr-btn rstr-btn-dashed", onClick: () => setDraft((current) => ({ ...current, members: [...current.members, blankDraft().members[0]] })) },
            `+ ${t("editor.addMember")}`,
          ),
        );

        const captain = draft.captain ?? { name: "", description: "", personaPrefix: "", provider: "", model: "", reasoningEffort: "" };
        const updateCaptain = (patch) => setDraft((current) => ({ ...current, captain: { ...captain, ...patch } }));
        body.push(h("div", { className: "rstr-section-title rstr-mt" }, t("editor.captain")));
        body.push(h("p", { className: "rstr-hint" }, t("editor.captainHint")));
        body.push(
          h(
            "div",
            { className: "rstr-grid" },
            h(Field, { label: t("editor.captainName"), hint: t("editor.captainNameHint") }, h(TextInput, { value: captain.name, mono: true, onChange: (value) => updateCaptain({ name: value }) })),
            h(Field, { label: t("editor.captainDescription") }, h(TextInput, { value: captain.description, onChange: (value) => updateCaptain({ description: value }) })),
            h(Field, { label: t("editor.captainProvider") }, h(TextInput, { value: captain.provider, mono: true, onChange: (value) => updateCaptain({ provider: value }) })),
            h(Field, { label: t("editor.captainModel") }, h(TextInput, { value: captain.model, mono: true, onChange: (value) => updateCaptain({ model: value }) })),
            h(
              Field,
              { label: t("editor.captainEffort") },
              h(Select, {
                value: captain.reasoningEffort,
                onChange: (value) => updateCaptain({ reasoningEffort: value }),
                options: [{ value: "", label: "—" }, ...EFFORTS.map((value) => ({ value, label: value }))],
              }),
            ),
          ),
        );
        body.push(
          h(Field, { label: t("editor.captainPersona"), hint: t("editor.captainPersonaHint") }, h(TextArea, { value: captain.personaPrefix, rows: 4, onChange: (value) => updateCaptain({ personaPrefix: value }) })),
        );
      }

      if (Object.keys(validation).length > 0) {
        body.push(h("p", { className: "rstr-hint rstr-hint-warn" }, Object.values(validation).map((key) => t(key)).join(" ")));
      }
      if (failure !== null) {
        body.push(
          h(
            "div",
            { className: "rstr-error" },
            h("p", { className: "rstr-error-title" }, t("editor.failedTitle")),
            h("code", { className: "rstr-code" }, failure.code),
            h(DiagnosticList, { items: failure.diagnostics }),
          ),
        );
      }
      if (confirmOverwrite !== null) {
        body.push(
          h(
            "div",
            { className: "rstr-confirm" },
            h("p", null, t("editor.overwriteTitle")),
            h("p", { className: "rstr-muted" }, t("editor.overwriteBody", { file: confirmOverwrite.existing?.file ?? "" })),
            h(
              "button",
              { type: "button", className: "rstr-btn rstr-btn-danger", onClick: () => { setConfirmOverwrite(null); save(true); } },
              t("editor.overwriteConfirm"),
            ),
          ),
        );
      }

      const disabled = busy || !loaded || Object.keys(validation).length > 0;

      return h(
        Modal,
        {
          title: existing ? t("editor.editTitle", { id: existing.id }) : t("editor.createTitle"),
          onClose,
          width: "820px",
          footer: h(
            "div",
            { className: "rstr-modal-foot-actions" },
            h("button", { type: "button", className: "rstr-btn", onClick: onClose }, t("editor.cancel")),
            h("button", { type: "button", className: "rstr-btn rstr-btn-primary", disabled, onClick: () => save(false) }, busy ? t("editor.saving") : t("editor.save")),
          ),
        },
        body,
      );
    }

    /** 表单侧的"能省一次往返"的最小校验：权威校验仍在 Host。 */
    function validateDraft(draft) {
      const problems = {};
      if (draft.id.trim() === "") problems.id = "editor.emptyId";
      if (draft.title.trim() === "") problems.title = "editor.emptyTitle";
      if (draft.members.length === 0) problems.members = "editor.emptyMembers";
      else if (draft.members.some((member) => member.name.trim() === "")) problems.memberName = "editor.emptyMemberName";
      else if (draft.members.some((member) => member.systemPrompt.trim() === "")) problems.memberPrompt = "editor.emptyMemberPrompt";
      return problems;
    }

    /* ------------------------------------------------------------------ */
    /* 导入 / 删除                                                          */
    /* ------------------------------------------------------------------ */

    function ImportDialog({ targets, initialRoot, onClose, onDone }) {
      useTranslation();
      const [text, setText] = useState("");
      const [rootDir, setRootDir] = useState(initialRoot);
      const [busy, setBusy] = useState(false);
      const [failure, setFailure] = useState(null);

      async function submit() {
        setBusy(true);
        setFailure(null);
        const trimmed = text.trim();
        const format = trimmed.startsWith("{") ? "json" : "yaml";
        const result = await mutate({ action: "import", rootDir, text, format, overwrite: false });
        setBusy(false);
        if (result.ok) {
          onDone(result.body?.file ?? "");
          return;
        }
        setFailure({ code: result.body?.error?.code ?? "import-failed", diagnostics: result.body?.diagnostics ?? [] });
      }

      return h(
        Modal,
        {
          title: t("importDialog.title"),
          onClose,
          width: "760px",
          footer: h(
            "div",
            { className: "rstr-modal-foot-actions" },
            h("button", { type: "button", className: "rstr-btn", onClick: onClose }, t("editor.cancel")),
            h("button", { type: "button", className: "rstr-btn rstr-btn-primary", disabled: busy || text.trim() === "", onClick: submit }, busy ? t("editor.saving") : t("importDialog.submit")),
          ),
        },
        h("p", { className: "rstr-hint" }, t("importDialog.hint")),
        h(Field, { label: t("importDialog.target") }, h(Select, { value: rootDir, onChange: setRootDir, options: targets.map((target) => ({ value: target.rootDir, label: target.label })) })),
        h(TextArea, { value: text, onChange: setText, rows: 16, mono: true, placeholder: t("importDialog.placeholder") }),
        failure !== null
          ? h("div", { className: "rstr-error" }, h("code", { className: "rstr-code" }, failure.code), h(DiagnosticList, { items: failure.diagnostics }))
          : null,
      );
    }

    function DeleteDialog({ roster, onClose, onDone }) {
      useTranslation();
      const [busy, setBusy] = useState(false);
      const [failure, setFailure] = useState(null);

      async function submit() {
        setBusy(true);
        const result = await mutate({ action: "delete", rootDir: roster.rootDir, id: roster.id });
        setBusy(false);
        if (result.ok) onDone();
        else setFailure(result.body?.error?.code ?? "delete-failed");
      }

      return h(
        Modal,
        {
          title: t("delete.title", { id: roster.id }),
          onClose,
          footer: h(
            "div",
            { className: "rstr-modal-foot-actions" },
            h("button", { type: "button", className: "rstr-btn", onClick: onClose }, t("delete.cancel")),
            h("button", { type: "button", className: "rstr-btn rstr-btn-danger", disabled: busy, onClick: submit }, t("delete.confirm")),
          ),
        },
        h("p", null, t("delete.body", { file: roster.file })),
        failure !== null ? h("code", { className: "rstr-code" }, failure) : null,
      );
    }

    /* ------------------------------------------------------------------ */
    /* 主面板                                                              */
    /* ------------------------------------------------------------------ */

    // 面板本身拿不到 ctx：这里由 apply() 把宿主服务放进来，供设置弹窗使用。
    const HOST = { form: null };


    /**
     * 档案库：像插件市场那样，把「能用的档案」全部摊在一张表里。
     *
     * 本机的与订阅来源的放在一起，因为人找的是能力，不是"这东西归谁管"。两种看法：
     * 按来源聚合（知道自己订了什么）、平铺（只想横向比较）。两种都只是**视图**，
     * 不改变数据，也不写回任何文件。
     *
     * 查询走后端排序（`/search`）：前端再写一套打分，两处迟早给出不同顺序。
     * 标签筛选是「且」，与档案页签的标签池同一语义。
     */
    function CatalogTab({ onOpen, onPullSpace, onFavorite, onToast }) {
      useTranslation();
      const [mode, setMode] = useState("source");
      const [query, setQuery] = useState("");
      const [selected, setSelected] = useState(() => new Set());
      const [catalog, setCatalog] = useState({ status: "loading", entries: [], counts: null });
      const [hits, setHits] = useState(null);
      const [pulling, setPulling] = useState("");
      const [updates, setUpdates] = useState(null);
      const [nonce, setNonce] = useState(0);

      useEffect(() => {
        let alive = true;
        setCatalog((current) => ({ ...current, status: "loading" }));
        readJson(CATALOG_ROUTE)
          .then((result) => {
            if (!alive) return;
            setCatalog({
              status: result.ok ? "ready" : "error",
              entries: result.body?.entries ?? [],
              counts: result.body?.counts ?? null,
            });
          })
          .catch(() => {
            if (alive) setCatalog({ status: "error", entries: [], counts: null });
          });
        return () => {
          alive = false;
        };
      }, [nonce]);

      useEffect(() => {
        const needle = query.trim();
        if (needle.length < 2) {
          setHits(null);
          return;
        }
        const controller = new AbortController();
        // 停止输入之后才问：每敲一个字打一次，等于自己给自己造并发。
        const timer = setTimeout(() => {
          setHits((current) => ({ status: "loading", matches: current?.matches ?? [] }));
          readJson(`${SEARCH_ROUTE}?q=${encodeURIComponent(needle)}`, { signal: controller.signal })
            .then((result) => {
              if (controller.signal.aborted) return;
              setHits({ status: result.ok ? "ready" : "error", matches: result.body?.matches ?? [] });
            })
            .catch(() => {
              if (!controller.signal.aborted) setHits({ status: "error", matches: [] });
            });
        }, 240);
        return () => {
          clearTimeout(timer);
          controller.abort();
        };
      }, [query]);

      const pool = useMemo(() => {
        const counts = new Map();
        for (const entry of catalog.entries) {
          for (const tag of entry.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      }, [catalog.entries]);

      // 哪些远端档案本机已经有了：按 id 对齐（同一个空间里 id 唯一）。
      const installed = useMemo(() => {
        const set = new Set();
        for (const entry of catalog.entries) if (entry.scope === "local") set.add(entry.rosterId);
        return set;
      }, [catalog.entries]);

      const entries = hits !== null && hits.status === "ready" ? hits.matches : catalog.entries;
      const filtered = useMemo(() => {
        return entries.filter((entry) => {
          for (const tag of selected) if (!(entry.tags ?? []).includes(tag)) return false;
          return true;
        });
      }, [entries, selected]);

      const groups = useMemo(() => {
        if (mode === "flat") return [{ key: "flat", title: "", scope: "mixed", entries: filtered }];
        const map = new Map();
        for (const entry of filtered) {
          const key = entry.scope === "local" ? "__local" : `c:${entry.collectionId ?? ""}`;
          if (!map.has(key)) {
            map.set(key, {
              key,
              scope: entry.scope,
              id: entry.scope === "local" ? t("catalog.local") : entry.collectionId ?? "",
              title: entry.scope === "local" ? "" : entry.collectionTitle ?? "",
              entries: [],
            });
          }
          map.get(key).entries.push(entry);
        }
        // 空间头上只放两件能当场核对的事实：有几份、其中几份本机已经有。
        return [...map.values()].map((group) => ({
          ...group,
          installed: group.entries.filter((entry) => installed.has(entry.rosterId)).length,
        }));
      }, [filtered, mode, installed, t]);

      // 本地空间的更新检查：账本在各自库根；一次检查把所有本地库都问一遍。
      //
      // 三种"不是干净"要分开报，否则会把它们都显示成"已是最新"：
      //   fastForward —— 只有远端改了，可以直接覆盖；
      //   pending     —— 冲突或远端删除，必须人看（本工具绝不自动合并）；
      //   unverified  —— 远端没回话（网络/限频），根本没核对上；
      //   unledgered  —— 这份副本没有账本（不是 clone 拉的），没有基线可比。
      async function checkUpdates() {
        const roots = [...new Set(catalog.entries.filter((entry) => entry.scope === "local" && entry.rootDir).map((entry) => entry.rootDir))];
        if (roots.length === 0) {
          setUpdates({ pending: 0, fastForward: 0, unverified: 0, unledgered: 0 });
          return;
        }
        if (updates !== null && updates.fastForward > 0) {
          let applied = 0;
          for (const rootDir of roots) {
            const response = await readJson(SPACE_UPDATE_ROUTE, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ rootDir, action: "apply" }),
            });
            applied += Array.isArray(response.body?.applied) ? response.body.applied.length : 0;
          }
          setUpdates(null);
          setNonce((value) => value + 1);
          onToast?.(t("catalog.updatesApplied", { count: String(applied) }));
          return;
        }
        let pending = 0;
        let fastForward = 0;
        let unverified = 0;
        let unledgered = 0;
        for (const rootDir of roots) {
          const response = await readJson(SPACE_UPDATE_ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ rootDir, action: "check" }),
          });
          if (response.body?.ok !== true) {
            const code = response.body?.code;
            if (code === "no-origin-ledger" || code === "origin-ledger-broken") unledgered += 1;
            else unverified += 1;
            continue;
          }
          pending += Number(response.body.pending ?? 0);
          fastForward += Number(response.body.fastForward ?? 0);
          unverified += Number(response.body.unverified ?? 0);
        }
        setUpdates({ pending, fastForward, unverified, unledgered });
      }

      function toggleTag(tag) {
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(tag)) next.delete(tag);
          else next.add(tag);
          return next;
        });
      }

      function why(entry) {
        if (Array.isArray(entry.hits) && entry.hits.length > 0) {
          return entry.hits.map((hit) => `${hit.label}：${hit.text}`).join(" · ");
        }
        if (Array.isArray(entry.memberRoles) && entry.memberRoles.length > 0) return entry.memberRoles.join(" · ");
        return entry.description ?? "";
      }

      function row(entry) {
        const here = entry.scope === "local" || entry.installed === true || installed.has(entry.rosterId);
        return h(
          "article",
          { key: `${entry.scope}:${entry.collectionId ?? ""}:${entry.rosterId}`, className: "rstr-row" },
          h(
            "div",
            { className: "rstr-row-body" },
            h("code", { className: "rstr-row-id", title: entry.rosterId }, entry.rosterId),
            h(
              "div",
              { className: "rstr-row-text" },
              h("h3", { className: "rstr-row-title" }, entry.title === "" ? entry.rosterId : entry.title),
              h("p", { className: "rstr-row-desc" }, why(entry)),
            ),
            h(
              "div",
              { className: "rstr-row-stats" },
              h("span", { className: "rstr-stat" }, t("catalog.members", { count: String(entry.members ?? 0) })),
              entry.scope === "remote" && installed.has(entry.rosterId)
                ? h("span", { className: "rstr-row-here" }, t("catalog.here"))
                : null,
              // 本机组里每行再写一次「本机」是废话：所在的分组头已经说了。
              entry.scope === "local"
                ? null
                : h(
                    "span",
                    { className: "rstr-stat" },
                    t("catalog.remoteFrom", { collection: entry.collectionTitle ?? entry.collectionId ?? "" }),
                  ),
            ),
            h(
              "div",
              { className: "rstr-row-actions" },
              // 拉取只能整空间拉：单独拉一份会把远端摊平成本地孤本，路径也对不上。
              // 所以没装的行只说明状态，不提供会骗人的按钮。
              here
                ? h("button", { type: "button", className: "rstr-btn rstr-btn-sm", onClick: () => onOpen(entry.rosterId) }, t("catalog.open"))
                : h("span", { className: "rstr-stat rstr-row-absent" }, t("catalog.notInstalled")),
              here && typeof onFavorite === "function" && entry.rootDir
                ? h(
                    "button",
                    {
                      type: "button",
                      className: `rstr-star${entry.favorite ? " rstr-star-on" : ""}`,
                      "aria-pressed": entry.favorite === true,
                      "aria-label": entry.favorite ? t("catalog.unfavorite") : t("catalog.favorite"),
                      title: entry.favorite ? t("catalog.unfavorite") : t("catalog.favorite"),
                      onClick: async () => {
                        await onFavorite(entry);
                        setNonce((value) => value + 1);
                      },
                    },
                    entry.favorite ? "\u2605" : "\u2606",
                  )
                : null,
            ),
          ),
        );
      }

      return h(
        "div",
        { className: "rstr-catalog" },
        h(
          "div",
          { className: "rstr-toolbar" },
          h("input", {
            className: "rstr-input rstr-search",
            value: query,
            placeholder: t("catalog.placeholder"),
            "aria-label": t("catalog.placeholder"),
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== "Escape") return;
              setQuery("");
              event.stopPropagation();
            },
          }),
          h(
            "div",
            { className: "rstr-toolbar-actions" },
            h(
              "div",
              { className: "rstr-segmented", role: "group", "aria-label": t("catalog.mode") },
              h(
                "button",
                {
                  type: "button",
                  className: `rstr-seg${mode === "source" ? " rstr-seg-on" : ""}`,
                  "aria-pressed": mode === "source",
                  onClick: () => setMode("source"),
                },
                t("catalog.modeSource"),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: `rstr-seg${mode === "flat" ? " rstr-seg-on" : ""}`,
                  "aria-pressed": mode === "flat",
                  onClick: () => setMode("flat"),
                },
                t("catalog.modeFlat"),
              ),
            ),
            h(
              "button",
              { type: "button", className: "rstr-btn rstr-btn-sm", onClick: () => setNonce((value) => value + 1) },
              t("catalog.refresh"),
            ),
          ),
        ),
        pool.length === 0
          ? null
          : h(
              "div",
              { className: "rstr-catalog-tags" },
              pool.map(([tag, count]) =>
                h(
                  "button",
                  {
                    key: tag,
                    type: "button",
                    className: `rstr-tag${selected.has(tag) ? " rstr-tag-on" : ""}`,
                    "aria-pressed": selected.has(tag),
                    onClick: () => toggleTag(tag),
                  },
                  h("span", { className: "rstr-tag-name" }, tag),
                  h("span", { className: "rstr-tag-count" }, String(count)),
                ),
              ),
            ),
        h(
          "p",
          { className: "rstr-results-head" },
          hits !== null && hits.status === "loading" && query.trim() !== ""
            ? t("catalog.searching")
            : t("catalog.counts", {
                shown: String(filtered.length),
                total: String(entries.length),
                local: String(catalog.counts?.local ?? 0),
                remote: String(catalog.counts?.remote ?? 0),
              }),
        ),
        catalog.status === "error" ? h("p", { className: "rstr-muted" }, t("catalog.failed")) : null,
        filtered.length === 0
          ? h("p", { className: "rstr-muted" }, t("catalog.empty"))
          : groups.map((group) =>
              h(
                "div",
                { key: group.key, className: "rstr-space" },
                mode === "flat"
                  ? null
                  : h(
                      "div",
                      { className: "rstr-space-head" },
                      h("code", { className: "rstr-space-id", title: group.id }, group.id),
                      h("span", { className: "rstr-space-title" }, group.title),
                      h(
                        "span",
                        { className: "rstr-space-facts" },
                        t("catalog.facts", {
                          count: String(group.entries.length),
                          installed: String(group.installed),
                        }),
                      ),
                      group.scope === "local"
                        ? h(
                            "button",
                            {
                              type: "button",
                              className: "rstr-btn rstr-btn-sm rstr-btn-ghost",
                              disabled: updates !== null && updates.fastForward === 0 && updates.pending + updates.unverified + updates.unledgered > 0,
                              onClick: checkUpdates,
                            },
                            updates === null
                              ? t("catalog.checkUpdates")
                              : updates.fastForward > 0
                                ? t("catalog.applyUpdates", { count: String(updates.fastForward) })
                                : updates.pending > 0
                                  ? t("catalog.conflicts", { count: String(updates.pending) })
                                  : updates.unverified > 0
                                    ? t("catalog.unverified", { count: String(updates.unverified) })
                                    : updates.unledgered > 0
                                      ? t("catalog.noBaseline")
                                      : t("catalog.upToDate"),
                          )
                        : null,
                      group.scope === "remote" && typeof onPullSpace === "function"
                        ? h(
                            "button",
                            {
                              type: "button",
                              className: "rstr-btn rstr-btn-sm rstr-btn-ghost",
                              disabled: pulling === `space:${group.key}`,
                              onClick: async () => {
                                setPulling(`space:${group.key}`);
                                try {
                                  await onPullSpace(group.key.slice(2));
                                  setNonce((value) => value + 1);
                                } finally {
                                  setPulling("");
                                }
                              },
                            },
                            t("catalog.pullSpace"),
                          )
                        : null,
                    ),
                group.entries.map(row),
              ),
            ),
      );
    }

    function Panel() {
      useTranslation();
      const library = useLibrary();
      const [tab, setTab] = useState("rosters");
      // 档案页默认只列收藏：拉一整个空间会带来二十份，全铺在首屏等于没有首屏。
      const [favOnly, setFavOnly] = useState(true);
      const [query, setQuery] = useState("");
      const [selectedTags, setSelectedTags] = useState(() => new Set());
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [editor, setEditor] = useState(null);
      const [importing, setImporting] = useState(false);
      const [removing, setRemoving] = useState(null);
      const [creatingTeam, setCreatingTeam] = useState(null);
      const [toast, setToast] = useState(null);

      useEffect(() => {
        if (toast === null) return;
        const timer = setTimeout(() => setToast(null), 4000);
        return () => clearTimeout(timer);
      }, [toast]);

      const snapshot = library.data;
      const rosters = useMemo(() => {
        return snapshot?.workspaces?.flatMap((workspace) =>
          (workspace.rosters ?? []).map((roster) => ({ ...roster, rootDir: workspace.rootDir })),
        ) ?? [];
      }, [snapshot]);

      const favorites = useMemo(() => rosters.filter((roster) => roster.favorite === true), [rosters]);

      // 标签池：整个库出现过的标签 + 各标签档案数，按出现次数降序（同数按字母）。
      const tagPool = useMemo(() => {
        const counts = new Map();
        for (const roster of rosters) {
          for (const tag of roster.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      }, [rosters]);

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return rosters.filter((roster) => {
          if (favOnly && roster.favorite !== true) return false;
          if (selectedTags.size > 0) {
            const tags = roster.tags ?? [];
            // 多选是“且”：勾了 revision 和 testing，就只看同时带这两个标签的档案。
            for (const tag of selectedTags) if (!tags.includes(tag)) return false;
          }
          if (needle === "") return true;
          return [roster.id, roster.title, roster.description, ...(roster.tags ?? []), ...(roster.members ?? []).map((member) => member.name)]
            .filter((value) => typeof value === "string")
            .some((value) => value.toLowerCase().includes(needle));
        });
      }, [rosters, query, selectedTags, favOnly]);

      function toggleTag(tag) {
        setSelectedTags((current) => {
          const next = new Set(current);
          if (next.has(tag)) next.delete(tag);
          else next.add(tag);
          return next;
        });
      }

      function clearTags() {
        setSelectedTags(() => new Set());
      }

      const teams = snapshot?.teams?.teams ?? [];
      const hints = snapshot?.hints ?? [];
      const attention = hints.filter((hint) => hint.severity !== "info").length;
      const targets = useMemo(
        () =>
          (snapshot?.workspaces ?? []).map((workspace) => ({
            rootDir: workspace.rootDir,
            label:
              workspace.scope === "global"
                ? `${t("settings.globalLibrary")} — ${workspace.rootDir}`
                : `${workspace.rootDir}${workspace.title ? ` — ${workspace.title}` : ""}`,
          })),
        [snapshot],
      );
      const defaultRoot =
        snapshot?.workspaces?.find((workspace) => workspace.missing !== true)?.rootDir ?? targets[0]?.rootDir ?? "";

      /**
       * 收藏 / 取消收藏。收藏只改库根的点文件，不动档案本体，也不动团队状态。
       * 失败就直说：星标停在原样比"看起来成功了"诚实。
       */
      async function toggleFavorite(target) {
        if (!target || typeof target.rootDir !== "string" || target.rootDir === "") return;
        const id = typeof target.id === "string" ? target.id : target.rosterId;
        try {
          const result = await readJson(FAVORITES_ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ rootDir: target.rootDir, id, favorite: target.favorite !== true }),
          });
          if (!result.ok) {
            setToast(`${t("misc.failed")} (${String(result.status)})`);
            return;
          }
          library.reload();
        } catch {
          setToast(t("misc.failed"));
        }
      }

      async function copyPayload(roster) {
        const payload = {
          plan: {
            members: roster.members.map((member) => {
              const entry = { name: member.name, role: member.role || member.name };
              if (member.provider) entry.provider = member.provider;
              if (member.model) entry.model = member.model;
              if (member.reasoningEffort && member.reasoningEffort !== "default") entry.reasoningEffort = member.reasoningEffort;
              if (member.toolPolicy) entry.tool_policy = member.toolPolicy;
              return entry;
            }),
            tasks: [],
          },
        };
        try {
          await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
          setToast(t("roster.copied"));
        } catch {
          setToast(t("roster.copyFailed"));
        }
      }

      const space = (snapshot?.workspaces ?? []).map((workspace) => workspace.space).find((item) => item && item.id)?.id ?? "";

      const header = h(
        "header",
        { className: "rstr-head" },
        h(
          "div",
          { className: "rstr-head-main" },
          h("h1", { className: "rstr-h1" }, t("panel.title")),
          // 抬头只放"这库里有什么"：几份档案、几个人、几支队在跑、属于哪个组织。
          h(
            "div",
            { className: "rstr-head-meta" },
            h("span", null, h("b", null, String(snapshot?.summary?.rosters ?? 0)), " ", t("panel.metaRosters")),
            h("span", null, h("b", null, String(snapshot?.summary?.members ?? 0)), " ", t("panel.metaMembers")),
            h("span", null, h("b", null, String(snapshot?.summary?.teams ?? 0)), " ", t("panel.metaTeams")),
            space === "" ? null : h("span", null, t("panel.metaSpace", { name: space })),
          ),
        ),
        h(
          "div",
          { className: "rstr-head-actions" },
          // 头部只留一个入口：导入/新建属于档案页，刷新索引属于档案源，各自回到自己的页签。
          h(
            "button",
            {
              type: "button",
              className: "rstr-btn rstr-settings-btn",
              onClick: () => setSettingsOpen(true),
              title: t("panel.settings"),
            },
            h("span", { className: "rstr-settings-glyph", "aria-hidden": "true" }, "\u2699"),
            t("panel.settings"),
          ),
        ),
      );

      if (library.status === "loading") {
        return h("div", { className: "rstr-page" }, header, h("p", { className: "rstr-muted" }, t("panel.loading")));
      }

      if (library.status === "error" && snapshot === null) {
        return h(
          "div",
          { className: "rstr-page" },
          header,
          h(
            "div",
            { className: "rstr-error" },
            h("p", { className: "rstr-error-title" }, t("panel.errorTitle")),
            h("button", { type: "button", className: "rstr-btn", onClick: library.reload }, t("panel.retry")),
          ),
        );
      }

      const tabs = h(
        "div",
        { className: "rstr-tabs", role: "tablist" },
        [
          ["rosters", t("panel.tabsRosters"), favorites.length],
          ["catalog", t("panel.tabsCatalog"), null],
          ["teams", t("panel.tabsTeams"), teams.length],
          // 只有真正要用户处理的问题才计数：info 只是说明，不该在页签上挂数字。
          ["health", t("panel.tabsDiagnostics"), attention],
        ].map(([value, label, count]) =>
          h(
            "button",
            {
              key: value,
              type: "button",
              role: "tab",
              "aria-selected": tab === value,
              className: `rstr-tab${tab === value ? " rstr-tab-on" : ""}`,
              onClick: () => setTab(value),
            },
            label,
            count === null ? null : h("span", { className: "rstr-tab-count" }, String(count)),
          ),
        ),
      );

      let content = null;

      if (tab === "catalog") {
        content = h(CatalogTab, {
          onToast: setToast,
          onOpen: (rosterId) => {
            setTab("rosters");
            setQuery(rosterId);
          },
          onFavorite: toggleFavorite,
          onPullSpace: async (collectionId) => {
            try {
              const result = await readJson(INSTALL_SPACE_ROUTE, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ collection: collectionId }),
              });
              if (!result.ok || result.body === null) {
                setToast(`${t("misc.failed")} (${String(result.status)})`);
                return;
              }
              const body = result.body;
              const summary = t("catalog.pulledSpace", {
                files: String((body.written ?? []).length),
                skipped: String((body.skipped ?? []).length),
              });
              setToast(summary);
              library.reload();
            } catch {
              setToast(t("misc.failed"));
            }
          },
        });
      }

      if (tab === "rosters") {
        // 一份都没收藏、但库里明明有档案：这是「还没挑」，不是「还没有」——两种空态得说不同的话。
        const noFavorites = rosters.length > 0 && favorites.length === 0 && favOnly;
        if (noFavorites) {
          content = h(
            "div",
            { className: "rstr-empty-wrap" },
            h(EmptyState, {
              title: t("panel.emptyFavoritesTitle"),
              body: t("panel.emptyFavoritesBody"),
              cta: t("panel.emptyFavoritesCta"),
              onCta: () => setTab("catalog"),
            }),
          );
        } else if (rosters.length === 0) {
          // 空状态与列表共享同一条左沿：页面本身 padding 为 0，留白由各页签自己给。
          content = h(
            "div",
            { className: "rstr-empty-wrap" },
            h(EmptyState, {
              title: t("panel.emptyTitle"),
              body: t("panel.emptyBody"),
              cta: targets.length === 0 ? undefined : t("panel.emptyCta"),
              onCta: () => setEditor({ roster: null, rootDir: defaultRoot }),
            }),
          );
        } else {
          content = h(
            "div",
            { className: "rstr-rosters" },
            h("aside", { className: "rstr-tagpool", "aria-label": t("panel.tagPool") }, [
              h("span", { className: "rstr-tagpool-title" }, t("panel.tagPool")),
              tagPool.length === 0
                ? h("p", { className: "rstr-muted rstr-small" }, t("panel.tagPoolEmpty"))
                : h(
                    "div",
                    { className: "rstr-tagpool-list" },
                    tagPool.map(([tag, count]) =>
                      h(
                        "button",
                        {
                          key: tag,
                          type: "button",
                          className: `rstr-tag${selectedTags.has(tag) ? " rstr-tag-on" : ""}`,
                          "aria-pressed": selectedTags.has(tag),
                          onClick: () => toggleTag(tag),
                        },
                        h("span", { className: "rstr-tag-name" }, tag),
                        h("span", { className: "rstr-tag-count" }, String(count)),
                      ),
                    ),
                  ),
              selectedTags.size === 0
                ? null
                : h(
                    "button",
                    { type: "button", className: "rstr-btn rstr-btn-sm rstr-tag-clear", onClick: clearTags },
                    t("panel.tagClear"),
                  ),
            ]),
            h(
              "div",
              { className: "rstr-rosters-main" },
              h(
                "div",
                { className: "rstr-toolbar" },
                h("input", {
                  className: "rstr-input rstr-search",
                  value: query,
                  placeholder: t("panel.searchPlaceholder"),
                  "aria-label": t("panel.search"),
                  onChange: (event) => setQuery(event.target.value),
                }),
                h(
                  "div",
                  { className: "rstr-toolbar-actions" },
                  h(
                    "div",
                    { className: "rstr-segmented", role: "group", "aria-label": t("panel.favFilter") },
                    h(
                      "button",
                      {
                        type: "button",
                        className: `rstr-seg${favOnly ? " rstr-seg-on" : ""}`,
                        "aria-pressed": favOnly,
                        onClick: () => setFavOnly(true),
                      },
                      t("panel.favOnly", { count: String(favorites.length) }),
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: `rstr-seg${favOnly ? "" : " rstr-seg-on"}`,
                        "aria-pressed": !favOnly,
                        onClick: () => setFavOnly(false),
                      },
                      t("panel.favAll", { count: String(rosters.length) }),
                    ),
                  ),
                  h(
                    "button",
                    { type: "button", className: "rstr-btn", onClick: () => setImporting(true), disabled: targets.length === 0 },
                    t("panel.import"),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "rstr-btn rstr-btn-primary",
                      onClick: () => setEditor({ roster: null, rootDir: defaultRoot }),
                      disabled: targets.length === 0,
                    },
                    t("panel.create"),
                  ),
                ),
              ),
              filtered.length === 0
                ? h("p", { className: "rstr-muted" }, t("panel.noMatch"))
                : h(
                    "div",
                    { className: "rstr-cards" },
                    filtered.map((roster) =>
                    h(RosterCard, {
                      key: `${roster.rootDir}::${roster.id}`,
                      roster,
                      deployment: snapshot?.deployments?.[roster.id],
                      captainReport: (snapshot?.captain?.reports ?? []).find(
                        (item) => item.rosterId === roster.id && item.rootDir === roster.rootDir,
                      ),
                      sessions: snapshot?.sessions?.sessions ?? [],
                      workspaces: snapshot?.hostWorkspaces ?? [],
                      onToast: setToast,
                      onEdit: () => setEditor({ roster, rootDir: roster.rootDir }),
                      onDuplicate: () => setEditor({ roster, rootDir: roster.rootDir, duplicate: true }),
                      onDelete: () => setRemoving(roster),
                      onCopy: copyPayload,
                      onFavorite: toggleFavorite,
                      onCreateTeam: (target) => setCreatingTeam(target),
                    }),
                  ),
              ),
            ),
          );
        }
      }

      if (tab === "teams") {
        content =
          teams.length === 0
            ? h("div", { className: "rstr-empty-wrap" }, h(EmptyState, { title: t("team.emptyTitle"), body: t("team.emptyBody") }))
            : h("div", { className: "rstr-cards" }, teams.map((team) => h(TeamCard, { key: team.id, team })));
      }

      if (tab === "health") {
        content = h(HealthTab, { snapshot });
      }

      const banner =
        attention > 0
          ? h(
              "div",
              { className: "rstr-banner" },
              h("span", null, attention === 1 ? t("panel.bannerOne") : t("panel.bannerMany", { count: attention })),
              h("button", { type: "button", className: "rstr-btn rstr-btn-sm", onClick: () => setTab("health") }, t("panel.bannerCta")),
            )
          : null;

      return h(
        "div",
        { className: "rstr-page" },
        header,
        banner,
        tabs,
        content,
        h(
          "footer",
          { className: "rstr-foot" },
          h("span", { className: "rstr-muted rstr-small" }, `${snapshot?.plugin ?? "agent-roster"} ${snapshot?.version ?? ""}`),
          snapshot?.workspaces?.some((workspace) => workspace.fallbackWorkspace)
            ? h("span", { className: "rstr-muted rstr-small" }, t("panel.workspaceFallback"))
            : null,
        ),
        toast !== null ? h("div", { className: "rstr-toast", role: "status" }, toast) : null,
        settingsOpen
          ? h(
              Modal,
              { title: t("panel.settings"), onClose: () => setSettingsOpen(false), width: "560px" },
              h(SettingsSection, { form: HOST.form, library, onSaved: () => library.reload() }),
            )
          : null,
        editor !== null
          ? h(Editor, {
              target: { roster: editor.roster, rootDir: editor.rootDir, duplicate: editor.duplicate === true },
              onClose: () => setEditor(null),
              onSaved: (file) => {
                setEditor(null);
                setToast(file);
                library.reload();
              },
            })
          : null,
        importing
          ? h(ImportDialog, {
              targets,
              initialRoot: defaultRoot,
              onClose: () => setImporting(false),
              onDone: (file) => {
                setImporting(false);
                setToast(t("import.done", { file }));
                library.reload();
              },
            })
          : null,
        creatingTeam !== null
          ? h(TeamCreateDialog, {
              roster: creatingTeam,
              sessions: snapshot?.sessions?.sessions ?? [],
              workspaces: snapshot?.hostWorkspaces ?? [],
              onClose: () => setCreatingTeam(null),
              onToast: setToast,
              onCreated: () => {
                setCreatingTeam(null);
                library.reload();
              },
            })
          : null,
        removing !== null
          ? h(DeleteDialog, {
              roster: removing,
              onClose: () => setRemoving(null),
              onDone: () => {
                setRemoving(null);
                library.reload();
              },
            })
          : null,
      );
    }

    /** 体检页：配置摘要 + 提示 + 诊断，全部来自快照，不在前端算任何东西。 */
    function HealthTab({ snapshot }) {
      const hints = snapshot?.hints ?? [];
      const diagnostics = (snapshot?.workspaces ?? []).flatMap((workspace) => workspace.diagnostics ?? []);
      const teamDiagnostics = snapshot?.teams?.diagnostics ?? [];

      return h(
        "div",
        { className: "rstr-health" },
        h(
          "div",
          { className: "rstr-config" },
          configRow(
            t("settings.rosterDirs"),
            (snapshot?.config?.rosterDirs ?? []).length > 0
              ? snapshot.config.rosterDirs.join(", ")
              : `${t("settings.globalLibrary")} ${snapshot?.config?.defaultRoot ?? ""}`,
          ),
          configRow(t("settings.dataDir"), snapshot?.config?.dshHome ?? ""),
          configRow(t("settings.stateDir"), snapshot?.teams?.stateDir ?? ""),
          configRow(t("settings.policies"), snapshot?.config?.knownToolPolicies?.length ? t("settings.policiesCount", { count: snapshot.config.knownToolPolicies.length }) : t("settings.policiesNone")),
          configRow(t("settings.version"), snapshot?.version ?? ""),
        ),
        hints.length === 0
          ? h("p", { className: "rstr-muted" }, t("diagnostics.empty"))
          : h(
              "div",
              { className: "rstr-hint-cards" },
              hints.map((hint, index) =>
                h(
                  "article",
                  { key: `${hint.code}-${index}`, className: "rstr-hint-card" },
                  h(
                    "div",
                    { className: "rstr-hint-card-head" },
                    h(Badge, { tone: hint.severity }, severityLabel(hint.severity)),
                    h("strong", null, t(`hint.${hint.code}.title`)),
                  ),
                  h("p", { className: "rstr-muted" }, t(`hint.${hint.code}.body`, hint.params ?? {})),
                ),
              ),
            ),
        h(DiagnosticList, { items: [...diagnostics, ...teamDiagnostics] }),
      );
    }

    function configRow(label, value) {
      return h(
        "div",
        { className: "rstr-config-row" },
        h("span", { className: "rstr-label" }, label),
        h("code", { className: "rstr-code rstr-truncate", title: value }, value === "" ? "—" : value),
      );
    }

    /**
     * 严重度的可读标签。`settings` 里没有 severity 词条，复用诊断里的三个词，
     * 拼不出词条时退回原始值——宁可露出 `warn` 也不显示空标签。
     */
    function severityLabel(severity) {
      const key = `diagnostics.severity${capitalize(severity ?? "info")}`;
      const value = readPath(i18n.dict(), key) ?? readPath(i18n.dicts.en ?? {}, key);
      return value ?? String(severity ?? "info");
    }

    /* ------------------------------------------------------------------ */
    /* 设置页：语言 + 只读配置摘要                                          */
    /* ------------------------------------------------------------------ */

    /**
     * 设置页的一节。
     *
     * 语言的写入走配置表单（`configForms.get(NS)`），因此保存后立即生效、无需重启；
     * 语言之外的配置项只读展示——档案目录与状态目录属于"部署事实"，
     * 让它们出现在两个地方反而会让人分不清哪个生效。
     */
    function SettingsSection({ form, library, onSaved }) {
      useTranslation();
      const [language, setLanguage] = useState(() => readLanguage(form));
      const [region, setRegion] = useState(() => readFormValue(form, "region", "auto"));
      const [mirror, setMirror] = useState(() => readFormValue(form, "registryMirror", ""));
      const [dirs, setDirs] = useState(() => (library?.data?.config?.rosterDirs ?? []).join(", "));
      const [saved, setSaved] = useState("");
      const [version, setVersion] = useState("");

      useEffect(() => {
        if (form?.subscribe === undefined) return undefined;
        const off = form.subscribe(() => {
          setLanguage(readLanguage(form));
          setRegion(readFormValue(form, "region", "auto"));
          setMirror(readFormValue(form, "registryMirror", ""));
        });
        return () => {
          if (typeof off === "function") off();
        };
      }, [form]);

      useEffect(() => {
        setVersion(String(library?.data?.version ?? ""));
        setDirs((library?.data?.config?.rosterDirs ?? []).join(", "));
      }, [library?.data?.version, library?.data?.config?.rosterDirs]);

      useEffect(() => {
        if (saved === "") return undefined;
        const timer = setTimeout(() => setSaved(""), 2000);
        return () => clearTimeout(timer);
      }, [saved]);

      function write(key, value) {
        try {
          form?.set?.(key, value);
          setSaved(t("settings.saved"));
        } catch {
          setSaved(t("settings.saveFailed"));
        }
      }

      function changeLanguage(next) {
        setLanguage(next);
        write("language", next);
      }

      function changeRegion(next) {
        setRegion(next);
        write("region", next);
      }

      function saveMirror() {
        // 镜像地址原样存：路径前缀（公司 Nexus 常带 /repository/npm）是它的一部分，
        // 规整交给宿主（lib/remote.js 的 normalizeRegistryUrl），界面不在写盘前偷偷改写。
        write("registryMirror", mirror.trim());
      }

      function saveDirs() {
        // 逗号/分号/空白都当分隔符：用户从别处粘路径时不该因为分隔符被卡住。
        const list = dirs
          .split(/[,;\n]/)
          .map((item) => item.trim())
          .filter((item) => item !== "");
        write("rosterDirs", list);
        onSaved?.();
      }

      return h(
        "section",
        { className: "rstr-settings" },
        h("h3", { className: "rstr-settings-title" }, t("settings.nav")),
        h("p", { className: "rstr-muted rstr-small" }, t("settings.languageHint")),
        h(
          "div",
          { className: "rstr-settings-row" },
          h("span", { className: "rstr-label" }, t("settings.language")),
          h(
            "div",
            { className: "rstr-segmented" },
            LANGUAGES.map((value) =>
              h(
                "button",
                {
                  key: value,
                  type: "button",
                  className: `rstr-seg${language === value ? " rstr-seg-on" : ""}`,
                  "aria-pressed": language === value,
                  onClick: () => changeLanguage(value),
                },
                value === "auto" ? t("settings.languageAuto") : value === "zh" ? t("settings.languageZh") : t("settings.languageEn"),
              ),
            ),
          ),
        ),
        h(
          "div",
          { className: "rstr-settings-row" },
          h("span", { className: "rstr-label" }, t("settings.region")),
          h(
            "div",
            { className: "rstr-segmented" },
            REGIONS.map((value) =>
              h(
                "button",
                {
                  key: value,
                  type: "button",
                  className: `rstr-seg${region === value ? " rstr-seg-on" : ""}`,
                  "aria-pressed": region === value,
                  onClick: () => changeRegion(value),
                },
                value === "auto" ? t("settings.regionAuto") : value === "global" ? t("settings.regionGlobal") : t("settings.regionChina"),
              ),
            ),
          ),
        ),
        h(
          "div",
          { className: "rstr-settings-field" },
          h("span", { className: "rstr-label" }, t("settings.mirror")),
          h(
            "div",
            { className: "rstr-settings-inline" },
            h("input", {
              className: "rstr-input",
              value: mirror,
              placeholder: t("settings.mirrorPlaceholder"),
              "aria-label": t("settings.mirror"),
              onChange: (event) => setMirror(event.target.value),
            }),
            h("button", { type: "button", className: "rstr-btn rstr-btn-sm", onClick: saveMirror }, t("settings.save")),
          ),
          h("span", { className: "rstr-muted rstr-small" }, t("settings.mirrorHint")),
        ),
        h(
          "div",
          { className: "rstr-settings-field" },
          h("span", { className: "rstr-label" }, t("settings.rosterDirs")),
          h(
            "div",
            { className: "rstr-settings-inline" },
            h("input", {
              className: "rstr-input",
              value: dirs,
              placeholder: library?.data?.config?.defaultRoot ?? "~/.dsh/agent-roster",
              "aria-label": t("settings.rosterDirs"),
              onChange: (event) => setDirs(event.target.value),
            }),
            h("button", { type: "button", className: "rstr-btn rstr-btn-sm", onClick: saveDirs }, t("settings.save")),
          ),
          h("span", { className: "rstr-muted rstr-small" }, t("settings.rosterDirsHint")),
        ),
        h(
          "div",
          { className: "rstr-settings-row" },
          h("span", { className: "rstr-label" }, t("settings.dataDir")),
          h(
            "code",
            { className: "rstr-code rstr-truncate", title: library?.data?.config?.defaultRoot ?? "" },
            library?.data?.config?.dshHome ?? "—",
          ),
        ),
        h(
          "div",
          { className: "rstr-settings-row" },
          h("span", { className: "rstr-label" }, t("settings.stateDir")),
          h("code", { className: "rstr-code rstr-truncate", title: library?.data?.teams?.stateDir ?? "" }, library?.data?.teams?.stateDir ?? "—"),
        ),
        h(
          "div",
          { className: "rstr-settings-row" },
          h("span", { className: "rstr-label" }, t("settings.version")),
          h("code", { className: "rstr-code" }, version),
        ),
        saved === "" ? null : h("p", { className: "rstr-muted rstr-small" }, saved),
      );
    }

    /* 通用读表单值：volatile 字段在 getSnapshot().value 里，取不到就用兜底。 */
    function readFormValue(form, key, fallback) {
      try {
        const value = form?.getSnapshot?.()?.value;
        if (value !== null && typeof value === "object" && typeof value[key] === "string") return value[key];
      } catch {
        /* 表单不可用时按兜底值。 */
      }
      return fallback;
    }

    function readLanguage(form) {
      const value = readFormValue(form, "language", "auto");
      return LANGUAGES.includes(value) ? value : "auto";
    }

    function readFormLanguage(form) {
      let value = "auto";
      try {
        const snapshotValue = form?.getSnapshot?.()?.value;
        if (snapshotValue !== null && typeof snapshotValue === "object" && LANGUAGES.includes(snapshotValue.language)) {
          value = snapshotValue.language;
        }
      } catch {
        /* 表单不可用时按"跟随 DSH"处理。 */
      }
      return value;
    }

    /* ------------------------------------------------------------------ */
    /* 样式                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 一次性注入样式表。
     *
     * 颜色**只用**宿主真实存在的 alias token（见 dsh-client-ui-theme 的 body
     * 变量表），**不写浅色兜底值**：宿主的 token 会随 `body[data-ds-dark-theme]`
     * 整体切换，写死 `#fff`/`#111` 的兜底在暗色下就是白底白字。
     * 需要"淡色底"的地方用 `color-mix(... , transparent)` 自己算，深浅主题都成立。
     * 文本色一律显式给出（不用 inherit），避免继承到与背景同色的文本。
     */
    const CSS = `/* ============================================================
   dsh-agent-roster — panel styles
   Everything derives from host theme aliases (--dsw-alias-*).
   No literal colors: the host owns light/dark.
   ============================================================ */

.rstr-page {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.6;
}

/* ---- masthead --------------------------------------------------------- */

.rstr-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  padding: 24px 28px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.rstr-head-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.rstr-h1 { margin: 0; font-size: 26px; font-weight: 650; letter-spacing: -0.02em; color: var(--dsw-alias-label-primary); }
.rstr-head-meta { display: flex; flex-wrap: wrap; gap: 18px; font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.rstr-head-meta > span > b { font-weight: 600; color: var(--dsw-alias-label-primary); }
.rstr-head-actions { display: flex; gap: 6px; flex-wrap: wrap; }

/* ---- tabs ------------------------------------------------------------- */

.rstr-tabs {
  display: flex;
  gap: 22px;
  padding: 0 28px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--dsw-alias-bg-base);
}
.rstr-tab {
  border: none;
  background: transparent;
  padding: 11px 0 9px;
  font-size: 13px;
  font-family: inherit;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: -1px;
}
.rstr-tab:hover { color: var(--dsw-alias-label-primary); }
.rstr-tab:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.rstr-tab-on { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-state-business-primary); font-weight: 600; }
.rstr-tab-count { font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }

/* ---- banner ----------------------------------------------------------- */

.rstr-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin: 14px 28px 0;
  padding: 9px 12px 9px 14px;
  border-left: 3px solid var(--dsw-alias-state-warn-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}

/* ---- 档案页：标签脊 + 账本 ------------------------------------------- */

.rstr-rosters {
  display: grid;
  grid-template-columns: 176px minmax(0, 1fr);
  align-items: start;
}
.rstr-tagpool {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 16px 12px 20px 20px;
  border-right: 1px solid var(--dsw-alias-border-l1);
  position: sticky;
  top: 41px;
  align-self: start;
  min-width: 0;
}
.rstr-tagpool-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  padding: 0 6px 6px;
}
.rstr-tagpool-list { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.rstr-tag {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  border: none;
  border-left: 2px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  padding: 4px 6px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  border-radius: 0 4px 4px 0;
}
.rstr-tag:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.rstr-tag:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
.rstr-tag-on {
  border-left-color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.rstr-tag-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rstr-tag-count { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.rstr-tag-clear { align-self: flex-start; margin-top: 8px; }

.rstr-rosters-main { display: flex; flex-direction: column; min-width: 0; padding: 16px 28px 28px; gap: 12px; }

/* ---- 工具条 ----------------------------------------------------------- */

.rstr-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.rstr-toolbar-actions { display: flex; gap: 6px; margin-left: auto; }
.rstr-search {
  max-width: 320px;
  border-color: transparent;
  background: var(--dsw-alias-bg-layer-2);
}
.rstr-search:focus-visible { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l3); }

/* ---- 账本（行） ------------------------------------------------------- */

.rstr-catalog { display: flex; flex-direction: column; gap: 10px; padding: 16px 28px 28px; min-width: 0; }

/* 标签池横着排：档案库是"逛"的地方，不该为了几个标签先把屏幕切成两栏。 */
.rstr-catalog-tags { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
/* 标签池在侧栏里是"一列可选的筛选项"，但放进档案库的顶部它就是一枚筛选标签：
   宽度、边框、圆角都得按标签给，不能沿用侧栏那套整行铺满的形态。 */
.rstr-catalog-tags .rstr-tag {
  width: auto;
  flex: 0 0 auto;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
}
.rstr-catalog-tags .rstr-tag-on {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, var(--dsw-alias-border-l2));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
  color: var(--dsw-alias-label-primary);
}
.rstr-catalog .rstr-search { max-width: 560px; }

.rstr-space { display: flex; flex-direction: column; min-width: 0; }
.rstr-space + .rstr-space { margin-top: 24px; }
.rstr-space-head {
  display: grid;
  grid-template-columns: minmax(110px, 176px) minmax(0, 1fr) auto auto;
  align-items: baseline;
  gap: 8px 16px;
  padding: 16px 8px 6px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  min-width: 0;
}
.rstr-space-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rstr-space-title { font-size: 13px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.rstr-space-facts {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.rstr-row-here { font-size: 11px; color: var(--dsw-alias-label-tertiary); }




.rstr-results { display: flex; flex-direction: column; min-width: 0; padding: 0 28px 28px; border-top: 1px solid var(--dsw-alias-border-l2); }

.rstr-results-head { margin: 12px 0 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); }

.rstr-cards { display: flex; flex-direction: column; min-width: 0; border-top: 1px solid var(--dsw-alias-border-l2); }

.rstr-row {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  padding-left: 15px;
  content-visibility: auto;
  contain-intrinsic-size: auto 68px;
}
.rstr-row::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: transparent;
  transition: width .12s ease;
}
.rstr-row-error::before { background: var(--dsw-alias-state-error-primary); }
.rstr-row-warn::before { background: var(--dsw-alias-state-warn-primary); }
.rstr-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.rstr-row:hover::before { width: 5px; }
.rstr-row-open { background: var(--dsw-alias-interactive-bg-hover); }
.rstr-row-open::before { width: 5px; }

.rstr-row-body {
  display: grid;
  grid-template-columns: minmax(110px, 176px) minmax(0, 1fr) auto auto;
  align-items: baseline;
  gap: 8px 16px;
  padding: 13px 8px 13px 0;
  min-width: 0;
}
.rstr-row-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rstr-row-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.rstr-row-title { margin: 0; font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-primary); display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.rstr-row-desc {
  margin: 0;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rstr-row-stats { display: flex; align-items: baseline; gap: 12px; font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.rstr-row-stats b { font-weight: 600; color: var(--dsw-alias-label-primary); }
.rstr-stat-error { color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 78%, var(--dsw-alias-label-primary)); font-weight: 600; }
.rstr-stat-warn { color: color-mix(in srgb, var(--dsw-alias-state-warn-label) 82%, var(--dsw-alias-label-primary)); font-weight: 600; }
.rstr-stat-ok { color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 65%, var(--dsw-alias-label-primary)); }
.rstr-row-actions { display: flex; align-items: center; gap: 4px; justify-self: end; }

.rstr-row-detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px 16px 20px 16px;
  margin: 0 0 12px -1px;
  min-width: 0;
  background: var(--dsw-alias-bg-layer-2);
  border-left: 2px solid var(--dsw-alias-border-l2);
}
.rstr-row-detail-actions { display: flex; gap: 6px; flex-wrap: wrap; padding-top: 4px; }

/* ---- 成员块 ----------------------------------------------------------- */

/* 成员是一张表：四列由容器统一给宽度（subgrid），否则每一行各算各的网格，
   姓名 / 说明 / 策略 / 模型四列对不齐，读起来就是散的。 */
.rstr-members {
  display: grid;
  grid-template-columns: minmax(120px, 172px) minmax(0, 1fr) 104px 244px;
  column-gap: 14px;
  border-top: 1px dashed var(--dsw-alias-border-l1);
}
.rstr-member {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  column-gap: 14px;
  row-gap: 2px;
  align-items: baseline;
  padding: 10px 4px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  min-width: 0;
}
.rstr-member:last-child { border-bottom: none; }
.rstr-member-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
.rstr-member-name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; }
.rstr-member-desc { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.rstr-member-policy { justify-self: start; min-width: 0; }
.rstr-member-meta { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary); justify-self: end; font-variant-numeric: tabular-nums; }
.rstr-member-note { grid-column: 1 / -1; margin: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); }
@media (max-width: 900px) {
  /* 窄面板：姓名一行、策略贴右；说明与模型各占一整行。 */
  .rstr-members { grid-template-columns: minmax(0, 1fr) auto; }
  .rstr-member-head { grid-column: 1; grid-row: 1; }
  .rstr-member-policy { grid-column: 2; grid-row: 1; justify-self: end; }
  .rstr-member-desc { grid-column: 1 / -1; grid-row: 2; margin-top: 2px; }
  .rstr-member-meta { grid-column: 1 / -1; grid-row: 3; justify-self: start; }
  .rstr-member-note { grid-row: auto; }
}

/* ---- 队长块 ----------------------------------------------------------- */

.rstr-captain { display: flex; flex-direction: column; gap: 10px; border-top: 1px dashed var(--dsw-alias-border-l1); padding-top: 12px; }
.rstr-meta-grid { display: grid; grid-template-columns: auto repeat(3, auto); justify-content: start; gap: 6px 20px; align-items: baseline; font-size: 12px; font-variant-numeric: tabular-nums; }
.rstr-checks { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, max-content)); gap: 0 24px; }
.rstr-check { display: flex; justify-content: space-between; gap: 18px; font-size: 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); padding: 4px 0; }
.rstr-apply { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.rstr-segmented { display: inline-flex; border: 1px solid var(--dsw-alias-border-l3); }
.rstr-seg { border: none; background: transparent; padding: 5px 12px; font-size: 12px; font-family: inherit; cursor: pointer; color: var(--dsw-alias-label-secondary); }
/* 对话框里的二选一开关：字段列默认拉伸，这里收回内容宽度，别让它长得像第二个输入框。 */
.rstr-field > .rstr-segmented { align-self: flex-start; }
.rstr-seg:hover { background: var(--dsw-alias-interactive-bg-hover); }
.rstr-seg-on { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); color: var(--dsw-alias-label-primary); font-weight: 600; }

/* ---- 诊断 ------------------------------------------------------------- */

.rstr-diagnostics { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.rstr-diag {
  display: flex;
  gap: 10px;
  align-items: baseline;
  flex-wrap: wrap;
  font-size: 12px;
  padding: 7px 0 7px 10px;
  border-left: 2px solid var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-primary);
}
.rstr-diag-error { border-left-color: var(--dsw-alias-state-error-primary); }
.rstr-diag-warn { border-left-color: var(--dsw-alias-state-warn-primary); }
.rstr-diag-reason { color: var(--dsw-alias-label-primary); }
.rstr-diag code.rstr-code { font-size: 11px; }

/* ---- 新建会话：空间 + 名字 --------------------------------------------- */
.rstr-field-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ---- 收藏 ------------------------------------------------------------- */

/* 星标是"这份我要常看"，不是一个动作按钮：默认安静，选中时才变实心。
   用字形而不是 SVG，是为了在 12–14px 的密集行里也不糊。 */
.rstr-star {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.rstr-star:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.rstr-star-on { color: var(--dsw-alias-state-business-primary); }
.rstr-star-on:hover { color: var(--dsw-alias-state-business-primary); }
.rstr-row-absent { color: var(--dsw-alias-label-tertiary); font-size: 12px; white-space: nowrap; }

/* ---- 通用件 ----------------------------------------------------------- */

.rstr-muted { color: var(--dsw-alias-label-secondary); margin: 0; }
.rstr-small { font-size: 12px; }
.rstr-mono, .rstr-code, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.rstr-code { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.rstr-code-strong { font-size: 13px; color: var(--dsw-alias-label-primary); font-weight: 600; }
.rstr-truncate { display: inline-block; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.rstr-ok { color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 62%, var(--dsw-alias-label-primary)); }
.rstr-bad { color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 80%, var(--dsw-alias-label-primary)); }
.rstr-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.rstr-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0; }
.rstr-hint-warn { color: color-mix(in srgb, var(--dsw-alias-state-warn-label) 75%, var(--dsw-alias-label-primary)); }
.rstr-section-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.rstr-mt { margin-top: 6px; }
.rstr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }

.rstr-btn {
  border: 1px solid var(--dsw-alias-border-l3);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  border-radius: 6px;
  padding: 5px 11px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease;
}
.rstr-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.rstr-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.rstr-btn:disabled { opacity: .5; cursor: not-allowed; }
.rstr-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-inverted); }
.rstr-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); border-color: var(--dsw-alias-button-primary-hover); }
.rstr-btn-danger { color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 72%, var(--dsw-alias-label-primary)); }
.rstr-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.rstr-btn-quiet { border-color: transparent; color: var(--dsw-alias-label-secondary); }
.rstr-btn-quiet:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.rstr-btn-sm { padding: 3px 9px; font-size: 11px; }
.rstr-btn-dashed { width: 100%; border-style: dashed; margin-top: 8px; }
.rstr-caret { display: inline-block; margin-left: 6px; font-size: 9px; opacity: .7; }
.rstr-icon-btn { border: none; background: transparent; font-size: 18px; line-height: 1; cursor: pointer; color: var(--dsw-alias-label-secondary); padding: 4px 8px; border-radius: 4px; }
.rstr-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.rstr-settings-btn { display: inline-flex; align-items: center; gap: 6px; }
.rstr-settings-glyph { font-size: 13px; line-height: 1; }

.rstr-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  font-family: inherit;
}
.rstr-input::placeholder { color: var(--dsw-alias-label-secondary); }
.rstr-input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.rstr-textarea { resize: vertical; line-height: 1.5; }
.rstr-textarea.rstr-mono { font-size: 12px; }
.rstr-select { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; padding: 5px 8px; font-size: 12px; max-width: 320px; }

.rstr-chip { font-size: 11px; padding: 0 6px; border-radius: 4px; background: var(--dsw-alias-markdown-tag); color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.rstr-chip-policy { color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 9%, transparent); }
.rstr-badge { font-size: 11px; padding: 0 6px; border-radius: 4px; font-weight: 600; }
.rstr-badge-error { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 80%, var(--dsw-alias-label-primary)); }
.rstr-badge-warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); color: color-mix(in srgb, var(--dsw-alias-state-warn-label) 85%, var(--dsw-alias-label-primary)); }
.rstr-badge-ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 62%, var(--dsw-alias-label-primary)); }
.rstr-badge-info, .rstr-badge-muted { background: var(--dsw-alias-markdown-tag); color: var(--dsw-alias-label-secondary); }
.rstr-drift { margin: 4px 0 0; padding-left: 16px; font-size: 12px; color: color-mix(in srgb, var(--dsw-alias-state-warn-label) 72%, var(--dsw-alias-label-primary)); }

/* ---- 空态 / 健康 / 页脚 ------------------------------------------------ */

.rstr-empty-wrap {
  padding: 16px 28px 28px;
  min-width: 0;
}
.rstr-empty { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; padding: 40px 2px; color: var(--dsw-alias-label-primary); }
.rstr-empty-title { margin: 0; font-size: 15px; font-weight: 600; }
.rstr-health { display: flex; flex-direction: column; gap: 14px; padding: 16px 28px 28px; }
.rstr-config { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-2); }
.rstr-config-row { display: flex; gap: 12px; align-items: baseline; }
.rstr-config-row .rstr-label { min-width: 150px; }
.rstr-hint-cards { display: grid; gap: 0; border-top: 1px solid var(--dsw-alias-border-l2); }
.rstr-hint-card { padding: 10px 2px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.rstr-hint-card-head { display: flex; gap: 8px; align-items: center; margin-bottom: 2px; }
.rstr-settings { display: flex; flex-direction: column; gap: 10px; }
.rstr-settings-title { margin: 0; font-size: 13px; font-weight: 600; }
.rstr-settings-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.rstr-settings-row .rstr-label { min-width: 110px; }
.rstr-settings-field { display: flex; flex-direction: column; gap: 6px; }
.rstr-settings-inline { display: flex; align-items: center; gap: 8px; }
.rstr-settings-inline .rstr-input { flex: 1 1 auto; min-width: 0; }

.rstr-foot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 28px 16px;
  margin-top: auto;
  border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

/* ---- 弹窗 / 编辑器 ---------------------------------------------------- */

.rstr-overlay { position: fixed; inset: 0; background: var(--dsw-alias-bg-mask-3); display: flex; align-items: flex-start; justify-content: center; padding: 5vh 16px; z-index: 1000; overflow: auto; }
.rstr-modal { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; width: 640px; max-width: 100%; box-shadow: 0 24px 64px var(--dsw-alias-bg-mask-1); display: flex; flex-direction: column; max-height: 90vh; }
.rstr-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.rstr-modal-title { margin: 0; font-size: 14px; font-weight: 600; }
.rstr-modal-body { padding: 16px 18px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.rstr-modal-foot { padding: 12px 18px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex; justify-content: flex-end; gap: 8px; }
.rstr-modal-foot-actions { display: flex; gap: 8px; }
.rstr-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.rstr-editor-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.rstr-editor-toolbar .rstr-input { width: 110px; }
.rstr-member-editor { border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.rstr-member-editor-head { display: flex; align-items: center; gap: 8px; }
.rstr-member-editor-head .rstr-input { width: 180px; }
.rstr-step { width: 18px; height: 18px; border: 1px solid var(--dsw-alias-border-l3); font-size: 10px; display: inline-flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.rstr-error { border-left: 3px solid var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.rstr-error-title { margin: 0; font-weight: 600; color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 78%, var(--dsw-alias-label-primary)); }
.rstr-confirm { border-left: 3px solid var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.rstr-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--dsw-alias-toast-bg); color: var(--dsw-alias-toast-label); padding: 8px 16px; border-radius: 4px; font-size: 12px; z-index: 1100; }

/* ---- 窄面板 ----------------------------------------------------------- */

@media (max-width: 860px) {
  .rstr-head, .rstr-tabs, .rstr-rosters-main, .rstr-health, .rstr-catalog, .rstr-foot { padding-left: 18px; padding-right: 18px; }
  .rstr-banner { margin-left: 18px; margin-right: 18px; }
  .rstr-rosters { grid-template-columns: minmax(0, 1fr); }
  .rstr-tagpool {
    position: static;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 10px 18px;
    border-right: none;
    border-bottom: 1px solid var(--dsw-alias-border-l1);
  }
  .rstr-tagpool-title { display: none; }
  .rstr-tagpool-list { flex-direction: row; flex-wrap: wrap; gap: 4px; min-width: 0; }
  .rstr-tag { border-left: none; border-bottom: 2px solid transparent; border-radius: 0; white-space: nowrap; }
  .rstr-tag-on { border-left: none; border-bottom-color: var(--dsw-alias-state-business-primary); background: transparent; }
  .rstr-tag-clear { margin-top: 0; flex: 0 0 auto; }
  /* 空间头：窄屏由一列 id/标题/事实/按钮的四列网格折成两行 */
  .rstr-space-head {
    grid-template-columns: minmax(0, 1fr) auto;
    row-gap: 2px;
    padding-top: 14px;
  }
  .rstr-space-id { grid-area: 1 / 1; }
  .rstr-space-head > .rstr-btn { grid-area: 1 / 2; }
  .rstr-space-title { grid-area: 2 / 1; }
  .rstr-space-facts { grid-area: 2 / 2; text-align: right; }
  .rstr-row-body { grid-template-columns: minmax(0, 1fr) auto; }
  .rstr-row-id { grid-column: 1; }
  .rstr-row-text { grid-column: 1; }
  .rstr-row-stats { grid-column: 1; }
  .rstr-row-actions { grid-column: 2; grid-row: 1; align-self: start; }
  .rstr-member { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .rstr-member-meta { justify-self: start; }
}
`;

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /* ------------------------------------------------------------------ */
    /* 挂载                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 注册面板、语言节，并把插件配置与 DSH 语言同步进词典运行时。
     *
     * @param {object} ctx 客户端上下文
     * @param {{ settings?: object }} [_config] 客户端拿不到插件配置，语言走配置表单
     * @returns {{ apply: Function }}
     */
    function defineClient() {
      return { inject: ["slots"], apply };
    }

    /**
     * 客户端挂载点。
     *
     * 三个订阅源（配置表单 / DSH 语言 / 词典加载）都汇进同一个 i18n 对象：
     * 任意一处变化都触发面板与设置节重渲染，不需要手动刷新页面。
     *
     * @param {object} ctx
     * @returns {void}
     */
    function apply(ctx) {
      ensureStyle();
      if (typeof document !== "undefined") void i18n.load();

      const locale = ctx.get?.("locale") ?? ctx.locale;
      const configForms = ctx.get?.("configForms") ?? ctx.configForms;
      const form = configForms?.get?.(NS) ?? null;

      const readActive = () => {
        try {
          const value = locale?.getLocale?.();
          if (typeof value === "string") return value;
          if (value !== null && typeof value === "object") {
            // LocaleSnapshot：{ active, locales, revision }。先取 active，再退到旧形状。
            return String(value.active ?? value.id ?? value.language ?? value.lang ?? "");
          }
        } catch {
          /* 拿不到就当英文。 */
        }
        return "";
      };

      const sync = () => {
        i18n.preference = readFormLanguage(form);
        i18n.activeLocale = readActive();
        i18n.emit();
      };
      sync();

      // 词典是异步取的：取到之后注册进宿主 locale 服务，槽位里的 `locale` 字段
      // 与 label() 才会走宿主的查找链；注册失败（已存在/语言包不接受）不影响自绘词典。
      let registered = false;
      const registerDictionaries = () => {
        if (registered) return;
        if (typeof locale?.register !== "function") return;
        if (i18n.dicts.en === undefined || i18n.dicts.zh === undefined) return;
        registered = true;
        try {
          locale.register(NS, "en", i18n.dicts.en);
          locale.register(NS, "zh", i18n.dicts.zh);
        } catch {
          /* 词典所有权冲突时保持静默：界面仍用 i18n.dict()。 */
        }
      };
      i18n.subscribe(registerDictionaries);
      registerDictionaries();

      ctx.effect(
        () => {
          const offs = [];
          for (const source of [form, locale]) {
            if (source !== null && source !== undefined && typeof source.subscribe === "function") {
              const off = source.subscribe(sync);
              if (typeof off === "function") offs.push(off);
            }
          }
          return () => {
            for (const off of offs) off();
          };
        },
        "agent-roster: language sync",
      );

      HOST.form = form;

      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 20,
            locale: NS,
            label: () => t("settings.nav"),
          },
          function RosterSidebarIcon(props) {
            const size = props?.size ?? 16;
            const active = props?.active === true;
            return h(
              "svg",
              {
                width: size,
                height: size,
                viewBox: "0 0 20 20",
                fill: "none",
                "aria-hidden": "true",
                style: { opacity: active ? 1 : 0.85 },
              },
              // 两个头型：左边实心大圆，右边描边小圆，读起来像"一队人"。
              h("circle", { cx: 7.5, cy: 7, r: 3.2, fill: "currentColor", opacity: active ? 1 : 0.75 }),
              h("path", { d: "M2.6 16.4c0-2.9 2.2-4.6 4.9-4.6s4.9 1.7 4.9 4.6", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", fill: "none" }),
              h("circle", { cx: 14.4, cy: 8.2, r: 2.3, stroke: "currentColor", strokeWidth: 1.4, fill: "none" }),
              h("path", { d: "M12.4 16.2c.2-2.2 1.5-3.5 3.4-3.5 1.5 0 2.6.9 3 2.4", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", fill: "none" }),
            );
          },
        ),
      );

      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS }, Panel),
      );

    }

    return defineClient();
  },
});

