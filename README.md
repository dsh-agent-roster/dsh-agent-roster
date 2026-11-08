# @stofone/dsh-agent-roster

**English** | [简体中文](README.zh.md)

A **static member roster** plugin for multi-agent teams on DeepSeek Harness.

A roster is a file on disk: who is on the team, what each member owns, which model route they take, and which tools they may touch. This plugin defines that format, validates it, and translates it into `agent_teams_*` arguments — it does not run teams.

## What it is / what it is not

| It is | It is not |
|---|---|
| A definition and validation layer: versionable, reviewable, and loud on errors (file path + field path), never silently degrading | A team runtime: it never creates members, schedules work, or replaces a scheduler |
| A bridge to `dsh-agent-teams`: `roster_create` emits ready-to-use member arguments and labels every field with whether the runtime really carries it | A writer of `.agent-teams/` state: read-only, for verification |
| A verification path: `roster_verify` reads the values **actually persisted** in `team.json` | A rubber stamp: when the evidence source is absent it says “unverified” |

## Install

Requirements: DSH provides the `tools` service; Node.js ≥ 22.19. Runtime dependencies are declared (`yaml`, `@deepseek-ai/schemastery`); `@deepseek-ai/dsh-tools` is a peer (accepted range spans the 0.1, 0.2.0, 0.2.1, 0.2.2 and 0.3 prerelease lines; the suite and both smokes run against 0.2.2-rc.1).

```
@stofone/dsh-agent-roster
```

The package ships `cordis.patch.yml`, so installing it into a profile wires the plugin. After install you should see **eleven tools** (see “Tools”) and an **Agent Roster** panel in the left sidebar.

Plugin code is loaded when DSH starts: after upgrading, **restart `dsh web`**. Swapping `node_modules` alone leaves the running host on the old build.

## Quick start

The roster library is **global** by default: one per machine, independent of workspaces, at `$DSH_HOME/agent-roster` (`~/.dsh/agent-roster`; the mounted data volume under Docker). It is created on first save.

A v2 space looks like this:

```
~/.dsh/agent-roster/
├── space.yaml                     # optional: register the library as a space
├── roles/
│   └── core-review-lead/
│       └── AGENT.md               # a role = one directory + one AGENT.md
├── rosters/
│   └── core-review/
│       ├── roster.yaml            # a roster = members + orchestration
│       └── capabilities.yaml      # optional: what the deployment must provide
└── dist/
    └── core-review-1.0.0.json     # compiled artifact (self-contained)
```

```bash
npx dsh-agent-roster validate --dir examples     # validate the example space (v2)
npx dsh-agent-roster list --dir examples         # list rosters and members
npx dsh-agent-roster compile --roster examples/rosters/core-review   # print the compiled result
```

The repo ships two example libraries: [`examples/`](./examples) (v2) and [`examples-orchestration/`](./examples-orchestration) (v2, demonstrating gates and the task plan).

## Three on-disk shapes

| Shape | Layout | Produced by |
|---|---|---|
| **Flat library (v1)** | `<root>/<id>/roster.yaml` | hand-written, single installs, old libraries |
| **Space (v2)** | `<root>/roles/` + `<root>/rosters/` (+ optional `snippets/`, `space.yaml`) | hand-written, `migrate`, `clone` |
| **Pulled copy** | a space or flat library + `.dsh-roster-origin.json` (origin ledger) | `clone` / the panel’s “pull the whole space” |

`space.yaml` is an **optional** declaration layer: with it you get “declared vs on disk vs missing vs undeclared”; without it the library is still scanned, just without that reconciliation. Favourites live in `.dsh-roster-favorites.json` at the library root (a dotfile; the scanner skips it).

## Roster format (v1, flat libraries)

