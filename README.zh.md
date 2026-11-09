# @stofone/dsh-agent-roster

[English](README.md) | **简体中文**

面向多 Agent 团队的**静态成员档案**插件（DeepSeek Harness）。

一份档案就是磁盘上的文件：团队里有谁、各自负责什么、走哪个模型路由、被允许碰哪些工具。本插件定义这套格式、校验它，并把它翻译成 `agent_teams_*` 调用参数——它不运行团队。

## 它是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 定义与校验层：格式可版本化、可评审，写错时带文件路径与字段路径报错，不静默降级 | 团队运行时：从不建成员、不调度任务、不替代调度器 |
| 对 `dsh-agent-teams` 的桥接：`roster_create` 产出可直接使用的建员参数，并逐字段标注运行时是否真的接收 | 不写 `.agent-teams/` 状态：只读，用于核对 |
| 核对手段：`roster_verify` 读 `team.json` 里**实际存下的值** | 不假装通过：证据源缺席时记「无法核对」 |

## 安装

前置：DSH 提供 `tools` 服务；Node.js ≥ 22.19。运行依赖已声明（`yaml`、`@deepseek-ai/schemastery`），`@deepseek-ai/dsh-tools` 是 peer（接受范围覆盖 0.1、0.2.0、0.2.1、0.2.2、0.3 各条预发布线；测试与两段冒烟跑的是 0.2.2-rc.1）。

```
@stofone/dsh-agent-roster
```

包内带 `cordis.patch.yml`，安装即把插件插进 profile。装好后应看到**十一个工具**（见「工具」）与左侧栏里的 **Agent 档案** 面板。

插件代码在 DSH 启动时加载：升级包后**必须重启 `dsh web`**，面板与工具才会是新的；只换 `node_modules` 不重启，运行中的宿主仍是旧版本。

## 快速开始

档案库默认是**全局**的：一台机器一份，不跟工作区走，位于 `$DSH_HOME/agent-roster`（默认 `~/.dsh/agent-roster`；docker 下就是挂载的数据卷）。目录在第一次保存时自动创建。

v2 空间长这样：

```
~/.dsh/agent-roster/
├── space.yaml                     # 可选：把这座库登记成一个空间
├── roles/
│   └── core-review-lead/
│       └── AGENT.md               # 角色 = 一个目录 + 一份 AGENT.md
├── rosters/
│   └── core-review/
│       ├── roster.yaml            # 档案 = 成员清单 + 编排
│       └── capabilities.yaml      # 可选：声明部署侧必须先提供什么
└── dist/
    └── core-review-1.0.0.json     # 编译产物（自包含）
```

```bash
npx dsh-agent-roster validate --dir examples     # 校验示例库（v2）
npx dsh-agent-roster list --dir examples         # 列出档案与成员
npx dsh-agent-roster compile --roster examples/rosters/core-review   # 只打印编译结果
```

本仓自带两座示例库：[`examples/`](./examples)（v2）与 [`examples-orchestration/`](./examples-orchestration)（v2，演示门与施工图）。

## 三种落盘形态

| 形态 | 目录特征 | 由谁产生 |
|---|---|---|
| **平铺库（v1）** | `<根>/<id>/roster.yaml` | 手写、单份安装、老库 |
| **空间（v2）** | `<根>/roles/` + `<根>/rosters/`（+ 可选 `snippets/`、`space.yaml`） | 手写、`migrate`、`clone` |
| **拉取副本** | 空间或平铺库 + `.dsh-roster-origin.json`（来源账本） | `clone` / 面板「拉取整个空间」 |

`space.yaml` 是**可选**的登记层：有它就有「声明了几份、实际几份、缺了谁、谁没登记」的核对；没有它，库仍按目录扫描，只是没有这层对账。收藏存在库根的 `.dsh-roster-favorites.json`（点文件，扫描器跳过）。

## 档案格式（v1，平铺库）

