# @stofone/dsh-agent-roster

**English** | [简体中文](README.zh.md)

A **static member roster** plugin for multi-agent teams on DeepSeek Harness.

A roster is a file on disk: who is on the team, what each member owns, which model route they take, and which tools they may touch. This plugin defines that format, validates it, and translates it into `agent_teams_*` arguments — it does not run teams.

**Contents**: what it is · install · quick start · three on-disk shapes · role → roster → compiled · references · shared knowledge · where each field lands · capabilities · space · the sidebar panel · tools · CLI · routes · configuration · diagnostics · relationship with `dsh-agent-teams` · development. Design and maintenance rules: [`docs/design.md`](./docs/design.md).

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

The package ships `cordis.patch.yml`, so installing it into a profile wires the plugin. After install you should see **thirteen tools** (see “Tools”) and an **Agent Roster** panel in the left sidebar.

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

The two roster versions share one semantic model; only the on-disk shape differs. The panel detail and `roster_list` / `roster_show` report `format: roster@1 | roster@2`. **v1 is frozen**: bug fixes only, no new fields — use v2 when you need role reuse, `{{> …}}` references, shared knowledge or orchestration. A single-collection install (`/install`) writes the flattened v1 document; use the whole-space pull to keep the space layout.

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
  provider: deepseek-official
  model: deepseek-flash
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
  provider: deepseek-official
  model: deepseek-flash
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
| `captain` | no | never creates a session and never writes team state; its persona is injected into the captain session's system prompt (a session-scoped section, same as members). `roster_verify` reports attached / not attached; a gap against the deployment preset persona is still `needs-config` |

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
  provider: "deepseek-official"
  model: "deepseek-flash"
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
    provider: deepseek-official
    model: deepseek-flash
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

Roster keys: `kind`, `id`, `version`, `title`, `description`, `license`, `maintainers`, `tags`, `defaults`, `targets`, `members`, `captain`, `orchestration`, `handover`, `requires`, `onMissing`, `notes`.

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

- `snippets/…` and `knowledge/…` resolve against the **library root**; other paths resolve against the **role directory**; escaping is an error.
- Exactly one level: a `{{>` inside an included file is `include-nested`.
- Including the same file twice expands it twice; `prompt.parts` still rejects duplicates.
- Budgets apply **after** expansion: 6000 per file, 12000 total, at most 32 references.
- Errors carry line numbers of the whole file; `promptStats` records `{path, kind: "include", line, sha256}`.
- No conditionals, loops, or variables: a roster must be readable literally and statically checkable.

`snippets/` and `knowledge/` belong to v2 libraries only; `dist/` is not cloned and must be rebuilt locally.

## Shared knowledge

`knowledge/` at the library root is **shared knowledge**, next to `snippets/` but consumed differently:

| Mode | How | Where it goes | Good for |
|---|---|---|---|
| inline | `{{> knowledge/xxx.md}}` on a line of its own | into `executionPrompt`, under the 12000 budget | short rules, conventions, checklists |
| pointer | declared under `knowledge:` in `space.yaml` | only "absolute path + content hash + title" reaches the captain's kick-off | long documents, project maps |

```yaml
# space.yaml
knowledge:
  - path: knowledge/project-map.md
    title: Project map
    sha256: 8db26ddabbdd897063625438d852e0641fe329a1eff084b526737e41ee993332   # optional
```

- **A declaration is not content**: bodies never enter the prompt; the pointer lets the session open them on demand.
- `clone` pulls every declared file (even if no role references it); `clone-knowledge-missing` is a warning.
- `validate`/`scan` check the disk: missing file is error `space-knowledge-missing`, hash mismatch is warn `space-knowledge-drift`, an undeclared file under `knowledge/` is info `space-knowledge-undeclared`.
- Paths must stay under `knowledge/` and be safe relative paths; hashes are 64 lowercase hex characters.
- No second source of truth: the file is the only copy; the declaration records path and hash only.

## Where each field actually lands

| Destination | Fields | Does the runtime receive it? |
|---|---|---|
| **direct** | `name`, `role`, `systemPrompt`, `provider`, `model`, `reasoningEffort`, `toolPolicy` | passed to `agent_teams_add_member` |
| **config** | library directories, team state directory, language, index sources | plugin configuration, not team state |
| **declaration** | `description`, `aliases`, `skills`, `examples`, `tags`, `notes`, `tools.scope` | documentation and validation only; `skills` never auto-loads |