```yaml
kind: dsh-agent-roster/v1
roster: core-review          # must equal the directory name
version: 1.0.0               # exact SemVer
title: Core review
description: A fixed team for code review and release gating.
license: MIT
maintainers: [STofone]
tags: [review, release]

defaults:                    # shared route defaults
  provider: deepseek
  model: deepseek-v4.1-flash
  reasoningEffort: high

members:
  - name: reviewer           # kebab-case, unique in the team
    role: Code review
    systemPrompt: |
      Look for semantic errors first, style second.
    toolPolicy: readonly
  - name: release-manager
    role: Release gating
    systemPrompt: |
      Check the diff, the version bump, and the rollback plan.

captain:                     # optional: what the session that creates the team looks like
  name: lead
  provider: tsingmicro
  model: deepseek-v4.1-flash
  personaPrefix: |
    Restate the goal and the acceptance criteria before delegating.
```

| Key | Required | Notes |
|---|---|---|
| `kind` | yes | `dsh-agent-roster/v1` |
| `roster` | yes | kebab-case id; must equal the directory name (position is identity) |
| `version` | yes | exact SemVer, no ranges |
| `title` / `description` / `license` / `maintainers` / `tags` | no | display and discovery metadata |
| `defaults` | no | `provider` / `model` / `reasoningEffort` inherited by members |
| `members` | yes | 1–32 |
| `captain` | no | declaration only; its persona is injected into the session when applied |

Member keys: `name`, `role`, `systemPrompt` (required), plus `provider`, `model`, `reasoningEffort`, `toolPolicy`, `fallback`, `toolScope`, `maxTokens`, `title`, `tags`, `notes`, `description`, `aliases`, `skills`, `examples`.

A directory is probed as `roster.yaml` → `roster.yml` → `roster.json`; **exactly one** is accepted. A second file is an error, never a silent pick. Unknown keys are errors.

## Role → roster → artifact (v2)

### Roles: `roles/<name>/AGENT.md`

A role is “one directory plus a file named exactly `AGENT.md`”; directories may nest (up to 3 levels), but a directory holds at most one role. Identity comes from frontmatter `name`, not the directory name; duplicate names are an error.

```yaml
---
kind: "dsh-agent-roster/role@1"
name: "core-review-lead"
version: "1.0.0"
role: "Lead"
title: "Orchestration"
description: "Runs the review, splits work, merges conclusions"
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

The body is the persona. `prompt.parts` may add fragments after the body, in order; fragments must live inside the role directory (escaping is an error).

### Rosters: `rosters/<id>/roster.yaml`

```yaml
kind: dsh-agent-roster/roster@2
id: core-review
version: 1.0.0
title: Core review
description: A small team: the lead splits work, review gates it, a fixer closes it.
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
  - as: reviewer            # name inside the team
    role: reviewer@1.0.0    # role reference with an exact version
  - as: fixer
    role: fixer@1.0.0
    prompt:
      append: overrides/fixer.md   # member-level append, joined at the end

captain:
  role: lead@1.0.0
  persona: captains/lead.md    # a file path (relative to the roster dir); its body is the persona

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
      requires: [Existing tests pass]
      verify:
        - command: node --test
          expectExit: 0

requires:
  toolPolicies: [member-safe]
onMissing: refuse
```

Roster keys: `kind`, `id`, `version`, `title`, `description`, `license`, `maintainers`, `tags`, `defaults`, `targets`, `members`, `captain`, `orchestration`, `requires`, `onMissing`, `notes`.

There is exactly one way to assemble the execution prompt (`lib/frontmatter.js#assemblePrompt`):

```
executionPrompt = join("\n\n", [member prepend, body after references, ...prompt.parts, member append])
```

Budgets are **characters**: body 8000, one part 6000, 16 parts, 12000 after expansion, member append 6000.

### Orchestration and gates

`orchestration.stages` are stages (`serial` / `parallel` lists, optional `join`, `on`, `maxRounds`); `gates` are gates (`after`, `by`, `requires`, `verify`).

A gate without an executable check is an error (`gate-unverifiable`): each `verify` entry needs `command` and `expectExit` (1–8 entries). **Only what a machine can run counts as a gate**; prose criteria belong in `requires`.

A gate may also declare a **failure edge**: where control goes when the gate fails, and how many times it may retry.

```yaml
gates:
  - id: tests-pass
    after: [audit]
    onFail: { to: repair, maxRounds: 2 }
```

