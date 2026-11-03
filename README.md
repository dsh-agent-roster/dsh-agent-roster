# @stofone/dsh-agent-roster

**English** | [简体中文](README.zh.md)

Static member rosters for multi-agent teams in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A roster is a file on disk: who is on the team, what each member is for, which model route they use, and which tools they are allowed to touch. This plugin defines that file format, validates it, and translates it into `agent_teams_*` call arguments — nothing more.

## What it is / what it is not

| | |
|---|---|
| **It is** a definition and validation layer | rosters are versioned, reviewable files; mistakes fail loudly with a file and field path |
| **It is** a bridge to `dsh-agent-teams` | `roster_create` emits ready-to-use `agent_teams_add_member` arguments and marks, field by field, what the runtime actually accepts |
| **It is** a verification aid | `roster_verify` reads `team.json` and compares persisted values against the roster |
| **It is not** a team runner | it never creates members, schedules tasks, or writes `.agent-teams/` state |
| **It is not** a scheduler or a runtime | dispatch, retries and review loops belong to `dsh-agent-teams` |

## Install

Requires DSH with the `tools` service (any recent build) and `yaml` — both are declared as dependencies.

From the plugin manager, point it at this repository (absolute path) or at the package name after publication:

```
@stofone/dsh-agent-roster
```

The bundle ships `cordis.patch.yml`, so installing it inserts the plugin into the profile automatically. After install you should see six tools (`roster_list`, `roster_show`, `roster_create`, `roster_verify`, `roster_diff`, `roster_index`) and an **Agent Roster** entry in the left sidebar (a full main panel, not a Settings section).

## Quick start

The library is **global**: one per machine, not per workspace, and it lives under the DSH data
directory (`$DSH_HOME/agent-roster`, which is `~/.dsh/agent-roster` by default — in Docker that is
the mounted volume). It is created on first save; you do not have to make it yourself.

```
~/.dsh/agent-roster/
└── core-review/
    └── roster.yaml
```

```yaml
kind: dsh-agent-roster/v1
roster: core-review          # must equal the directory name
version: 1.0.0               # exact SemVer
title: Core review team
description: Fixed members for code review and release gatekeeping.
license: MIT
maintainers: [STofone]
tags: [review, release]

defaults:                    # team-wide fallback for route fields
  provider: deepseek
  model: deepseek-v4.1-flash
  reasoningEffort: high

members:
  - name: reviewer          # kebab-case, unique in the team
    role: Code review
    description: Reviews only, never releases   # one-line responsibility, used for delegation
    aliases: [code-reviewer]                   # former names: still matched after a rename
    skills: [frontend-skill]                   # declared skills (never auto-loaded)
    examples:                                  # typical requests, used as delegation hints
      - Review this change for semantic bugs
    systemPrompt: |
      You review for semantic bugs first, style second.
    toolPolicy: readonly
  - name: release-manager
    role: Release gatekeeper
    systemPrompt: |
      You check the diff, the version and the rollback plan.
    model: deepseek-v4.1-pro
    reasoningEffort: low

captain:                     # optional: what the captain (the session that creates a team) should be
  name: lead
  description: The main session is the captain; it splits work and accepts results
  provider: tsingmicro
  model: deepseek-v4.1-flash
  personaPrefix: |
    Restate the goal and acceptance criteria before delegating.
```

JSON works too (`roster.json`); YAML and JSON are probed in the order `roster.yaml`, `roster.yml`, `roster.json`. Exactly one file per directory — a second one is reported, never silently picked.

This package ships two example libraries: [`examples/`](./examples) (v2, migrated from the v1 archives this repo grew up with) and [`examples-orchestration/`](./examples-orchestration) (v2, hand-written to show gates and a construction plan). `rosterDirs` is empty by
default, meaning the global library above, which is empty in a fresh install — so the panel shows
"0 rosters" until you create one in the UI. To look at the examples instead, point the CLI at them:

```bash
# see what the example libraries look like
npx dsh-agent-roster list --dir examples
```

Then ask the model to run `roster_list`, or call the CLI (it reads the same global library by
default):

```bash
npx dsh-agent-roster validate
npx dsh-agent-roster list
```

## File reference

Top level: only these keys are allowed — unknown keys are errors, not warnings.

