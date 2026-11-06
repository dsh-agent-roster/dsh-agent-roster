# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.8.3] - 2026-11-06

### Fixed

- **Picking a workspace did not put the new session in it.** The panel read host workspaces through `workspaceId`, but the registry entity exposes `id` — every entry mapped to `""`, so the picker fell back to creating the session with a bare `cwd`. The host creates that session in the directory but never records it in any workspace's `sessionIds`, so it did not show up under the chosen space. Workspaces are now read from `id`; when only a directory is known, `workspaceIdForPath` resolves it to the owning workspace first and the request carries `workspaceId`, so the host attaches the session. Both the create-team dialog and `roster_team` go through the same resolution.

## [1.8.2] - 2026-11-06

### Fixed

- **A role-style roster's captain persona was silently dropped.** v2 keeps it in `captain.personaPrefix` (the compiled form of `captain.persona`), while the kick-off prompt only read the v1 field `captain.systemPrompt`. Applying such a roster produced no persona block and the session fell back to the deployment preset without saying so. Both fields are now accepted, with a regression test on the v2 shape.

### Changed

- **The READMEs were rewritten against the current implementation** (1.8.x): the space model as the primary shape, favourites and the four-tab panel, the origin ledger with seven update states, the eleven tools, the twelve routes, the nine CLI commands, the seven configuration keys, and the persona injection. Stale claims (a settings section, per-roster pulls, six update states, single-roster installs keeping the v2 layout) are gone.

## [1.8.1] - 2026-11-06

### Fixed

- **The workspace picker could not select a second workspace.** Options used `workspaceId` as their value; workspaces without an id (older registries, or the fallback entry) all collapsed to `""`, so choosing one looked like choosing nothing. The picker now keys options by the workspace path (falling back to the id), resolves the chosen entry back to `workspaceId` or `cwd`, and refills a default when the list arrives after the first render. Both entry points (create team, apply captain) share the same rule.
- **Two workspaces with the same name read as one option.** When titles collide, the label now appends the parent directory (`workspace · money`); a unique name stays a bare name.

## [1.8.0] - 2026-11-06

### Added

- **The captain's persona now travels with the roster.** `captain.systemPrompt` is injected verbatim into the kick-off prompt when a roster is applied (panel, `roster_team`, or the `/apply` route); the session acts on it. The model still comes from the deployment (`agent-default-model`) and the plugin still writes no runtime state. With no persona declared, the note says so instead of silently falling back.
- `roster_verify` and the panel report keep comparing the **deployment** persona prefix with the declared one; the injected persona is a per-session instruction, not a deployment change.

### Fixed

- **The provenance line had no content hash in v2 libraries.** `shaOf` only looked under `<root>/<id>/`, so every v2 roster (`<root>/rosters/<id>/`) produced `roster:<id>@<version>` without `#<sha8>`, and `roster_verify` could only report `id-only`. It now reads the roster document in either layout.
- **The kick-off prompt told the captain to pass `provenance` to `agent_teams_add_member`, a parameter the tool does not have.** Live runs showed the model reading the tool schema and refusing the instruction. Step 3 now appends the provenance line returned by `roster_create` (`roster:<id>@<version>#<sha8>`) to the team description instead, and step 4 passes the member parameters as-is.

## [1.7.2] - 2026-11-06

### Fixed

- **Workspace options in "create team → new session" showed the filesystem path.** The label was `title · /full/path`, which squeezes out the only part a person can choose by. It now shows the workspace name alone (title, falling back to the directory name).
- **Existing-session options fell back to the directory name for every session.** `TeamCreateDialog` called `sessionLabel(session)` without the workspace list, so the label could not resolve a workspace title. Both pickers now pass it, and both show `workspace · session`.

## [1.7.1] - 2026-11-06

### Fixed

- **Creating a team from a roster failed with `prompt-not-queued`.** The host service's signature is `sessionController.prompt(request, signal)` — the second argument is an `AbortSignal`, and the service starts with `signal.throwIfAborted()`. We passed only the request, so every apply threw `TypeError: Cannot read properties of undefined (reading 'throwIfAborted')` and the catch turned it into "the prompt was not queued". The call now passes `AbortSignal.timeout(30_000)`; the same second DSH instance reproduces the old failure on 1.7.0 and succeeds on this build.
- The panel now shows the host's `reason` next to the error code when applying a captain fails, instead of a bare code.

### Changed

- The fake `sessionController` in `test/apply.test.js` mirrors the real contract (`prompt(request, signal)` with `signal.throwIfAborted()`), so a missing signal fails the suite instead of the user's first team creation.

## [1.7.0] - 2026-11-05

### Removed

- **The DSH settings section is gone.** The plugin has had a full main panel since 0.9, and that panel's gear dialog already renders the exact same form (language, region, roster directories, registry mirror). Keeping a second registration of the same component in the settings page meant two entry points that could drift, and a settings tab whose only unique content was "open the panel". The `settings.section` slot is no longer registered; `SettingsSection` stays as the panel's settings dialog. There is exactly one place to change language or roster directories now.

### Changed

- The client registers two slots instead of three (`sidebar.panellist`, `main`); `client smoke` asserts that.

## [1.6.1] - 2026-11-04

### Fixed

- **The origin ledger is a file on disk, so its paths are now treated as untrusted.** `checkOrigin` only counts entries whose relative path is safe, `applyFastForward` refuses to write any other, and `acceptLocal` no longer matches inherited object keys (`in` → `Object.hasOwn`). A hand-edited ledger could otherwise point outside the space directory and make a fast-forward write there.

## [1.6.0] - 2026-11-04

### The panel stops calling "not checked" clean

A full pass over the code turned up a class of false green rather than missing features: places where the
panel or a tool answered "all good" because it had not actually looked. This release fixes those, plus the
gaps the audit found around creating sessions and reading the index.

#### Added

- **`update --accept`** — record the local content as the new baseline. It only accepts `local-only` files; a `diverged` file is never accepted silently, because that would throw the remote half away without saying so.
- **`unverified` is a state of its own.** When the remote does not answer (offline, rate-limited, 5xx), the file is no longer reported as `clean`; `checkOrigin` counts it separately and the summary line says so. Seven states in total.
- **`roster_index` keeps its promise:** every collection now carries `pulled` (whether a ledger-backed copy exists on this machine, and where), and the detail branch adds `space` and `layout` by reading that copy.

#### Changed

- **The panel's Check updates button tells four different things apart:** `Apply N updates` only when something can be fast-forwarded; otherwise `N conflicts`, `N unverified`, or `No baseline`. A network failure can no longer look like "up to date", and the button is disabled when there is nothing it could apply.
- **Creating a captain session asks for a space and a name**, exactly like Create team: a workspace picker from `workspaceRegistry` plus a session name, instead of a free-text working directory. Both entry points send `rootDir`, so the same roster id in two libraries can no longer be confused for one another.
- `remoteDigests` fetches the remote files six at a time instead of one after another; a five-hundred-file space no longer takes a minute to check.
- `roster_search` says when it truncated the source list (`search-sources-truncated`) instead of quietly searching only the first eight.
- `roster_compile` decides "is this v2" by `roles/` + `rosters/`, not by the presence of `space.yaml`.

