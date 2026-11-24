# @stofone/dsh-agent-roster

[**English**](README.en.md) | [简体中文](README.md)

**Write the team down as a file you can review before you build it — then verify what the runtime actually stored after it exists.**

The roster layer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Agent Teams: personas, model routes and tool boundaries live in YAML/Markdown, compile into one self-contained artifact, and are checked field by field against `team.json` once the team is running. It does not run teams and does not replace [`dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams) — it adds the layer that engine leaves out.

<p align="center">
  <a href="https://www.npmjs.com/package/@stofone/dsh-agent-roster"><img src="https://img.shields.io/npm/v/@stofone/dsh-agent-roster?style=flat-square&amp;color=5B4CF0" alt="npm version"></a>
  <a href="https://github.com/dsh-agent-roster/dsh-agent-roster/actions/workflows/registry.yml"><img src="https://github.com/dsh-agent-roster/dsh-agent-roster/actions/workflows/registry.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT license"></a>
</p>

## 30-second demo

A real `roster_verify` run against a 14-member team (the tool's output is localized to Chinese; fields `agent-teams` does not persist are trimmed from the excerpt):

```text
[roster_verify] ok=false state=available members=14 deployed=14 faithful=7 unverified=0 drift=7 missing=0 unmanaged=1 toolFilter=14/14 policyDrift=0 provenance=0absent/1differ skills=0/0 requires=0missing/11 capabilityBlocked=0 captain=1

roster:money-lab@10.2.1  成员 14 · 已部署 14 · 一致 7

▸ report-builder  @ money-lab-v17   一致
   systemPrompt   运行时取值与档案一致  2494 字符
   model          运行时取值与档案一致  deepseek-v4.1-flash
   toolPolicy     运行时取值与档案一致  member-safe

▸ report-builder  @ money-lab       降级
   systemPrompt   运行时实际取值与档案不同  1741 字符  · 成员自带（运行时采用了不同的值）
```

Three things in that output matter:

- **It reads the values the runtime actually stored**, not the parameters we sent — which is how "the roster says A, the runtime is B" gets caught.
- **No evidence, no pass**: with no member session or an unreadable log, the verdict is *unverifiable*, never *faithful*.
- **The same member can differ across generations**: `report-builder` is faithful in the new team `money-lab-v17` and overridden in the old `money-lab` — exactly what you want to see before a handover.

## How this relates to agent-teams

The engine **runs** the team; this plugin makes it **reviewable before and verifiable after**. They do not overlap:

| | [`dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams) | This plugin |
|---|---|---|
| Where the team comes from | One sentence in a session; the captain decides the roster on the spot | A file you wrote: personas, model routes, tool boundaries, gates |
| Verifiable after creation | `team.json` is the runtime source of truth | Compares the roster against `team.json`, field by field: faithful / degraded / unverifiable |
| Can the persona change | Member personas are frozen at spawn | The captain persona is re-read every model step; edit the file, effective next step |
| What a handover carries | Not provided | Captain summary + one context packet per member (old session id and log path inside) |
| When to use it | You want a team that **runs** | You want that team **reviewable, verifiable, replaceable** |

You can use the engine alone; the moment you want to review the roster up front, or confirm "is the runtime actually the set of people I asked for", you want this layer.

## Install

```bash
dsh plugin --profile web add @stofone/dsh-agent-roster
```

Requires Node.js ≥ 22.19 and a running `dsh web`. Restart `dsh web` once after installing (plugins load at startup); after that **Agent 档案** appears in the left sidebar and thirteen `roster_*` tools are available.