`captain` is its own section: not a member field, never sent to `agent_teams_add_member`; the plugin registers a `deployment:persona-prefix` section on the captain session to inject it. The model still comes from the deployment.

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
- A library root can be just a container: `clone` / “pull the whole space” lands a space under `<root>/<space-id>/`, and the panel and tools expand each space as its own library. The root itself is not a space — do not put a `space.yaml` there.
- Repository coordinates `github:owner/repo` and `owner/repo` are equivalent; the prefix is stripped before building `raw.githubusercontent.com` URLs.
- Pulling zero rosters is not success: it fails with `clone-no-rosters` instead of leaving a `space.yaml`-only directory (which would look installed while showing nothing).
- **`origin` is an error inside a repository**: the source is the repository itself, and a second copy would be a second source of truth. Only pulled local copies may carry `origin: {repo, ref, path}`.

### Pulling a whole space

```bash
npx dsh-agent-roster clone --repo dsh-agent-roster/agent-teams --space agent-teams --dir /tmp/clone
```

It pulls rosters, roles, `parts/`, `snippets/`, `knowledge/` and `space.yaml` in their original layout, then writes an origin ledger `.dsh-roster-origin.json` (`origin`, `commit`, `pulledAt`, per-file `sha256` and blob id). `dist/` is deliberately not pulled.

### Keeping a pulled copy current

```bash
npx dsh-agent-roster update --dir /tmp/clone/agent-teams           # check only
npx dsh-agent-roster update --dir /tmp/clone/agent-teams --write   # fast-forward
npx dsh-agent-roster update --dir /tmp/clone/agent-teams --accept  # accept local as the new baseline
```

Beyond the files in the ledger, it also reads the remote `space.yaml` and picks up `knowledge/` and `rosters/` entries that exist upstream but not in the ledger — those used to report "clean" forever.

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
- The captain persona takes two paths: verbatim in the kick-off prompt (one-shot), and a `deployment:persona-prefix` section registered on the session (every turn). See the next section. The model still comes from the deployment, and the plugin writes no runtime state.
- `roster_verify` compares the declared captain route with **the model the captain session actually selected** (`session.*`), not with the deployment default; if the session cannot be read, the check is `unknown` rather than a pass.
- **Captain model**: the dropdown lists the provider/model pairs this deployment actually serves (from the host model catalog). A roster's `captain.route` was written on its author's machine and may not exist here — when the declared pair is present it stays selected; when it is missing the option is disabled with an explanation and “deployment default (no switch)” is chosen instead. The picked pair travels as `model` to `/apply` and overrides the roster route; `reasoningEffort` still comes from the roster.
- Both the panel and the tool only **queue** the prompt; the model in that session calls `agent_teams_*` to build the team.

### Team engines

Teams are built by **Agent Teams** (`@nanmicoder/dsh-agent-teams`) only: members are created field by field (provider/model/persona/toolPolicy reach the runtime), the team has a `team.json`, and verify/capture/iterate plus captain-persona injection all work.

The panel no longer offers an engine choice — there is one. When the package is missing, the create-team dialog says "not installed" and disables submit, so the dependency stays visible. Detection means "this profile can resolve the package", not "it is mounted".

`POST /apply` and `roster_team` take a closed `target` set (`agent-teams` only); any other value is `unknown-target`. Both also accept a `model` override `{provider, model, reasoningEffort?}`: the panel lists only models the deployment really serves, and `roster_team` rejects an unavailable model with `model-unavailable`.

### How the captain persona reaches the session

Member personas work because `dsh-agent-teams` registers a `systemPrompt.section` named `deployment:persona-prefix` on each **member child session**; a same-named section shadows the deployment persona. The captain is a top-level session, outside its remit, so this plugin adds the other half:

- It registers the **same section name** on the captain session's ctx, with the roster persona (v1 `captain.systemPrompt` / `captain.personaPrefix`, v2 `captain.persona` file body or the role body, with optional `captain.prompt.prepend` / `captain.prompt.append` files — the same two ends members get).
- `text` is a function, evaluated by the host on every model step, so edits take effect immediately and no restart or session rebuild is needed; on a read failure the last good text is kept — **never an empty string that would shadow the deployment persona**.
- Ownership is resolved, not guessed: read the team's `captainSessionId`, then the `roster:<id>@<ver>#<sha8>` provenance in the team description to find the roster. A new session creates the session first and the team second, so a short poll (up to 30 minutes) attaches as soon as the team lands.
- **The library the injection reads follows the `path` used to create the session.** `roster_team({path})` may point at any library; the session remembers that library root, and `rosterDirs` is only the fallback. When neither holds the roster the failure is no longer silent — the log gets `captain persona not attached: roster "<id>" not found in roots [...]`, and `roster_verify` says `roster directory not found: searched …` instead of blaming the session's age.
- It is an in-process contribution, not a preset written to disk: disabling the plugin returns the session to the deployment persona. A restart re-resolves the team on `agent/created` and reattaches.
- `roster_verify` prints an extra line: `captain persona: attached <id> (N chars · #sha8 · file/inline) → session …`. Sessions created before the plugin was enabled show `not attached`, and keep working off the kick-off message.
- Set `injectCaptainPersona` to `false` to opt out; behaviour falls back to the kick-off message only.

### Favourites

Favourites live in `.dsh-roster-favorites.json` at the library root (`dsh-agent-roster/favorites@1`, at most 500 entries, atomic replace). Saving or importing auto-favourites the new roster; deleting unfavourites it; a broken file yields one warning and the panel still works. Favourites **affect the view only** and never move files.

### Iterating and handing over

A roster does not get fresher because the team ran well — the runtime consumes rosters in one direction. Two tools bring changes back:

- `roster_capture`: compares `team.json` with the roster member by member (`role` by the **expanded role name**, with the reference kept as a note; `provider`/`model`/`reasoningEffort`/`toolPolicy` by value; the persona only by the assembled hash and length). Read-only by default, and it lists what could be written back; `apply: true` writes the **mechanical fields** back to `roster.yaml`, bumps the patch version and recompiles `dist/`; `apply: true` plus `remember: true` also records “always write back from now on” (first as the `captureAutoApply` setting, then, if that cannot be written, into `.dsh-roster-preferences.json` at the library root). The persona is never written back: the runtime stores the assembled text, and writing it into the role file would flatten `parts` and `{{> …}}`; edit the role body instead.
- `roster_iterate`: finds the old team by its provenance line, optionally captures/applies, then creates a new session and queues the build prompt. The old team is left alone. When there are writable differences and `capture` is omitted, it returns the diff and **stops without creating a session**, so you can pick `capture: true` (write back, then iterate), `capture: true` + `remember: true` (write back and remember), or `capture: false` (iterate without touching the roster).

A roster can also carry its own hand-over guide: `handover` is the long-lived answer to "what should the next captain read first", not a script. Items are strings or `{title, detail?, verify?}` (up to 32; `title` ≤120 characters, `detail`/`verify` ≤400). `roster_iterate` puts it into the new captain's first message, in the order **archive guide → this run's steps (if any) → system fallback**; the plugin never executes it.

```yaml
handover:
  - "Read the gates and acceptance criteria before delegating"
  - title: "Recreate the 09:30 wake-up in the new session"
    detail: "The old session id cannot be reused; timers belong to the host schedule"
    verify: "schedule list shows a task pointing at the new session"
```

Hand-over steps go in `handover.steps` (`timer.cancel`/`timer.create`/`wake.update`/`archive`/`notify`/`verify`/`note`, …). The tool writes them to `<library>/.dsh-handover/<roster>-YYYYMMDD-HHmmss.json` and renders a checklist at the end of the new captain’s kick-off message, for that captain to execute one by one. **The plugin carries, validates and delivers; it does not run them**: timers belong to the host `schedule` plugin, wake routing to the team scripts, archiving to the workspace API — none of that is inside the roster layer’s boundary; the `verify` field is the command the new captain should run afterwards. A non-note step without `verify` records a warning.

## Tools (thirteen: `roster_team` and `roster_iterate` touch the runtime, `roster_capture` with `apply:true` writes a roster; the rest are read-only)

