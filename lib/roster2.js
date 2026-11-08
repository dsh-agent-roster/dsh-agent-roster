/**
 * 组装（roster@2）层：只描述「谁、按什么顺序、走什么流程」，不装人设。
 *
 * 一份 roster 是物料清单：成员是对角色的**引用**（`role: name@version`），只能覆盖少量
 * 桥接字段、只能 prepend/append 正文片段，**不能重排或替换角色内部片段**——
 * 想改行为就改角色版本，那是唯一入口。
 *
 * 与 v1 的关键差别：身份来自文档（v1 靠目录名），队长不是成员（v1 允许 `lead` 双写），
 * 编排是一等公民（v1 完全没有这一层）。
 *
 * @module dsh-agent-roster/roster2
 */
import {
  CAPTAIN2_FIELDS,
  DEFAULT_ON_MISSING,
  DEFAULTS2_FIELDS,
  GATE_FIELDS,
  VERIFY_FIELDS,
  LIMITS2,
  MEMBER2_FIELDS,
  MEMBER_PROMPT_FIELDS,
  ONFAIL_FIELDS,
  ON_MISSING,
  ORCHESTRATION_FIELDS,
  ORCHESTRATION_SHAPES,
  PATTERNS2,
  REQUIRES_FIELDS,
  ROLE_REF,
  ROSTER2_FIELDS,
  ROSTER2_KIND,
  ROSTER2_REQUIRED,
  ROUTE_FIELDS,
  STAGE_FIELDS,
  TARGETS,
  TOOL_SCOPE_FIELDS,
  TOOLS_FIELDS,
} from "./format-v2.js";
import { PATTERNS, REASONING_EFFORTS } from "./format.js";
import { diagnostic } from "./parse.js";
import { isSafeRelative } from "./role.js";

/**
 * 校验 roster@2 的结构（纯函数、零 IO；不检查角色是否真实存在）。
 *
 * @param {unknown} value
 * @param {{ file?: string, knownToolPolicies?: string[] | null, expectedId?: string | null }} [options]
 * @returns {{ ok: boolean, roster: object | null, diagnostics: object[] }}
 */
export function validateRoster2(value, options = {}) {
  const file = String(options.file ?? "");
  const expectedId = typeof options.expectedId === "string" ? options.expectedId : null;
  const knownToolPolicies = Array.isArray(options.knownToolPolicies) ? options.knownToolPolicies : null;
  const diagnostics = [];
  const report = (severity, code, path, reason) => diagnostics.push(diagnostic(severity, code, path, reason, file));

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("error", "document-not-mapping", "", "文档顶层必须是映射（对象）");
    return { ok: false, roster: null, diagnostics };
  }

  for (const key of Object.keys(value)) {
    if (!ROSTER2_FIELDS.includes(key)) {
      report("error", "unknown-field", key, `未知字段 ${key}；允许的字段见 schema/roster.v2.schema.json`);
    }
  }
  for (const key of ROSTER2_REQUIRED) {
    if (value[key] === undefined) report("error", "missing-field", key, `缺少必填字段 ${key}`);
  }

  if (value.kind !== ROSTER2_KIND) {
    report("error", "invalid-kind", "kind", `kind 必须是 "${ROSTER2_KIND}"，实际是 ${describe(value.kind)}`);
  }

  const id = text(value.id, "id", LIMITS2.roleNameChars, report);
  if (id !== null && !PATTERNS2.id.test(id)) {
    report("error", "invalid-id", "id", `id 必须是 kebab-case 的 2~64 字符：${id}`);
  }
  if (id !== null && expectedId !== null && id !== expectedId) {
    // v2 不再要求目录名等于 id（身份来自文档），但仍把不一致作为 info 报出来：
    // 它不影响正确性，只影响人类找文件的效率。
    report("info", "id-directory-differs", "id", `文档 id（${id}）与目录名（${expectedId}）不同；v2 允许，但建议一致`);
  }

  const version = text(value.version, "version", 64, report);
  if (version !== null && !PATTERNS2.semver.test(version)) {
    report("error", "invalid-semver", "version", `version 必须是精确 SemVer：${version}`);
  }

  const title = text(value.title, "title", LIMITS2.titleChars, report);
  const description = text(value.description, "description", LIMITS2.descriptionChars, report);
  const license = text(value.license, "license", LIMITS2.titleChars, report);
  const notes = text(value.notes, "notes", LIMITS2.notesChars, report);
  const maintainers = list(value.maintainers, "maintainers", LIMITS2.maintainers, PATTERNS2.handle, report);
  const tags = list(value.tags, "tags", LIMITS2.tagsPerRole, PATTERNS2.tag, report);

  const defaults = validateDefaults(value.defaults, report);
  const targets = validateTargets(value.targets, report);
  const requires = validateRequires(value.requires, "requires", report);

  let onMissing = DEFAULT_ON_MISSING;
  if (value.onMissing !== undefined) {
    if (!ON_MISSING.includes(value.onMissing)) report("error", "invalid-on-missing", "onMissing", `onMissing 只能是 ${ON_MISSING.join(" / ")}`);
    else onMissing = value.onMissing;
  }

  const members = validateMembers(value.members, defaults, knownToolPolicies, report);
  const captain = validateCaptain(value.captain, knownToolPolicies, report);
  const orchestration = validateOrchestration(value.orchestration, members, report);

  if (diagnostics.some((item) => item.severity === "error")) {
    return { ok: false, roster: null, diagnostics };
  }

  return {
    ok: true,
    roster: {
      kind: ROSTER2_KIND,
      id,
      version,
      title,
      description,
      license,
      notes,
      maintainers,
      tags,
      defaults,
      targets,
      members,
      captain,
      orchestration,
      requires,
      onMissing,
    },
    diagnostics,
  };
}