```yaml
kind: dsh-agent-roster/v1
roster: core-review          # 必须与所在目录名一致
version: 1.0.0               # 精确 SemVer
title: 核心评审组
description: 负责代码评审与发布把关的固定成员。
license: MIT
maintainers: [STofone]
tags: [review, release]

defaults:                    # 成员共享的路由默认值
  provider: deepseek
  model: deepseek-v4.1-flash
  reasoningEffort: high

members:
  - name: reviewer           # kebab-case，团队内唯一
    role: 代码评审
    systemPrompt: |
      你先找语义错误，再看风格。
    toolPolicy: readonly
  - name: release-manager
    role: 发布把关
    systemPrompt: |
      你核对变更、版本号与回滚方案。
    model: deepseek-v4.1-pro

captain:                     # 可选：记录队长（= 创建团队的那个会话）应该是什么样
  name: lead
  provider: tsingmicro
  model: deepseek-v4.1-flash
  personaPrefix: |
    派活前先复述目标与验收标准。
```

| 键 | 必填 | 说明 |
|---|---|---|
| `kind` | 是 | `dsh-agent-roster/v1` |
| `roster` | 是 | kebab-case id，必须等于目录名（位置即身份） |
| `version` | 是 | 精确 SemVer，不接受范围 |
| `title` / `description` / `license` / `maintainers` / `tags` | 否 | 展示与检索元数据 |
| `defaults` | 否 | 成员继承的 `provider` / `model` / `reasoningEffort` |
| `members` | 是 | 1–32 个 |
| `captain` | 否 | 不创建会话、不写团队状态；人设由插件注入队长会话的 system prompt（会话级 section，与成员侧同构）。`roster_verify` 报「已嵌入 / 未嵌入」，与部署 preset 的 persona 差距仍报 `needs-config` |

成员键：`name`、`role`、`systemPrompt`（必填），以及 `provider`、`model`、`reasoningEffort`、`toolPolicy`、`fallback`、`toolScope`、`maxTokens`、`title`、`tags`、`notes`、`description`、`aliases`、`skills`、`examples`。

同一目录按 `roster.yaml` → `roster.yml` → `roster.json` 探测，**只认一份**；出现第二份是 error，绝不静默挑一份。未知键一律 error。

## 角色 → 档案 → 产物（v2）

### 角色 `roles/<name>/AGENT.md`

角色是「一个目录 + 一份精确命名为 `AGENT.md` 的文件」；目录可以嵌套（最多 3 层），但**一个目录只能有一份角色**。角色身份取 frontmatter 的 `name`，不是目录名；重名是 error。

```yaml
---
kind: "dsh-agent-roster/role@1"
name: "core-review-lead"
version: "1.0.0"
role: "队长"
title: "编排与取舍"
description: "编排这次审查、拆任务、合并结论；不写具体代码"
tags: ["orchestration"]
route:
  provider: "deepseek"
  model: "deepseek-v4.1-flash"
  reasoningEffort: "high"
tools:
  policy: "read-only"
requires:
  skills: ["frontend-skill"]
---
```

正文就是人设。`prompt.parts` 可以再拆若干片段，按顺序拼在正文之后；片段必须位于角色目录内（越界即 error）。

### 档案 `rosters/<id>/roster.yaml`

```yaml
kind: dsh-agent-roster/roster@2
id: core-review
version: 1.0.0
title: 核心评审组
description: 一个小团队：队长拆任务，评审把关，修复收尾。
license: MIT
maintainers: [stofone]
tags: [review, example]

defaults:
  route:
    provider: deepseek
    model: deepseek-v4.1-flash
    reasoningEffort: high
targets: [agent-teams/members]

members:
  - as: reviewer            # 团队里的名字
    role: reviewer@1.0.0    # 引用角色与精确版本
  - as: fixer
    role: fixer@1.0.0
    prompt:
      append: overrides/fixer.md   # 成员级追加，拼在执行提示词末尾

captain:
  role: lead@1.0.0
  persona: captains/lead.md    # 文件路径（相对档案目录），内容是队长人设

orchestration:
  shape: gate-pipeline
  stages:
    - id: build
      serial: [fixer]
    - id: audit
      parallel: [reviewer]
  gates:
    - id: tests-pass
      after: [audit]
      by: reviewer
      requires: [现有测试全部通过]
      verify:
        - command: node --test
          expectExit: 0

requires:
  toolPolicies: [member-safe]
onMissing: refuse
```