- `onFail.to` must be a declared stage and must **not** be in this gate's own `after` (that is a retry in place, with no repair step) — `onfail-immediate`.
- It must be covered by another gate's `after`; otherwise the repair never returns to a gate and the edge has no exit — `onfail-dangling`.
- `maxRounds` is required (1–5) — a retry without a bound is a loop with no stop condition.
- Two failure edges may point at each other; the product of the rounds around such a loop must stay ≤ 5 (`onfail-unbounded`). `after` declares order only and is not a machine-checkable cycle.

### Compiled artifacts

```bash
npx dsh-agent-roster compile --roster examples/rosters/core-review --write
```

- `dist/<id>-<version>.json` (`compiled@1`): self-contained; members carry `executionPrompt`, `promptStats` (character counts, per-part `{path, kind, line?, sha256}`, an overall sha256) and `provenance`; `source` carries discovery metadata (title, description, tags, license, maintainers).
- `dist/<id>-<version>.tasks.json` (`plan@1`): emitted when the roster has orchestration; `executor: "captain"`.
- `--run <receipt>` folds a failed `run@1` back into the retry card.

## References inside a persona

A persona body may place a shared block inline, **on a line of its own**:

```markdown
{{> snippets/report-shape.md}}
```

- `snippets/…` resolves against the **library root**; other paths resolve against the **role directory**; escaping is an error.
- Exactly one level: a `{{>` inside an included file is `include-nested`.
- Including the same file twice expands it twice; `prompt.parts` still rejects duplicates.
- Budgets apply **after** expansion: 6000 per file, 12000 total, at most 32 references.
- Errors carry line numbers of the whole file; `promptStats` records `{path, kind: "include", line, sha256}`.
- No conditionals, loops, or variables: a roster must be readable literally and statically checkable.

`snippets/` belongs to v2 libraries only; `dist/` is not cloned and must be rebuilt locally.

## Where each field actually lands

| Destination | Fields | Does the runtime receive it? |
|---|---|---|
| **direct** | `name`, `role`, `systemPrompt`, `provider`, `model`, `reasoningEffort`, `toolPolicy` | passed to `agent_teams_add_member` |
| **config** | library directories, team state directory, language, index sources | plugin configuration, not team state |
| **declaration** | `description`, `aliases`, `skills`, `examples`, `tags`, `notes`, `captain`, `tools.scope` | documentation and validation only; `skills` never auto-loads, `captain` only describes (its persona is injected on apply) |

`roster_create` labels every emitted field with its class; `roster_verify` compares only what the runtime persisted.

`tools.scope` is a declaration too: it is validated and surfaced by `roster_verify` under “declared fields (applied: false)”, but it never reaches `agent_teams_add_member` and does not change what a member may call. Runtime permissions come from `toolPolicy`.

## Capability requirements (`capabilities.yaml`)

A sibling file may declare what the deployment must provide before the team can be built:

```yaml
requires:
  skills: [frontend-skill]
  toolPolicies: [member-safe]
  documents:
    - path: docs/runbook.md
      sha256: 3f2a…            # optional: pin the content, not just the name
onMissing: refuse        # refuse (default) | degraded
```

- Three verifiable classes: whether a skill is installed, whether a toolPolicy id was declared by the deployment, and whether a document is present (and unchanged, if you pinned its sha256).
- Three states: `present` / `missing` / `unknown`; only `missing` triggers `onMissing`; `unknown` (no evidence source) is not a pass.
- `refuse` makes `roster_create` emit no arguments and name what is missing; `degraded` emits them with per-field labels.
- Document paths are relative to the **library root** (not the roster directory); `..` and absolute paths are rejected. A missing file is `missing`; an existing file whose content no longer matches the pinned sha256 is also `missing` (with `why: sha-mismatch`). Documents are never assembled into `executionPrompt` — they are evidence, not persona text.

## Spaces (`space.yaml`)

```yaml
kind: dsh-agent-roster/space@1
space: agent-roster            # must equal the directory name
title: Team roster collection
description: Many rosters living in one repository.
license: MIT
homepage: https://github.com/…
maintainers: [STofone]
layout: monorepo               # monorepo | flat
rosters:
  - id: core-review
  - id: research
    status: active             # active | archived
roles: [core-review-lead, reviewer]   # optional role declarations
```

