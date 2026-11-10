/**
 * 把「运行时团队」和「档案」的差异算出来，并能把机械字段写回档案。
 *
 * 为什么只写机械字段：
 * - provider / model / reasoningEffort / toolPolicy 是**两者一一对应**的值，运行时记下什么就
 *   写回什么，语义不会变；
 * - 人设正文不是：运行时存的是**拼装后的结果**（正文 + parts + includes + 两端），写回角色
 *   文件会把结构压平、把片段并进正文。所以人设差异只报告、不落盘，由人改角色。
 *
 * 写回仍走既有的校验管线（`validateRoster`）与原子替换，写完重新编译 dist——
 * 否则面板/工具读到的是「新档案 + 旧产物」，比不写更糟。
 *
 * @module dsh-agent-roster/capture
 */
import fs from "node:fs";
import nodePath from "node:path";
import YAML from "yaml";

import { compileRosterAt } from "./compile2.js";
import { compilePlan } from "./plan.js";
import { diagnostic } from "./parse.js";
import { sha256Hex } from "./digest.js";
import { validateRoster } from "./validate.js";
import { validateRoster2 } from "./roster2.js";

/** 可机械写回的字段（人设不在其中，理由见模块注释）。 */
export const MECHANICAL_FIELDS = ["provider", "model", "reasoningEffort", "toolPolicy"];

const ROSTER_FILES = ["roster.yaml", "roster.yml", "roster.json"];

/** 找到档案目录里的档案文件。 */
export function rosterFileOf(rosterDir) {
  for (const name of ROSTER_FILES) {
    const file = nodePath.join(rosterDir, name);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // 继续找下一个名字
    }
  }
  return null;
}

function textOf(text) {
  return typeof text === "string" ? text : "";
}

function shortSha(value) {
  return typeof value === "string" ? value.slice(0, 8) : "";
}

/**
 * 比对一支团队与它声明的档案。
 *
 * @param {{ rosterDir: string, rootDir: string, id: string, team: object, knownToolPolicies?: string[] | null }} input
 */
export function captureTeam(input) {
  const { rosterDir, rootDir, id, team } = input;
  const compiled = compileRosterAt(rosterDir, {
    rolesDir: nodePath.join(rootDir, "roles"),
    libraryRoot: rootDir,
    expectedId: id,
    knownToolPolicies: input.knownToolPolicies ?? null,
  });
  if (!compiled.ok || compiled.compiled === null) {
    return { ok: false, code: "compile-failed", diagnostics: compiled.diagnostics ?? [], members: [] };
  }

  const declared = compiled.compiled.members;
  const runtime = Array.isArray(team?.members) ? team.members : [];
  const runtimeByName = new Map();
  for (const member of runtime) {
    if (typeof member.name === "string") runtimeByName.set(member.name, member);
  }

  const members = [];
  const seen = new Set();
  for (const member of declared) {
    seen.add(member.name);
    const actual = runtimeByName.get(member.name) ?? null;
    const fields = [];
    for (const field of ["role", "provider", "model", "reasoningEffort", "toolPolicy"]) {
      const wanted = field === "role" ? member.roleRef : member[field];
      const got = field === "role" ? actual?.role : actual?.[field];
      let status = "unknown";
      if (actual === null) status = "missing";
      else if (wanted === null || wanted === undefined || wanted === "") status = "undeclared";
      else if (textOf(got).trim() === "" ) status = "unknown";
      else status = String(got).trim() === String(wanted).trim() ? "match" : "differ";
      fields.push({ field, declared: wanted ?? null, runtime: got ?? null, status });
    }

    // 人设：运行时存的是拼装结果，所以只比哈希与字数，不写回。
    const runtimePrompt = textOf(actual?.executionPrompt);
    const persona = {
      declaredSha256: member.promptStats?.sha256 ?? null,
      runtimeSha256: runtimePrompt === "" ? null : sha256Hex(runtimePrompt),
      declaredChars: member.promptStats?.chars ?? 0,
      runtimeChars: runtimePrompt.length,
      status:
        actual === null || runtimePrompt === ""
          ? "unknown"
          : member.promptStats?.sha256 === sha256Hex(runtimePrompt)
            ? "match"
            : "differ",
    };

    members.push({ name: member.name, role: member.roleRef, status: actual === null ? "missing" : String(actual.status ?? "present"), fields, persona });
  }

  const undeclared = runtime.filter((member) => typeof member.name === "string" && !seen.has(member.name)).map((member) => member.name);
  const summary = { match: 0, differ: 0, unknown: 0 };
  for (const member of members) {
    for (const field of member.fields) {
      if (field.status === "differ") summary.differ += 1;
      else if (field.status === "match") summary.match += 1;
      else summary.unknown += 1;
    }
  }

  return {
    ok: true,
    roster: {
      id: compiled.compiled.source.roster,
      version: compiled.compiled.source.version,
      sha256: compiled.compiled.source.sha256 ?? null,
    },
    team: {
      id: team?.id ?? null,
      name: team?.name ?? null,
      captainSessionId: team?.captainSessionId ?? "",
      phase: team?.phase ?? null,
    },
    members,
    undeclared,
    summary,
    diagnostics: compiled.diagnostics ?? [],
  };
}