#### Fixed

- `roster_index`'s `execute` was missing its `exec` parameter, so `pulled` could not be computed at all.
- `roster_team` had no `path` argument although it called `resolve(exec, args.path)`, and could create a session with no workspace (`create({})`), landing wherever the host defaults to. `mode: "existing"` without a session id now fails as `missing-session` before touching the session controller.
- `lib/tools-space.js` carried unused imports and an unused helper; `statusLine` existed twice (now in `lib/tool-output.js`).

## [1.5.0] - 2026-11-04

### Added

- **An origin ledger for every pulled space.** `clone` now writes `.dsh-roster-origin.json` — the repository, ref, path, the commit it was pulled at, and the sha256 + blob id of each file it wrote. Without a baseline there is nothing to compare, so `update` says so instead of calling the copy clean.
- **`dsh-agent-roster update --dir <space> [--write]`** — compares ledger, disk and the remote at that ref, and reports one of six states: `clean`, `local-only`, `remote-only`, `diverged`, `remote-deleted`, `missing`. `--write` fast-forwards only `remote-only`; a conflict prints both shas and a diff and stops. There is no automatic merge: YAML plus prose has no merge base, and a three-way merge would quietly produce duplicate role names. Use `git clone` when you want real merging.
- **Five more read-only tools** (eleven in total): `roster_space` describes a space (layout, declared vs present, roles, origin commit), `roster_search` searches this machine and the first eight subscribed sources with the same engine as the Library tab, `roster_changes` reports the six states per file, `roster_compile` compiles a v2 roster in memory without writing `dist/`, and `roster_index` entries now carry `space`, `layout` and `pulled`.
- **`roster_team`** — create a team from a roster: a new session (choose the space and the session name) or an existing one, select the captain model declared by the roster, then queue the build prompt. It shares `applyCaptain` with the panel, so the two paths cannot drift.
- **Create team from the row you are looking at** now asks for a space and a session name when it opens a new session, and lists existing sessions as `space · session name` (title from the session projection, falling back to the workspace directory, then the short id). The host workspaces come from `workspaceRegistry`, so the picker speaks the same names as the rest of DSH.
- **Check updates** on a local space header in the Library tab: check every local library once, show `N updates`, apply the fast-forward set, toast the number of files written.

### Changed

