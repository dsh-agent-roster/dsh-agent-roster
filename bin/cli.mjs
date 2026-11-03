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
 *   dsh-agent-roster compile --roster rosters/money-lab [--roles roles] [--write] [--json]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import { resolveDirSpec } from "../lib/home.js";
import { scanRosterLibrary } from "../lib/registry.js";
import { renderRosterList } from "../lib/render.js";
import { REGISTRY_KIND } from "../lib/format.js";
import { fetchCollection, readRegistryFile } from "../lib/remote.js";
import { compileRosterAt } from "../lib/compile2.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const USAGE = `用法：
  dsh-agent-roster validate [选项]   校验一座档案库，有 error 时退出码为 1
  dsh-agent-roster list [选项]       列出档案与成员
  dsh-agent-roster registry validate --file <路径>   校验公共索引（registry）
  dsh-agent-roster registry fetch --file <路径>      逐条确认 collection 真的能取到
  dsh-agent-roster registry sync --file <路径>       按仓库实际内容重算 roster 列表
  dsh-agent-roster compile --roster <目录>            把 v2 组装编译成自包含产物（不写盘）
  dsh-agent-roster --version         输出版本号

选项：
  --dir <path>              档案库目录，可重复；默认全局库 $DSH_HOME/agent-roster（~/.dsh/agent-roster）
  --known-policy <id>       部署已声明的 toolPolicy id，可重复；用于交叉校验
  --file <path>             registry 文件（registry 子命令用）
  --local-only              fetch 只验本仓库登记的 collection（CI 里用，不依赖外网）
  --write                   sync 把重算结果写回文件
  --roster <path>           v2 组装目录（compile 用）
  --roles <path>            角色库目录（compile 用；缺省按 rosters/<id> 推同级的 roles/）
  --json                    以 JSON 输出（validate / list / compile 都支持）
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
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--local-only") options.localOnly = true;
    else if (arg === "--write") options.write = true;
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
            organization: report.scan.organization,
            organizationCheck: report.scan.organizationCheck,
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
        const organization = report.scan.organization ?? null;
        if (organization !== null) {
          const check = report.scan.organizationCheck;
          process.stdout.write(
            `  组织 ${organization.id}  ${organization.title}（登记 ${check.declared} · 在库 ${check.present} · ` +
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
  const root = options.roles === null && nodePath.basename(parent) === "rosters" ? nodePath.dirname(parent) : null;
  const rolesDir =
    options.roles === null
      ? root === null
        ? nodePath.join(parent, "roles")
        : nodePath.join(root, "roles")
      : nodePath.resolve(process.cwd(), options.roles);

  const result = compileRosterAt(rosterDir, {
    rolesDir,
    knownToolPolicies: options.knownPolicies.length > 0 ? options.knownPolicies : null,
    source: { repo: ownRepo(), ref: "main" },
  });

  const diagnostics = result.diagnostics ?? [];
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