Team creation still needs [`@nanmicoder/dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams): this plugin declares it as an optional peer and prints the install command when it is missing.

Compatibility: verified against DSH `0.2.2-rc.1`; the engine must be `>= 0.1.27`. See [Releases](https://github.com/dsh-agent-roster/dsh-agent-roster/releases/latest) for the current version and [CHANGELOG](./CHANGELOG.md) for what changed in each one.

## Quick start (no YAML required)

1. **Open the panel → 档案库 (Library)**. Everything published under the project registry is listed by space, searchable by capability and filterable by tag.

   2. **Pull a roster.** It is written into your local library; the 档案 (Rosters) tab then shows its members and model routes.

3. **Create a team**: click 创建团队 on the roster row — a new session (pick workspace, session name, captain model) or an existing one.

4. **Verify**: run `roster_verify` in that session. Every field gets a verdict; values the runtime overrode show as *degraded*, with the roster value and the runtime value side by side.

Prefer to write your own? The minimal v2 roster is two files (`roles/<name>/AGENT.md` + `rosters/<id>/roster.yaml`), then `compile` once. The full layout is in [docs/guide.md](./docs/guide.md); [examples/](./examples) is a two-roster example library.

## What you get

| Capability | What it changes | Entry point |
|---|---|---|
| **A persona that keeps evolving** | The captain's system prompt carries the roster persona through a same-name section that is **re-read on every model step**: you edit it, or the session edits it, and the next step obeys — no restart, no rebuild. The persona is a live file, not text frozen at spawn. | automatic |
| Roster definition | v2 in three layers: `roles/<name>/AGENT.md` (+ `parts/`, `{{> include}}`) → `rosters/<id>/roster.yaml` → a self-contained `dist/` artifact | `roster_compile` |
| Validation | Every field has a home (direct / config / declaration); a gate must have an executable `verify`; capability requirements report present / missing / unknown only | `validate`, `roster_verify` |
| Team creation | Member arguments generated from the roster; new session or an existing one, optional workspace and session name | `roster_team` |
| Iteration | Compare roster against runtime → optionally write back → new session, or **iterate inside the current one** (asks before archiving a team it already leads); captain context via `handover.summary`, members via `handover.members` | `roster_iterate` |
| Verification | Reads the provider / model / reasoningEffort / toolPolicy **actually stored** in `team.json`, and reports faithful, degraded or unverifiable per field | `roster_verify` |
| Write-back | Writes runtime values back into the roster; **asks first** by default | `roster_capture` |
| Persona rosters | `members: []` + `captain.persona`: one persona *is* a session's identity, no team; applies to an existing session immediately | panel "Apply" |
| Knowledge layer | Roles and rosters can declare `knowledge:`; the prompt carries title + summary + path, and the body is opened on demand | `roster_compile` |
| Panel | **Agent 档案** in the sidebar: Rosters / Library / Teams / Health, with search, tag filters, favorites, space pull, import | Web UI |
| Spaces and subscriptions | `space.yaml` describes a library; `clone` pulls it, `update` reports six states and never auto-merges | `roster_space`, CLI |

## The most useful thing it does: let a context-heavy session write its own roster and hand over

A project session that has run for weeks holds decisions, mistakes already paid for, open threads, and each member's temperament. Pasting that transcript into a new session is expensive and drags stale conclusions along; throwing it away resets the project's memory to zero.

So let **the session write the roster itself**: captain persona, member composition, model and tool boundaries, acceptance gates, handover guidance — all as files. Then `roster_iterate` produces the next generation: a fresh session that starts from zero and carries exactly three things — the previous captain's handover summary, one context packet per member, and an executable step list. Details are not copied wholesale, only pointed at: each packet names the old session id and the session log path, so the original words can be read back when needed.

The roster is a live file, not a snapshot: edit a role's body and the captain speaks as the new persona on the next step (same-name section, re-read every step) — no rebuild, no restart.

Three moves: **write** (the session turns "how we work now" into a roster) → **hand over** (`roster_iterate` writes the captain summary and per-member packets, with delivery instructions in the kickoff message) → **verify** (`roster_verify` checks models, tool boundaries, personas, and whether each packet actually reached its member: delivered / not seen / unverifiable).

The boundaries, stated plainly: conversations are not migrated, only pointed at; member personas are frozen at spawn, so changing members means a new generation; the captain persona is the one part that changes and takes effect immediately.

## What it is / is not

| Is | Is not |
|---|---|
| A definition and validation layer: versionable, reviewable, with file and field paths in every error, never a silent downgrade | A team runtime: it does not spawn members, schedule tasks, or replace the scheduler |
| A bridge to `dsh-agent-teams`: produces usable member arguments and marks, field by field, whether the runtime really took them | It does not write `.agent-teams/` state: read-only, for verification |
| A verification tool: only the values actually stored in `team.json` count | It does not fake a pass: a missing evidence source is reported as *unverifiable* |

## Docs

| Document | What it covers |
|---|---|
| [docs/guide.md](./docs/guide.md) | **The full manual**: three on-disk shapes, v1/v2 formats, includes, shared knowledge, field homes, capability requirements, spaces, panel, thirteen tools, CLI, routes, config, diagnostics |
| [docs/roster-v2.md](./docs/roster-v2.md) | The v2 format spec (roles / rosters / artifacts / task plans) |
| [docs/design.md](./docs/design.md) | Design trade-offs and where each module lives |
| [CHANGELOG.md](./CHANGELOG.md) | What changed in each version, why, and what it affects |
| [examples/](./examples), [examples-orchestration/](./examples-orchestration) | Two example libraries: a minimal roster; orchestration with gates and task plans |

## Boundaries

- It does not run teams, schedule work, or write `.agent-teams/`; it also **never restarts** a service on its own.
- A session leads at most one team; iterate the same roster through `roster_iterate` instead of rebuilding in place.
- Editing a roster in the panel edits files; runtime values inside `.agent-teams/` are never rewritten by the panel.

## Development

```bash
node --test              # 498 tests
npm run smoke            # host + client smoke
npm run check:host       # four host contracts, read from the installed DSH
npm run check:locale     # panel strings aligned across en/zh
node bin/cli.mjs validate --dir examples
npm run e2e              # boots a real host: 17 panel checks
```

## How releases work

This repository is maintained by an AI, and the cadence is public so you can tell when your issue turns into a version:

- **Two passes a day** (12:00 / 18:00 Beijing time): 12:00 handles issues and PRs without touching the version; **18:00 is the release window**.
- **At most one version per day**; a day with no substantive change ships nothing.
- **Merged is not released**: changes land on `main` and ship in the next version; the `Unreleased` section of `CHANGELOG.md` states which version it is planned for.
- SemVer by content: bug fixes are patches, new capability is a minor; a batch containing any new capability ships as a minor.
- GitHub Releases exist only for minors (`x.y.0`); patch notes live in `CHANGELOG.md` and the tag.
- Every change — including the maintainer's own — goes through a pull request, and merges only when `verify` is green.

## License

MIT. Licensing of example libraries and role material is documented per directory; material imported from `@michengai/dsh-agency-agents` follows its Apache-2.0 NOTICE.
