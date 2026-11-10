# 设计说明（dsh-agent-roster）

这份文档回答两个问题：**这个插件由哪些部分构成**，以及**加一个能力时，哪些地方必须一起改**。
它写给未来的维护者（包括我自己）：功能一多，最危险的失败不是写错一行代码，而是
「加了模型覆盖，却忘了让工具也接受它」——两边都绿，行为却不一样。

> 本文不是用户手册。用法看 README；历史看 CHANGELOG；每个格式的精确定义看 `schema/`。

---

## 1. 定位与边界

**做**：把「一支团队该由谁组成、各自的人设/路由/权限从哪来」写成可评审、可校验、可编译的**静态档案**，
并在建团队时把它交给运行时。

**不做**（这些是刻意的，不是没做）：

| 不做 | 为什么 |
|---|---|
| 跑团队、调度任务、拆 DAG | 那是 `dsh-agent-teams` / 官方实验线 / 宿主 `schedule` 的职责 |
| 写团队状态（`team.json`） | 档案层只读运行时状态；写它等于制造第二真源 |
| 把运行时的"优化"自动写回档案 | 档案是评审过的真源；自动回写会把上下文压力下的漂移固化 |
| 改部署配置（profile / preset） | 需要写 profile 并重启宿主；插件只给 patch 与核对结果 |
| 代替队长执行定时器、唤醒、归档 | 每台机器的实现不同；插件承载、校验、交付，不代跑 |

一句话：**档案 → 运行时是单向的**。反方向只有两条受控路径：`roster_capture` 给人看差异、
`roster_capture(apply:true)` 写回机械字段——都经人触发。

---

## 2. 数据模型：五种文件

| 文件 | 格式 | 作用 | 谁写 |
|---|---|---|---|
| `roster.yaml`（v2，`rosters/<id>/`） | `dsh-agent-roster/roster@2` | 成员引用角色、队长、编排与门 | 人 / 面板 / capture |
| `roles/<name>/AGENT.md` | frontmatter + 正文 + `parts/` | 人设的唯一真源 | 人 |
| `roster.yaml`（v1，平铺） | `dsh-agent-roster/v1` | 单文件交换形态；**已冻结** | 人 / `/install` 摊平 |
| `dist/<id>-<ver>.json` | `compiled@1` | 编译产物：拼装后的人设、施工图、回执合并 | CLI `compile --write` |
| `space.yaml` | `dsh-agent-roster/space@1` | 一座库的封面：登记、布局、知识、拉取来源 | 人 / `clone` |

配套文件：

- `capabilities.yaml`（档案级兄弟文件）：技能/策略/文档要求，只核对、不注入。
- `.dsh-roster-origin.json`（拉取副本）：来源账本，七态更新检测的基线。
- `.dsh-handover/<roster>-<时间>.json`：一次迭代的交接清单，附在起始消息里。
- `.dsh-roster-favorites.json`（库根）：收藏，跟着库走。

**v1 与 v2 不合并**：v1 是"一个文件拿走就能用"的交换形态，`/install` 正落在它上面；
v2 是目录（角色可复用）。合并会把"装一份档案"变成 1+N 个文件，并引入同名角色冲突。

---

## 3. 一条数据的生命周期

```
磁盘扫描           校验                 编译                桥接                 运行时
lib/registry.js → lib/validate.js    → lib/compile2.js →  lib/bridge.js   →  agent_teams_add_member
     │               lib/roster2.js        │                   │                    │
     └── 诊断 ◄──────┴──────────────────────┴── 编译诊断 ◄──────┘                    │
                                                                              lib/verify.js / roster_verify
                                                                                      │
                                                                              lib/capture.js（反方向，人触发）
```

每个阶段只做一件事，且**下游不重新发明上游的判断**：

1. **扫描**（`registry.js`）：认布局（v1/v2/空间/嵌套空间），产出档案视图 + 诊断；不解释语义。
2. **校验**（`validate.js` / `roster2.js`）：字段闭集、上限、引用、门与失败边；出错即 `ok:false`。
3. **编译**（`compile2.js`）：拼人设（`frontmatter.assemblePrompt` 是唯一实现）、算哈希、出施工图。
4. **桥接**（`bridge.js`）：只把**运行时真接收的字段**变成参数；字段归宿是数据，不是注释。
5. **核对**（`verify.js` / `captain.js` / `capabilities.js`）：拿运行时实际值反比，读不到记 `unknown`。
6. **回写**（`capture.js`）：只写机械字段，人设只报哈希；写前重校验，写后重编译。

---

## 4. 模块地图