function validateDefaults(value, report) {
  const defaults = { route: {}, tools: {} };
  if (value === undefined) return defaults;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("error", "invalid-field", "defaults", "defaults 必须是映射");
    return defaults;
  }
  for (const key of Object.keys(value)) {
    if (!DEFAULTS2_FIELDS.includes(key)) report("error", "unknown-field", `defaults.${key}`, `未知字段 defaults.${key}`);
  }
  defaults.route = route(value.route, "defaults.route", report) ?? {};
  defaults.tools = tools(value.tools, "defaults.tools", null, report) ?? {};
  return defaults;
}

function validateTargets(value, report) {
  if (value === undefined) return ["agent-teams/members"];
  if (!Array.isArray(value) || value.length === 0) {
    report("error", "invalid-targets", "targets", "targets 必须是非空数组（至少声明一个编译目标）");
    return [];
  }
  const out = [];
  value.forEach((item, index) => {
    if (!TARGETS.includes(item)) {
      report("error", "invalid-target", `targets[${index}]`, `未知编译目标 ${describe(item)}；允许：${TARGETS.join(", ")}`);
      return;
    }
    out.push(item);
  });
  if (new Set(out).size !== out.length) report("error", "duplicate-target", "targets", "编译目标重复");
  return out;
}

function validateMembers(value, defaults, knownToolPolicies, report) {
  if (!Array.isArray(value) || value.length === 0) {
    report("error", "missing-field", "members", "members 必须是非空数组");
    return [];
  }
  if (value.length > LIMITS2.members) report("error", "too-many-members", "members", `members 最多 ${LIMITS2.members} 个`);
  const out = [];
  const seen = new Set();
  value.forEach((raw, index) => {
    const path = `members[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      report("error", "invalid-member", path, "成员必须是映射");
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!MEMBER2_FIELDS.includes(key)) report("error", "unknown-field", `${path}.${key}`, `未知字段 ${path}.${key}`);
    }
    const as = text(raw.as, `${path}.as`, LIMITS2.roleNameChars, report);
    if (as !== null && !PATTERNS2.id.test(as)) report("error", "invalid-member-name", `${path}.as`, `as 必须是 kebab-case：${as}`);
    if (as !== null) {
      if (seen.has(as)) report("error", "duplicate-member", `${path}.as`, `成员名重复：${as}`);
      seen.add(as);
    }
    const roleRef = ref(raw.role, `${path}.role`, report);

    const ownRoute = mergeRoute(defaults.route, route(raw.route, `${path}.route`, report) ?? {});
    const ownTools = mergeTools(defaults.tools, tools(raw.tools, `${path}.tools`, knownToolPolicies, report) ?? {});
    // tools.scope 是**声明**，不是权限开关：它不在 bridge 的 CARRIED_FIELDS 里，
    // 永远不会传给 agent_teams_add_member。但沉默也是骗人——这里明说它只用于校验与展示。
    if (raw.tools !== undefined && raw.tools !== null && typeof raw.tools === "object" && raw.tools.scope !== undefined) {
      report(
        "info",
        "scope-declaration-only",
        `${path}.tools.scope`,
        "scope 只用于声明与校验，不会传给运行时，也不改变成员实际可用的工具；运行时权限来自部署的 toolPolicy",
      );
    }

    let prompt = { prepend: null, append: null };
    if (raw.prompt !== undefined) {
      if (raw.prompt === null || typeof raw.prompt !== "object" || Array.isArray(raw.prompt)) {
        report("error", "invalid-field", `${path}.prompt`, "members[].prompt 必须是映射");
      } else {
        for (const key of Object.keys(raw.prompt)) {
          if (!MEMBER_PROMPT_FIELDS.includes(key)) {
            report("error", "unknown-field", `${path}.prompt.${key}`, `未知字段 ${path}.prompt.${key}；只能 prepend / append`);
          }
        }
        for (const key of MEMBER_PROMPT_FIELDS) {
          const item = raw.prompt[key];
          if (item === undefined) continue;
          if (typeof item !== "string" || !isSafeRelative(item)) {
            report("error", "unsafe-path", `${path}.prompt.${key}`, `${key} 必须是角色/组装目录内的相对路径：${describe(item)}`);
            continue;
          }
          prompt[key] = item;
        }
      }
    }

    const memberRequires = validateRequires(raw.requires, `${path}.requires`, report);
    const memberNotes = text(raw.notes, `${path}.notes`, LIMITS2.notesChars, report);

    out.push({ as, role: roleRef, route: ownRoute, tools: ownTools, prompt, requires: memberRequires, notes: memberNotes });
  });
  return out;
}

function validateCaptain(value, knownToolPolicies, report) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("error", "invalid-field", "captain", "captain 必须是映射");
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!CAPTAIN2_FIELDS.includes(key)) report("error", "unknown-field", `captain.${key}`, `未知字段 captain.${key}`);
  }
  const roleRef = value.role === undefined ? null : ref(value.role, "captain.role", report);
  const routeFields = route(value.route, "captain.route", report) ?? {};
  const policyOverride = tools(value.tools, "captain.tools", knownToolPolicies, report);
  let persona = null;
  if (value.persona !== undefined) {
    if (typeof value.persona !== "string" || !isSafeRelative(value.persona)) {
      report("error", "unsafe-path", "captain.persona", `persona 必须是组装目录内的相对路径：${describe(value.persona)}`);
    } else {
      persona = value.persona;
    }
  }
  return { role: roleRef, route: routeFields, tools: policyOverride ?? {}, persona, notes: text(value.notes, "captain.notes", LIMITS2.notesChars, report) };
}

function validateOrchestration(value, members, report) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("error", "invalid-field", "orchestration", "orchestration 必须是映射");
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!ORCHESTRATION_FIELDS.includes(key)) report("error", "unknown-field", `orchestration.${key}`, `未知字段 orchestration.${key}`);
  }
  let shape = null;
  if (value.shape !== undefined) {
    if (!ORCHESTRATION_SHAPES.includes(value.shape)) {
      report("error", "invalid-shape", "orchestration.shape", `shape 只能是 ${ORCHESTRATION_SHAPES.join(" / ")}`);
    } else {
      shape = value.shape;
    }
  }
  const aliases = new Set(members.map((member) => member.as).filter(Boolean));
  const stageIds = new Set();
  const stages = [];
  if (value.stages !== undefined) {
    if (!Array.isArray(value.stages) || value.stages.length > LIMITS2.stages) {
      report("error", "invalid-stages", "orchestration.stages", `stages 必须是数组（最多 ${LIMITS2.stages} 个）`);
    } else {
      value.stages.forEach((raw, index) => {
        const path = `orchestration.stages[${index}]`;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          report("error", "invalid-stage", path, "阶段必须是映射");
          return;
        }
        for (const key of Object.keys(raw)) {
          if (!STAGE_FIELDS.includes(key)) report("error", "unknown-field", `${path}.${key}`, `未知字段 ${path}.${key}`);
        }
        const id = text(raw.id, `${path}.id`, LIMITS2.roleNameChars, report);
        if (id !== null) {
          if (stageIds.has(id)) report("error", "duplicate-stage", `${path}.id`, `阶段 id 重复：${id}`);
          stageIds.add(id);
        }
        const parallel = nameList(raw.parallel, `${path}.parallel`, aliases, report);
        const serial = nameList(raw.serial, `${path}.serial`, aliases, report);
        if (parallel.length > 0 && serial.length > 0) {
          report("error", "stage-conflict", path, "一个阶段不能同时是 parallel 与 serial");
        }
        let maxRounds = 1;
        if (raw.maxRounds !== undefined) {
          if (!Number.isInteger(raw.maxRounds) || raw.maxRounds < 1 || raw.maxRounds > LIMITS2.maxRounds) {
            report("error", "invalid-max-rounds", `${path}.maxRounds`, `maxRounds 必须是 1~${LIMITS2.maxRounds} 的整数`);
          } else {
            maxRounds = raw.maxRounds;
          }
        }
        stages.push({
          id,
          parallel,
          serial,
          join: text(raw.join, `${path}.join`, LIMITS2.roleNameChars, report),
          on: text(raw.on, `${path}.on`, LIMITS2.roleChars, report),
          role: raw.role === undefined ? null : ref(raw.role, `${path}.role`, report),
          maxRounds,
        });
      });
    }
  }
  const gates = [];
  if (value.gates !== undefined) {
    if (!Array.isArray(value.gates) || value.gates.length > LIMITS2.gates) {
      report("error", "invalid-gates", "orchestration.gates", `gates 必须是数组（最多 ${LIMITS2.gates} 个）`);
    } else {
      value.gates.forEach((raw, index) => {
        const path = `orchestration.gates[${index}]`;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          report("error", "invalid-gate", path, "门必须是映射");
          return;
        }
        for (const key of Object.keys(raw)) {
          if (!GATE_FIELDS.includes(key)) report("error", "unknown-field", `${path}.${key}`, `未知字段 ${path}.${key}`);
        }
        const id = text(raw.id, `${path}.id`, LIMITS2.roleNameChars, report);
        const after = stringArray(raw.after, `${path}.after`, LIMITS2.stages, report);
        for (const stageId of after) {
          if (!stageIds.has(stageId)) {
            report("error", "unknown-stage", `${path}.after`, `门等待了不存在的阶段：${stageId}`);
          }
        }
        // 判据是句子，不是引用：只钉条数与长度，不假装能验它的内容。
        const requiresList = stringArray(raw.requires, `${path}.requires`, 16, report, LIMITS2.gateCriterionChars);
        const verifyList = gateVerify(raw.verify, `${path}.verify`, report);
        if (verifyList.length === 0) {
          report(
            "error",
            "gate-unverifiable",
            `${path}.verify`,
            "门没有任何可执行判据：它只能自己给自己盖章。至少写一条 verify（跑什么命令、期望退出码）",
          );
        }
        const by = text(raw.by, `${path}.by`, LIMITS2.roleNameChars, report);
        if (by !== null && !aliases.has(by)) {
          report("error", "unknown-member", `${path}.by`, `门由不存在的成员判定：${by}`);
        }
        // 失败回边：门没过时回到哪个阶段、最多重试几轮。
        // 只声明「回到哪、几轮」，不假装能描述修复动作；上限是必需的，
        // 否则一次失败可以无限重跑，而人只在第一次失败时看得见。
        let onFail = null;
        if (raw.onFail !== undefined) {
          if (raw.onFail === null || typeof raw.onFail !== "object" || Array.isArray(raw.onFail)) {
            report("error", "invalid-onfail", `${path}.onFail`, "onFail 必须是映射 {to, maxRounds}");
          } else {
            for (const key of Object.keys(raw.onFail)) {
              if (!ONFAIL_FIELDS.includes(key)) {
                report("error", "unknown-field", `${path}.onFail.${key}`, `未知字段 ${path}.onFail.${key}`);
              }
            }
            const to = text(raw.onFail.to, `${path}.onFail.to`, LIMITS2.roleNameChars, report);
            if (to !== null) {
              if (!stageIds.has(to)) {
                report("error", "onfail-unknown-stage", `${path}.onFail.to`, `重试目标必须是已声明的阶段：${to}`);
              } else if (after.includes(to)) {
                report(
                  "error",
                  "onfail-immediate",
                  `${path}.onFail.to`,
                  `重试目标不能是本门 after 里的阶段（${to}）：失败后原地重来，没有修复动作`,
                );
              }
            }
            const rounds = raw.onFail.maxRounds;
            if (!Number.isInteger(rounds) || rounds < 1 || rounds > LIMITS2.maxRounds) {
              report(
                "error",
                "onfail-unbounded",
                `${path}.onFail.maxRounds`,
                `onFail.maxRounds 必须是 1~${LIMITS2.maxRounds} 的整数：没有上限的重试等于死循环`,
              );
            } else if (to !== null) {
              onFail = { to, maxRounds: rounds };
            }
          }
        }
        gates.push({ id, after, requires: requiresList, verify: verifyList, by, onFail });
      });
    }
  }
  if (shape !== null && stages.length === 0) {
    report("error", "empty-orchestration", "orchestration", "声明了 shape 就必须至少有一个 stage");
  }
  // 失败回边的闭合与上限：门把控制权交回某个阶段，那个阶段必须被别的门接住，
  // 否则修复完再也不会回到任何一个门——这条回边没有出口。
  const covered = new Set(gates.flatMap((gate) => gate.after));
  gates.forEach((gate, index) => {
    if (gate.onFail === null) return;
    if (!covered.has(gate.onFail.to)) {
      report(
        "error",
        "onfail-dangling",
        `orchestration.gates[${index}].onFail.to`,
        `重试目标 ${gate.onFail.to} 没有被任何门覆盖：修复后回不到任何一个门，这次重试没有出口`,
      );
    }
  });
  // after 只声明先后，本身不构成可判定的环；可判定的环必须经过 onFail。
  // 每个这样的环都要有上限，否则「修不好就一直修」没有任何停机条件。
  for (const cycle of findRetryCycles(gates)) {
    const rounds = cycle.reduce((product, edge) => product * edge.maxRounds, 1);
    if (rounds > LIMITS2.maxRounds) {
      report(
        "error",
        "onfail-unbounded",
        `orchestration.gates[${cycle[0].from}].onFail`,
        `重试环的轮数乘积是 ${rounds}，超过上限 ${LIMITS2.maxRounds}：把某一处 maxRounds 调小，或把环拆开`,
      );
    }
  }
  return shape === null && stages.length === 0 && gates.length === 0 ? null : { shape, stages, gates };
}

/**
 * 找门与门之间的重试环：A.onFail.to 落在 B.after 里，就是 A 失败后经 B 再回到 A。
 *
 * @param {Array<{after: string[], onFail: object | null}>} gates
 * @returns {Array<Array<{from: number, maxRounds: number}>>}
 */
function findRetryCycles(gates) {
  const edges = gates.map((gate) =>
    gate.onFail === null
      ? []
      : gates.flatMap((candidate, index) => (candidate.after.includes(gate.onFail.to) ? [index] : [])),
  );
  const cycles = [];
  const seen = new Set();
  const walk = (node, path) => {
    for (const next of edges[node] ?? []) {
      const at = path.indexOf(next);
      if (at !== -1) {
        const ids = path.slice(at);
        const key = [...ids].sort((a, b) => a - b).join(",");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(ids.map((from) => ({ from, maxRounds: gates[from].onFail?.maxRounds ?? 1 })));
        }
        continue;
      }
      if (path.includes(next)) continue;
      walk(next, [...path, next]);
    }
  };
  gates.forEach((_, index) => walk(index, [index]));
  return cycles;
}

function nameList(value, path, aliases, report) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMITS2.members) {
    report("error", "invalid-field", path, `${path} 必须是成员名数组`);
    return [];
  }
  const out = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || !PATTERNS2.id.test(item)) {
      report("error", "invalid-item", `${path}[${index}]`, `${path}[${index}] 必须是成员名`);
      return;
    }
    if (!aliases.has(item)) report("error", "unknown-member", `${path}[${index}]`, `阶段引用了不存在的成员：${item}`);
    out.push(item);
  });
  return out;
}

function validateRequires(value, path, report) {
  if (value === undefined) return { skills: [], toolPolicies: [] };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("error", "invalid-field", path, "requires 必须是映射");
    return { skills: [], toolPolicies: [] };
  }
  for (const key of Object.keys(value)) {
    if (!REQUIRES_FIELDS.includes(key)) report("error", "unknown-field", `${path}.${key}`, `未知要求 ${path}.${key}：只有有证据源的要求才能被声明`);
  }
  return {
    skills: list(value.skills, `${path}.skills`, LIMITS2.skillsPerRole, PATTERNS2.skill, report),
    toolPolicies: list(value.toolPolicies, `${path}.toolPolicies`, 16, PATTERNS2.id, report),
  };
}

function route(value, path, report) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("error", "invalid-field", path, "route 必须是映射");
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!ROUTE_FIELDS.includes(key)) report("error", "unknown-field", `${path}.${key}`, `未知字段 ${path}.${key}`);
  }
  const out = {};
  if (value.provider !== undefined) {
    if (typeof value.provider !== "string" || !PATTERNS2.provider.test(value.provider)) report("error", "invalid-provider", `${path}.provider`, `provider 形态不合法：${describe(value.provider)}`);
    else out.provider = value.provider;
  }
  if (value.model !== undefined) {
    if (typeof value.model !== "string" || !PATTERNS2.model.test(value.model)) report("error", "invalid-model", `${path}.model`, `model 形态不合法：${describe(value.model)}`);
    else out.model = value.model;
  }
  if (value.reasoningEffort !== undefined) {
    if (!REASONING_EFFORTS.includes(value.reasoningEffort)) report("error", "invalid-effort", `${path}.reasoningEffort`, `reasoningEffort 只能是 ${REASONING_EFFORTS.join(" / ")}`);
    else out.reasoningEffort = value.reasoningEffort;
  }
  if ((out.provider === undefined) !== (out.model === undefined)) {
    report("error", "incomplete-route", path, "provider 与 model 必须成对出现");
  }
  return out;
}

function tools(value, path, knownToolPolicies, report) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("error", "invalid-field", path, "tools 必须是映射");
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!TOOLS_FIELDS.includes(key)) report("error", "unknown-field", `${path}.${key}`, `未知字段 ${path}.${key}`);
  }
  const out = {};
  if (value.policy !== undefined) {
    if (typeof value.policy !== "string" || !PATTERNS2.id.test(value.policy)) {
      report("error", "invalid-tool-policy", `${path}.policy`, `policy 必须是 kebab-case：${describe(value.policy)}`);
    } else if (knownToolPolicies !== null && knownToolPolicies.length > 0 && !knownToolPolicies.includes(value.policy)) {
      report("error", "unknown-tool-policy", `${path}.policy`, `部署没有声明工具策略 ${value.policy}；已知：${knownToolPolicies.join(", ")}`);
    } else {
      out.policy = value.policy;
    }
  }
  if (value.scope !== undefined) {
    if (value.scope === null || typeof value.scope !== "object" || Array.isArray(value.scope)) {
      report("error", "invalid-field", `${path}.scope`, "scope 必须是映射");
    } else {
      out.scope = {};
      for (const key of Object.keys(value.scope)) {
        if (!TOOL_SCOPE_FIELDS.includes(key)) report("error", "unknown-field", `${path}.scope.${key}`, `未知字段 ${path}.scope.${key}`);
      }
      for (const key of TOOL_SCOPE_FIELDS) {
        if (value.scope[key] === undefined) continue;
        const items = value.scope[key];
        if (!Array.isArray(items) || items.length > 64 || items.some((item) => typeof item !== "string" || !PATTERNS.toolPattern.test(item))) {
          report("error", "invalid-tool-scope", `${path}.scope.${key}`, `${key} 必须是工具名数组（最多 64 项）`);
          continue;
        }
        out.scope[key] = items.slice();
      }
    }
  }
  return out;
}

function mergeRoute(base, own) {
  const out = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(own ?? {})) if (value !== undefined) out[key] = value;
  return out;
}

function mergeTools(base, own) {
  return { ...(base ?? {}), ...(own ?? {}) };
}

function ref(value, path, report) {
  if (value === undefined) {
    report("error", "missing-field", path, "缺少角色引用（name@version）");
    return null;
  }
  if (typeof value !== "string") {
    report("error", "invalid-role-ref", path, `角色引用必须是字符串：${describe(value)}`);
    return null;
  }
  const match = ROLE_REF.exec(value);
  if (match === null) {
    report("error", "invalid-role-ref", path, `角色引用必须是 name@x.y.z：${value}`);
    return null;
  }
  return { name: match[1], version: match[2], raw: value };
}

function text(value, path, maxChars, report) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value === "") {
    report("error", "invalid-field", path, `${path} 必须是非空字符串`);
    return null;
  }
  if (value.includes("\n")) {
    report("error", "multiline-field", path, `${path} 必须是单行；长文本请写进角色正文或片段`);
    return null;
  }
  if ([...value].length > maxChars) {
    report("error", "field-too-long", path, `${path} 有 ${[...value].length} 字符，超过 ${maxChars}`);
    return null;
  }
  return value;
}

function stringArray(value, path, max, report, maxChars = null) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || item === "")) {
    report("error", "invalid-field", path, `${path} 必须是最多 ${max} 项的字符串数组`);
    return [];
  }
  if (maxChars !== null) {
    const tooLong = value.filter((item) => [...item].length > maxChars);
    if (tooLong.length > 0) {
      report("error", "field-too-long", path, `${path} 有 ${tooLong.length} 项超过 ${maxChars} 字符`);
      return [];
    }
  }
  return value.slice();
}

function list(value, path, max, pattern, report) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    report("error", "invalid-field", path, `${path} 必须是数组`);
    return [];
  }
  if (value.length > max) report("error", "too-many-items", path, `${path} 最多 ${max} 项`);
  const out = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || !pattern.test(item)) {
      report("error", "invalid-item", `${path}[${index}]`, `${path}[${index}] 形态不合法：${describe(item)}`);
      return;
    }
    out.push(item);
  });
  if (new Set(out).size !== out.length) report("error", "duplicate-item", path, `${path} 里有重复项`);
  return out;
}

function describe(value) {
  if (value === undefined) return "缺失";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `数组(${value.length})`;
  return "对象";
}

/**
 * 门的可执行判据。
 *
 * 判据只有两种下场：要么能被跑出来，要么就是签字画押。这里只收前者——
 * 门的存在意义是「别人能复核」，而 `requires` 里的一句话复核不了。
 */
function gateVerify(value, path, report) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMITS2.gateVerifyCommands) {
    report("error", "invalid-gate-verify", path, `verify 必须是数组（最多 ${LIMITS2.gateVerifyCommands} 条）`);
    return [];
  }
  const list = [];
  value.forEach((raw, index) => {
    const at = `${path}[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      report("error", "invalid-gate-verify", at, "一条判据必须是 {command, expectExit} 映射");
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!VERIFY_FIELDS.includes(key)) report("error", "unknown-field", `${at}.${key}`, `未知字段 ${at}.${key}`);
    }
    const command = raw.command;
    if (typeof command !== "string" || command.trim() === "") {
      report("error", "invalid-gate-verify", `${at}.command`, "command 必须是非空字符串");
      return;
    }
    if (command.length > LIMITS2.gateVerifyCommandChars) {
      report("error", "field-too-long", `${at}.command`, `command 超过 ${LIMITS2.gateVerifyCommandChars} 字符`);
    }
    let expectExit = 0;
    if (raw.expectExit !== undefined) {
      if (!Number.isInteger(raw.expectExit) || raw.expectExit < 0 || raw.expectExit > 255) {
        report("error", "invalid-gate-verify", `${at}.expectExit`, "expectExit 必须是 0..255 的整数");
      } else {
        expectExit = raw.expectExit;
      }
    }
    list.push({ command, expectExit });
  });
  return list;
}