- `layout` describes file placement, not counts: `monorepo` is `rosters/<id>/roster.yaml`, `flat` is `<id>/roster.yaml`.
- Declared vs disk: missing → error `space-roster-missing`; extra → warn `space-roster-undeclared`; archived but still present → info.
- **`origin` is an error inside a repository**: the source is the repository itself, and a second copy would be a second source of truth. Only pulled local copies may carry `origin: {repo, ref, path}`.

### Pulling a whole space

```bash
npx dsh-agent-roster clone --repo dsh-agent-roster/agent-teams --space agent-teams --dir /tmp/clone
```

It pulls rosters, roles, `parts/`, `snippets/` and `space.yaml` in their original layout, then writes an origin ledger `.dsh-roster-origin.json` (`origin`, `commit`, `pulledAt`, per-file `sha256` and blob id). `dist/` is deliberately not pulled.

### Keeping a pulled copy current

```bash
npx dsh-agent-roster update --dir /tmp/clone/agent-teams           # check only
npx dsh-agent-roster update --dir /tmp/clone/agent-teams --write   # fast-forward
npx dsh-agent-roster update --dir /tmp/clone/agent-teams --accept  # accept local as the new baseline
```

Three-way comparison per file (ledger / disk / remote at the ref), seven states:

| State | Meaning | `--write` |
|---|---|---|
| `clean` | neither side changed | nothing |
| `local-only` | local changed, remote did not | nothing |
| `remote-only` | remote changed, local did not | replace and update the ledger |
| `diverged` | both changed | **nothing**; print both shas and a diff |
| `remote-deleted` | gone on the remote | nothing; keep local and mark it |
| `missing` | gone locally | report only |
| `unverified` | remote did not answer | nothing; **not clean** |

There is deliberately **no auto-merge**: these files are YAML plus prose, with no merge base; a three-way merge would quietly invent duplicate roles or half-renamed members. Real merging belongs to `git clone` — which drags credentials and push access into the plugin, so it is not the default. `--accept` only accepts `local-only`; `diverged` is never accepted.

## Sidebar panel

The plugin adds one row, **Agent Roster**, to the global sidebar (`sidebar.panellist`) and registers the full page under the same id in `main`. Four tabs:

| Tab | What it does |
|---|---|
| **Rosters** | defaults to favourites (segmented control switches to all); create / edit / duplicate / delete / import / export; a “Create team” button per row; expand for members, apply-captain, copy member params; search and a tag pool |
| **Library** | find rosters across local libraries and subscribed sources: search, tag filtering, grouped by source or flat; open local ones, favourite the rest; “pull the whole space” per space; the local space header shows “check updates / apply N updates / N conflicts / N unverified / no baseline” |
| **Teams** | reads the state directory (default `.agent-teams`) and lists the teams actually built, member routes, per-member agreement with the roster, and tasks |
| **Health** | resolved directories, state directory, unconfirmed declarations, and which setting to change |

The design is a **ledger, not a card wall**: one row per roster — a 3px status edge (lit only for error/warn), a monospace id column, title and one-line description, counts on the right, quiet actions. Only the panel root scrolls; expanded content grows the page instead of creating a nested scroll box. Below 860px the tag pool moves above the list and the space header wraps to two lines.

Settings live only in the panel’s gear dialog (language, download region, mirror, library directories, read-only summary); the plugin **no longer registers a DSH settings section**.

### Creating a team

The row button and the `roster_team` tool share one `applyCaptain` path:

- **New session**: pick a workspace (dropdown; duplicates are disambiguated with one parent directory) and type a session name; the session is renamed after creation. The choice is sent as the host `workspaceId` (not just a directory), so the session is accounted in that workspace; a bare directory is resolved to a workspace id first.
- **Existing session**: shown as “workspace · session name”, never an id or a path.
- If the roster declares a captain persona, it is injected into the kick-off prompt verbatim; the model still comes from the deployment, and the plugin writes no runtime state.
- `roster_verify` compares the declared captain route with **the model the captain session actually selected** (`session.*`), not with the deployment default; if the session cannot be read, the check is `unknown` rather than a pass.
- Both the panel and the tool only **queue** the prompt; the model in that session calls `agent_teams_*` to build the team.