| 模块 | 一句话 |
|---|---|
| `lib/format.js` / `format-v2.js` | 字段闭集、上限、常量（改字段先改这里） |
| `lib/registry.js` | 扫库、认布局、空间与知识诊断 |
| `lib/space.js` | `space.yaml` 校验与对账 |
| `lib/validate.js` / `roster2.js` | v1 / v2 语义校验 |
| `lib/role.js` / `frontmatter.js` / `paths.js` | 角色读取、拼装、路径守卫 |
| `lib/includes.js` | `{{> path}}`（snippets/ 与 knowledge/） |
| `lib/compile2.js` / `plan.js` / `run.js` | 编译产物、施工图、回执合并 |
| `lib/bridge.js` | 字段 → 运行时参数（`CARRIED_FIELDS`） |
| `lib/verify.js` / `captain.js` / `capabilities.js` | 三张核对表 |
| `lib/capture.js` | 运行时 ↔ 档案差异；机械字段回写 |
| `lib/captain-inject.js` | 队长人设注入（会话级 section） |
| `lib/apply.js` | 建会话 / 复用会话 / 排提示词；工作区与会话名 |
| `lib/handover.js` | 交接清单：校验、写盘、渲染、系统级兜底 |
| `lib/teams-state.js` | 只读 `team.json`（适配层边界） |
| `lib/clone.js` / `origin.js` | 整空间拉取、账本、七态更新 |
| `lib/service.js` | 面板快照、安装、收藏、应用（HTTP 背后的业务） |
| `lib/tools.js` / `tools-space.js` / `host-models.js` / `team-targets.js` | 宿主工具层与探测 |
| `lib/render.js` / `tool-output.js` | 文本渲染与状态行 |
| `lib/library.js` / `serialize.js` | 面板投影（**投影丢字段 = 面板缺能力**） |
| `index.js` | 路由与插件装配 |
| `client.js` | 面板（浏览器半边） |

---

## 5. 字段归宿（唯一判定表）

| 归宿 | 含义 | 例子 |
|---|---|---|
| `direct` | 原样传给 `agent_teams_add_member` | `name`、`role`、`systemPrompt`、`provider`、`model`、`reasoningEffort`、`toolPolicy` |
| `config` | 只能落部署配置，插件只报「需落配置」 | `captain.route`、`captain.persona`（要脱离插件生效时） |
| `declaration` | 只声明与校验，永不下发 | `tools.scope`、`requires.skills`、`requires.documents`、`skills` |

**新字段必须能回答：它属于哪一格？** 答不出来就不要加——那会变成"写了但不生效"的假字段。

---

## 6. 三个入口，同一份能力

| 能力 | 工具 | HTTP 路由 | CLI |
|---|---|---|---|
| 列/看/校验 | `roster_list`、`roster_show`、`roster_compile` | `/library`、`/catalog`、`/search` | `validate`、`list` |
| 建团队 | `roster_team` | `POST /apply` | — |
| 引擎与模型 | `roster_team{target,model}` | `/apply{target,model}` | — |
| 拉取 | — | `POST /install`、`/install-space` | `clone` |
| 更新 | `roster_changes` | `POST /space-update` | `update` |
| 迭代 | `roster_capture`、`roster_iterate` | — | — |
| 收藏 | — | `POST /favorites` | — |

**纪律**：一个能力要么三处都有，要么在表里写清为什么不给某个入口。
「面板能选模型、工具不能」这种不一致，本质是这张表没更新。

---

## 7. 依赖的宿主契约（`npm run check:host` 钉住）

| 契约 | 位置 | 我们的用法 |
|---|---|---|
| `prompt(request, signal)` | `dsh-api-session-controller/lib/index.js:4048` | 必须传 `AbortSignal.timeout` |
| `create` 只有传 `workspaceId` 才 `attachSession` | 同文件 `:666`/`:687` | 选工作区必须发 workspaceId |
| `WorkspaceEntity.id`（不是 workspaceId） | `dsh-workspace/lib/index.js:76` | `listHostWorkspaces` 读 `id` |
| `get path()` / `get title()` | 同文件 `:90` | 工作区名与路径 |
| `agent.ctx.systemPrompt.section` 同名遮蔽 | `dsh-system-prompt` | 队长人设注入 |
| `agent/created` 在释放输入前触发 | `dsh-agent` | 注入时机 |

**契约变了先跑 `check:host`**；它是正则，只覆盖已知的几条，不是全部。

---

## 8. 不变量（违反就是 bug）

1. **fail-closed**：找不到、读不到、拿不准 → 报错或 `unknown`，不猜、不静默通过。
2. **unknown ≠ pass**：核对不到不是"一致"；`unverified` 是独立状态。
3. **无第二真源**：`space.yaml` 不写给仓库自己；账本只存在本地副本；`dist/` 是可重建产物。
4. **插件不写运行时状态**：`team.json` 只读。
5. **空结果必须是显式决定**：零档案、空文件、空 diff 都要有明确 code，不能长得像成功。
6. **一次判据只算一次**：同一事实在汇总里不重复计数（见 `render.js` 的 `counted`）。
7. **投影完整性**：`serializeRoster` 少一个字段，面板就少一个能力；`test/projection.test.js` 兜底。

---

## 9. 加一个能力：落点清单

