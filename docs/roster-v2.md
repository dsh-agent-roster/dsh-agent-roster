# 档案 v2：角色 / 组装 / 编译

> 状态：draft → 实现中（`lib/role.js`、`lib/roster2.js`、`lib/compile2.js` 已落地并通过单测；CLI 与工具接线待做）。
> 判别键：`dsh-agent-roster/role@1`、`dsh-agent-roster/roster@2`、`dsh-agent-roster/compiled@1`。
> v1（`dsh-agent-roster/v1`）**冻结**：不再长字段，只按本文的迁移规则重写成 v2。

## 1. 为什么分层

v1 把四类不同性质的权威塞进同一份 `roster.yaml`：

| 权威 | 该谁拥有 | v1 的做法 | 后果 |
|---|---|---|---|
| 人设（散文） | 角色 | YAML 块标量 `systemPrompt` | 散文缩在 YAML 里，diff 不可读，编辑器不给补全 |
| 路由与工具策略（参数） | 角色 | 与散文并列 | 换模型要改人设文件 |
| 目录元数据（标题、描述、标签） | 组装 | 同文件 | 同一角色的两套组装各写一份标题 |
| 队长配置 | 组装 | `lead` 既是成员又进 `captain` | 双写，两份会漂移 |

再加三条结构性缺陷：

- **拼装协议藏在插件代码里**：运行时只收到一条 `executionPrompt` 字符串，谁拼的、拼了哪些片段，产物里看不出来。
- **身份靠路径**：目录名必须等于文件里的 `id`，改 id 就得移目录。
- **没有编排层**：质量门、修复回合只能队长临场发挥，格式里写不下来，也就没法校验。

v2 的答案是三层，每层只有一个权威：

```
roles/<任意目录>/AGENT.md      ← 角色：frontmatter=参数，正文=人设，parts/=可选片段
rosters/<id>/roster.yaml       ← 组装：成员是引用，队长独立成段，编排是一等公民
dist/<id>-<ver>.json           ← 编译产物：自包含、可哈希、消费者只看这个
```

## 2. 三个判别键，一条规则

| 文件 | 判别键 |
|---|---|
| `roles/*/AGENT.md` 的 frontmatter | `kind: dsh-agent-roster/role@1` |
| `rosters/*/roster.yaml` | `kind: dsh-agent-roster/roster@2` |
| `dist/*.json`、`compiled/` | `kind: dsh-agent-roster/compiled@1` |
| `.agent-roster/lock.yaml` | `kind: dsh-agent-roster/lock@1` |

**判别键决定版本，目录与文件名不决定版本。** 同一个目录不允许两种格式共存：v1 文件被 v2 加载器读到就报 `kind` 不符，`roster migrate` 负责原地重写。

## 3. 角色：`roles/<dir>/AGENT.md`

```markdown
---
kind: dsh-agent-roster/role@1
name: reviewer
version: 1.4.0
role: 代码评审
route:
  provider: deepseek
  model: deepseek-v4.1-flash
  reasoningEffort: high
tools:
  policy: member-safe
prompt:
  parts: [parts/checklist.md, parts/tone.md]
  budget: 6000
requires:
  skills: [dsh-chat-import]
---

你是评审。先读 diff，再读测试……
```

- **正文就是人设**，不再需要块标量；`parts/` 里的片段按 `prompt.parts` 的顺序拼在正文之后。
- **拼装语义写进格式**（不是插件的秘密）：

  ```
  executionPrompt = join("\n\n", [body, ...parts, ...rosterAppend])
  其中每段前置 member.prompt.prepend（若有）
  ```

  分隔符固定为两个换行，`assemblePrompt()` 是唯一实现（`lib/frontmatter.js`）。
- **预算按字符**：`prompt.budget` 与 `LIMITS2.promptChars`（12000）都是字符数。不引入 token 预算——token 估算随 provider 变，会变成第二种真源。
- **字段归宿**与 v1 一致的三分法：`route`/`tools.policy` 是 `direct`（进 `agent_teams_add_member`）；`tools.scope` 是 `config`（声明，不承载）；`requires` 是证据源约束（技能目录 / 部署声明的 toolPolicies）。
- **未知键一律拒绝**：角色文档宁可报错，也不带一个没人校验的键。

## 4. 组装：`rosters/<id>/roster.yaml`

