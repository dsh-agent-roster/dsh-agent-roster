# @stofone/dsh-agent-roster

**English** | [简体中文](README.md)

A **static member roster** layer for multi-agent teams on DeepSeek Harness: who is on the team, what each member owns, which model route they take, and which tools they may touch — written as reviewable, validatable files, and **checked against what the runtime actually stored** after the team is created.

It does not run teams and does not replace `dsh-agent-teams`; it adds the layer around it — review the roster before creating a team, verify after, and write drift back.

**Quick start**: [install](#install) → [write a roster](#quick-start). The full manual (format, tools, panel, diagnostics) is in [docs/guide.md](./docs/guide.md) (Chinese).

> **How this repository is run**: it is operated by AI — issues, pull requests, releases and documentation are handled by an AI agent, while humans keep the direction and the final call.
>
> **Release discipline** (since 2026-11-12):
>
> - Two rounds a day (12:00 / 18:00): 12:00 only handles issues and PRs; 18:00 is the release window.
> - Unless explicitly asked, **at most one release per day**; no substantive change, no release.
> - Nothing ships unless every gate is green: `node --test`, smoke, `check:host`, `check:locale`, `validate`; panel or team-creation changes also run `e2e`.
> - Versions only move by patch/minor; commits link their issue; CHANGELOG says what changed and what it touches.
> - After a release the profile is updated and WeCom notified; **`dsh web` is never restarted automatically**.
> - Anything that could not be verified is labelled “unverified”; the message stream is not a ledger.
>
> Every change goes through a pull request: `main` is protected and the `verify` check must pass.

## What it does

| Capability | In one line | Entry point |
|---|---|---|
| **Captain persona, live** | The captain session's system prompt is replaced (same-name section) with the roster persona and **re-read on every model step**: edit the file, next step reflects it — no restart, no new session | automatic |
| Roster definition | v2 is three layers: `roles/<name>/AGENT.md` (+ `parts/` and `{{> include}}`) → `rosters/<id>/roster.yaml` → self-contained `dist/` | `roster_compile` |
| Validation | Every field is direct / config / declaration; a gate needs an executable `verify`; capabilities report present / missing / unknown | `validate`, `roster_verify` |
| Team creation | Turn a roster into member arguments; new session or a named existing one, with workspace and title | `roster_team` |
| Succession | Compare roster with runtime → optional write-back → new session, or **replace within the current session** (asks before archiving the old team) | `roster_iterate` |
| Verification | Read what `team.json` actually stored (provider / model / reasoningEffort / toolPolicy) and report match, degraded, or unverifiable | `roster_verify` |
| Write-back | Put runtime values back into the roster; asks first by default | `roster_capture` |
| Knowledge | Roles and rosters can declare `knowledge:`; the prompt carries title + summary + path only, the body is opened on demand | `roster_compile` |
| Panel | “Agent roster” in the left panel: rosters / library / teams / health, with search, tag filters, favourites, space pulls and import | Web UI |
| Spaces | `space.yaml` describes a library; `clone` pulls it, `update` compares six states (conflicts are never auto-merged) | `roster_space`, CLI |

## What it is / is not

| It is | It is not |
|---|---|
| A definition and validation layer: versionable, reviewable, errors carry file and field paths, nothing degrades silently | A team runtime: it does not spawn members, schedule tasks, or replace a scheduler |
| A bridge to `dsh-agent-teams`: produces member arguments and labels, field by field, whether the runtime carries them | A writer of `.agent-teams/` state: that is read-only, used for verification |
| A verification tool that only trusts what `team.json` actually stored | A rubber stamp: a missing evidence source is reported as “unverifiable” |

## Install

```bash
dsh plugin --profile web add @stofone/dsh-agent-roster
```

Then restart `dsh web` (the plugin loads at start): the **Agent roster** panel appears in the sidebar and thirteen tools are registered. Requires Node.js ≥ 22.19.

## Quick start

The roster library is **global** by default (one per machine), at `$DSH_HOME/agent-roster` (usually `~/.dsh/agent-roster`), created on first save.

A v2 roster on disk looks like this (**required**: `AGENT.md` and `roster.yaml`; the optional entries are shown in place, their contents are not expanded here):

```
~/.dsh/agent-roster/
├── space.yaml                  # optional: register this library as a space
├── snippets/                   # optional: shared text ({{> snippets/x.md}})
├── knowledge/                  # optional: project knowledge; prompts carry title+summary+path
├── shared-roles/               # shared roles (legacy name roles/ is still read)
│   └── writer/
│       ├── AGENT.md            # required: frontmatter + persona body
│       └── parts/              # optional: body parts, joined in prompt.parts order
├── rosters/
│   └── docs/
│       ├── roster.yaml         # required: members, captain, orchestration and gates
│       ├── roles/              # optional: roles private to this roster (shadow shared)
│       └── capabilities.yaml   # optional: what the deployment must provide first
└── dist/
    └── docs-1.0.0.json         # compiled artifact (panel, /install and subscriptions read it)
```

A minimal roster is `roles/writer/AGENT.md` + `rosters/docs/roster.yaml`, plus one `compile` run to produce `dist/`. Full field list: [docs/guide.md](./docs/guide.md).

### 1. Write a role

`roles/writer/AGENT.md`:

```markdown
---
kind: dsh-agent-roster/role@1
name: writer
version: 1.0.0
role: technical writer
title: documentation
description: edits docs only, never code
tags: [docs]
route:
  model: deepseek-flash
  reasoningEffort: high
tools:
  policy: read-only
---

You own the documentation. After editing, run `npm run check:locale` and paste the raw output if it fails.
```

### 2. Write a roster

`rosters/docs/roster.yaml`:

```yaml
kind: dsh-agent-roster/roster@2
id: docs
version: 1.0.0
title: Docs crew
members:
  - as: writer
    role: writer@1.0.0
captain:
  role: writer@1.0.0
  notes: The captain persona is injected into the captain session's system prompt and re-read every step.
```

### 3. Validate

```bash
npx dsh-agent-roster validate --dir ~/.dsh/agent-roster   # format, references, capabilities, gates
npx dsh-agent-roster list --dir ~/.dsh/agent-roster       # rosters and members
npx dsh-agent-roster compile --roster ~/.dsh/agent-roster/rosters/docs
```

### 4. Create and verify

Tell the captain session “create a team from the docs roster”, or pick it under **Teams → Create team** in the panel. After it exists, in the same session:

```
roster_verify            # roster vs runtime, field by field
roster_capture           # write runtime values back (asks first)
roster_iterate           # succession: new session, or in place (asks before archiving)
```

## Documentation

| Document | Contents |
|---|---|
| [docs/guide.md](./docs/guide.md) | **Full manual** (Chinese): layouts, v1/v2 formats, includes, shared knowledge, field destinations, capabilities, spaces, panel, the thirteen tools, CLI, routes, config, diagnostics |
| [docs/roster-v2.md](./docs/roster-v2.md) | v2 format specification |
| [docs/design.md](./docs/design.md) | Design decisions and module placement |
| [CHANGELOG.md](./CHANGELOG.md) | What each version changed, why, and what it touches |
| [examples/](./examples), [examples-orchestration/](./examples-orchestration) | Two example libraries: a minimal roster; gates and a task plan |

## Boundaries

- No running teams, no scheduling, no writes to `.agent-teams/`, and **no automatic restarts**.
- A session leads at most one team; use `roster_iterate` for succession rather than recreating in place.
- Editing in the panel edits files; runtime values under `.agent-teams/` are never rewritten by the panel.

## Development and verification

```bash
node --test              # 468 tests
npm run smoke            # host + client smoke
npm run check:host       # four host contracts, read from the installed DSH
npm run check:locale     # panel strings, en/zh parity
node bin/cli.mjs validate --dir examples
npm run e2e              # real host: 17 panel checks
```

## License

MIT. Licences of example libraries and imported material are in their own directories; material imported from `@michengai/dsh-agency-agents` follows its Apache-2.0 NOTICE.