| Key | Required | Notes |
|---|---|---|
| `kind` | yes | must be `dsh-agent-roster/v1` |
| `roster` | yes | kebab-case id, must equal the containing directory name |
| `version` | yes | exact SemVer (`1.2.0`, not `^1.2.0`) |
| `title` | no | single line, at most 120 chars (defaults to the id) |
| `description` | no | at most 500 chars |
| `license` | no | SPDX-ish single line |
| `maintainers` | no | non-empty strings if present |
| `tags` | no | at most 16 tags, each lowercase kebab-case |
| `defaults` | no | route fields inherited by members |
| `members` | yes | 1 to 32 entries |
| `captain` | no | captain block: describes, never creates (see below) |

Member keys: `name`, `role`, `systemPrompt` (all required), plus `provider`, `model`, `reasoningEffort`, `toolPolicy`, `fallback`, `toolScope`, `maxTokens`, `title`, `tags`, `notes`, `description`, `aliases`, `skills`, `examples`.

`systemPrompt` is capped at 8000 characters. Members that omit a route field inherit it from `defaults`; the resolved value is recorded in the member's `inherited` list so you can see where it came from.

A machine-readable JSON Schema lives in [`schema/roster.v1.schema.json`](./schema/roster.v1.schema.json) for editor completion and external tools. `lib/validate.js` stays authoritative; `test/schema.test.js` keeps the two aligned.

