#!/usr/bin/env node
/**
 * 命令行入口：给 CI 与本地预检用。
 *
 * 工具是给模型用的，CLI 是给人/CI 用的：同一套校验器，不需要启动宿主。
 * 退出码是契约：0 = 全部通过（警告不算失败），1 = 至少一处 error，2 = 用法错误。
 *
 * 用法：
 *   dsh-agent-roster validate [--dir rosters] [--known-policy <id>]... [--json]
 *   dsh-agent-roster list     [--dir rosters]
 *   dsh-agent-roster registry validate --file index/registry.json [--json]
 *   dsh-agent-roster registry fetch    --file index/registry.json [--local-only]
 *   dsh-agent-roster registry sync     --file index/registry.json [--write]
 *   dsh-agent-roster compile --roster rosters/money-lab [--roles roles] [--run run.json] [--write] [--json]
 *   dsh-agent-roster migrate --dir examples [--write] [--json]
 *   dsh-agent-roster migrate --dir . --from rosters --repo owner/repo --write
 *   dsh-agent-roster libraries [--json] [--add <绝对路径>] [--forget <绝对路径>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import { resolveDirSpec } from "../lib/home.js";
import { globalRosterRoot } from "../lib/home.js";
import { cloneSpace } from "../lib/clone.js";
import { findAgencyAssets, planAgencyLibrary, readAgencyExperts, writeAgencyLibrary } from "../lib/agency.js";
import { scanRosterLibrary } from "../lib/registry.js";
import { forgetLibraryDir, registeredLibraryDirs, rememberLibraryDir } from "../lib/preferences.js";
import { renderRosterList } from "../lib/render.js";
import { REGISTRY_KIND } from "../lib/format.js";
import { fetchCollection, readRegistryFile } from "../lib/remote.js";
import { compileRosterAt } from "../lib/compile2.js";
import { migrateLibrary } from "../lib/migrate.js";
import { compilePlan } from "../lib/plan.js";
import { mergeRunIntoPlan, validateRun } from "../lib/run.js";
import { DIST_DIR } from "../lib/migrate.js";
import { acceptLocal, applyFastForward, checkOrigin } from "../lib/origin.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const USAGE = `用法：
  dsh-agent-roster validate [选项]   校验一座档案库，有 error 时退出码为 1
  dsh-agent-roster list [选项]       列出档案与成员
  dsh-agent-roster registry validate --file <路径>   校验公共索引（registry）
  dsh-agent-roster registry fetch --file <路径>      逐条确认 collection 真的能取到
  dsh-agent-roster registry sync --file <路径>       按仓库实际内容重算 roster 列表
  dsh-agent-roster compile --roster <目录>            把 v2 组装编译成自包含产物（不写盘）
  dsh-agent-roster migrate --dir <目录> [--from <子目录>] [--repo <owner/repo>] [--write]
                                                      把 v1 档案原地迁成 v2（roles/ + rosters/ + dist/）
  dsh-agent-roster clone --repo <owner/repo> [--ref <分支>] [--path <子目录>] [--space <id>] [--dir <目录>]
                                                      把一个远端空间按原布局拉成本地副本（可编辑）
  dsh-agent-roster update --dir <空间目录> [--write] [--accept] [--json]
                                                      检查拉下来的空间有没有变（本地/远端/冲突六态）
  dsh-agent-roster import-agency --from <包目录|assets 目录> --dir <目标库> [--write] [--force]
                                                      把 @michengai/dsh-agency-agents 的专家素材转成一座 v2 库
  dsh-agent-roster --version         输出版本号

选项：
  --dir <path>              档案库目录，可重复；默认全局库 $DSH_HOME/agent-roster（~/.dsh/agent-roster）
  --known-policy <id>       部署已声明的 toolPolicy id，可重复；用于交叉校验
  --file <path>             registry 文件（registry 子命令用）
  --local-only              fetch 只验本仓库登记的 collection（CI 里用，不依赖外网）
  --write                   sync 把重算结果写回文件
  --roster <path>           v2 组装目录（compile 用）
  --from <path>             v1 档案所在目录（migrate 用；缺省与 --dir 相同，用于仓库根 + rosters/ 布局）
  --repo <owner/repo>       写进 dist 产物的仓库坐标（migrate 用）；clone 的源仓库
  --ref <branch|tag>        clone 的分支/tag（缺省 main）
  --path <subdir>           clone 的仓库内子目录（缺省仓库根）
  --space <id>              clone 落到本地后的空间 id（缺省取仓库名）
  --run <path>              执行回执（compile 用；把上一轮失败并入重试卡）
  --roles <path>            角色库目录（compile 用；缺省按 rosters/<id> 推同级的 roles/）
  --json                    以 JSON 输出（validate / list / compile 都支持）
  --force                   import-agency 覆盖目标库里已有的文件
  --help                    显示本帮助
`;

/** 极简参数解析：这个 CLI 不值得引入依赖。 */
function parseArgs(argv) {
  const options = {
    command: null,
    subcommand: null,
    dirs: [],
    knownPolicies: [],
    json: false,
    help: false,
    file: null,
    localOnly: false,
    write: false,
    roster: null,
    roles: null,
    run: null,
    from: null,
    ref: null,
    path: null,
    space: null,
    repo: null,
    force: false,
    forget: null,
    add: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--local-only") options.localOnly = true;
    else if (arg === "--write") options.write = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--add") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--add 需要一个绝对路径");
      options.add = value;
      index += 1;
    } else if (arg === "--forget") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--forget 需要一个绝对路径");
      options.forget = value;
      index += 1;
    }
    // 冲突之后"认账"：把当前本地内容接受为新基线。它是唯一能让 diverged 消失的动作，
    // 所以必须由人显式给，绝不在 --write 里顺手做。
    else if (arg === "--accept") options.accept = true;
    else if (arg === "--version" || arg === "-v") options.command = "version";
    else if (arg === "--dir") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--dir 需要一个路径");
      options.dirs.push(value);
      index += 1;
    } else if (arg === "--file") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--file 需要一个路径");
      options.file = value;
      index += 1;
    } else if (arg === "--roster") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--roster 需要一个路径");
      options.roster = value;
      index += 1;
    } else if (arg === "--from") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--from 需要一个路径");
      options.from = value;
      index += 1;
    } else if (arg === "--repo") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--repo 需要 owner/name");
      options.repo = value;
      index += 1;
    } else if (arg === "--run") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--run 需要一个路径");
      options.run = value;
      index += 1;
    } else if (arg === "--ref") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--ref 需要一个分支名");
      options.ref = value;
      index += 1;
    } else if (arg === "--path") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--path 需要一个相对目录");
      options.path = value;
      index += 1;
    } else if (arg === "--space") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--space 需要一个 id");
      options.space = value;
      index += 1;
    } else if (arg === "--roles") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--roles 需要一个路径");
      options.roles = value;
      index += 1;
    } else if (arg === "--known-policy") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--known-policy 需要一个 id");
      options.knownPolicies.push(value);
      index += 1;
    } else if (arg.startsWith("-")) throw new UsageError(`未知选项：${arg}`);
    else if (options.command === null) options.command = arg;
    else if (options.command === "registry" && options.subcommand === null) options.subcommand = arg;
    else throw new UsageError(`多余参数：${arg}`);
  }
  return options;
}