档案级键：`kind`、`id`、`version`、`title`、`description`、`license`、`maintainers`、`tags`、`defaults`、`targets`、`members`、`captain`、`orchestration`、`requires`、`onMissing`、`notes`。

执行提示词只有一种拼法（`lib/frontmatter.js#assemblePrompt`）：

```
executionPrompt = join("\n\n", [成员 prepend, 展开引用后的正文, ...prompt.parts, 成员 append])
```

预算口径按**字符**：正文 8000、单片段 6000、片段 16 个、展开后 12000、成员追加 6000。

### 编排与门

`orchestration.stages` 是阶段（`serial` / `parallel` 列表，可选 `join`、`on`、`maxRounds`），`gates` 是门（`after`、`by`、`requires`、`verify`）。

门没有可执行判据就是 error（`gate-unverifiable`）：每条 `verify` 必须给出 `command` 与 `expectExit`（1–8 条）。**能被机器跑的才算门**，纯文字标准只能写进 `requires` 供人看。

门还可以声明**失败回边**：没过时回到哪个阶段、最多重试几轮。

```yaml
gates:
  - id: tests-pass
    after: [audit]
    onFail: { to: repair, maxRounds: 2 }
```

- `onFail.to` 必须是已声明的阶段，且不能在本门自己的 `after` 里（那是原地重试，没有修复动作）——`onfail-immediate`。
- 它必须被另一个门的 `after` 覆盖，否则修完回不到任何一个门，这条回边没有出口——`onfail-dangling`。
- `maxRounds` 必填（1~5）——没有上限的重试等于死循环。
- 两条回边可以互相指，但环上的轮数乘积必须 ≤ 5（`onfail-unbounded`）。`after` 只声明先后，不构成可判定的环。

### 编译产物

```bash
npx dsh-agent-roster compile --roster examples/rosters/core-review --write
```

- `dist/<id>-<version>.json`（`compiled@1`）：自包含，成员带 `executionPrompt`、`promptStats`（字符数、逐段 `{path, kind, line?, sha256}`、整体 sha256）与 `provenance`；`source` 里带发现元数据（标题、描述、标签、许可、维护者）。
- `dist/<id>-<version>.tasks.json`（`plan@1`）：有编排时生成，`executor: "captain"`，队长按图施工。
- 失败轮次可用 `--run <回执>` 把 `run@1` 的失败并入重试卡。

## 正文里的引用

人设正文可以就地引用一段共享片段，**独占一行**才算：

```markdown
{{> snippets/report-shape.md}}
```

- `snippets/…` 相对**库根**；其余路径相对**角色目录**，越界即 error。
- 只展开一层：被引文件里再出现 `{{>` 是 `include-nested`。
- 同一文件引两次就展开两次；`prompt.parts` 仍拒绝重复。
- 预算按**展开后**算：单片段 6000、整篇 12000、最多 32 处。
- 报错带整份文件的行号，`promptStats` 记 `{path, kind: "include", line, sha256}`。
- 不做条件、循环、变量：档案要能逐字读懂，也要能被静态校验。

`snippets/` 只属于 v2 库；`dist/` 不随 `clone` 拉取，需要本地重新编译。

## 每个字段到底落在哪

| 归宿 | 字段 | 运行时是否真的接收 |
|---|---|---|
| **direct** | `name`、`role`、`systemPrompt`、`provider`、`model`、`reasoningEffort`、`toolPolicy` | 传给 `agent_teams_add_member` |
| **config** | 档案库目录、团队状态目录、语言、索引源等 | 插件自己的配置，不进团队 |
| **declaration** | `description`、`aliases`、`skills`、`examples`、`tags`、`notes` | 只做文档与校验；`skills` 永不自动加载 |

`captain` 是独立一段：它不是成员字段，也不进 `agent_teams_add_member`；人设由插件在队长会话上注册 `deployment:persona-prefix` section 注入，模型仍来自部署。

`roster_create` 输出的每个字段都带这一类标注；`roster_verify` 只比对运行时实际存下的值。

## 能力要求（`capabilities.yaml`）

档案旁可以有一份兄弟文件，声明「建这支队伍前，部署侧必须提供什么」：

```yaml
requires:
  skills: [frontend-skill]
  toolPolicies: [member-safe]
  documents:
    - path: docs/runbook.md
      sha256: 3f2a…            # 可选：钉住内容，而不只是文件名
onMissing: refuse        # refuse（默认）| degraded
```