```yaml
kind: dsh-agent-roster/roster@2
id: money-lab
version: 10.0.0
title: 资金实验室
defaults:
  route: { provider: deepseek, model: deepseek-v4.1-flash, reasoningEffort: high }
targets: [agent-teams/members]
members:
  - as: reviewer
    role: reviewer@1.4.0
    prompt: { append: overrides/reviewer.md }
captain:
  role: lead@2.0.0
  persona: personas/lead.md
requires:
  toolPolicies: [member-safe]
orchestration:
  shape: gate-pipeline
  stages:
    - { id: build, parallel: [reviewer], join: audit }
    - { id: fix, role: fixer@1.0.0, maxRounds: 2 }
  gates:
    - { id: audit, after: [build], by: reviewer, verify: [{ command: node --test, expectExit: 0 }] }
```

四条规则：

1. **成员是引用不是内嵌**：`role: name@x.y.z`，不写范围、不写 latest。角色内容改了必须发版，引用它的组装才知道要跟。
2. **队长独立成段**：`captain` 不是成员。它描述"创建这个团队的那个会话"，路由与 persona 只能落 profile 配置——这是 `config` 层，插件只声明。
3. **`targets` 决定字段落到哪个面**：`agent-teams/members`（桥接参数）、`agent-teams/orchestration`（任务 DAG）、`profile/agent-preset`。没有目标的面，字段只能是声明。
4. **`orchestration` 先当声明**：它能被校验（stage/gate 交叉引用、`maxRounds` 上限），但编译器只把它原样带进产物并标 `status: "declaration"`。**没有任何验证器能证明它会被执行**，所以不假装生效；编译成 `create_task` 的 DAG 是下一步。

### 身份与唯一性

- `id` 来自文档，不再要求等于目录名（不同就报 info `id-directory-differs`）。
- 代价是丢了 v1 用路径换来的唯一性，所以补一条更强的规则：**同一座库里 `name`（角色）与 `as`（成员）必须唯一**，重名是 error。
- 锁文件（`.agent-roster/lock.yaml`）双轨记录：`role@x.y.z` + 角色文件 sha256。版本回答"该不该升"，哈希回答"内容是不是我以为的那份"。

## 5. 门必须有可执行的判据

一个门如果只写一句「现有测试全部通过」，那它唯一的判定者就是签字的人自己——这正是 issue #2 修掉的那种假绿。所以 v2 的门**必须**带至少一条 `verify`：

```yaml
gates:
  - id: tests-pass
    after: [audit]
    by: reviewer
    verify:
      - command: node --test
        expectExit: 0
    requires: [没有新增未覆盖的分支]   # 人读判据，不能替代 verify
```

- `verify` 是可执行判据：跑什么命令、期望哪个退出码。判定者必须先跑它，跑不过就是不过。
- `requires` 保留，但降级为**补充说明**：它描述「命令之外还想让人看什么」，不能替代 `verify`。
- 没有 `verify` 的门在组装校验阶段就被拒（`gate-unverifiable`），不会流进编译产物。

## 6. 编译产物：`dist/<id>-<ver>.json`

```json
{
  "kind": "dsh-agent-roster/compiled@1",
  "source": { "roster": "money-lab", "version": "10.0.0", "file": "rosters/money-lab/roster.yaml", "lock": "…", "repo": "github:…", "ref": "main" },
  "targets": ["agent-teams/members"],
  "captain": { "role": "lead@2.0.0", "provider": "deepseek", "model": "…", "personaPath": "personas/lead.md", "personaChars": 900, "personaSha256": "…" },
  "members": [
    {
      "name": "reviewer",
      "role": "reviewer@1.4.0",
      "roleName": "reviewer",
      "roleVersion": "1.4.0",
      "executionPrompt": "……",
      "promptStats": { "chars": 4210, "parts": [{ "path": "AGENT.md", "kind": "body+parts" }], "sha256": "…" },
      "provenance": { "role": "reviewer@1.4.0", "sha256": "ab12cd34" }
    }
  ],
  "orchestration": { "shape": "gate-pipeline", "stages": [], "gates": [], "status": "declaration" },
  "declarations": [{ "scope": "member", "member": "reviewer", "field": "tools.scope", "note": "运行时只认 toolPolicy，scope 不承载" }],
  "requires": { "skills": [], "toolPolicies": ["member-safe"] }
}
```