class UsageError extends Error {}

/** 把诊断折成一行；让终端输出和工具输出口径一致。 */
function formatDiagnostic(item) {
  const where = [item.file, item.path].filter(Boolean).join(" · ");
  return `  ${item.severity.toUpperCase()} ${item.code}${where === "" ? "" : ` (${where})`}: ${item.reason}`;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  if (options.help || options.command === null) {
    process.stdout.write(USAGE);
    return options.command === null && !options.help ? 2 : 0;
  }
  if (options.command === "version") {
    process.stdout.write(`${pkg.name} ${pkg.version}\n`);
    return 0;
  }
  if (options.command === "compile") return runCompile(options);
  if (options.command === "clone") return runClone(options);
  if (options.command === "update") return runUpdate(options);
  if (options.command === "import-agency") return runImportAgency(options);
  if (options.command === "libraries") return runLibraries(options);
  if (options.command === "migrate") return runMigrate(options);
  if (options.command === "registry") {
    if (options.file === null) {
      process.stderr.write(`registry 子命令需要 --file\n\n${USAGE}`);
      return 2;
    }
    if (options.subcommand !== "validate" && options.subcommand !== "fetch" && options.subcommand !== "sync") {
      process.stderr.write(`未知 registry 子命令：${String(options.subcommand)}\n\n${USAGE}`);
      return 2;
    }
    return runRegistry(options);
  }
  if (options.command !== "validate" && options.command !== "list") {
    process.stderr.write(`未知命令：${options.command}\n\n${USAGE}`);
    return 2;
  }

  const dirs = options.dirs.length > 0 ? options.dirs : [""];
  const knownToolPolicies = options.knownPolicies.length > 0 ? options.knownPolicies : null;
  const reports = dirs.map((dir) => {
    // 与插件同一条解析规则：留空 = 全局库，相对路径才相对当前目录。
    const rootDir = resolveDirSpec(dir, process.cwd());
    const scan = scanRosterLibrary({ rootDir, knownToolPolicies });
    return { dir, rootDir, scan };
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          plugin: pkg.name,
          version: pkg.version,
          reports: reports.map((report) => ({
            rootDir: report.rootDir,
            missing: report.scan.missing,
            stats: report.scan.stats,
            space: report.scan.space,
            spaceCheck: report.scan.spaceCheck,
            rosters: report.scan.rosters.map((roster) => ({ id: roster.id, file: roster.file })),
            diagnostics: report.scan.diagnostics,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const report of reports) {
      process.stdout.write(`${report.rootDir}\n`);
      if (options.command === "list") {
        process.stdout.write(`${renderRosterList(report.scan)}\n`);
      } else {
        const { stats } = report.scan;
        const space = report.scan.space ?? null;
        if (space !== null) {
          const check = report.scan.spaceCheck;
          process.stdout.write(
            `  空间 ${space.id}  ${space.title}（登记 ${check.declared} · 在库 ${check.present} · ` +
              `缺 ${check.missing.length} · 未登记 ${check.undeclared.length}）\n`,
          );
        }
        process.stdout.write(
          `  档案 ${stats.total}（通过 ${stats.ok}，失败 ${stats.failed}），成员 ${stats.members}，` +
            `诊断 ${stats.errors} error / ${stats.warnings} warn / ${stats.infos} info\n`,
        );
        for (const roster of report.scan.rosters) {
          process.stdout.write(`  OK   ${roster.id}  (${roster.file})  ${roster.members.length} 名成员\n`);
        }
        const diagnostics = report.scan.diagnostics;
        if (diagnostics.length > 0) {
          process.stdout.write("  诊断：\n");
          for (const item of diagnostics) process.stdout.write(`${formatDiagnostic(item)}\n`);
        }
      }
      process.stdout.write("\n");
    }
  }

  const hasError = reports.some((report) => report.scan.stats.errors > 0);
  return hasError ? 1 : 0;
}

/**
 * registry 三个子命令：validate / fetch / sync。
 *
 * 这三个动作就是“索引怎么更新”的答案：
 * - `validate` 在 PR 里跑，格式不对就不许合并；
 * - `fetch` 确认索引里写的每份档案真的存在（本仓库的走本地文件，其余走网络）；
 * - `sync` 用仓库实际内容重算 `rosters` 与 `generatedAt`，把人肉维护改成机器盖章。
 */
/**
 * 编译一份 v2 组装。
 *
 * 三条约定：
 * 1. 默认**不写盘**——编译是纯函数，`--write` 才落 `dist/`；
 * 2. 有 error 就是退出码 1，警告不影响；
 * 3. 产物是消费者唯一入口：桥接层与面板不需要再解析源文件。
 */
async function runCompile(options) {
  if (options.roster === null) {
    process.stderr.write(`compile 需要 --roster\n\n${USAGE}`);
    return 2;
  }
  const rosterDir = nodePath.resolve(process.cwd(), options.roster);
  const parent = nodePath.dirname(rosterDir);
  // 在 `<root>/rosters/<id>/` 里就不再替它猜角色目录：由 compileRosterAt 按
  // 「档案本地 roles/ → 共享 shared-roles/ → 旧名 roles/」自己发现。
  const underRosters = nodePath.basename(parent) === "rosters";
  const rolesDir =
    options.roles === null
      ? underRosters
        ? null
        : nodePath.join(parent, "roles")
      : nodePath.resolve(process.cwd(), options.roles);

  const result = compileRosterAt(rosterDir, {
    ...(rolesDir === null ? {} : { rolesDir }),
    knownToolPolicies: options.knownPolicies.length > 0 ? options.knownPolicies : null,
    source: { repo: options.repo ?? ownRepo(), ref: "main" },
  });

  const diagnostics = [...(result.diagnostics ?? [])];
  const planResult = result.compiled === null ? { plan: null, diagnostics: [] } : compilePlan(result.compiled);
  let plan = planResult.plan;
  diagnostics.push(...planResult.diagnostics);
  let feedback = [];
  if (options.run !== null) {
    const runPath = nodePath.resolve(process.cwd(), options.run);
    let runValue = null;
    try {
      runValue = JSON.parse(readFileSync(runPath, "utf8"));
    } catch (error) {
      diagnostics.push({ severity: "error", code: "run-unreadable", path: "", file: options.run, reason: `读不到执行回执：${error?.message ?? error}` });
    }
    if (runValue !== null) {
      const validation = validateRun(runValue, { file: options.run });
      diagnostics.push(...validation.diagnostics);
      if (validation.ok) {
        const merged = mergeRunIntoPlan(plan, validation.run);
        plan = merged.plan;
        feedback = merged.feedback;
      }
    }
  }
  const errors = diagnostics.filter((item) => item.severity === "error");

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          plugin: pkg.name,
          version: pkg.version,
          rolesDir,
          rosterDir,
          ok: result.ok,
          compiled: result.compiled,
          plan: plan === null ? null : planResult.plan,
          diagnostics,
        },
        null,
        2,
      )}\n`,
    );
    return errors.length > 0 ? 1 : 0;
  }

  if (!result.ok || result.compiled === null) {
    process.stderr.write(`编译失败：${nodePath.basename(rosterDir)}\n`);
    for (const item of diagnostics) process.stderr.write(`${formatDiagnostic(item)}\n`);
    return 1;
  }

  const compiled = result.compiled;
  const chars = compiled.members.reduce((sum, item) => sum + item.promptStats.chars, 0);
  process.stdout.write(
    `产物 ${compiled.source.roster}@${compiled.source.version}  成员 ${compiled.members.length}  ` +
      `人设合计 ${chars} 字符  声明 ${compiled.declarations.length} 项  targets ${compiled.targets.join(",") || "-"}\n`,
  );
  if (compiled.captain !== null) {
    process.stdout.write(`  队长 ${compiled.captain.role ?? "-"}  persona ${compiled.captain.personaChars} 字符\n`);
  }
  if (compiled.orchestration !== null) {
    process.stdout.write(
      `  编排 ${compiled.orchestration.shape ?? "-"}  stages ${compiled.orchestration.stages.length}  ` +
        `gates ${compiled.orchestration.gates.length}  status ${compiled.orchestration.status}\n`,
    );
  }
  if (plan !== null) {
    const gates = plan.tasks.filter((task) => task.kind === "gate").length;
    const loop = plan.loop.onGateFailure;
    process.stdout.write(
      `  施工图 ${plan.tasks.length} 张卡  门 ${gates}  executor ${plan.executor}  ` +
        `重试回到 ${loop.retry ?? "-"}（最多 ${loop.maxRounds} 轮）\n`,
    );
  }
  if (feedback.length > 0) {
    process.stdout.write(`  回执 上一轮失败 ${feedback.length} 张卡，已并入重试卡\n`);
  }
  for (const member of compiled.members) {
    process.stdout.write(
      `  ${member.name.padEnd(24)} ${member.role.padEnd(24)} ${String(member.promptStats.chars).padStart(5)} 字符  ` +
        `${member.promptStats.sha256.slice(0, 12)}\n`,
    );
  }
  for (const item of diagnostics) process.stdout.write(`${formatDiagnostic(item)}\n`);

  if (options.write) {
    const outDir = nodePath.join(root ?? parent, "dist");
    mkdirSync(outDir, { recursive: true });
    const outFile = nodePath.join(outDir, `${compiled.source.roster}-${compiled.source.version}.json`);
    writeFileSync(outFile, `${JSON.stringify(compiled, null, 2)}\n`);
    process.stdout.write(`  已写出 ${nodePath.relative(process.cwd(), outFile) || outFile}\n`);
    if (plan !== null) {
      const planFile = nodePath.join(outDir, `${compiled.source.roster}-${compiled.source.version}.tasks.json`);
      writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
      process.stdout.write(`  已写出 ${nodePath.relative(process.cwd(), planFile) || planFile}\n`);
    }
  }

  return 0;
}

async function runRegistry(options) {
  const file = nodePath.resolve(process.cwd(), options.file);
  const output = (text) => process.stdout.write(`${text}\n`);

  let report;
  try {
    report = readRegistryFile(file);
  } catch (error) {
    process.stderr.write(`读不了 ${file}：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const diagnostics = [...report.diagnostics];
  const registry = report.registry;
  const own = ownRepo();

  if (options.subcommand === "fetch" && registry !== null) {
    const repoRoot = nodePath.resolve(nodePath.dirname(file), "..");
    for (const collection of registry.collections) {
      if (isOwnCollection(collection, own)) {
        const scanned = scanRosterLibrary({ rootDir: nodePath.join(repoRoot, collection.path) });
        const present = new Set(scanned.rosters.map((roster) => roster.id));
        for (const id of collection.rosters) {
          if (!present.has(id)) {
            diagnostics.push({
              severity: "error",
              code: "collection-roster-missing",
              reason: `${collection.id} 登记了 ${id}，但 ${collection.path}/${id} 里没有合法档案`,
              file,
              path: collection.id,
            });
          }
        }
        for (const roster of scanned.rosters) {
          if (!collection.rosters.includes(roster.id)) {
            diagnostics.push({
              severity: "warn",
              code: "collection-roster-unlisted",
              reason: `${collection.path}/${roster.id} 存在但没登记（跑 registry sync 会补上）`,
              file,
              path: collection.id,
            });
          }
        }
        continue;
      }
      if (options.localOnly) {
        output(`跳过 ${collection.id}（不是本仓库登记，--local-only 下不联网）`);
        continue;
      }
      const fetched = await fetchCollection(collection);
      diagnostics.push(...fetched.diagnostics);
      if (fetched.rosters.length !== collection.rosters.length) {
        diagnostics.push({
          severity: "warn",
          code: "collection-fetch-partial",
          reason: `${collection.id} 登记 ${collection.rosters.length} 份，实际取到 ${fetched.rosters.length} 份`,
          file,
          path: collection.id,
        });
      }
      output(`${collection.id}: 取到 ${fetched.rosters.length}/${collection.rosters.length} 份`);
    }
  }

  if (options.subcommand === "sync" && registry !== null) {
    const repoRoot = nodePath.resolve(nodePath.dirname(file), "..");
    const document = JSON.parse(readFileSync(file, "utf8"));
    document.generatedAt = new Date().toISOString();
    document.kind = REGISTRY_KIND;
    let changed = false;
    for (const entry of document.collections ?? []) {
      const asCollection = registry.collections.find((item) => item.id === entry.id);
      if (asCollection === undefined || !isOwnCollection(asCollection, own)) continue;
      const scanned = scanRosterLibrary({ rootDir: nodePath.join(repoRoot, asCollection.path) });
      const ids = scanned.rosters.map((roster) => roster.id).sort();
      if (JSON.stringify(ids) !== JSON.stringify((entry.rosters ?? []).slice().sort())) {
        entry.rosters = ids;
        changed = true;
      }
      const files = {};
      for (const roster of scanned.rosters.slice().sort((a, b) => a.id.localeCompare(b.id))) {
        files[roster.id] =
          roster.format === "v2"
            ? `${DIST_DIR}/${roster.id}-${roster.version}.json`
            : `${roster.id}/${roster.file ?? "roster.yaml"}`;
      }
      if (JSON.stringify(files) !== JSON.stringify(entry.files ?? {})) {
        entry.files = files;
        changed = true;
      }
    }
    if (options.write) {
      writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
      output(`已写回 ${file}（${changed ? "roster 列表有更新" : "列表未变，只更新了 generatedAt"}）`);
    } else {
      output(`${changed ? "需要更新" : "无需更新"}：${file}（加 --write 才会落盘）`);
    }
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          plugin: pkg.name,
          version: pkg.version,
          file,
          subcommand: options.subcommand,
          collections: registry === null ? [] : registry.collections.map((item) => ({ id: item.id, rosters: item.rosters })),
          diagnostics,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    if (options.subcommand === "validate") {
      output(`${file}`);
      output(
        `  collection ${registry === null ? 0 : registry.collections.length} 条，` +
          `诊断 ${diagnostics.filter((item) => item.severity === "error").length} error / ` +
          `${diagnostics.filter((item) => item.severity === "warn").length} warn`,
      );
    }
    for (const item of diagnostics) output(formatDiagnostic(item));
  }

  return diagnostics.some((item) => item.severity === "error") ? 1 : 0;
}