- 只声明**能核对**的三类：技能是否装进目录、策略 id 是否在部署里声明过、文档是否在（写了 sha256 就连内容一起核）。
- 三态：`present` / `missing` / `unknown`；只有 `missing` 触发 `onMissing`，`unknown`（证据源缺席）不算通过。
- `refuse` 时 `roster_create` 不出参数并说明缺什么；`degraded` 出参数但逐条标注。
- 文档路径相对**档案库根**（不是档案目录），`..` 与绝对路径一律拒绝。文件不在是 `missing`；文件在但内容与写死的 sha256 对不上，同样是 `missing`（`why: sha-mismatch`）。文档**永远不会拼进** `executionPrompt`——它是证据，不是人设正文。

## 档案空间（`space.yaml`）

```yaml
kind: dsh-agent-roster/space@1
space: agent-roster            # 必须等于目录名
title: 团队档案合集
description: 多份档案放在同一个仓库里。
license: MIT
homepage: https://github.com/…
maintainers: [STofone]
layout: monorepo               # monorepo | flat
rosters:
  - id: core-review
  - id: research
    status: active             # active | archived
roles: [core-review-lead, reviewer]   # 可选：声明角色
```

- `layout` 描述文件布局，不描述数量：`monorepo` 是 `rosters/<id>/roster.yaml`，`flat` 是 `<id>/roster.yaml`。
- 登记与磁盘对账：缺 → error `space-roster-missing`；多 → warn `space-roster-undeclared`；归档但仍在 → info。
- **仓库里写 `origin` 是 error**：来源就是仓库本身，再写一遍等于第二个真源。只有拉下来的本地副本可以带 `origin: {repo, ref, path}`。

### 整空间拉取

```bash
npx dsh-agent-roster clone --repo dsh-agent-roster/agent-teams --space agent-teams --dir /tmp/clone
```

按原布局拉 rosters、roles、`parts/`、`snippets/` 与 `space.yaml`，并写一份来源账本 `.dsh-roster-origin.json`（`origin`、`commit`、`pulledAt`、每个文件的 `sha256` 与 blob id）。`dist/` 有意不拉。

### 让副本保持更新

```bash
npx dsh-agent-roster update --dir /tmp/clone/agent-teams           # 只看
npx dsh-agent-roster update --dir /tmp/clone/agent-teams --write   # 快进
npx dsh-agent-roster update --dir /tmp/clone/agent-teams --accept  # 把本地内容记成新基线
```

逐文件三方对比（账本 / 磁盘 / 该 ref 的远端），七态：

| 状态 | 含义 | `--write` |
|---|---|---|
| `clean` | 两边都没动 | 不动 |
| `local-only` | 本地改了、远端没动 | 不动 |
| `remote-only` | 远端改了、本地没动 | 替换并更新账本 |
| `diverged` | 两边都改了 | **不动**，打印两边 sha 与 diff |
| `remote-deleted` | 远端删了 | 不动，本地保留并标记 |
| `missing` | 本地没了 | 只报告 |
| `unverified` | 远端没回话 | 不动；**不算干净** |

刻意**不做自动合并**：这些是 YAML 加散文，没有 merge base，三方合并只会悄悄造出重名角色或改了一半的成员。要真合并就用 `git clone` 让 git 做——那会把凭据与推送带进插件，不作为默认。`--accept` 只认 `local-only`；`diverged` 永不认账。

## 左侧栏面板

左侧全局栏一行 **Agent 档案** 图标（`sidebar.panellist`），主区域同 id 注册整页；四个页签：

| 页签 | 能做什么 |
|---|---|
| **档案** | 默认只列收藏（分段控件切「全部」）；新建 / 编辑 / 复制 / 删除 / 导入 / 导出；每行「创建团队」；展开看成员、应用队长、复制成员参数；搜索与标签池 |
| **档案库** | 跨本机与订阅来源找档案：搜索、标签筛选、按来源聚合或平铺；本机的打开，其余的收藏；每个空间可「拉取整个空间」；本地空间章头显示「检查更新 / 应用 N 处更新 / N 处冲突 / N 处无法核对 / 无基线」 |
| **团队** | 读状态目录（默认 `.agent-teams`），列出运行时真正建出来的团队、成员路由、逐成员是否与档案一致、任务 |
| **体检** | 目录解析、状态目录、声明未确认项，指出该改哪个设置 |