- **消费者只看产物**：桥接层、registry、面板都从 `compiled` 读，不再各自解析源文件。
- **自包含**：产物里有人设全文与哈希、有每个成员的来源角色与短哈希，不需要回头再读 `roles/`。
- **可 diff、可哈希**：产物序列化稳定（键顺序固定、无时间戳），`sha256` 直接当发布指纹。
- **声明清单显式化**：凡是"写下来但不会被运行时执行"的字段，都在 `declarations[]` 里点名，避免第二次"看起来生效了"。

## 7. 施工图：`dist/<id>-<ver>.tasks.json`

编译产物回答「这份档案长什么样」，施工图回答「照它该怎么跑」。它把 stages/gates 摊成一张张卡片，每张卡带 `id / kind / member / subject / description / dependencies`，门卡额外带 `gate.verify`。

```json
{
  "kind": "dsh-agent-roster/plan@1",
  "roster": { "id": "core-review", "version": "1.0.0" },
  "executor": "captain",
  "tasks": [
    { "id": "build", "kind": "stage", "member": "fixer", "dependencies": [] },
    { "id": "audit", "kind": "stage", "member": "reviewer", "dependencies": ["build"] },
    { "id": "tests-pass", "kind": "gate", "member": "reviewer", "dependencies": ["audit"],
      "gate": { "id": "tests-pass", "verify": [{ "command": "node --test", "expectExit": 0 }] } }
  ],
  "loop": { "onGateFailure": { "retry": "build", "maxRounds": 2 }, "runRecord": "dist/core-review-1.0.0.run.json" }
}
```

三件事在这份文件里被写死，不留解释空间：

1. **谁执行**：`executor: "captain"`。插件不调用 `agent_teams_create_task`——写团队状态的能力只属于队长会话。施工图是**给队长的施工图**，不是插件替队长施工。
2. **谁判门**：`gate.verify` 里的命令。判定者跑完把结论写进卡片输出；没跑就等于没判。
3. **谁重试**：门不过就回到第一个阶段，最多 `maxRounds` 轮；失败意见写进 `runRecord` 指向的文件，下一轮重试卡把它带上。

卡片真正的 id 由团队分配，施工图里的 id 只在内部表达依赖——否则「编译产物」就变成了「团队状态的第二真源」。

## 8. 迁移

- `roster migrate --dir <库> [--write]` 读 v1 档案，把 `systemPrompt` 拆成角色（`roles/<member>/AGENT.md`）+ 组装（成员改为引用），原地重写并生成 `dist/`。默认只出计划，`--write` 才落盘——这是唯一会删旧目录的命令。
- **角色名带档案 id 前缀**（`core-review-reviewer`）：v2 要求同库角色名唯一，而真实档案库里几十套组装都可能叫 `lead`。队长与成员同名时，队长得到 `-captain` 后缀，不与人设合并。
- `maintainers` 用 `handle` 模式（允许大写与点），不复用档案 id 的小写短横线规则——维护者是账号，不是标识符。
- v1 冻结：新字段只进 v2，不再回填 v1。
- 同一目录两种格式共存是**禁止**的：判别键说了算。

## 9. 与既有两层声明的关系

| 层 | 文件 | 回答的问题 |
|---|---|---|
| 能力 | `capabilities.yaml` | 这份档案要求部署提供什么（有证据源） |
| 组织 | `organization.yaml` | 这座库收了哪些档案、哪些已归档 |
| 角色/组装 | `AGENT.md` + `roster.yaml` | 谁是谁、怎么拼、编排放哪 |

三者正交：`requires` 说"必须有"，`capabilities.yaml` 说"这份组装必须有"，`organization.yaml` 说"这座库有哪些"。

## 10. 未决与下一步

1. **施工图 ↔ 团队真实卡 id 的映射**：`run@1` 已经能读、能合并（`compile --run` 会把上一轮失败写进重试卡），但「施工图内部 id ↔ 团队真实 task id」的映射表还没落成文件——目前靠执行者按 id 命名建卡。
2. `dist` 的发布与 `registry` 只登记产物（现在 registry 登记的是档案路径）。
3. `profile/agent-preset` 目标：把队长与成员的 preset 片段生成出来，仍然只产参不写入。
4. 编辑器支持：三个 schema 已就位，LSP 级校验待做。