- `applyCaptain` accepts `workspaceId` and `sessionTitle`; a new session is created in that workspace and renamed right after creation (the host's create request has no title field). A failed rename reports `session-rename-failed` with the session id, instead of pretending the name stuck.
- The panel's roster tab defaults to starred rosters only, and the Library tab no longer offers a per-roster pull — pulls are per space.

## [1.4.0] - 2026-11-04

### A persona can place a block, not only append one

`prompt.parts` could only stack fragments after the body, in the order the frontmatter listed them. That
made "the checklist for this step" impossible to put next to the step, and it made a fragment shared by
three roles a three-way copy: `safeResolve` pins parts inside the role directory.

The body can now reference a file where it belongs:

```md
## Before you ship
{{> parts/self-check.md}}

## Units
{{> snippets/units.md}}
```

`parts/…` resolves against the role directory, `snippets/…` against the library root, so one file can be
shared by every role and edited once. Expansion is a single level and the included text is literal: a
reference inside an included file is an error (`include-nested`), never silently expanded and never shipped
as a raw directive.

The contract is deliberately small — no conditions, loops or variables. `executionPrompt` has to stay a
deterministic function of the files on disk; otherwise `promptStats.sha256` stops meaning anything and
"what did this member actually receive" becomes a runtime guess.

- Errors carry `AGENT.md:line` (body lines are offset by the frontmatter, so the number matches the editor):
  `include-syntax`, `missing-include`, `unreadable-include`, `unsafe-include`, `include-nested`,
  `library-root-unknown`, `include-too-long`.
- Budget applies to the expanded text: 32 references, 6000 characters per included file, and the 12000
  `promptChars` ceiling is checked after expansion.
- `promptStats.parts` gains `{ path, kind: "include", line, sha256 }`, so the compiled artifact points at
  the exact line the compiler read.
- `prompt.parts` is unchanged and can be mixed with references; it still rejects duplicates, while a
  repeated reference expands twice because position is meaning.
- `lib/paths.js` now owns `isSafeRelative` / `safeResolve` (role fragments, includes, captain personas and
  examples all use one guard); `lib/includes.js` owns parsing and expansion.
- `clone` carries the referenced `snippets/` as well, so a space pulled from a remote repository compiles
  locally without hand-copying shared text.
- `examples/` demonstrates it: `snippets/report-shape.md` is referenced from the review lead, and the
  shipped `dist/` is rebuilt.

## [1.3.0] - 2026-11-03

### Favourites instead of fifteen pull buttons

The library offered a **Pull** button on every roster, including the ones already on the machine. Pulling
one roster out of a space produced a copy with no path back to the space it came from, so the button was
either redundant or actively wrong. Pulling is now a property of the space — the one button on its head —
and the row keeps a **favourite** star instead.

That star is what the first tab reads. It opens on `Favourites`: pulling a 21-roster space should not dump
21 rows on the screen you look at every day. A segmented control in the toolbar switches to `All`; with
nothing starred yet the tab says so and points at the library. Favourites live in `.dsh-roster-favorites.json`
at the library root — they travel with the library, not the machine, and a corrupt file degrades to "nothing
starred" plus one warning instead of blocking the panel. Saving or importing a roster stars it; deleting one
unstars it.

Two smaller corrections from the same pass:

- **The sources tab is gone.** Subscription management was a whole tab for something you set once; the
  library already spans every subscribed source, and each space head pulls what it needs. Refresh moved
  into the library toolbar.
- **Duplicating a roster fills the editor.** `duplicate` opened the form with the previous filter, which
  read the roster back only when *not* duplicating — so a copy arrived empty. It now always loads the
  source roster and only changes the id (`<id>-copy`). The clipboard action is renamed
  **Copy member params**, because "copy build payload" described the wire format rather than the thing
  you get.

## [1.2.0] - 2026-11-03

### Create a team from the row you are looking at

Creating a team used to require expanding the roster, finding the captain panel and pressing *apply*. The
one action the product is named after was the hardest thing to find, and a roster without a `captain` block
offered no path at all.

Every roster row now carries **Create team**. It opens a small dialog: team name (defaults to the roster id),
a choice between a new session and an existing one — new is the default, because quick creation must not
hijack the conversation you are in — and a one-line summary of what will be built (`N members · captain model`).
Submitting queues the same build prompt as *apply*; the toast names the session it landed in.

The boundary is unchanged, and the dialog says so on its face: the plugin never writes team state. It
prepares a session (selects the captain model when the archive declares one, queues the prompt), and that
session calls `agent_teams_create` / `agent_teams_add_member` / `roster_verify`. A roster without a captain
block can still create a team; it just will not switch the model, and the dialog says that instead of failing
silently.

## [1.1.0] - 2026-11-03

### The library reads as spaces, not groups

1.0.0 made the space a real level in the format. The panel still showed collections as small labels, so the
level existed in the files and not on screen. Each group header is now the space itself: its id sits in the
same column as the roster ids (the register keeps one spine), the right side states two facts you can check
on the spot — how many rosters it holds, how many are already here — and one button pulls the whole space.

Rows also stopped lying about state. A roster that is already on this machine says so, and its action
becomes **Open** instead of **Pull**: the panel no longer offers to fetch something you already have. The
local group drops the per-row "local" label, because the group header already says it.

On a narrow panel the space header folds into two lines (id + action, then title + facts) instead of
squeezing a long space name into a vertical stack one character wide.


## [1.0.0] - 2026-11-03

### A space is the thing a repository holds

Until now a pulled roster was a flattened copy: whatever the source repository looked like, it arrived as
`<id>/roster.yaml` and the editor had no idea which file upstream it corresponded to. That is fine for "I
only need this one", and wrong for every monorepo — which is what this project's own libraries have been
since 0.10.0.

`space.yaml` (`kind: dsh-agent-roster/space@1`) is the level that was missing. It declares what a
directory in a repository *is*: which rosters it holds, whether the layout is `flat` (`<id>/roster.yaml`)
or `monorepo` (`roles/` + `rosters/` + `dist/`), and — only on local copies — where it came from
(`origin: {repo, ref, path}`). Layout is now part of the format instead of something the puller guesses.
Clone a space and the local tree is the repository's tree: edit `rosters/<id>/roster.yaml` and you are
editing the file upstream.

### Changed (breaking)

- `organization.yaml` is replaced by `space.yaml`. The old file, its `kind`
  (`dsh-agent-roster-organization/v1`), its schema and its diagnostics codes (`organization-*`) are gone;
  the equivalents are `space.yaml`, `dsh-agent-roster/space@1` and `space-*`. Migration: rename the file,
  change `kind`, rename the `organization:` key to `space:`, and add `layout: flat|monorepo`.
- A space file inside a repository may not declare `origin`; the validator rejects it. `origin` describes
  a local copy, and a repository claiming a source is a second copy of the truth.

### Added

- `lib/space.js` + `schema/space.v1.schema.json`: declaration, cross-check (missing = error, undeclared =
  warn, archived = info) and strict validation, with `layout` and `origin`.
- `lib/clone.js` and `dsh-agent-roster clone --repo <owner/repo> [--path] [--ref] [--space]`: pull a whole
  space with its layout intact — rosters, the roles they reference, and each role's `parts/`. The written
  `space.yaml` is the source's cover plus `origin`.
- `POST /plugins/dsh-agent-roster/install-space` and a "Pull whole space" button on every source group in
  the Library tab; pulled files land in `<library>/<space>/` with the repository's paths.
- The Library tab marks rosters that are already installed locally, so "everything is pulled" and "what
  do I actually have" stop looking the same.
- `examples/`, `examples-orchestration/` and `orgs/agent-roster-collective/` each ship a `space.yaml`.


## [0.13.1] - 2026-11-03

### The local rosters are the front page

0.13.0 opened on the library tab. That got the metaphor right and the priority wrong: the rosters you
already manage are what you come back to every day, and they were one tab away. The panel now lands on
**Rosters** — local, searchable, with its tag pool — and the library marketplace is the second tab.

- Tab order is `Rosters, Library, Teams, Sources, Health`; the default tab is `rosters` again.
- Nothing moved between the two: both read the same snapshot, both filter by tag, and the tag pools stay
  independent (local-only vs everything in view) so neither one silently changes the other's counts.

## [0.13.0] - 2026-11-03

### A tab that behaves like a marketplace, not a filter on a list

0.12.0 put a search field above the tabs. That was still the wrong shape: search belonged to a page about
collections, and browsing still meant "pick a source, then read". The panel now opens on its own **Library**
tab — search, tags, and one list that spans this machine and every subscribed source.

- `GET /plugins/dsh-agent-roster/catalog` returns every roster in view in one response: this machine plus
  each subscribed collection, with tags, member counts, member roles and where each one lives.
- The tag strip is a real filter: counts are computed from everything in view, multiple tags are AND, and
  the selection never writes back to a file. The segmented control switches between **by source** (this
  machine, then one group per collection) and **flat** (one list, source named per row).
- Search keeps its own route and its own ranking (`lib/search.js`): two characters, 240 ms debounce, and the
  in-flight request is aborted when you keep typing, so typing never queues requests.
- Compiled artifacts now carry what it takes to be *found*: `source.title`, `description`, `tags`, `license`
  and `maintainers`. A subscribed roster is one file (`dist/<id>-<ver>.json`) resolved through `files` in the
  index — previously the artifact knew its id and version and nothing else, so remote results could only be
  searched by id.
- The panel's tag chips were inheriting the sidebar's full-width row form; they are now chips (own width,
  pill border, count attached), and the narrow layout gets the same 18px gutter as the rest of the page.

### Changed

- The header lookup field is gone; its behaviour lives inside the Library tab. `lookup.*` strings were
  replaced by `catalog.*` (both locales).
- `flattenCompiledToRoster` and `rosterViewOf` now fall back to artifact metadata, so a remote roster keeps
  its title and tags after being flattened into a v1 document.

### Fixed

- `GET /catalog` and search share one `gatherEntries()` path; before, each route assembled local + remote
  entries itself, which is how a cache or concurrency fix lands in one and not the other.

## [0.12.0] - 2026-11-03

### The panel answers "which one", not "show me everything"

Until now the panel was organised by **collection**: expand a source, then read a list. But the real
question is almost always the opposite — "I need someone who watches data quality" — so the entry
point is now one search field above the tabs.

- `GET /plugins/dsh-agent-roster/search?q=` searches this machine and every subscribed source in one
  request, reusing the collection cache (60s) so repeated typing does not hit the network again.
- Ranking is explainable: every match reports `hits[{field, label, text}]` ("标签：数据质量"), and id
  matches outrank title matches outrank tag matches outrank member roles. Multiple words are **AND**:
  "data kubernetes" matches nothing here, instead of matching everything that has "data".
- A result that lives in another library says so ("来自 agent-roster-collective") and can be pulled
  from the row itself; a local one opens straight into the roster list filtered to that id.
- `lib/search.js` is a pure function — no filesystem, no network — so the ranking is unit-tested.

### Added

- `lib/search.js` with `searchRosters`, `searchableFields`, `tokenize`; 6 tests.
- `/plugins/dsh-agent-roster/search` route (local + remote, bounded source concurrency).
- Panel lookup field, result rows with match provenance, and `lookup.*` strings in both locales.

## [0.11.1] - 2026-11-03

### Fixed

- Empty states hugged the panel edge: the rosters and teams tabs rendered their "nothing here yet" block
  straight into a page whose padding is `0` (each tab supplies its own gutter), so the sentence sat against
  the window border while the tab labels and lists were indented. Both now sit in `.rstr-empty-wrap`, the
  same 16/28px measure the source tab and the health tab use.

## [0.11.0] - 2026-11-03

### Changed

- **Expanding a collection no longer walks its rosters one by one.** `fetchCollection` runs up to six
  fetches at a time and keeps the index order for both rosters and diagnostics: the 21-roster
  `agent-roster-collective` went from **9.4 s to 0.8 s** on this machine (serial vs parallel, real network).
- The collection route memoises the fetched result for 60 s, and the panel keeps the last expansion in
  memory — re-opening a collection paints immediately instead of re-fetching 21 files.

### Added

- A filter box inside an expanded collection: narrows by roster id, title or member name, and shows
  `shown / total`. It only hides rows; it never writes anything.

## [0.10.7] - 2026-11-03

### Documentation

- README (both languages) now describes the cache that knows its own version, the two remote-source
  diagnostics added in 0.10.6, and a `lib/` listing that matches what is actually there — the previous one
  still named only the v1-era modules and omitted `compile2`/`plan`/`migrate`/`run`/`role`/`roster2`.
- Test count corrected to 297/297.

## [0.10.6] - 2026-11-03

### Fixed

- **An index cached before an upgrade kept feeding the old shape.** The cache stored an index document
  with no notion of what shape it had, so after upgrading to 0.10.3 — the release that added
  `collection.files` — the panel kept reading a cached index without `files`, fell back to the v1 path, and
  404'd. Caches now carry `CACHE_VERSION`; a mismatch refetches once.
- A failed fetch on the v1 fallback path now says *why* it is likely failing: if the collection has no
  `files` mapping, the diagnostic points at a stale index (refresh, or delete `.index-cache`) instead of
  leaving a bare `HTTP 404`.

## [0.10.5] - 2026-11-03

### Fixed

- **`roster_index` could not run at all.** Its `execute()` called `loadRemotePanel` and `fetchCollection`,
  neither of which was imported; the module loaded fine and threw `ReferenceError` on the first call.
  It now imports both, and a test executes the tool so this class of breakage cannot pass silently again.
- **Every public collection answered HTTP 404.** `loadRemotePanel` rebuilds each registry collection from
  an explicit field list, and `files` was not on it — so every URL fell back to the v1 path
  `<id>/roster.yaml`, which no longer exists for a v2 library. The projection keeps `files` now, with a
  test that fails if the field is dropped again.

## [0.10.4] - 2026-11-03

### Fixed

- **`compile --repo` was accepted and ignored.** The flag was parsed, then the artifact recorded `ownRepo()`
  — the coordinates of whichever checkout ran the compiler. A repository that committed `dist/` therefore
  disagreed with its own CI on every run: the drift check recompiled, got a different `source.repo`, and
  failed. `migrate` had the same fault one layer down: it passed `source: {}` to the compiler instead of
  the repository it was told to record. Both now write the coordinates they were given, and a test pins it.

## [0.10.3] - 2026-11-03

### Added

- `migrate --from <dir>` and `--repo <owner/repo>`: a repository that publishes a collection keeps its
  v1 rosters in `rosters/<id>/`, so the library root and the old files are not the same directory. The
  migration now rewrites that file in place, adds `roles/` and `dist/` at the root, removes the stale
  `roster.json`/`roster.yml` beside it (two spellings of one roster are two sources of truth), and does
  **not** delete `rosters/<id>/` — that is where the new assembly lives.
- A collection's `path` may be empty, meaning the repository root *is* the library. The three example
  repositories (`agent-teams`, `metagpt-company`, `openmanus`) now use that shape: `roles/`, `rosters/`,
  `dist/` at the root, `files` pointing at the compiled artifact.

### Fixed

- The `agent-teams`, `metagpt-company` and `openmanus` collections were still published as v1, so their
  `roster.yaml` was fetched while a v2 world had already moved on; every entry now names its artifact.

## [0.10.2] - 2026-11-03

### Fixed

- **Every v2 collection was unfetchable (HTTP 404).** The index assumed the v1 flat layout
  (`<path>/<id>/roster.yaml`), which stopped existing the moment rosters moved to `rosters/<id>/`.
  A collection may now pin one relative path per roster in an optional `files` map;
  `registry sync` fills it in and points v2 rosters at the self-contained `dist/<id>-<ver>.json`
  (an assembly alone cannot be pulled — its members are role references).
- Pulling a compiled artifact flattens it into an inline v1 document (personas are the assembled
  prompt, which is what would actually be sent); run `migrate` afterwards if you want the role split
  on your machine. A bare `roster@2` is reported as `collection-roster-needs-roles` instead of being
  fetched as if it were one file.
- `flattenCompiledToRoster` no longer emits empty `title`/`description` strings — v1 rejects those,
  so a flattened artifact used to fail its own validation.

## [0.10.1] - 2026-11-03

### Docs

- The Chinese README said `migrate` was "not implemented", listed one example library where there are
  two, and had a file tree from before `roles/`, `roster.v2` and `compiled.v1` existed — docs that
  describe last week's format read as current, which is worse than no docs.
- Both READMEs now carry the same two sections: one-command v1→v2 migration (including why role names
  are prefixed and why a colliding captain gets `-captain`), and feeding a failed round back into the
  plan with `compile --run`.

## [0.10.0] - 2026-11-03

### Roles, rosters and compiled artifacts (v2)

- **A roster is no longer one document doing four jobs.** Personas move to `roles/<dir>/AGENT.md`
  (frontmatter for parameters, markdown body for the persona, optional `parts/`), assemblies stay in
  `rosters/<id>/roster.yaml` (members are `name@x.y.z` references, the captain gets its own section),
  and everything consumers read is a self-contained `dist/<id>-<ver>.json`.
- **Assembly is part of the format**: `executionPrompt = join("\n\n", [body, ...parts, ...append])`,
  implemented once in `lib/frontmatter.js#assemblePrompt`. The compiled artifact records character
  count, block list and SHA-256 per prompt.
- **The discriminator decides the version** — `dsh-agent-roster/role@1`, `/roster@2`, `/compiled@1`.
  v1 is frozen; two formats never share a directory.
- **Identity comes from the document**, so the "directory name must equal `id`" rule is replaced by a
  stronger one: role names are unique within a library, and duplicate `name` is an error.
- **`orchestration` is compiled as a declaration.** Stages and gates are validated (a gate's `after`
  must name real stages, `by` must name a real member), the artifact marks
  `status: "declaration"`, and every non-executed field is listed in `declarations[]`.
- **New CLI**: `dsh-agent-roster compile --roster <dir> [--roles <dir>] [--write] [--json]`.
- **Schema alignment tests**: `test/v2-schema.test.js` pins field sets, enums, limits and regexes to
  `lib/format-v2.js`, and `test/examples-orchestration.test.js` compiles `examples-orchestration/` and fails if `dist/` drifts.
- Design contract: [`docs/roster-v2.md`](./docs/roster-v2.md).
- **Gates must be runnable.** Every gate carries at least one `verify` entry (`command`, `expectExit`);
  a gate without one is rejected as `gate-unverifiable`, because a gate whose only criterion is a
  sentence is judged by the person signing it.
- **A construction plan, not an execution.** `compile` now also writes
  `dist/<id>-<ver>.tasks.json` (`plan@1`): stages and gates flattened into cards with dependencies,
  `executor: "captain"`, and `loop.onGateFailure` naming where a failed gate goes back to and how many
  rounds it may take. The plugin never calls `agent_teams_create_task` — the plan is a drawing.

### Migrating what already existed

- **`migrate --dir <library> [--write]`** rewrites a v1 library in place: each member's
  `systemPrompt` becomes the body of `roles/<roster>-<member>/AGENT.md`, the member turns into a
  reference, the captain becomes a role file of its own, `capabilities.yaml` moves next to the
  assembly, every roster is compiled into `dist/`, and the old flat directory is removed.
  Without `--write` it only reports what it would do — it is the one command that deletes things.
- **Role names carry the roster id prefix.** v2 requires role names to be unique per library; a
  library whose 21 rosters all call their captain `lead` cannot have 21 files named `lead`. When the
  captain collides with a member it gets a `-captain` suffix instead of being merged — they are two
  personas and merging them would silently drop one.
- **This repository's own archives were migrated**: `examples/` (2 rosters, 5 members, one captain)
  and `orgs/agent-roster-collective/` (21 rosters, 63 members) now live as `roles/ + rosters/ + dist/`.
- `maintainers` accepts handles (`STofone`) rather than the lowercase id pattern — migration must not
  rename a person to satisfy a validator.
- **Both layouts are readable**: the scanner, the document route and the writer accept
  `<root>/<id>/roster.*` and `<root>/rosters/<id>/roster.*`, so a v1 library keeps working while it is
  being migrated, and the panel shows v2 rosters through the same `rosterViewOf` shape.

### An execution record feeds the next compile

- **`run@1`** (`lib/run.js`): rounds → tasks → findings/commands, with unknown fields rejected.
- **`compile --run <file>`** merges the previous round's failures into the retry card's description
  (and stamps `round` on the plan). A failure that only lives on a red card never reaches the next
  compile — which is how a gate becomes decoration.
- The record is written by the captain session, not by the plugin: task ids belong to the team.

## [0.9.2] - 2026-11-03

### The member list is a table

- **Four columns now line up across rows.** Each member row used to compute its own grid, so the
  name / description / tool policy / model columns drifted from row to row and the list read as
  separate blocks. `.rstr-members` owns the column widths and every row uses `subgrid`.
- **One line per member at narrow widths**: name and role on the left, the policy pinned right,
  description and model beneath — four lines instead of five, and nothing overlaps.
- Member notes (aliases, declared skills, inherited fields) span the full row instead of pushing
  the columns around.

## [0.9.1] - 2026-11-03

### Expansion stops clipping itself

- **No more scroll boxes inside expansions.** 0.8.3 capped the expanded collection list at
  `max-height: 340px` with its own scrollbar; with 21 rosters that reads as "the list is cut off".
  The cap and the nested scroller are gone — the panel root is the only thing that scrolls, and
  an expanded section simply grows.
- **The sources tab gets its page padding back** (`16px 28px 28px`); its collections had been
  rendering flush against the window edge, hard against `overflow-x: hidden`.
- **Source collections use the ledger row**, like rosters and teams. They were still emitting
  `.rstr-card*` class names whose rules disappeared in the 0.9.0 ledger rewrite, so the tab
  rendered unstyled elements. A regression assertion now forbids those class names returning.
- **Member rows keep name and role on one line**: `toolPolicy` moved from the head to the meta
  strip, where the model, effort and prompt size already sit.
- **Wider id column with a title tooltip**, so `agent-roster-collective` is readable instead of
  truncated to `agent-roster-collec…`.
- The CSS guard now asserts the opposite of what it did in 0.8.3: expansions must carry neither
  `max-height` nor `overflow`, because nested scrolling is what made the content look incomplete.

## [0.9.0] - 2026-11-03

### The roster list is a ledger

- **Rows, not cards.** Each roster is one row: a 3px state edge (lit only for `error` / `warn`),
  a monospace id column, the title with its one-line description, right-aligned counts and a
  quiet pair of actions. Duplicate / copy-create / delete moved into the expanded area — 21
  rosters go from 105 always-visible buttons to 42.
- **The edge is the only loud thing.** Healthy rows carry no colour at all; the accent colour is
  reserved for the selected tab underline and the selected tag's left edge. Every colour still
  comes from `--dsw-alias-*` tokens, so light and dark themes stay consistent.
- **Teams are rows too**, collapsed by default, with the same state edge.
- **The header states what the library holds**: rosters, members, teams, and the owning
  `organization.yaml` id when the directory has one.
- Narrow panels (below 860px) fold the tag pool into a wrapping top row instead of clipping it.

## [0.8.3] - 2026-11-03

### The panel no longer cuts long content

- **The page owns its own scroll.** A global panel is mounted inside the centre column, which is
  `overflow: hidden`; a page that never asks for scroll silently clips everything below the fold —
  that is why the sources tab looked half-rendered as soon as a collection was expanded. `.rstr-page`
  now sets `height: 100%; min-height: 0; overflow-y: auto; overflow-x: hidden`.
- **Card grids no longer overflow narrow panels.** `repeat(auto-fill, minmax(380px, 1fr))` became
  `repeat(auto-fill, minmax(min(380px, 100%), 1fr))`, so a narrow column stops clipping cards on the
  right edge.
- **The expanded roster list scrolls inside its card** (`max-height: 340px`) instead of stretching
  the card without bound, and long roster titles ellipsize instead of pushing the badges out.
- Three regression assertions pin the three layers (page / grid / expanded list) in
  `test/client.test.js`, so a later style refactor cannot quietly bring the clipping back.

## [0.8.2] - 2026-11-03

### The whole family lives under one organization

- **The three example repositories moved too, and were renamed to their collection ids**:
  `dsh-agent-roster/agent-teams`, `dsh-agent-roster/metagpt-company`,
  `dsh-agent-roster/openmanus`. Their old `STofone/dsh-roster-*` names redirect, and each repo got
  its own `registry.json` and README links rewritten, so nothing in them points at the old owner.
- **`index/registry.json` follows**: every collection's `repo` (and `homepage`) now names the org,
  including the two collections that live in this repository.
- **All four repositories carry the `dsh-agent-roster` topic** (plus `dsh-plugin`,
  `agent-roster`, `deepseek-harness`), which is what makes the collections findable by topic
  rather than only by this hand-maintained index.

## [0.8.1] - 2026-11-03

### Moved to the `dsh-agent-roster` organization

- **The repository now lives at `dsh-agent-roster/dsh-agent-roster`** (GitHub keeps redirects from
  the old owner, so existing clones and links keep working). Nothing about the format, the tools or
  the published package name changes.
- **The default registry source follows the move**: `lib/remote.js` asks
  `https://raw.githubusercontent.com/dsh-agent-roster/dsh-agent-roster/main/index/registry.json`,
  so a fresh install that has not configured `indexes` does not depend on a redirect.
- **Package metadata and schema `$id`s point at the new home** (`package.json` homepage /
  repository / issues, and the four `schema/*.v1.schema.json` files), so editors and npm resolve
  the canonical location instead of a redirect.

## [0.8.0] - 2026-11-02

### Library organization (new root file)

- **`organization.yaml`** — an optional file at the library root, beside the roster directories.
  It declares which rosters belong to the library, their status (`active` | `archived`) and where
  they came from. It is the only file allowed to sit at the root, and it still cannot create
  anything: no teams, no members, no `agent_teams_add_member` arguments.
- **Three-way cross-check against the disk**, surfaced as diagnostics the panel already renders:
  declared but missing → **error**, present but undeclared → **warn**, declared `archived` but
  still in the library → **info**. Archiving is a declaration, not a deletion.
- **`roster_list` and `dsh-agent-roster validate` show it** (`organization=<id>`, the counts, and
  per-file `organization` / `organizationCheck` in `--json`);
  `schema/organization.v1.schema.json` covers the file for editor-side validation.
- **`orgs/agent-roster-collective/`** ships as a worked example: 21 self-authored rosters
  (63 members) covering review, incident response, data, docs, release, research and more.
- **`security-audit/capabilities.yaml`** in that example shows the two-file library: a roster plus
  its declared requirements, with `onMissing: degraded` so a deployment without the policy still
  builds the team but reports the gap instead of pretending it passed.

### Registry schema (new file)

- **`schema/registry.v1.schema.json`** — the shipped `index/registry.json` pointed at a schema that
  did not exist, so editors had nothing to lint against. The file now exists, mirrors
  `lib/remote.js#validateRegistry`, and `test/registry-schema.test.js` keeps the two aligned
  (field sets, id/repo/ref/path patterns, collection and roster limits).

### Removed

- **`INDEX_KIND`** (`dsh-agent-roster-index/v1`). Nothing ever produced that document: a registry
  collection already carries its `rosters` list, and `registry sync` recomputes it from the
  repository. Keeping a second manifest format would have been a second source of truth.

## [0.7.0] - 2026-11-02

### Honest verification (issue #2)

- **`omitted` is split in two.** "The roster did not declare this field" and "the roster declared
  a value, the runtime never persisted it" used to collapse into one status that the summary
  counted as "not degraded". They are now `omitted` (nothing to check, expected) and
  `not-persisted` (sent, no receipt, counted as degraded). `systemPrompt` lands in the second
  bucket because `team.json` members have no `executionPrompt` key at all — the persona was
  never actually verified before.
- **One predicate instead of three.** `isBindingFaithful` now delegates to
  `summarizeBinding(...).faithful`, so the note and the implementation cannot drift apart again.
- **Four mutually exclusive buckets** in `roster_verify`: `faithful` / `unverified` / `drift` /
  `missing`. `ok` requires `drift === 0 && missing === 0`, and `unverified` is printed on the
  status line and the summary instead of hiding inside "degraded".
- **Materialised tool filters are visible.** Each member shows `deny`/`allow` counts and a
  digest of the normalised list; the same `toolPolicy` materialising into two different deny
  lists inside one team is reported as policy drift.
- **Provenance.** `roster_create` emits `roster:<id>@<version>#<sha8>` for the created team's
  description; `roster_verify` parses it back and reports `absent` / `id-only` / `match` /
  `differ` / `unknown-roster`. The plugin still never writes team state.
- **New tool `roster_diff`** — roster-to-roster diff for generation hand-over: members matched
  by name (`aliases` are a hint, never auto-merged), effective values compared with their
  origin, persona compared by length and hash only.

### Capability requirements (new sibling file)

- **`capabilities.yaml`** — an optional file next to `roster.yaml` that declares what the
  deployment must provide: `requires.skills`, `requires.toolPolicies`, `onMissing`
  (`refuse` | `degraded`), `asOf` (date only) and `notes`. Unknown keys and unknown requirement
  categories are errors: model routing, plugin versions, credential pointers and business
  preconditions have no evidence source, so declaring them would only manufacture a new kind of
  false green.
- **Three states, not two.** `checkCapabilities` answers `present` / `missing` / `unknown`;
  only `missing` (the evidence source explicitly says no) trips the gate. `unknown` is neither a
  pass nor a failure and is always printed.
- **`roster_create` refuses instead of warning.** With a `missing` requirement under
  `onMissing: refuse` it emits no `agent_teams_add_member` argument at all and prints where each
  requirement has to be installed. `onMissing: degraded` hands over the arguments and records
  the debt.
- **`roster_verify`** gains `requires=<missing>missing/<declared>` and `capabilityBlocked` in its
  status line, a capability section in the body, `ok` includes `capabilityBlocked === 0`, and a
  structured `capabilities` field.
- **`roster_show`** prints the declaration block.
- New `schema/capabilities.v1.schema.json`, pinned to `lib/capabilities.js` by
  `test/capabilities.test.js`.

- **The panel sees it.** Capability requirements surface as roster diagnostics: a missing
  `toolPolicies` requirement is `error` under `refuse` (the sidebar badge turns red) and `warn`
  under `degraded`; skill requirements are `capability-skills-unverified` / `info` because the
  panel snapshot is synchronous and cannot enumerate the catalogue; an unset `knownToolPolicies`
  yields one `capability-cross-check-skipped` entry naming the affected rosters.

### Docs

- README (both languages): six tools, the new verification buckets, `roster_diff`, a
  "one roster per directory, two generations per machine" section answering how to keep both
  generations side by side, and a "capability requirements" section covering the three-state
  check and the gate.

## [0.6.2] - 2026-10-30

### Packaging

- `peerDependencies` for `@deepseek-ai/dsh-tools` no longer uses the wildcard. node-semver only
  admits a prerelease version when one comparator in the range shares its exact
  `major.minor.patch` tuple and itself carries a prerelease tag, so `*` — like the broad
  `>=0.0.1-rc.1 <0.2.0` form — silently excludes every prerelease harness build. The range is now
  `^0.1.0-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.1 || ^0.3.0-rc.1`, which admits the 0.1.x, 0.2.0-x,
  0.2.1-x and 0.3.x prerelease lines while still refusing 0.4.x prereleases.
- No runtime change; the peer stays optional because the host always provides the module.

## [0.6.1] - 2026-10-30

### Custom registry mirror

- New config field `registryMirror`: type any npm registry URL in Settings (download section)
  and index packages published as npm packages are fetched from there instead of the region
  presets. Sub-paths are kept, so corporate Nexus layouts such as
  `http://nexus.corp.local/repository/npm` work.
- Precedence: a registry pinned inside a source wins, then `registryMirror`, then `region`.
  A blank or malformed value is ignored instead of silently disabling downloads.
- Tests: 195 passing (mirror normalisation, precedence, config-view passthrough).

## [0.6.0] - 2026-10-30

### Captain verification and applying a roster

- The panel now compares an archive's `captain` block with what the deployment actually says:
  provider / model / reasoning-effort / persona prefix are read from every profile's
  `cordis.patch.yml` and reported as `match`, `differ`, `undeclared` or `unknown`.
  Unreadable deployment config is never reported as a pass.
- New `POST /plugins/dsh-agent-roster/apply`: picks an existing session or creates a new one,
  applies the declared model to that session, and queues a prompt that builds the team with
  `agent_teams_create` + `agent_teams_add_member` + `roster_verify`. The plugin still never
  creates teams itself.
- `/library` now also returns the session list (read-only) and the captain section.
- `roster_verify` reports the captain checks next to the member checks.
- Panel: captain card inside each archive with the declared routing, the four-state checks and an
  "apply" row (existing session / new session + optional working directory).
- Locale dictionary gained the `captain` section in both languages.
- Header actions moved to where they act: import/new archive on the archive tab, "refresh sources"
  on the sources tab (bypasses the TTL and re-reads the index), and a gear button that opens a
  settings dialog (language, download region, roster directories, resolved paths).
- The panel fills the whole page (no `max-width` on the outer container) and the archive
  list gains a tag pool on the left: every tag in the library with its count, multi-select
  narrows with AND semantics, one click clears.

## [0.5.1] - 2026-10-29

### Fixed

- **配置视图漏了两个字段**：`configView` 只转发了 `rosterDirs`/`knownToolPolicies`/`agentTeamsStateDir`，
  面板与路由读不到 `indexes` 与 `region`——于是设置里关掉远端（`indexes: false`）不生效、
  `region: china` 也不生效。现在四个字段都转发，`indexes` 的三种取值（`undefined`/空数组 = 官方源、
  `false` = 关掉远端、数组 = 自定义源）原样保留。
- **缺省档案库目录退回旧的相对路径**：`rosterDirs` 未配置时曾退回 `["rosters"]`（相对当前工作区），
  与 0.3.0 起的“留空 = 全局库 `$DSH_HOME/agent-roster`”不一致；一键拉取会把档案写进工作区而不是全局库。
  现在缺省统一为空串（全局库）。测试 162 → 163。

### Added

- 官方索引 `index/registry.json` 新增三个迁移自上游的 collection：
  `agent-teams`（wshobson/agents，MIT，4.2 万星）、`metagpt-company`（MetaGPT，MIT）、
  `openmanus`（OpenManus，MIT）。三份档案在各自仓库的 `rosters/<id>/roster.yaml`，可在面板“档案源”页一键拉取。

## [0.5.0] - 2026-10-29

### Added

- **公共档案源（registry）**：`indexes` 配置订阅 `https` 的 `registry.json` 或 `npm:pkg`；默认只有官方源
  `STofone/dsh-agent-roster` 的 `index/registry.json`。索引按 **TTL 一小时** 缓存（等于未认证 GitHub 的
  60 次/小时配额），`refresh=1` 才绕过缓存且有 60 秒最短间隔；网络失败沿用上次缓存并说明原因，
  不会把「没拉到」显示成「没有档案」。
- **一键拉取到本机**：面板新增「档案源」页签，列出每个 collection 的标题、仓库、登记份数与上次拉取时间，
  点「拉取到本机」把整目录写进全局档案库。写入是幂等的：内容相同跳过、本地改过默认**不覆盖**并报冲突数，
  只有显式 `overwrite` 才替换。对应 `POST /plugins/dsh-agent-roster/install`。
- 第 5 个工具 `roster_index`：列出索引源状态与 collection；给定 `collection` 时只读地把那套档案拉下来看。
- `lib/serialize.js`：把已校验档案还原成落盘 JSON（只写语义字段，不带 `inherited`/`origin`/`file` 之类副产物）。
- `.github/workflows/registry.yml`：校验 `index/registry.json`、比对仓库真实文件、跑测试。

### Fixed

- `indexes: []` 现在明确表示「用官方源」——此前空数组会被当成「没有源」，装上插件后档案源页签就是空的。

## [0.4.0] - 2026-10-29

### Added

- 成员声明字段 `description`、`aliases`、`skills`、`examples`：文档与派活用的信息，明确标注为声明层。
  `aliases` 参与核对匹配，改名后不再出现「未部署 + 无档案」的假报警；`skills` 与宿主技能目录交叉核对。
- 档案级 `captain` 段：记录队长（＝创建团队的那个会话）应该是什么样，给出可复制的 profile 片段。
  agent-teams 没有 captain 成员行，档案只声明、不改写会话。
- `schema/roster.v1.schema.json`：编辑器与外部工具用的 JSON Schema，由 `test/schema.test.js` 与运行时常量对齐。
- 测试：声明字段校验、别名冲突、队长段、别名核对、技能核对、schema 对齐（共 153 例）。

## [0.3.0] - 2026-10-29

### Changed

- **档案库默认全局**：`rosterDirs` 留空时使用 `<DSH_HOME>/agent-roster`（默认 `~/.dsh/agent-roster`），
  不再按工作区展开。docker 部署下 `$DSH_HOME` 就是被挂载的数据卷，档案天然落在持久化位置。
  只有显式写相对路径（如 `examples`）才按工作区解析——那是显式例外。
- 四个模型可见工具的默认档案库、面板快照、写路由白名单统一走同一套解析（`lib/home.js`），
  「工具读的库」和「面板写的库」不再可能指向不同目录。
- 面板配置区新增「数据目录」一行；档案库目录留空时显示全局默认路径，而不是空白。

### Added

- `lib/home.js`：`$DSH_HOME` > `~/.dsh` 的解析、`~` 展开、全局/工作区目录判定。
- 首次向不存在的全局目录写入时自动创建目录树（面板新建/导入即可用，无需先手动建目录）。
- 测试：全局库解析、空配置只有一个全局根目录、首次写入自动建目录（共 135 例）。

### Fixed

- 空档案库不再产出任何诊断或体检提示：目录还没建（首次保存会自动建）、目录里还没有档案、
  以及「没配 knownToolPolicies」都不再各发一条 info/warn。面板「体检」页签的角标只统计
  真正需要处理的问题（warn/error），info 不再挂数字。

## [0.2.1] - 2026-10-29

### Fixed

- 面板样式只用宿主语义 token（`--dsw-alias-*`），删掉全部硬编码颜色和浅色兜底——暗色主题下不再
  「白底白字」。正文、徽标、按钮、提示条、模态框在两个主题下都按 WCAG AA 复核过（脚本对真实
  token 求对比度，两主题 0 违规）。
- 徽标不再用「深色文字压浅色底」的语义色当正文色（宿主语义色本身是给图标用的，小字压不住），
  改为语义色描边 + 正文色文字；分段控件的选中态同理。
- 模态框改用 `bg-layer-1`，`bg-overlay` 在暗色下是中间灰，压不住次级文字。
- `README.zh.md` 的用例数从 122 更新为 123。

### Added

- 回归测试：`client.js` 的 CSS 不允许出现硬编码颜色，且只能引用 `--dsw-alias-*`。

## [0.2.0] - 2026-10-29

### Added

- 面板从「只看」变成「能管」：三个页签（档案 / 团队 / 体检）。档案页支持新建、编辑、复制、
  删除、导入、导出，编辑器有表单与源码两种模式，覆盖前留 `.bak`；团队页只读状态目录，列出每个
  团队的成员、模型路由、是否与档案一致，以及团队任务；体检页集中回答「配置有没有指错」。
- 写路由 `POST /plugins/dsh-agent-roster/rosters`：同源（`connection` 围栏）、`application/json`
  校验、请求体上限、档案库根目录白名单；`create` / `update` / `delete` / `import` / `export`
  五个动作，宿主侧校验失败原样返回诊断，客户端不直接写文件。
- 只读路由 `GET /plugins/dsh-agent-roster/document`：单份档案原文 + 解析结果，供编辑器源码模式。
- 只读路由 `GET /plugins/dsh-agent-roster/locale`：面板词典（`en` / `zh`）。
- 中英双语：面板与宿主文本都走词典（`locale/*.json`），设置页新增「语言」小节
  （`auto` / `zh` / `en`），默认跟随 DSH；语言变化时面板实时重渲染。
- 设置页 `settings.section` 小节：语言选择 + 只读配置摘要（目录、状态目录、已声明策略数）。
- 面板顶部一条「需要处理的事」徽标，配置类提示集中在体检页，不再把噪声堆到首屏。
- `scripts/check-locale.mjs`：静态 `t()` 键必须两本词典都存在，避免界面漏词。
- 面板快照扩展：`teams`（团队与成员核对）、`hints`（配置体检）、`counts`、`deployments`。
- `lib/http.js`、`lib/write.js`、`lib/service.js`、`lib/teams-state.js`：路由工具、写入计划与
  执行、面板快照投影、状态目录只读解析。
- 单测 111 个用例（新增写入计划/执行、快照与提示、路由契约）。

### Changed

- 面板改为整页布局（`main` 键控槽 + `sidebar.panellist`），设置页只保留语言与配置摘要。
- `package.json` `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-settings`。
- 版本 0.1.0 → 0.2.0。

## [0.1.0]

### Added

- 档案格式 `dsh-agent-roster/v1`：`<root>/<roster-id>/roster.{yaml,yml,json}`，一份档案一个目录。
- 校验器：结构、取值、上限、安全（保留字符 / 提示注入特征）四类检查；未知键直接报错。
- 档案库扫描：按目录探测档案文件，重复文件、散落文件、不可读目录都出诊断，不静默跳过。
- 桥接层：把成员翻译成 `agent_teams_add_member` 参数与 `agent_teams_create` 的 `plan.members`，
  每个字段标注 `direct` / `config` / `declaration` 归宿。
- 核对层：只读 `dsh-agent-teams` 的 `team.json`，逐字段比对并判为 `applied` / `overridden` /
  `omitted` / `unconfirmed`；状态缺失时降级而不是假装通过。
- 四个工具：`roster_list`、`roster_show`、`roster_create`、`roster_verify`。
- 左侧栏面板：`sidebar.panellist` 一行图标 + 同 id 的 `main` 键控槽整页内容；点击后在主区域
  打开工作区 × 档案库快照（只读路由 `/plugins/dsh-agent-roster/library`），档案卡片与成员表；
  取不到工作区注册表时标注回退到进程工作目录。
- CLI `dsh-agent-roster`：`validate` / `list` / `version`，`--dir`、`--known-policy`、`--json`；
  退出码 0 = 通过，1 = 至少一个 error，2 = 用法错误。
- 两座示例档案库（`examples/core-review`、`examples/research`）。
- 单测 88 个用例，覆盖格式、解析、校验、扫描、路径解析、桥接、核对、无损 JSON、工具契约（状态行/无损输出）、客户端加载器契约（两个槽位 + 身份一致）、面板快照与包清单自洽。
- 宿主半边冒烟脚本 `scripts/host-smoke.mjs`：用真实 `defineTool` 注册并调用四个工具，断言输出可无损往返。

### Changed

- 「没配 `knownToolPolicies`」改为档案库级只发一条 `tool-policy-cross-check-skipped`（info），
  不再每份档案重复一条 `tool-policy-unverified` 警告——一个库级事实不该放大成 n 行噪音。
- 四个工具的渲染文本首行改为 `k=v` 状态行（如 `[roster_list] rootDir=… total=2 ok=2`）：
  模型读到的是渲染文本，结构化字段不会自动出现，状态行让"成功没有/命中没有"不必靠中文措辞去猜。

### Fixed

- `volatile` 配置字段在 `apply()` 里是 `{ get, write }` 引用对象，原来被当成普通值读，导致面板与工具
  永远读默认值。改为经 `lib/config-view.js` 每次访问取当前值。
- `roster_list` / `roster_show` / `roster_create` 忽略 `path` 参数、只扫配置目录；现在显式 `path` 即覆盖。
- 工具返回值含 `undefined` 键，运行时按 `value is not lossless JSON` 整次拒绝；缺失值统一写 `null`，
  且所有返回值先过 `lib/json.js#lossless`。

[Unreleased]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.8.2...main
[1.8.3]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.8.2...v1.8.3
[1.8.2]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.7.2...v1.8.0
[1.7.2]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.6.1...v1.7.0
[1.6.1]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.1.0...v1.2.0
[0.13.1]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v0.13.0...v0.13.1
[1.0.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v0.13.1...v1.0.0
[1.1.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v1.0.0...v1.1.0
[0.13.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v0.10.7...v0.11.0
[0.10.7]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v0.10.6...v0.10.7
[0.10.6]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v0.10.5...v0.10.6
[0.10.5]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v0.10.4...v0.10.5
[0.10.4]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/dsh-agent-roster/dsh-agent-roster/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/releases/tag/v0.10.0
[0.9.2]: https://github.com/dsh-agent-roster/dsh-agent-roster/releases/tag/v0.9.2
[0.9.1]: https://github.com/dsh-agent-roster/dsh-agent-roster/releases/tag/v0.9.1
[0.9.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/releases/tag/v0.9.0
[0.8.3]: https://github.com/dsh-agent-roster/dsh-agent-roster/releases/tag/v0.8.3
[0.8.2]: https://github.com/dsh-agent-roster/dsh-agent-roster/releases/tag/v0.8.2
[0.8.1]: https://github.com/dsh-agent-roster/dsh-agent-roster/releases/tag/v0.8.1
[0.8.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/releases/tag/v0.8.0
[0.7.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/releases/tag/v0.7.0
[0.2.0]: https://github.com/dsh-agent-roster/dsh-agent-roster/releases/tag/v0.2.0
