# @stofone/dsh-agent-roster

[English](README.en.md) | **简体中文**

面向多 Agent 团队的**静态成员档案**层（DeepSeek Harness）：把「团队里有谁、各自负责什么、走哪个模型、能碰哪些工具」写成可评审、可校验的文件，并在建团之后**核对运行时真实存下的值**。

它不运行团队，也不替代 `dsh-agent-teams`——它补的是「建团前能 review、建完能核、跑偏能回写」这一层。

**一分钟上手**：[安装](#安装) → [快速开始](#快速开始)；完整的格式、工具参数、面板与诊断在 [docs/guide.md](./docs/guide.md)。

## 主要功能

| 能力 | 一句话 | 入口 |
|---|---|---|
| **队长人设运行时注入** | 队长会话的 system prompt 用同名 section 换成档案人设，**每个模型步重读**：改档案下一步生效，不用重启或重建会话 | 自动 |
| 档案定义 | v2 三层：`roles/<name>/AGENT.md`（+ `parts/` 与 `{{> 引用}}`）→ `rosters/<id>/roster.yaml` → 自包含产物 `dist/` | `roster_compile` |
| 校验 | 字段归宿三分（direct / config / declaration）、门必须有可执行的 `verify`、能力要求只报 present / missing / unknown | `validate`、`roster_verify` |
| 建团 | 从档案生成建员参数；新开会话或落到指定会话，可选工作区与会话名 | `roster_team` |
| 换代 | 先比对档案与运行时 → 可选回写 → 新开会话，或**在当前会话里换代**（已带队时先问是否归档） | `roster_iterate` |
| 核对 | 读 `team.json` 里**实际存下的** provider / model / reasoningEffort / toolPolicy，逐项报一致、降级、无法核对 | `roster_verify` |
| 回写 | 把运行时值写回档案；默认**先问再做**，确认后才动文件 | `roster_capture` |
| 知识层 | 角色与档案可声明 `knowledge:`，提示词只放「标题 + 概要 + 路径」，正文按需打开 | `roster_compile` |
| 面板 | 左侧栏「Agent 档案」：档案 / 档案库 / 团队 / 体检四页签，搜索、标签筛选、收藏、拉取空间、导入 | Web UI |
| 空间与订阅 | `space.yaml` 描述一座档案库；可用 `clone` 拉取、`update` 比对六态（不自动合并冲突） | `roster_space`、CLI |

## 它是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 定义与校验层：格式可版本化、可评审，写错时带文件路径与字段路径报错，不静默降级 | 团队运行时：不建成员、不调度任务、不替代调度器 |
| 对 `dsh-agent-teams` 的桥接：产出可直接使用的建员参数，并逐字段标注运行时是否真的接收 | 不写 `.agent-teams/` 状态：只读，用于核对 |
| 核对手段：只认 `team.json` 里实际存下的值 | 不假装通过：证据源缺席时记「无法核对」 |

## 安装

```bash
dsh plugin --profile web add @stofone/dsh-agent-roster
```

装完重启 `dsh web`（插件在启动时加载）：左侧栏出现 **Agent 档案**，工具多出十三个。前置只要 Node.js ≥ 22.19。

## 快速开始

档案库默认是**全局**的（一台机器一份），位于 `$DSH_HOME/agent-roster`（默认 `~/.dsh/agent-roster`），首次保存时自动创建。

一份 v2 档案在磁盘上的完整结构（**必需**的两个文件是 `AGENT.md` 与 `roster.yaml`；其余可选，位置在这里列出，内容不展开）：

```
~/.dsh/agent-roster/
├── space.yaml                  # 可选：把这座库登记成一个空间
├── snippets/                   # 可选：正文共享片段（{{> snippets/x.md}}）
├── knowledge/                  # 可选：项目知识，提示词只放标题+概要+路径
├── shared-roles/               # 共享角色（旧名 roles/ 仍读）
│   └── writer/
│       ├── AGENT.md            # 必需：frontmatter + 人设正文
│       └── parts/              # 可选：正文分段，按 prompt.parts 的顺序拼接
├── rosters/
│   └── docs/
│       ├── roster.yaml         # 必需：成员、队长、编排与门
│       ├── roles/              # 可选：只属于这份档案的角色（同名压过共享）
│       └── capabilities.yaml   # 可选：部署侧必须先提供什么
└── dist/
    └── docs-1.0.0.json         # 编译产物（面板、/install 与订阅读它）
```

最小档案就是 `roles/writer/AGENT.md` + `rosters/docs/roster.yaml`，再跑一次 `compile` 得到 `dist/`。完整字段见 [docs/guide.md](./docs/guide.md)。

### 1. 写一个角色

`roles/writer/AGENT.md`：

```markdown
---
kind: dsh-agent-roster/role@1
name: writer
version: 1.0.0
role: 技术写作
title: 文档维护
description: 只改文档，不动代码
tags: [docs]
route:
  model: deepseek-flash
  reasoningEffort: high
tools:
  policy: read-only
---

你负责文档。改完必须跑 `npm run check:locale`，报错就把原始输出贴出来。
```

### 2. 写一份档案

`rosters/docs/roster.yaml`：

```yaml
kind: dsh-agent-roster/roster@2
id: docs
version: 1.0.0
title: 文档小队
members:
  - as: writer
    role: writer@1.0.0
captain:
  role: writer@1.0.0
  notes: 队长人设由插件注入队长会话的 system prompt，每步重读。
```

### 3. 校验

```bash
npx dsh-agent-roster validate --dir ~/.dsh/agent-roster   # 格式、引用、能力、门
npx dsh-agent-roster list --dir ~/.dsh/agent-roster       # 列档案与成员
npx dsh-agent-roster compile --roster ~/.dsh/agent-roster/rosters/docs
```

### 4. 建团并核对

对队长会话说「用 docs 档案建一支团队」，或在面板「团队 → 创建团队」里选它；建完在同一个会话里跑：

```
roster_verify            # 档案 vs 运行时，逐字段
roster_capture           # 想把运行时值写回档案时（默认先问）
roster_iterate           # 换代：新开会话，或当前会话换代（先问是否归档旧队）
```

## 文档

| 文档 | 讲什么 |
|---|---|
| [docs/guide.md](./docs/guide.md) | **完整手册**：三种落盘形态、v1/v2 格式、正文引用、公共知识、字段归宿、能力要求、空间、面板、十三个工具、命令行、路由、配置、诊断 |
| [docs/roster-v2.md](./docs/roster-v2.md) | v2 格式规范（角色 / 档案 / 产物 / 施工图） |
| [docs/design.md](./docs/design.md) | 设计取舍与模块落点 |
| [CHANGELOG.md](./CHANGELOG.md) | 每个版本改了什么、为什么、影响面 |
| [examples/](./examples)、[examples-orchestration/](./examples-orchestration) | 两座示例库：最小档案；带门与施工图的编排 |

## 边界

- 不跑团队、不调度、不写 `.agent-teams/`；也**不自动重启**任何服务。
- 一个会话最多领导一支团队；同一档案的换代请走 `roster_iterate`，而不是原地重建。
- 面板改档案 = 改文件；`.agent-teams/` 里的运行时值不会被面板改写。

## 开发与验证

```bash
node --test              # 468 个测试
npm run smoke            # 宿主 + 客户端两段冒烟
npm run check:host       # 四条宿主契约（对着装好的 DSH 读）
npm run check:locale     # 面板文案 en/zh 对齐
node bin/cli.mjs validate --dir examples
npm run e2e              # 真起宿主：面板 17 项
```

## 许可

MIT。示例库与角色素材的许可见各自目录；`@michengai/dsh-agency-agents` 导入的素材遵循其 Apache-2.0 NOTICE。