设计上是**账本，不是卡片墙**：一行一份档案——左沿 3px 状态色（只有 error/warn 才亮）、等宽 id 列、标题与一句话、右侧计数、安静的操作；整页只有面板根滚动，展开多少内容就撑多高。窄于 860px 时标签池移到顶部、空间章头折两行。

设置只在面板头部的齿轮弹窗里（语言、下载区、镜像、档案库目录、只读摘要），**不再注册 DSH 设置页的节**。

### 创建团队

档案行上的「创建团队」与 `roster_team` 工具走同一段 `applyCaptain`：

- **新建会话**：选工作区（下拉，重名时补一级目录）+ 会话名；建好后自动改名。选中项以宿主的 `workspaceId` 发出（不是只给目录），会话因此会登记到该空间；只给目录时也会先按路径解析成工作区 id。
- **已有会话**：只显示「空间 · 会话名」，不显示 id 与路径。
- 队长人设走两条路：起始消息里原样带一份（一次性），以及会话建立后注入 `deployment:persona-prefix` section（每轮生效）。详见下节。模型仍来自部署，插件不写运行时。
- 队长应用（`/apply`）与工具都只**排队**提示词，建队由会话里的模型调用 `agent_teams_*` 完成。

### 队长人设怎么进会话

成员的人设由 `dsh-agent-teams` 在**成员子会话**上注册一个与部署 persona 同名的 `systemPrompt.section`（`deployment:persona-prefix`），靠同名遮蔽生效；队长是顶层会话，不在它的管辖里。本插件补上这另一半：

- 在队长会话的 ctx 上注册**同一个 section 名**，内容是档案里的队长人设（v1 的 `captain.systemPrompt` / `captain.personaPrefix`，v2 的 `captain.persona` 文件正文）。
- `text` 传的是函数，宿主每个模型步都会求值 ⇒ 改档案立即生效，不用重启、不用重建会话；文件读失败时沿用上一次的好值，**绝不用空串遮蔽部署 persona**。
- 归属不靠猜：读团队的 `captainSessionId`，再看团队 `description` 里的 `roster:<id>@<ver>#<sha8>` 找到档案。新会话是「先建会话、队长再建团队」，所以团队晚落盘时会短暂轮询（30 分钟内），落盘即挂上。
- 这是**进程内的 contribution**，不是写进磁盘的 preset：插件停用就回到部署 persona；跨重启仍在，因为重启后 `agent/created` 会重新解析团队并挂上。
- `roster_verify` 会额外打印一行「队长人设：已嵌入 <id>（N 字符 · #sha8 · 来源 file/inline）→ 会话 …」；插件启用前就存在的会话会显示「未嵌入」，此时会话只按起始消息里那份人设工作。
- 不想用就把 `injectCaptainPersona` 设为 `false`；行为回到「只有起始消息」。

### 收藏

收藏写在库根的 `.dsh-roster-favorites.json`（`dsh-agent-roster/favorites@1`，最多 500 条，原子替换）。保存/导入会自动收藏新档案；删除会取消收藏；坏文件只报一条 warn，面板照常可用。收藏**只影响视图**，不会移动文件。

## 工具（十一个：十个只读，`roster_team` 会建会话）

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `roster_list` | 列出档案与成员 | `path?` |
| `roster_show` | 一份档案的全部字段、归宿与诊断 | `ref`、`member?`、`path?` |
| `roster_create` | 产出可直接用的建员参数 + 溯源行 `roster:<id>@<ver>#<sha8>` | `ref`、`path?` |
| `roster_verify` | 比对 `team.json` 里实际存下的值 | `ref`、`team?`、`path?` |
| `roster_diff` | 两份档案的语义差异 | `from`、`to`、`path?` |
| `roster_index` | 公共索引状态；collection 附 `pulled` / `space` / `layout` | `collection?`、`source?`、`refresh?` |
| `roster_space` | 空间的登记 vs 在库、角色、来源与账本 commit | `path?` |
| `roster_search` | 跨本机与订阅来源搜索（多词为「且」；远端最多 8 个来源，超出报 info） | `query`、`path?`、`remote?`、`limit?` |
| `roster_compile` | 编译预览（不写盘） | `ref`、`path?` |
| `roster_changes` | 逐文件更新检查（七态） | `path?`、`refresh?` |
| `roster_team` | 从档案创建团队（新会话或已有会话） | `id`、`teamName?`、`mode?`、`workspace?`、`sessionName?`、`sessionId?`、`path?` |