/** 从 package.json 的 repository 推本仓库坐标（失败时用内置值）。 */
function ownRepo() {
  const url = typeof pkg.repository?.url === "string" ? pkg.repository.url : "";
  const match = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
  return match === null ? "stofone/dsh-agent-roster" : `${match[1]}/${match[2]}`.toLowerCase();
}

/** 这条 collection 是不是本仓库（CI 里可以走本地文件，不必联网）。 */
function isOwnCollection(collection, own) {
  return collection.repo.replace(/^github:/, "").toLowerCase() === own;
}

process.exitCode = await main(process.argv.slice(2));

/**
 * `migrate`：把一座 v1 档案库原地迁到 v2 布局。
 *
 * 默认只出计划（要写哪些文件、编译能不能过），`--write` 才真的落盘；这是唯一一个会删旧目录
 * 的命令，所以默认不动手。
 */
function runMigrate(options) {
  const dirs = options.dirs.length > 0 ? options.dirs : [""];
  const knownToolPolicies = options.knownPolicies.length > 0 ? options.knownPolicies : null;
  let rc = 0;
  const reports = [];
  for (const dir of dirs) {
    const rootDir = resolveDirSpec(dir, process.cwd());
    const fromDir = options.from === null ? rootDir : resolveDirSpec(options.from, process.cwd());
    const report = migrateLibrary(rootDir, {
      write: options.write,
      knownToolPolicies,
      source: { repo: options.repo ?? ownRepo(), ref: "main" },
      fromDir,
    });
    reports.push({ dir, rootDir, report });
    if (report.diagnostics.some((item) => item.severity === "error")) rc = 1;
    if (options.json) continue;
    process.stdout.write(`${options.write ? "迁移" : "迁移计划（未写盘）"}  ${rootDir}\n`);
    if (report.entries.length === 0) process.stdout.write("  没有找到 v1 档案（每个子目录里的 roster.yaml）\n");
    for (const entry of report.entries) {
      const extra = [entry.hasCaptain ? "含队长" : null, entry.capabilities ? "能力要求" : null].filter(Boolean).join(" · ");
      process.stdout.write(`  ${entry.id}@${entry.version}  成员 ${entry.memberCount}  文件 ${entry.files.length}${extra ? `  ${extra}` : ""}\n`);
      if (!options.write) {
        for (const file of entry.files) process.stdout.write(`    + ${file.path}\n`);
      }
    }
    if (options.write) {
      process.stdout.write(`  写入 ${report.written.length} 个文件，删除 ${report.removed.length} 个旧目录，编译 ${report.compiled.length} 份\n`);
    }
    for (const item of report.diagnostics) process.stdout.write(`  ${formatDiagnostic(item)}\n`);
  }
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          plugin: pkg.name,
          version: pkg.version,
          write: options.write,
          reports: reports.map((item) => ({
            dir: item.dir,
            rootDir: item.rootDir,
            write: item.report.write,
            entries: item.report.entries.map((entry) => ({
              id: entry.id,
              version: entry.version,
              from: entry.from,
              files: entry.files.map((file) => file.path),
              memberCount: entry.memberCount,
              hasCaptain: entry.hasCaptain,
              capabilities: entry.capabilities,
            })),
            written: item.report.written,
            removed: item.report.removed,
            compiled: item.report.compiled,
            diagnostics: item.report.diagnostics,
          })),
        },
        null,
        2,
      )}\n`,
    );
  }
  return rc;
}

/**
 * `clone`：把一个远端空间按原布局拉成本地副本。
 *
 * 落点默认是全局档案库根（`$DSH_HOME/agent-roster`），可以用 `--dir` 指到别处。
 * 目录里有同名空间时**不覆盖**——覆盖别人正在用的副本不该是顺手发生的事；
 * 要重来做 `rm -rf` 或换个 `--space` 名字。
 *
 * @param {object} options
 * @returns {Promise<number>}
 */
async function runUpdate(options) {
  const dir = options.dirs.length > 0 ? nodePath.resolve(options.dirs[0]) : null;
  if (dir === null) {
    process.stderr.write(`update 需要 --dir <空间目录>\n\n${USAGE}`);
    return 2;
  }
  const result = await checkOrigin(dir, { fetchImpl: fetch, refresh: true });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ plugin: pkg.name, version: pkg.version, dir, ...result, entries: (result.entries ?? []).map(({ remoteText, ...rest }) => rest) }, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.text}\n`);
  }
  if (!result.ok) return 1;
  if (options.accept === true) {
    // 只认 local-only：diverged 两边都改过，直接认账等于悄悄丢掉远端那一半。
    const locals = (result.entries ?? []).filter((entry) => entry.state === "local-only").map((entry) => entry.path);
    if (locals.length === 0) {
      process.stdout.write("没有可认账的本地改动（只认 local-only；冲突要先人看）\n");
      return 0;
    }
    const accepted = acceptLocal(dir, locals);
    process.stdout.write(`认账 ${accepted.updated.length} 个文件（本地内容成为新基线）\n`);
    for (const item of accepted.updated) process.stdout.write(`  基线 ${item}\n`);
    return accepted.ok ? 0 : 1;
  }
  if (options.write !== true) return 0;
  const applied = applyFastForward(dir, result.entries ?? []);
  process.stdout.write(
    `快进 ${applied.applied.length} 个文件${applied.skipped.length > 0 ? ` · 未动 ${applied.skipped.length}（冲突或本地改动）` : ""}\n`,
  );
  for (const item of applied.applied) process.stdout.write(`  写入 ${item}\n`);
  return applied.ok ? 0 : 1;
}