### Favourites

Favourites live in `.dsh-roster-favorites.json` at the library root (`dsh-agent-roster/favorites@1`, at most 500 entries, atomic replace). Saving or importing auto-favourites the new roster; deleting unfavourites it; a broken file yields one warning and the panel still works. Favourites **affect the view only** and never move files.

## Tools (eleven: ten read-only, `roster_team` creates a session)

| Tool | Purpose | Key parameters |
|---|---|---|
| `roster_list` | list rosters and members | `path?` |
| `roster_show` | all fields, destinations and diagnostics for one roster | `ref`, `member?`, `path?` |
| `roster_create` | emit ready-to-use member arguments + provenance line `roster:<id>@<ver>#<sha8>` | `ref`, `path?` |
| `roster_verify` | compare against the values persisted in `team.json` | `ref`, `team?`, `path?` |
| `roster_diff` | semantic diff between two rosters | `from`, `to`, `path?` |
| `roster_index` | public index state; collections carry `pulled` / `space` / `layout` | `collection?`, `source?`, `refresh?` |
| `roster_space` | declared vs on-disk rosters, roles, origin and ledger commit | `path?` |
| `roster_search` | search across local and subscribed sources (words are ANDed; remote scans at most 8 sources and reports truncation) | `query`, `path?`, `remote?`, `limit?` |
| `roster_compile` | compilation preview (writes nothing) | `ref`, `path?` |
| `roster_changes` | per-file update check (seven states) | `path?`, `refresh?` |
| `roster_team` | create a team from a roster (new or existing session) | `id`, `teamName?`, `mode?`, `workspace?`, `sessionName?`, `sessionId?`, `path?` |

Writing goes through the CLI and the panel’s HTTP routes only; the tool layer stays read-only.

## CLI

| Command | Purpose |
|---|---|
| `validate [--dir…] [--json]` | validate libraries; exit code 1 on errors |
| `list [--dir…] [--json]` | list rosters and members |
| `compile --roster <dir> [--write] [--run <receipt>] [--json]` | compile a v2 roster; `--write` writes `dist/` |
| `migrate --dir <dir> [--from <sub>] [--repo <owner/repo>] [--write]` | migrate v1 → v2 in place |
| `clone --repo <owner/repo> [--ref] [--path] [--space] [--dir]` | pull a whole space with a ledger |
| `update --dir <space> [--write] [--accept] [--json]` | check / fast-forward / accept |
| `registry validate --file <path>` | validate a public index |
| `registry fetch --file <path> [--local-only]` | confirm every collection really resolves |
| `registry sync --file <path> [--write]` | recompute roster lists and file maps from the repo |

## Routes (twelve)

| Route | Method | Purpose |
|---|---|---|
| `/plugins/dsh-agent-roster/library` | GET | panel snapshot: workspaces, libraries, rosters, teams, diagnostics, counts, `hostWorkspaces` |
| `/plugins/dsh-agent-roster/document` | GET | raw and parsed document for the editor |
| `/plugins/dsh-agent-roster/rosters` | POST | create / update / delete / import / export |
| `/plugins/dsh-agent-roster/apply` | POST | apply the captain: new session (workspace + name) or existing session |
| `/plugins/dsh-agent-roster/collection` | GET | read a collection without writing |
| `/plugins/dsh-agent-roster/install` | POST | write a collection into a local library (idempotent, no overwrite by default) |
| `/plugins/dsh-agent-roster/install-space` | POST | pull a whole space into a local directory |
| `/plugins/dsh-agent-roster/catalog` | GET | every roster visible locally or in subscribed sources |
| `/plugins/dsh-agent-roster/search` | GET | `?q=`, with match reasons |
| `/plugins/dsh-agent-roster/favorites` | POST | favourite / unfavourite |
| `/plugins/dsh-agent-roster/space-update` | POST | `check` / `apply` / `accept` |
| `/plugins/dsh-agent-roster/locale` | GET | panel dictionary (`zh` / `en`) |