| Tool | Purpose | Key parameters |
|---|---|---|
| `roster_list` | list rosters and members | `path?` |
| `roster_show` | all fields, destinations and diagnostics for one roster | `ref`, `member?`, `path?` |
| `roster_create` | emit ready-to-use member arguments + provenance line `roster:<id>@<ver>#<sha8>` | `ref`, `path?` |
| `roster_verify` | compare against the values persisted in `team.json` | `ref`, `team?`, `path?` |
| `roster_diff` | semantic diff between two rosters | `from`, `to`, `path?` |
| `roster_index` | public index state; collections carry `pulled` / `space` / `layout` | `collection?`, `source?`, `refresh?` |
| `roster_space` | declared vs on-disk rosters, roles, origin and ledger commit; carries a `changes` section when a ledger exists | `path?`, `refresh?` |
| `roster_search` | search across local and subscribed sources (words are ANDed; remote scans at most 8 sources and reports truncation) | `query`, `path?`, `remote?`, `limit?` |
| `roster_compile` | compilation preview (writes nothing) | `ref`, `path?` |
| `roster_changes` | **[deprecated]** per-file update check; use `roster_space`'s `changes` instead (removed in 2.0) | `path?`, `refresh?` |
| `roster_team` | create a team from a roster (new or existing session) | `id`, `teamName?`, `mode?`, `workspace?`, `sessionName?`, `sessionId?`, `target?`, `model?`, `path?` |
| `roster_capture` | compare `team.json` with the roster; `apply:true` writes mechanical fields back, `remember:true` records auto-apply | `id`, `team?`, `stateDir?`, `fields?`, `apply?`, `remember?`, `path?` |
| `roster_iterate` | iterate from the current team into a new session: optional write-back plus a hand-over checklist | `id`, `teamName?`, `sessionName?`, `workspace?`, `target?`, `model?`, `capture?`, `remember?`, `handover?`, `path?` |

Only these three change anything; the other ten are read-only. Saving/importing/deleting rosters still goes through the CLI and the panel’s HTTP routes.

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
| `import-agency --from <package|assets> --dir <library> [--write] [--force]` | turn `@michengai/dsh-agency-agents` experts into a v2 library (roles + per-domain rosters + NOTICE); dry run unless `--write` |

### Importing `agency-agents` experts

`@michengai/dsh-agency-agents` (Apache-2.0) ships 331 Chinese-language experts, each a Markdown file with frontmatter. It is not a roster format, so the import is a **one-time conversion**, not a second source of truth:

```bash
node bin/cli.mjs import-agency --from ~/.dsh/profiles/web/node_modules/@michengai/dsh-agency-agents \
  --dir ~/.dsh/agent-roster/agency-experts --write
```

- Each expert becomes a role (`roles/agency-<slug>/AGENT.md`) whose `notes` carry the source file and body hash.
- Each domain becomes one or more rosters (≤24 members, `as` = expert slug) with `targets: [agent-teams/members]`.
- Bodies over 8000 characters are split into `parts/rest.md`; bodies over 12000 are **skipped with a reason** (23 of 331 today).
- `NOTICE-agency.txt` keeps the Apache-2.0 attribution; nothing links back to the package afterwards.

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
| `agentTeamsStateDir` | `.agent-teams` | read-only state directory for `roster_verify`, `roster_team`, and captain injection |
| `injectCaptainPersona` | `true` | inject the roster captain persona into the captain session's system prompt (same-named section shadows the deployment persona, re-read every step). Off: kick-off message only |
| `captureAutoApply` | `false` | when a comparison finds writable mechanical fields, write them back without asking (version +1, recompile `dist/`). The tools' “always” option sets it to `true`; if the setting cannot be written, the library-root preference file is used |
| `language` | `"auto"` | `auto` follows DSH, or pin `zh` / `en` |
| `indexes` | `[]` | public sources: an `https` `registry.json` or `npm:pkg`; empty = official source; `false` = local only |
| `region` | `"auto"` | download region: `china` uses the Tencent npm mirror; `auto` means `global` (no probing) |
| `registryMirror` | `""` | custom mirror URL (sub-paths allowed); empty uses the region preset |

All nine are volatile: changes apply without a restart, but the running host re-registers tools on its own schedule.

## Diagnostics

Every diagnostic is `{severity, code, path, message, file}`; `validate` exits 1 when there is an error. By family:

| Family | Examples |
|---|---|
| Format | `unknown-field`, `unknown-format`, `multiple-roster-files`, `duplicate-roster-id`, `duplicate-role` |
| Roles and assembly | `missing-part`, `prompt-part-too-long`, `include-syntax`, `missing-include`, `unsafe-include`, `include-nested` |
| Orchestration | `gate-unverifiable`, `gate-without-stage`, `empty-stage`, `onfail-unknown-stage`, `onfail-immediate`, `onfail-dangling`, `onfail-unbounded` |
| Capabilities | `capability-policy-missing`, `capability-skills-unverified`, `capability-cross-check-skipped`, `invalid-document-path`, `invalid-document-sha` |
| Policy | `tool-policy-cross-check-skipped` (a warning when `knownToolPolicies` is unset: a typo'd id passes too, because there is nothing to check it against) |
| Spaces | `space-roster-missing`, `space-roster-undeclared`, `space-roster-archived`, `multiple-space-files`, `space-origin-not-allowed`, `space-knowledge-missing` (error), `space-knowledge-drift` (warn), `space-knowledge-undeclared` (info) |
| Ledger | `no-origin-ledger`, `origin-ledger-broken`, `clone-unsafe-path`, `clone-snippet-missing`, `clone-knowledge-missing`, `clone-no-rosters` (nothing was pulled, so the clone fails) |
| Sessions | `session-controller-unavailable`, `session-create-failed`, `session-rename-failed`, `prompt-not-queued` |
| Favourites / writes | `favorites-unreadable`, `write-failed`, `delete-failed` |

## Relationship to `dsh-agent-teams`

- `roster_create` member arguments feed `agent_teams_add_member` directly; every field is labelled direct / config / declaration.
- The provenance line `roster:<id>@<version>#<sha8>` is meant for `agent_teams_create`’s `description`; `roster_verify` parses it and reports `match` / `differ` / `id-only` / `absent`.
- `roster_verify` reads persisted fields in `team.json`; the persona (`executionPrompt`) **is** persisted there (verified on DSH 0.2.2 — the bridge `stateKey` is exactly that). “Unverified” in the report means “no receipt was available”, not “designed not to persist”.
- **The captain persona is now actually in the session**: the plugin registers a `deployment:persona-prefix` section on the captain session (re-read per turn) and `roster_verify` reports attached / not attached instead of `differ`. It remains a different text from the deployment preset persona: if you also want it to survive with the plugin disabled, land it in a profile preset; `roster_verify` reports that gap as `needs-config` with `profiles/<name>/cordis.patch.yml` and the preset name.
- `toolFilter` is the materialised deny list and is not stored in `team.json`, so it is reported as “unverified”; check policy definitions on the deployment side.
- The plugin never writes team state and has no transfer operation.

## Development

Design notes: `docs/design.md` (module map, field homes, capability matrix, and the checklist of every place a change must land).

```bash
node --test                 # 438 tests
npm run smoke               # host: 13 tools; client: two slots
npm run check:host         # host contracts the unit tests fake
npm run e2e                    # boot a throwaway host and ask what it actually sees (~9 s, no model calls)
npm run e2e -- --depth=apply   # the same, then really build a team (slower, calls the model)
npm run e2e -- --depth=persona # the same, then read the captain's system prompts and prove replacement
npm run check:locale        # zh/en dictionary key parity
npx dsh-agent-roster validate --dir examples
npx dsh-agent-roster registry validate --file index/registry.json
```

## Verification status

- **440/440** tests; both smoke halves; `check:locale` four checks at 0; `validate` on three libraries with 0 errors (`examples-orchestration` keeps one pre-existing `captain-not-targeted` warning); `registry validate` covers 5 collections with 0 errors.
- CI `registry` (Node 22) recomputes the index, recompiles the examples, and fails when `dist/` drifts from source.
- **Scripted e2e** (`npm run e2e`): packs the working tree, installs it into a temporary copy of the production profile, boots a throwaway `dsh web` on a free port, and asks the running host what it sees — version, libraries and the captain projection, `hostTeamTargets`, `hostModels`, `/catalog`, a 400 for an unknown engine, a 404 for an unknown roster, a favourites round-trip: 17 assertions, no model calls, about 9 seconds. `--depth=apply` also builds a real team and checks `team.json` (slow, costs model calls). `--depth=persona` goes one step further and decodes the captain session log: the first system prompt (before the team exists) has no roster persona, while the later one has it and has lost the deployment prefix — that is what proves the injector shadows the section instead of appending a line to the kick-off message. The production profile is only read.
- Known boundaries: `npm run e2e` copies a snapshot of the production profile (with its installed plugins), so it verifies how the host loads us rather than replacing unit tests of individual modules; `dist/` is not cloned; installing a collection (`/install`) flattens rosters into v1 documents, while a whole-space pull (`clone` / `/install-space`) keeps the v2 layout and ledger; `toolFilter` cannot be verified from `team.json`; `dsh web` must be restarted after an upgrade.

## License

MIT