写操作只走 CLI 与面板 HTTP 路由；工具层保持只读。

## 命令行

| 命令 | 用途 |
|---|---|
| `validate [--dir…] [--json]` | 校验档案库，有 error 时退出码 1 |
| `list [--dir…] [--json]` | 列出档案与成员 |
| `compile --roster <目录> [--write] [--run <回执>] [--json]` | 编译 v2 档案；`--write` 才写 `dist/` |
| `migrate --dir <目录> [--from <子目录>] [--repo <owner/repo>] [--write]` | v1 → v2 原地迁移 |
| `clone --repo <owner/repo> [--ref] [--path] [--space] [--dir]` | 整空间拉成本地副本（带账本） |
| `update --dir <空间> [--write] [--accept] [--json]` | 检查/快进/认账 |
| `registry validate --file <路径>` | 校验公共索引 |
| `registry fetch --file <路径> [--local-only]` | 逐条确认真能取到 |
| `registry sync --file <路径> [--write]` | 按仓库实际内容重算 roster 列表与文件映射 |

## 路由（十二条）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/plugins/dsh-agent-roster/library` | GET | 面板快照：工作区、库、档案、团队、提示、计数、`hostWorkspaces` |
| `/plugins/dsh-agent-roster/document` | GET | 单份档案原文与解析结果 |
| `/plugins/dsh-agent-roster/rosters` | POST | 新建 / 更新 / 删除 / 导入 / 导出 |
| `/plugins/dsh-agent-roster/apply` | POST | 应用队长：新会话（工作区 + 会话名）或已有会话 |
| `/plugins/dsh-agent-roster/collection` | GET | 只读拉取某个 collection |
| `/plugins/dsh-agent-roster/install` | POST | 把 collection 落盘（幂等，默认不覆盖） |
| `/plugins/dsh-agent-roster/install-space` | POST | 整空间拉取到本地目录 |
| `/plugins/dsh-agent-roster/catalog` | GET | 本机 + 每个订阅源的全部档案 |
| `/plugins/dsh-agent-roster/search` | GET | `?q=`：带命中原因 |
| `/plugins/dsh-agent-roster/favorites` | POST | 收藏 / 取消收藏 |
| `/plugins/dsh-agent-roster/space-update` | POST | `check` / `apply` / `accept` |
| `/plugins/dsh-agent-roster/locale` | GET | 面板词典（`zh` / `en`） |

都是 `exact` 路由，走宿主 `connection` 围栏，方法不符返回 405；写路由还会校验根目录白名单与请求体。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `rosterDirs` | `[]` | 档案库目录。留空 = 全局库 `$DSH_HOME/agent-roster`；绝对路径或 `~` 开头同样是全局的；只有相对路径按工作区解析。第一项是工具默认目录 |
| `knownToolPolicies` | `[]` | 部署已声明的 toolPolicy id；填了才做交叉校验 |
| `agentTeamsStateDir` | `.agent-teams` | 只读：`roster_verify`、`roster_team` 与会话注入的状态目录 |
| `injectCaptainPersona` | `true` | 把档案 captain 段的人设注入队长会话的 system prompt（同名 section 遮蔽部署 persona，每个模型步重读）。关掉后只剩起始消息里那份 |
| `language` | `"auto"` | `auto` 跟随 DSH，或固定 `zh` / `en` |
| `indexes` | `[]` | 公共源：`https` 的 `registry.json` 或 `npm:pkg`；留空 = 官方源；`false` = 不连远端 |
| `region` | `"auto"` | 下载区：`china` 走腾讯 npm 镜像；`auto` 等同 `global`，不探测 |
| `registryMirror` | `""` | 自定义镜像地址（可带子路径），留空用下载区预置 |