All are exact routes behind the host `connection` fence; a wrong method is 405. Write routes also enforce a root-directory allow-list and request-body limits.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `rosterDirs` | `[]` | library directories. Empty = global library `$DSH_HOME/agent-roster`; absolute or `~` paths are global too; only relative paths resolve per workspace. The first entry is the tools’ default |
| `knownToolPolicies` | `[]` | toolPolicy ids declared by the deployment; cross-checking only happens when set |
| `agentTeamsStateDir` | `.agent-teams` | read-only state directory for `roster_verify` and the Teams tab |
| `language` | `"auto"` | `auto` follows DSH, or pin `zh` / `en` |
| `indexes` | `[]` | public sources: an `https` `registry.json` or `npm:pkg`; empty = official source; `false` = local only |
| `region` | `"auto"` | download region: `china` uses the Tencent npm mirror; `auto` means `global` (no probing) |
| `registryMirror` | `""` | custom mirror URL (sub-paths allowed); empty uses the region preset |

All seven are volatile: changes apply without a restart, but the running host re-registers tools on its own schedule.

## Diagnostics

Every diagnostic is `{severity, code, path, message, file}`; `validate` exits 1 when there is an error. By family:

| Family | Examples |
|---|---|
| Format | `unknown-field`, `unknown-format`, `multiple-roster-files`, `duplicate-roster-id`, `duplicate-role` |
| Roles and assembly | `missing-part`, `prompt-part-too-long`, `include-syntax`, `missing-include`, `unsafe-include`, `include-nested` |
| Orchestration | `gate-unverifiable`, `gate-without-stage`, `empty-stage`, `onfail-unknown-stage`, `onfail-immediate`, `onfail-dangling`, `onfail-unbounded` |
| Capabilities | `capability-policy-missing`, `capability-skills-unverified`, `capability-cross-check-skipped`, `invalid-document-path`, `invalid-document-sha` |
| Spaces | `space-roster-missing`, `space-roster-undeclared`, `space-roster-archived`, `multiple-space-files`, `space-origin-not-allowed` |
| Ledger | `no-origin-ledger`, `origin-ledger-broken`, `clone-unsafe-path`, `clone-snippet-missing` |
| Sessions | `session-controller-unavailable`, `session-create-failed`, `session-rename-failed`, `prompt-not-queued` |
| Favourites / writes | `favorites-unreadable`, `write-failed`, `delete-failed` |

## Relationship to `dsh-agent-teams`

- `roster_create` member arguments feed `agent_teams_add_member` directly; every field is labelled direct / config / declaration.
- The provenance line `roster:<id>@<version>#<sha8>` is meant for `agent_teams_create`’s `description`; `roster_verify` parses it and reports `match` / `differ` / `id-only` / `absent`.
- `roster_verify` reads persisted fields in `team.json`; the persona (`executionPrompt`) is not persisted there, so it is reported as “not persisted”, never as “matches”.
- `toolFilter` is the materialised deny list and is not stored in `team.json`, so it is reported as “unverified”; check policy definitions on the deployment side.
- The plugin never writes team state and has no transfer operation.

## Development

```bash
node --test                 # 364 tests
npm run smoke               # host: 11 tools; client: two slots
npm run check:locale        # zh/en dictionary key parity
npx dsh-agent-roster validate --dir examples
npx dsh-agent-roster registry validate --file index/registry.json
```

## Verification status

- **375/375** tests; both smoke halves; `check:locale` four checks at 0; `validate` on three libraries with 0 errors (`examples-orchestration` keeps one pre-existing `captain-not-targeted` warning); `registry validate` covers 5 collections with 0 errors.
- CI `registry` (Node 22) recomputes the index, recompiles the examples, and fails when `dist/` drifts from source.
- Live e2e on an isolated `DSH_HOME` (port 3099): the `agent-teams` (4 members), `metagpt-company` (4) and `openmanus` (3) rosters each actually built a team; `roster_verify` reported every member faithful, `drift 0`, and the provenance line carried the content hash.
- Known boundaries: `dist/` is not cloned; installing a collection (`/install`) flattens rosters into v1 documents, while a whole-space pull (`clone` / `/install-space`) keeps the v2 layout and ledger; `toolFilter` cannot be verified from `team.json`; `dsh web` must be restarted after an upgrade.

## License

MIT