/**
 * 把 @michengai/dsh-agency-agents 的专家素材转成一座 v2 档案库。
 *
 * 默认只预览；--write 才落盘，目标库必须为空（或 --force 覆盖）。
 */
function runLibraries(options) {
  if (options.add !== null) {
    if (!existsSync(options.add)) {
      process.stderr.write(`没有这个目录：${options.add}\n`);
      return 1;
    }
    const result = rememberLibraryDir(options.add);
    if (!result.ok) {
      process.stderr.write(`登记失败：${result.code}\n`);
      return 1;
    }
    process.stdout.write(`${result.added ? "已登记" : "已在登记表里"}：${nodePath.resolve(options.add)}\n`);
    return 0;
  }
  if (options.forget !== null) {
    const ok = forgetLibraryDir(options.forget);
    if (!ok) {
      process.stderr.write(`没有忘掉 ${options.forget}：偏好文件写不进去\n`);
      return 1;
    }
    process.stdout.write(`已忘掉 ${nodePath.resolve(options.forget)}\n`);
    return 0;
  }
  const dirs = registeredLibraryDirs();
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ dirs }, null, 2)}\n`);
    return 0;
  }
  if (dirs.length === 0) {
    process.stdout.write("没有自动登记的库：面板与工具用 path= 用过一次之后才会记下来。\n");
    return 0;
  }
  process.stdout.write(`自动登记的库（${dirs.length}）：\n`);
  for (const dir of dirs) process.stdout.write(`- ${dir}${existsSync(dir) ? "" : "（已不存在）"}\n`);
  return 0;
}

function runImportAgency(options) {
  if (options.from === null) {
    process.stderr.write(`import-agency 需要 --from <包目录|assets 目录>\n\n${USAGE}`);
    return 2;
  }
  if (options.dirs.length === 0) {
    process.stderr.write(`import-agency 需要 --dir <目标库目录>\n\n${USAGE}`);
    return 2;
  }
  const dir = nodePath.resolve(options.dirs[0]);
  const found = findAgencyAssets(options.from);
  if (!found.ok) {
    process.stderr.write(`找不到专家素材：${found.code}\n`);
    return 1;
  }
  const { experts, diagnostics } = readAgencyExperts(found.dir);
  // 空间 id 必须等于目录名（位置即身份）：--space 只能用来确认，不能换个名字。
  const derivedSpace = nodePath.basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (options.space !== null && options.space !== derivedSpace) {
    process.stderr.write(`--space ${options.space} 与目录名 ${derivedSpace} 不一致；空间 id 必须等于目录名，请改目录名或去掉 --space。\n`);
    return 2;
  }
  const spaceId = derivedSpace;
  const plan = planAgencyLibrary(experts, { spaceId });
  const report = {
    source: found.dir,
    lang: found.lang,
    target: dir,
    space: spaceId,
    stats: plan.stats,
    skipped: plan.skipped,
    diagnostics: [...diagnostics, ...plan.diagnostics],
    write: options.write,
  };
  if (options.write) {
    const written = writeAgencyLibrary(dir, plan, { force: options.force });
    Object.assign(report, written);
    if (!written.ok) {
      process.stderr.write(`没有写入：${written.code}（目标库非空；确要覆盖请加 --force）\n`);
      return 1;
    }
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.write && report.written !== undefined ? 0 : report.write ? 1 : 0;
  }
  process.stdout.write(`来源：${found.dir}（${found.lang}）\n`);
  process.stdout.write(`计划：${plan.stats.experts} 位专家 → ${plan.stats.roles} 角色、${plan.stats.rosters} 份档案（跳过 ${plan.skipped}）\n`);
  for (const item of report.diagnostics.slice(0, 5)) process.stdout.write(`  ${item.code}: ${item.reason}\n`);
  if (!options.write) {
    process.stdout.write(`未写入。加 --write 落盘到 ${dir}（目标库需为空）。\n`);
    return 0;
  }
  process.stdout.write(`已写入 ${report.written.length} 个文件到 ${dir}；空间 ${spaceId}\n`);
  return 0;
}

async function runClone(options) {
  if (options.repo === null) {
    process.stderr.write(`clone 需要 --repo <owner/repo>\n\n${USAGE}`);
    return 2;
  }
  const rootDir = options.dirs.length > 0 ? nodePath.resolve(options.dirs[0]) : globalRosterRoot();
  const spaceId = options.space ?? options.repo.split("/")[1];
  const target = nodePath.join(rootDir, spaceId);
  if (existsSync(target) && options.write !== true) {
    process.stderr.write(
      `目标已存在：${target}\n` +
        "不覆盖已有副本（那可能正被使用）。要重来请先删掉它，或用 --space 换个名字。\n" +
        "确认要就地重写就加 --write（只重写本次拉到的文件）。\n",
    );
    return 1;
  }

  const result = await cloneSpace({
    rootDir,
    spaceId,
    repo: options.repo,
    ref: options.ref ?? "main",
    path: options.path ?? "",
    fetchImpl: fetch,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ plugin: pkg.name, version: pkg.version, rootDir, ...result }, null, 2)}\n`);
  } else {
    const where = options.path === null ? "" : `/${options.path}`;
    process.stdout.write(
      `空间 ${spaceId}  <-  ${options.repo}@${options.ref ?? "main"}${where}  布局 ${result.layout}  ` +
        `写入 ${result.written.length} 个文件${result.skipped.length > 0 ? ` · 跳过 ${result.skipped.length}` : ""}\n`,
    );
    process.stdout.write(`  落点 ${result.dir}\n`);
    for (const item of result.diagnostics) process.stdout.write(`${formatDiagnostic(item)}\n`);
    if (result.written.length > 0) {
      process.stdout.write(`  文件 ${result.written.slice(0, 8).join(" · ")}${result.written.length > 8 ? " …" : ""}\n`);
    }
  }
  return result.ok ? 0 : 1;
}