八项都是 volatile：改完不需要重启，但运行中的宿主重新注册工具时才生效。

## 诊断

诊断统一是 `{severity, code, path, message, file}`；`validate` 有 error 时退出码 1。按族看：

| 族 | 例子 |
|---|---|
| 格式 | `unknown-field`、`unknown-format`、`multiple-roster-files`、`duplicate-roster-id`、`duplicate-role` |
| 角色与拼装 | `missing-part`、`prompt-part-too-long`、`include-syntax`、`missing-include`、`unsafe-include`、`include-nested` |
| 编排 | `gate-unverifiable`、`gate-without-stage`、`empty-stage`、`onfail-unknown-stage`、`onfail-immediate`、`onfail-dangling`、`onfail-unbounded` |
| 能力 | `capability-policy-missing`、`capability-skills-unverified`、`capability-cross-check-skipped`、`invalid-document-path`、`invalid-document-sha` |
| 策略 | `tool-policy-cross-check-skipped`（没配 `knownToolPolicies` 时是 warn：写错的 id 也会通过，无法核对） |
| 空间 | `space-roster-missing`、`space-roster-undeclared`、`space-roster-archived`、`multiple-space-files`、`space-origin-not-allowed` |
| 账本 | `no-origin-ledger`、`origin-ledger-broken`、`clone-unsafe-path`、`clone-snippet-missing` |
| 会话 | `session-controller-unavailable`、`session-create-failed`、`session-rename-failed`、`prompt-not-queued` |
| 收藏/写入 | `favorites-unreadable`、`write-failed`、`delete-failed` |

## 与 `dsh-agent-teams` 的关系

- `roster_create` 的成员参数可直接喂给 `agent_teams_add_member`；每个字段标注 direct / config / declaration。
- 溯源行 `roster:<id>@<version>#<sha8>` 建议写进 `agent_teams_create` 的 `description`；`roster_verify` 会解析它并回显 `match` / `differ` / `id-only` / `absent`。
- `roster_verify` 读 `team.json` 的持久化字段；人设（`executionPrompt`）**会**持久化（DSH 0.2.2 实测，bridge 的 `stateKey` 就是它）。输出里的「未核实」只表示拿不到回执，不是「设计上不持久化」。
- **队长人设现在真的进会话了**：插件在队长会话上注册与成员侧同名的 `deployment:persona-prefix` section（每轮重读档案），`roster_verify` 报「已嵌入 / 未嵌入」而不是 `differ`。它与部署 preset 的 persona 仍是两份文本：如果还要让「插件不在时也生效」，需要把正文落进 profile preset，`roster_verify` 对那份差距报 `needs-config` 并给出 `profiles/<name>/cordis.patch.yml` 与 preset 名。
- `toolFilter` 是策略物化后的结果，team.json 不存，故显示「无法核对」；要核对策略定义得在部署侧。
- 插件不写团队状态，也不做 transfer。

## 开发

```bash
node --test                 # 386 个测试
npm run smoke               # 宿主侧 11 个工具 + 客户端两槽位
npm run check:locale        # 中英词典键对齐
npx dsh-agent-roster validate --dir examples
npx dsh-agent-roster registry validate --file index/registry.json
```

## 验证状态

- 全仓 **386/386**；smoke 双段；`check:locale` 四项 0；三座库 `validate` 0 error（`examples-orchestration` 保留一条既有的 `captain-not-targeted` warn）；`registry validate` 5 条 collection、0 error。
- CI `registry`（Node 22）重算索引、重编示例，并在 `dist/` 与源码不一致时失败。
- 实机 e2e（独立 `DSH_HOME` + 端口 3099）：`agent-teams`（4 人）、`metagpt-company`（4 人）、`openmanus`（3 人）三套档案分别真的建出团队，`roster_verify` 均 `faithful` 全中、`drift 0`；溯源行含内容哈希。
- 已知边界：`dist/` 不随 clone 拉取；按合集安装（`/install`）会把档案摊平成 v1 文档，整空间拉取（`clone` / `/install-space`）才保留 v2 布局与账本；`toolFilter` 无法从 team.json 核对；升级后需重启 `dsh web`。

## 许可

MIT