> **这是一份下限，不是上限。** 它列的是“最容易漏的地方”，不是“全部地方”。
> 改动时如果发现新的落点（某个缓存、某个生成物、某台机器上才有的状态文件……），
> 就在**同一个提交**里把它补进对应小节——这份文档的维护方式就是“边改边补”，不是一次性写完。
> 条目不适用的，写明为什么不适用，不要删掉：删掉等于下一次没人再想它。
> 具体文件名与数量（24 份 `dist/`、13 个工具）会随版本漂移，以代码为准；清单只负责提醒“该想哪些地方”。


### 9.1 加一个档案字段

- [ ] `lib/format-v2.js`（或 `format.js`）：字段闭集与上限
- [ ] `schema/roster.v2.schema.json`：属性 + 描述 + required
- [ ] `lib/roster2.js`：校验与归一化
- [ ] `lib/compile2.js`：若进产物，写进 `compiled`
- [ ] `lib/bridge.js`：若下发，进 `CARRIED_FIELDS` + `FIELD_BINDING`
- [ ] `lib/render.js`：工具的文本输出
- [ ] `lib/library.js#serializeRoster`：面板投影（**最容易漏**）
- [ ] `test/v2-schema.test.js`、`test/projection.test.js`
- [ ] README 字段表、`docs/roster-v2.md`、CHANGELOG
- [ ] 重编 24 份 `dist/`；`npm run smoke`、`npm run e2e`

### 9.2 加一个工具

- [ ] `lib/tools.js` 或 `tools-space.js`：`defineTool` + 描述 + 参数
- [ ] 状态行用 `statusLine`；返回值过 `lossless`；缺失值写 `null`
- [ ] `scripts/host-smoke.mjs` 的工具数断言
- [ ] `test/tools.test.js` 的工具清单与行为测试
- [ ] README 工具表；CHANGELOG

### 9.3 加一个 HTTP 路由

- [ ] `index.js`：方法、白名单（`findLibraryRoot`）、错误码
- [ ] `lib/service.js`：业务放在这里，路由只做协议
- [ ] `test/routes.test.js`：200/4xx/405 与越权
- [ ] README 路由表

### 9.4 加一个面板能力

- [ ] `lib/service.js#buildPanelSnapshot`：数据进快照
- [ ] `client.js`：渲染 + 文案键
- [ ] `locale/zh.json`、`locale/en.json`（`check:locale` 会拦）
- [ ] `test/client.test.js` 的守卫断言
- [ ] 窄屏：`.rstr-*` 的媒体查询

### 9.5 加一个 CLI 命令

- [ ] `bin/cli.mjs`：`if (options.command === …)` 派发 + 用法行
- [ ] 退出码：0 成功、1 校验失败、2 用法错误
- [ ] README 命令表

### 9.6 加一条宿主契约

- [ ] `scripts/host-contracts.mjs`：读装好的 bundle，断言真实文本
- [ ] README「验证状态」注明
- [ ] 如果契约变了：先改调用点，再改断言

---

### 9.7 随时补的落点（这一节就是给未来的你留的）

- 新状态文件 / 新缓存 / 新生成物：写清谁写、谁读、能否重建。
- 新探测点（宿主服务、profile 文件、包是否可解析）：探测失败时的降级要写出来。
- 新的“跨入口同一能力”：先补第 6 节矩阵，再改代码。

## 10. 测试策略

| 层 | 文件 | 证明什么 |
|---|---|---|
| 单元 | `test/*.test.js` | 模块行为；**假件由实现者写，证明不了宿主形状** |
| 投影完整性 | `test/projection.test.js` | 档案字段不会被投影静默丢掉 |
| 宿主契约 | `scripts/host-contracts.mjs` | 我们读的那几行代码确实长那样 |
| 端到端 | `scripts/e2e.mjs` | 宿主真的把它加载起来、真的建出团队、真的把队长人设换掉 |

**假件只证明"代码符合假设"，不证明"假设符合世界"。**历史事故（见 CHANGELOG 1.13.3 的 Why）
全是这么发生的：绿测试 + 错假设。所以新能力至少要有 单元 + 投影/契约 两层；
涉及"宿主到底怎么看我们"的，必须走 e2e。

---

## 11. 已知边界

- 官方实验线没有 `team.json`：`roster_verify` 对它只能报「无团队记录」，不能假装核对。
- 官方实验线不支持 per-member 模型/人设/toolPolicy：这些字段在它的引擎上不生效，建团提示里如实写明。
- `toolFilter` 是策略物化结果，`team.json` 不存，只能报「无法核对」。
- 队长人设与部署 preset persona 是两份文本：插件在会话里遮蔽，进程外仍需落 preset。
- 交接清单里的 `verify` 是给人/新队长执行的文本，插件不代跑，也不核对"是否真的执行了"。

---

## 12. 版本与演进

- 语义化版本；破坏性格式变更走 major（1.0.0 把 `organization.yaml` 换成 `space.yaml`）。
- 每个版本在 `CHANGELOG.md` 里写「为什么」，不只是「改了什么」。
- `dist/` 与源码不一致会让 CI 失败：改了档案/角色就要重编译。