function bumpVersion(version) {
  const text = textOf(version).trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (match === null) return null;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/**
 * 把机械字段写回档案；版本号默认 +1（patch），写完重新编译。
 *
 * @param {{
 *   rosterDir: string, rootDir: string, id: string, members: object[],
 *   fields?: string[], knownToolPolicies?: string[] | null,
 * }} input
 */
export function applyCapture(input) {
  const { rosterDir, rootDir, id, members } = input;
  const allowed = Array.isArray(input.fields) && input.fields.length > 0
    ? input.fields.filter((field) => MECHANICAL_FIELDS.includes(field))
    : MECHANICAL_FIELDS.slice();
  const file = rosterFileOf(rosterDir);
  if (file === null) return { ok: false, code: "roster-file-missing", written: [], diagnostics: [] };
  if (allowed.length === 0) return { ok: false, code: "no-writable-fields", written: [], diagnostics: [] };

  const text = fs.readFileSync(file, "utf8");
  let doc;
  try {
    doc = YAML.parseDocument(text);
  } catch (error) {
    return { ok: false, code: "roster-unreadable", reason: String(error?.message ?? error), written: [], diagnostics: [] };
  }
  const body = doc.toJS() ?? {};
  const isV2 = body.kind === "dsh-agent-roster/roster@2";
  const written = [];
  const skipped = [];

  for (const member of members) {
    if (!member || typeof member.name !== "string") continue;
    const index = Array.isArray(body.members)
      ? body.members.findIndex((item) => item && (item.as ?? item.name) === member.name)
      : -1;
    if (index < 0) continue;
    const byField = new Map((member.fields ?? []).map((field) => [field.field, field]));
    // v2 的 route 里 provider 与 model 必须成对：只写一半会让整份档案非法。
    // 所以任一者不同时，把两端一起按运行时的值补齐；补齐不了就整体跳过并如实记 code。
    if (isV2) {
      const provider = byField.get("provider");
      const model = byField.get("model");
      const routeDiffers =
        (provider !== undefined && provider.status === "differ" && allowed.includes("provider")) ||
        (model !== undefined && model.status === "differ" && allowed.includes("model"));
      if (routeDiffers) {
        const runtimeProvider = textOf(provider?.runtime).trim();
        const runtimeModel = textOf(model?.runtime).trim();
        if (runtimeProvider === "" || runtimeModel === "") {
          skipped.push({ name: member.name, field: "route", reason: "capture-route-incomplete" });
        } else {
          doc.setIn(["members", index, "route", "provider"], runtimeProvider);
          doc.setIn(["members", index, "route", "model"], runtimeModel);
          if (provider?.status === "differ" && allowed.includes("provider")) {
            written.push({ name: member.name, field: "provider", value: runtimeProvider });
          }
          if (model?.status === "differ" && allowed.includes("model")) {
            written.push({ name: member.name, field: "model", value: runtimeModel });
          }
        }
      }
      for (const field of member.fields ?? []) {
        if (field.field === "provider" || field.field === "model") continue;
        if (!allowed.includes(field.field)) continue;
        if (field.status !== "differ") continue;
        if (field.runtime === null || field.runtime === undefined || String(field.runtime).trim() === "") continue;
        doc.setIn(["members", index, "route", field.field], String(field.runtime));
        written.push({ name: member.name, field: field.field, value: String(field.runtime) });
      }
      continue;
    }
    for (const field of member.fields ?? []) {
      if (!allowed.includes(field.field)) continue;
      if (field.status !== "differ") continue;
      if (field.runtime === null || field.runtime === undefined || String(field.runtime).trim() === "") continue;
      doc.setIn(["members", index, field.field], String(field.runtime));
      written.push({ name: member.name, field: field.field, value: String(field.runtime) });
    }
  }

  if (written.length === 0) {
    return { ok: true, code: "nothing-to-write", version: body.version ?? null, written: [], diagnostics: [] };
  }

  const nextVersion = bumpVersion(body.version);
  if (nextVersion === null) {
    return { ok: false, code: "invalid-version", written: [], diagnostics: [] };
  }
  doc.setIn(["version"], nextVersion);

  const nextBody = doc.toJS();
  const checked = isV2
    ? validateRoster2(nextBody, { file, expectedId: id, knownToolPolicies: input.knownToolPolicies ?? null })
    : validateRoster(nextBody, { file, expectedId: id, knownToolPolicies: input.knownToolPolicies ?? null });
  const errors = checked.diagnostics.filter((item) => item.severity === "error");
  if (!checked.ok || errors.length > 0) {
    return { ok: false, code: "capture-invalid", written: [], diagnostics: checked.diagnostics };
  }

  const output = file.endsWith(".json") ? `${JSON.stringify(nextBody, null, 2)}\n` : doc.toString();
  const temporary = `${file}.capture-${process.pid}.tmp`;
  fs.writeFileSync(temporary, output, "utf8");
  fs.renameSync(temporary, file);

  const diagnostics = [];
  let dist = null;
  let plan = null;
  if (isV2) {
    const compiled = compileRosterAt(rosterDir, {
      rolesDir: nodePath.join(rootDir, "roles"),
      libraryRoot: rootDir,
      expectedId: id,
      knownToolPolicies: input.knownToolPolicies ?? null,
    });
    if (!compiled.ok || compiled.compiled === null) {
      diagnostics.push(diagnostic("error", "capture-compile-failed", "", "写回后编译失败，产物未更新", file));
    } else {
      const outDir = nodePath.join(rootDir, "dist");
      fs.mkdirSync(outDir, { recursive: true });
      dist = nodePath.join(outDir, `${compiled.compiled.source.roster}-${compiled.compiled.source.version}.json`);
      fs.writeFileSync(dist, `${JSON.stringify(compiled.compiled, null, 2)}\n`, "utf8");
      const built = compilePlan(compiled.compiled);
      if (built.plan !== null) {
        plan = nodePath.join(outDir, `${compiled.compiled.source.roster}-${compiled.compiled.source.version}.tasks.json`);
        fs.writeFileSync(plan, `${JSON.stringify(built.plan, null, 2)}\n`, "utf8");
      }
    }
  }

  return { ok: true, code: "captured", version: nextVersion, written, dist, plan, diagnostics };
}

export { shortSha };