An **optional sibling file** `capabilities.yaml` in the same directory declares what the deployment must provide before this roster can be built — see [Capability requirements](#capability-requirements-capabilitiesyaml).

### Where each field actually lands

The bridge never pretends a field took effect. Every member field is classified:

| Class | Fields | Meaning |
|---|---|---|
| `direct` | `name`, `role`, `systemPrompt`, `provider`, `model`, `reasoningEffort`, `toolPolicy` | passed to `agent_teams_add_member` and stored by the runtime |
| `config` | `fallback` | no runtime argument; needs owner-side configuration |
| `declaration` | `toolScope`, `maxTokens`, `title`, `tags`, `notes`, `description`, `aliases`, `skills`, `examples` | documentation and validation only — explicitly reported as not applied |

`roster_create` emits `agent_teams_add_member` arguments (`systemPrompt` → `executionPrompt`, `reasoningEffort` → `reasoning_effort`, `toolPolicy` → `tool_policy`) and a per-field summary; `roster_verify` then reports each field as `applied`, `overridden`, `omitted` or `unconfirmed`.

### Declared fields and the captain

These four declared fields carry information the runtime does not act on, and each has one job:

- `description` — one line on what the member owns. CrewAI's `backstory`, Claude's `description` and the OpenAI Agents SDK's `handoff_description` occupy this slot; it is what you read when handing out work.
- `aliases` — former names. After a rename the team state still holds the old name; verification matches by alias (reported as `matchedAs`) instead of raising "not deployed" plus "unmanaged" on every rename. Aliases may not collide with a member name or with each other.
- `skills` — skill names the member is expected to use, matching the DSH skill catalog. **Declaration only**: nothing is loaded because a roster says so; when the host can list skills, `roster_verify` answers just one question — declared but not installed.
- `examples` — typical requests, one per line, useful as delegation hints; never executed as instructions.

The `captain` block records the captain, which is **not a member**. In `dsh-agent-teams` the captain is the session that creates the team: `team.json` has no captain member row and no argument can change its model. So a roster only does three things for it:

1. describe what it should be (`name`, `description`, `systemPrompt`);
2. declare its route and persona prefix, and print a copy-pasteable profile snippet (`agent-default-model`, `@deepseek-ai/dsh-persona`) from `roster_show`;
3. validate that the declarations pair up (`provider` and `model` come together).

Making it real means editing the profile's `cordis.patch.yml` and the agent preset. Editing the captain block in the panel records intent; the plugin neither can nor will change your session.

## Capability requirements (`capabilities.yaml`)

A roster says *who the members are*. It cannot say *whether this machine can actually run them* — the skill catalogue and the tool-policy definitions live in the deployment, not in the archive. An optional sibling file in the roster directory declares exactly that, and nothing else:

```yaml
kind: dsh-agent-roster-capabilities/v1
roster: money-lab            # must equal the directory name
onMissing: refuse            # refuse (default) | degraded
asOf: 2026-11-02             # date only
requires:
  skills: [frontend-skill, {name: dsh-chat-import, reason: 会话导出需要}]
  toolPolicies: [member-safe]
notes: 建队前先确认成员会话可用。
```

Every requirement lands in one of **three** states — never two:

| State | Meaning | Effect |
|---|---|---|
| `present` | the evidence source has it | nothing to do |
| `missing` | the evidence source says it is not there | the **only** state that trips the gate |
| `unknown` | there is no evidence source at all | neither pass nor failure — written down so silence is never read as approval |

There are exactly two evidence sources, because they are the only two the host can answer: `skills` from the skill catalogue, `toolPolicies` from this plugin's `knownToolPolicies` configuration. Everything else — model-routing availability, plugin versions, credential pointers, business preconditions — is rejected (`unknown-field`): a requirement nobody can check is just another way to look green.

Behaviour: under `onMissing: refuse` (default) `roster_create` emits **no** `agent_teams_add_member` argument while anything is `missing`, and prints where to install each one. `roster_verify` reports `requires=<missing>missing/<declared>` plus `capabilityBlocked` in its status line, and `ok` is false when a declared requirement blocks a build. `onMissing: degraded` still hands you the arguments, with the debt recorded on every verification. `roster_show` prints the declaration block itself.

**The panel shows it too.** Each roster card lists these requirements as diagnostics: a missing `toolPolicies` requirement is an `error` under `refuse` (so the sidebar badge goes red) and a `warn` under `degraded`. Skill requirements are deliberately reported as `capability-skills-unverified` / `info` — the panel snapshot is synchronous and cannot enumerate the skill catalogue, so it says *not checked here* instead of guessing; run `roster_verify` for the real answer. When `knownToolPolicies` is unset, a single `capability-cross-check-skipped` entry names the affected rosters rather than repeating once per roster.

The sibling file has its own JSON Schema: [`schema/capabilities.v1.schema.json`](./schema/capabilities.v1.schema.json), kept aligned with `lib/capabilities.js` by `test/capabilities.test.js`.

## Library organization (`organization.yaml`)

A roster answers *who the members are*; it cannot answer **which rosters belong together, which one is production and which is retired**. When a library holds twenty archives from different sources, the directory listing stops being an index. An optional file at the **library root** declares that, and nothing else:

```yaml
kind: dsh-agent-roster-organization/v1
organization: agent-roster-collective   # must equal the directory name
title: 团队档案合集
maintainers: [STofone]
rosters:
  - {id: api-design, title: API 设计评审组, status: active, origin: 本项目自撰}
  - {id: legacy-team, status: archived}
```

Placement matters: the file sits **next to** the roster directories, not inside one. It is a table of contents for the library, so it is the only file allowed at the root — scatter a `foo.yaml` there and the scanner still warns `unexpected-file`.

The declaration is mechanically checked against disk, and the three outcomes are deliberately different severities:

| Situation | Code | Severity | Why |
|---|---|---|---|
| declared, directory missing | `organization-roster-missing` | **error** | the organization page is lying — worse than no page |
| directory present, not declared | `organization-roster-undeclared` | warn | someone added a roster around the index; it still loads |
| declared `archived`, directory still there | `organization-roster-archived` | info | archiving is a statement, not a delete |

`organization` must equal the directory name, exactly like `roster` does: position is identity, and two ids for one library would make every diagnostic ambiguous. Unknown keys are rejected — a field nobody can check is another way to look green.

This file creates nothing. It does not write `team.json`, does not create members, and never reaches `agent_teams_add_member`. Its JSON Schema is [`schema/organization.v1.schema.json`](./schema/organization.v1.schema.json), kept aligned with `lib/organization.js` by `test/organization.test.js`.

**A worked example ships in this repository:** [`orgs/agent-roster-collective/`](./orgs/agent-roster-collective/) holds 21 rosters (63 members) covering API review, incident response, data quality, database migration, localization, security audit, performance, frontend, docs, release, support triage, recruiting, market research, finance reconciliation, contract review, content ops, regression testing, model evaluation, SRE on-call, literature review and product discovery. Every roster is a three-person team with a captain, and each was written for this repository (no upstream text is copied). Validate it with:

```bash
node bin/cli.mjs validate --dir orgs/agent-roster-collective
```

## Roles, rosters and compiled artifacts (v2)

v1 keeps everything in one `roster.yaml`: the persona sits in a YAML block scalar, the assembly protocol lives in plugin code, the captain is written twice, and identity comes from the directory name. v2 splits that into three layers, one authority each:

```text
roles/<any-dir>/AGENT.md     role: frontmatter is parameters, body is the persona, parts/ optional
rosters/<id>/roster.yaml     assembly: members are references, the captain has its own section
dist/<id>-<ver>.json         compiled: self-contained, hashable, the only thing consumers read
```

The discriminator decides the version — `dsh-agent-roster/role@1`, `dsh-agent-roster/roster@2`, `dsh-agent-roster/compiled@1`. Two formats never share a directory: v1 is frozen, and `roster migrate` (not yet built) rewrites it in place.

Assembly is written into the format rather than hidden in code:

```text
executionPrompt = join("\n\n", [body, ...parts, ...member.append])
```

`assemblePrompt()` in `lib/frontmatter.js` is the only implementation, and the compiled artifact records the character count, the block list and a SHA-256 for every prompt, so "which text did this member actually get" is answerable without re-reading the sources.

A gate must be runnable, not self-certified: every gate carries at least one `verify` entry (`command` + `expectExit`), and a gate without one is rejected at validation time (`gate-unverifiable`). `requires` stays, but only as prose for the human reading the verdict.

`compile` also emits the construction plan — `dist/<id>-<ver>.tasks.json`:

```json
{ "kind": "dsh-agent-roster/plan@1", "executor": "captain",
  "tasks": [ { "id": "build", "kind": "stage", "member": "fixer", "dependencies": [] },
             { "id": "audit", "kind": "stage", "member": "reviewer", "dependencies": ["build"] },
             { "id": "tests-pass", "kind": "gate", "member": "reviewer", "dependencies": ["audit"] } ],
  "loop": { "onGateFailure": { "retry": "build", "maxRounds": 1 } } }
```

`executor: "captain"` is the whole point: the plugin never calls `agent_teams_create_task`, because writing team state belongs to the captain session. The plan is a drawing the captain builds from, not the plugin building for it.

The example library in [`examples-orchestration/`](./examples-orchestration/) compiles end to end:

```bash
node bin/cli.mjs compile --roster examples-orchestration/rosters/core-review --write
node bin/cli.mjs compile --roster examples-orchestration/rosters/core-review --json
```

`orchestration` is part of the format but is compiled with `status: "declaration"`: stages and gates are validated (a gate's `after` must name real stages, `by` must name a real member), yet nothing executes them. Declaring a field is not the same as proving it runs, so the artifact says which is which in `declarations[]`. The full contract — field ownership, assembly semantics, identity and uniqueness, migration rules — is in [`docs/roster-v2.md`](./docs/roster-v2.md); the schemas are [`schema/role.v1.schema.json`](./schema/role.v1.schema.json), [`schema/roster.v2.schema.json`](./schema/roster.v2.schema.json) and [`schema/compiled.v1.schema.json`](./schema/compiled.v1.schema.json).

### From v1 to v2 in one command

```bash
node bin/cli.mjs migrate --dir examples            # 只出计划：要写哪些文件、能不能编译
node bin/cli.mjs migrate --dir examples --write    # 原地重写：roles/ + rosters/ + dist/，删掉旧目录
```

Migration keeps personas verbatim: a member's `systemPrompt` becomes the body of
`roles/<roster>-<member>/AGENT.md`, and the member turns into a reference. The captain stops being a
loose field and becomes a role file of its own — `<roster>-<captain>-captain` when its name collides
with a member, because those are two different personas and silently merging them would lose one.

If the v1 rosters live in a subdirectory (the usual case for a repository that publishes a
collection), point the migration at the library root and tell it where the old files are:

```bash
node bin/cli.mjs migrate --dir . --from rosters --repo owner/repo --write
```

That layout rewrites `rosters/<id>/roster.yaml` in place, adds `roles/` and `dist/` at the repository
root, and drops the stale `roster.json`/`roster.yml` next to it — two spellings of one roster are two
sources of truth. The collection then uses `path: ""` (the repository root *is* the library) and a
`files` map pointing at `dist/`, because an assembly only references roles and cannot be pulled alone.

Role names carry the roster id prefix because v2 requires role names to be **unique per library**,
and a library whose 21 rosters all call their captain `lead` cannot have 21 files with the same name.

### Feeding a failed round back into the plan

`compile --run <file>` reads an execution record (`run@1`) and appends the previous round's failures
to the retry card's description:

```bash
node bin/cli.mjs compile --roster examples-orchestration/rosters/core-review \
  --run examples-orchestration/dist/core-review-1.0.0.run.json
```

The record is written by whoever executes the plan (the captain session), not by the plugin: a task
id belongs to the team, and the plugin never writes team state. What it does own is the merge — a
failure that only exists on a red card never reaches the next compile, which is exactly how a gate
turns into decoration.

## The library tab: find by capability, not by source

The panel opens on **Library**, which is meant to read like a plugin marketplace: one search field, one row
of tags, and one list that spans this machine and every subscribed source.

```
要找什么能力？例：数据质量、发版、代码评审
```

Two characters in, after a 240 ms pause, the panel asks `/search` a question. Every row says **why** it
matched (`标签：数据质量 · 成员角色：数据质量工程师`) and where it lives (`来自 agent-roster-collective`),
and carries the next action — open it locally, or pull that collection — inside the row.

With an empty field it **browses**: `/catalog` flattens this machine and the subscribed sources in one
response, the tag strip summarises every tag in view with its count (multiple tags are AND), and the
segmented control switches between **by source** (this machine, then one group per collection) and **flat**
(one list, source named per row). Tag filtering is view state only; it never writes back to a file.

Multiple words are AND, not OR: `data kubernetes` returns nothing rather than every roster that merely
mentions "data". Ranking is a pure function in `lib/search.js`, so it is unit-tested rather than eyeballed.

Subscribed rosters resolve through `files` in the index, which points at a concrete compiled artifact
(`dist/<id>-<ver>.json`). The artifact carries its own title, description, tags, licence and maintainers,
so finding a roster from a distance costs one file — not a clone.

## Tools

| Tool | Purpose |
|---|---|
| `roster_list` | list rosters in a library with per-roster validation results |
| `roster_show` | show one roster (or one member) in full, including bridge field classes |
| `roster_create` | translate members into `agent_teams_add_member` arguments / `plan.members`; refuses when a declared capability is missing |
| `roster_verify` | compare a roster against `dsh-agent-teams`' `team.json`; reports faithful / unverified / drift / missing, plus materialised tool-filter digests, policy drift, provenance and capability requirements |
| `roster_diff` | diff two rosters (generation N vs N+1): members matched by name, effective values compared, persona compared by length + hash |
| `roster_index` | list registry sources and their collections; given a collection, fetch it read-only for inspection |

All six are read-only with respect to team state. `roster_create` only produces arguments — the model still has to call `agent_teams_add_member` itself.

`roster_list`, `roster_show`, `roster_create` and `roster_verify` all accept a `path` argument: when given, it is the library root, with no silent fallback to the configured directory.

### One roster per directory, two generations per machine

`roster` must equal the directory name, and a library holds one document per directory. Two
generations of the same roster therefore live in **two libraries** — that is intended, not a
gap: it keeps "position is identity" intact (a later `load` can never pick the wrong generation
by accident) and makes the switch an explicit `path` argument instead of a silent side effect.

```text
~/.dsh/agent-roster/money-lab/roster.yaml          # one generation
/workspace/money/.dsh/rosters/money-lab/roster.yaml # the next generation
```

`roster_diff({ from, to })` answers "what changed between the generations"; `roster_create`
prints a provenance line (`roster:money-lab@9.0.0#ab12cd34`) to put into the created team's
description, and `roster_verify` compares that line against the current file — so a roster
edited after the team was created shows up as `differ` instead of silently passing.

### Captain verification

An archive's `captain` block is a declaration. The captain is the session that creates the team — it
has no member row, its model comes from the deployment (`agent-default-model`) and its persona from
the agent preset. The panel therefore **compares** instead of pretending to write: the Settings row
shows the deployed provider / model per profile, and every archive with a captain block reports
`match` / `differ` / `undeclared` / `unknown` per field. When the deployment cannot be read the
state is `unknown`, never "passed".

The **apply** action is the one write the panel offers here: it switches the chosen session to the
declared model and queues a prompt that calls `agent_teams_create`, `agent_teams_add_member` per
member and finally `roster_verify`. Creating the team stays with the runtime.

## Sidebar panel

The roster list is a **ledger, not a wall of cards**: one row per roster — a 3px state edge (lit only when something is wrong, quiet when it is fine), a monospace id column, the title with a one-line description, right-aligned counts (members / errors / warnings / deployment), and a quiet pair of actions (edit, expand). Duplicate, copy-create and delete moved into the expanded area, which turns 105 buttons across 21 rosters into 42. Below 860px the tag pool becomes a top row and the metadata wraps. Expansions never build their own scroll box: the panel root is the only scroller, so an expanded section grows as tall as its content instead of showing "just a few rows".

The panel takes the full page width; nothing constrains it to a reading column. The archive list has
a **tag pool** on the left: every tag present in the library, with how many archives carry it. Clicking
tags narrows the list — multiple selections are ANDed — and one button clears the selection. The tag
pool is a filtered view only; it never writes tags back to files.

Header actions follow the place they act on: **Import** and **New archive** sit in the archive tab
next to the search box, **Refresh sources** sits in the sources tab (it bypasses the one-hour cache and
re-reads the public index), and the header keeps a single **gear button** that opens the settings dialog.
The dialog edits the language, the download region, the mirror address and the roster directories, and shows the resolved
data directory, the team state directory and the version.

A badge at the top summarises how many items need attention

The client plugin adds an **Agent Roster** entry to the left sidebar: one row in the `sidebar.panellist` slot plus the matching key in the `main` slot. Clicking the row opens a full-width page with five tabs — the panel is not only a viewer:

| Tab | What you can do |
|---|---|
| Rosters | browse every workspace × library, expand members, and **create / edit / duplicate / delete / import / export** rosters. The editor has a form mode and a source mode (the file as-is); the host validates before writing and keeps a `.bak` next to an overwritten file |
| Teams | read one configured state directory (`.agent-teams` by default) and see every team the runtime created: profile, member profiles and model routes, whether each persisted member really matches its roster, plus the team's tasks |
| Sources | the subscribed registry directories; each collection has a **Pull to this machine** button, and can be expanded to inspect its rosters first |
| Health | the "configuration points somewhere wrong" questions in one place: which directories resolved, whether the state directory exists, how many declarations are unconfirmed, and what to change |

A badge at the top summarises how many items need attention; the Health tab explains each one. All write operations go through `POST /plugins/dsh-agent-roster/rosters`, which enforces same-origin (`connection`), a JSON content type, a body-size cap and a library-root whitelist — the client never writes files itself.

The panel is bilingual. Its language defaults to the DSH language and can be pinned in **Settings → Plugins → Agent Roster** (the same section shows a read-only summary of the configuration). Both the panel and the host-side texts are translated; dictionaries live in `locale/` and are served by the host, so switching the DSH language re-renders the panel without a reload.

## Public registry and one-click pull

Rosters can be shared: keep one or more of them in a GitHub repository, register them as a **collection** in that
repository's `index/registry.json`, and anyone who subscribes can see them in the panel and pull them locally.

- **Subscribing**: set `indexes` to an `https://…/registry.json` URL or `npm:pkg` (reads `registry.json` from the
  package). Empty means the official source, `dsh-agent-roster/dsh-agent-roster`'s `index/registry.json`; an explicit `false`
  is the only way to disable remote sources entirely.
- **How often it refreshes**: TTL **one hour** — that is the unauthenticated GitHub budget of 60 requests/hour.
  `?refresh=1` (or the tools' `refresh`) bypasses the cache, throttled to one try per 60 seconds so the quota is not
  burned. On failure the last cached index is reused and labelled "cached (fetch failed)" in the panel.
  The cache records **which shape of index it holds** (`CACHE_VERSION`): a plugin upgrade that changes the
  index shape invalidates old caches and refetches once, so "I upgraded but the panel still 404s" is not a
  thing you have to debug by deleting a directory.
- **Pulling**: writes are idempotent and report one of `created`, `updated` (explicit overwrite), `unchanged`
  (same content, nothing written) or `conflict` (the local copy differs and is **not** overwritten by default).
  Conflicts are yours to resolve: merge in the editor, or pull again with `overwrite` in the request body.
- **Expanding is fast and filterable**: opening a collection fetches its rosters in parallel (up to six in
  flight) instead of one after another — the 21-roster collective went from **9.4 s to 0.8 s** on this
  machine. The route memoises the fetched result for 60 seconds, and the panel keeps the last expansion in
  memory, so re-opening is instant and re-opening after a minute costs one round of six requests, not 21.
  A filter box inside the expanded list narrows by id, title or member name; it only hides rows, it never
  changes data.
- **Where each roster lives**: a collection's `rosters[]` is just the list of ids; the optional
  `files` map says where each one is (`{"core-review": "dist/core-review-1.0.0.json"}`). It is optional —
  without it the fetcher assumes the v1 layout `<id>/roster.yaml` — but a v2 library needs it, because an
  assembly only references roles and cannot be pulled on its own. `registry sync` writes this map for you.
- **The index has a schema**: [`schema/registry.v1.schema.json`](./schema/registry.v1.schema.json) mirrors the
  runtime validator, so an editor flags a typo before CI does.
- **Publishing your own**: add an entry to `collections` in `index/registry.json` (`id`, `repo: github:owner/repo`,
  `ref`, `path`, `rosters[]`) and open a PR. `.github/workflows/registry.yml` checks the index against the real files.

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/plugins/dsh-agent-roster/library` | GET | panel snapshot: libraries, rosters, teams, hints, counts, remote sources |
| `/plugins/dsh-agent-roster/document` | GET | one roster's raw text plus its parsed form (editor) |
| `/plugins/dsh-agent-roster/rosters` | POST | create / update / delete / import / export one roster |
| `/plugins/dsh-agent-roster/apply` | POST | apply an archive's captain to an existing or new session and queue the team-building prompt |
| `/plugins/dsh-agent-roster/collection` | GET | fetch one collection's rosters read-only (nothing is written) |
| `/plugins/dsh-agent-roster/install` | POST | write one collection into the local library (idempotent, no overwrite by default) |
| `/plugins/dsh-agent-roster/locale` | GET | `en` / `zh` dictionary for the panel |

All six are `exact` routes behind the host's `connection` fence and answer `405` for other methods.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `rosterDirs` | `[]` | library directories. Empty means the global library `$DSH_HOME/agent-roster`; an absolute or `~` path is global too; only a relative path is resolved per workspace. The first entry is what the tools read by default |
| `knownToolPolicies` | `[]` | tool-policy ids declared by your deployment; enables cross-checks |
| `agentTeamsStateDir` | `.agent-teams` | read only: where `roster_verify` and the Teams tab look for team state |
| `language` | `"auto"` | panel language: `auto` follows DSH, or pin `zh` / `en` |
| `indexes` | `[]` | public registry sources: an `https` `registry.json` or `npm:pkg`. Empty means the official source; `false` means local-only |
| `region` | `"auto"` | download region: `china` reads npm-style index packages from the Tencent mirror; `auto` equals `global` (no probing, one less request) |
| `registryMirror` | `""` | custom npm registry for download sources, e.g. `https://registry.npmmirror.com` or `http://nexus.corp.local/repository/npm`. Set it and it beats `region`; a registry pinned inside a source still beats both. Empty means no custom mirror |

All six are `volatile`: changes apply immediately, no host restart.

## Diagnostics

Validation reports errors, warnings and infos with `file`, `path` and `reason`. Families:

- structure: `missing-field`, `unknown-key`, `invalid-type`, `invalid-kind`, `pair-required`, `invalid-value`
- values: `invalid-id`, `invalid-provider`, `invalid-model`, `invalid-semver`, `invalid-tag`, `invalid-tool-name`, `invalid-tool-policy-id`, `invalid-number`, `empty-tool-scope`
- safety: `reserved-character` (`^`, `$`, `|`, braces), `forbidden-content` (prompt-injection patterns), `single-line-required`
- limits: `string-too-long`, `too-many-members`, `too-many-values`
- library level: `library-missing`, `library-unusable`, `missing-roster-file`, `multiple-roster-files`, `unexpected-file`, `unreadable-file`, `unreadable-dir`, `duplicate-roster-id`, `tool-policy-cross-check-skipped`
- remote sources: `index-unreachable`, `index-invalid`, `index-refresh-throttled`, `index-source-invalid`, `collection-fetch-failed`, `collection-not-found`, `index-may-be-stale` (a v1-path fetch failed on a collection that has no `files` map — the index is probably older than the library), `collection-roster-needs-roles` (the entry points at a v2 assembly, which cannot travel as one file)

An empty library is not an error. A missing one is reported as info, not error. `tool-policy-cross-check-skipped` is emitted **once per library** (not once per roster) when no `knownToolPolicies` are configured — a per-roster warning would turn one fact into n lines of noise.

## Relationship to `dsh-agent-teams`

`dsh-agent-teams` owns team lifecycles, task dispatch and member persistence. This plugin owns the *definition* of members and the honesty of the handoff: it reads `.agent-teams/<team>/team.json` (read-only) to verify what the runtime actually stored, and it degrades to "unconfirmed" when it cannot read it. No state is ever written.

## Development

```bash
npm install
npm test          # node --test, 191 cases
npm run smoke     # registers the tools against a real DSH bundle, asserts lossless output
node scripts/check-locale.mjs   # static t() keys must exist in both dictionaries
```

Layout:

```
index.js          host plugin: Config, apply, six routes
lib/              reading: format, format-v2, frontmatter, parse, validate, role, roster2,
                  capabilities, organization, registry, remote, library, home
                  compiling: compile2, plan, migrate, run
                  speaking to the runtime: bridge, verify, diff, digest, render, tools, service,
                  teams-state, captain, write, apply, serialize, config-view, json, http
client.js         client plugin: sidebar entry, main panel (rosters/teams/health), settings section
locale/           panel + listing dictionaries (en/zh)
schema/           roster v1 / role v1 / roster v2 / compiled v1 / capabilities / organization / registry
                  schemas (editor completion; kept aligned by tests)
bin/cli.mjs       validate/list/compile/migrate/registry for CI
scripts/          host-smoke.mjs, client-smoke.mjs, check-locale.mjs (dev only, not shipped)
examples/         a v2 library migrated from the v1 archives
examples-orchestration/  a v2 library with orchestration, gates and a construction plan
orgs/             a worked example library with its own organization.yaml (21 rosters)
test/             unit tests
```

## Verification status

Verified on this machine:

- `npm test` — 308/308 passing (format, parse, validate, registry, paths, bridge, verify buckets, digests and provenance, roster diff, capability requirements and the capability gate, library organization, registry schema, lossless JSON, write plan/apply, all routes, panel snapshot and hints, dictionary consistency, tool contracts, client loader contract, library snapshot, config view, package manifest, declared fields and captain block, schema/constant alignment, the v2 role/roster/compiled layers and their schema alignment, v1→v2 migration, run records feeding the plan, remote registry and one-click install).
- `npm run smoke` — `apply()` registers all six tools through a real `defineTool` from a DSH bundle; `roster_list` / `roster_show` / `roster_create` / `roster_verify` / `roster_diff` execute, every output survives `lossless` checks, `path` overrides are honored, effect disposal runs cleanly. The same command then loads `client.js` against a stubbed module table and asserts the three slot registrations, style injection and effect disposal.
- CLI: `validate --dir examples` returns exit 0 over both example libraries.
- Installed into a real profile with the plugin manager (`plugin_manager install_bundle` against this directory → `link:` dependency + bundle entry); the profile re-reads the linked files on restart.
- The read-only route answered from the running host: `GET /plugins/dsh-agent-roster/library` → 200 with the plugin version and resolved rosters.
- A second agent session saw all six tools in its tool list and called them.
- The sidebar panel was confirmed visible with real roster data.

Not verified in this pass: the 0.2.0 management UI (tabs, editors, Teams view, language switch, `document` / `rosters` routes) inside a live page — those need a host restart to load the new modules, and are verified after it.

Three real defects were found by this verification and fixed:

1. `volatile()` config fields reach `apply()` as `{ get, write }` reference objects, so the panel and every tool were reading the defaults no matter what the settings form said. Reads now go through `lib/config-view.js`, which resolves references per access and falls back on type mismatch.
2. `roster_list` ignored its `path` argument and always scanned the configured directory. `resolvePaths` now treats an explicit `path` as an override.
3. Tool outputs carried `undefined`-valued keys, which the runtime rejects as `value is not lossless JSON`. Absent values are now `null` (or omitted), and every return value goes through `lib/json.js#lossless` first.

## License

MIT — see [LICENSE](./LICENSE).
