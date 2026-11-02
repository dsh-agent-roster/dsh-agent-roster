/**
 * 组织档案（organization）：一座档案库的"目录页"。
 *
 * 为什么需要它：档案库只能回答"这一份档案写了什么"，回答不了"这些档案是什么关系、
 * 哪份是生产、哪份是归档、谁维护"。当一座库里放二十份来自不同来源的档案时，
 * 缺了这层就只能靠目录名猜。
 *
 * 边界（与 capabilities.yaml 同一条纪律）：
 * - 组织只做**声明与核对**：声明库里有哪几份档案、各自什么状态；
 *   它不创建团队、不改档案、不进 `agent_teams_add_member`。
 * - 它**能被机械核对**：声明了但目录不在 = error，目录在却没声明 = warn，
 *   已归档却仍在用 = info。核对不了的字段一律不收（未知键即错误）。
 * - 位置即身份：`organization` 必须等于所在目录名，和 `roster` 的规则一致。
 *
 * @module dsh-agent-roster/organization
 */

/** 组织文件的 `kind`。与 roster / registry / capabilities 并列，互不冒充。 */
export const ORGANIZATION_KIND = "dsh-agent-roster-organization/v1";

/** 组织文件允许的文件名，按优先级排列。 */
export const ORGANIZATION_FILE_NAMES = ["organization.yaml", "organization.yml", "organization.json"];

/** 档案在组织里的状态。刻意只有两档：归档不等于删除，删除就是没有这个目录。 */
export const ORGANIZATION_STATUSES = ["active", "archived"];

/** 长度上限：与档案的 LIMITS 同一套口径，超了就报错而不是截断。 */
export const LIMITS = {
  rosters: 64,
  titleChars: 120,
  descriptionChars: 500,
  licenseChars: 120,
  homepageChars: 200,
  maintainers: 16,
  maintainerChars: 120,
  noteChars: 300,
};

/** 组织 id 与档案 id 同形：小写、连字符、首字符必须是字母或数字。 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

const ROOT_FIELDS = new Set([
  "kind",
  "organization",
  "title",
  "description",
  "license",
  "homepage",
  "maintainers",
  "rosters",
]);

const ROSTER_FIELDS = new Set(["id", "title", "status", "origin", "note"]);

/** 顶层字段清单（供 schema 对齐测试反向钉住，避免两处各写一份）。 */
export const ORGANIZATION_FIELDS = Object.freeze([...ROOT_FIELDS]);

/** 每条登记项的字段清单。 */
export const ORGANIZATION_ROSTER_FIELDS = Object.freeze([...ROSTER_FIELDS]);

/**
 * 一条诊断。形状与 `lib/validate.js` 保持一致，好让 render / panel / CLI 用同一套渲染。
 *
 * @param {"error"|"warn"|"info"} severity
 * @param {string} code
 * @param {string} file
 * @param {string} reason
 * @returns {{severity: string, code: string, path: string, file: string, reason: string}}
 */
function diagnose(severity, code, file, reason) {
  return { severity, code, path: "", file, reason };
}

/**
 * 校验一份组织档案。
 *
 * 与 roster 的校验同一条纪律：**能核对的才收**。`homepage` 只校验是不是 http(s)，
 * 不联网；`maintainers` 只校验形态，不校验这个人存在不存在。
 *
 * @param {unknown} value 解析后的 JSON/YAML 值
 * @param {{file?: string, expectedId?: string|null}} [options]
 * @returns {{ok: boolean, organization: object|null, diagnostics: object[]}}
 */
export function validateOrganization(value, options = {}) {
  const file = options.file ?? ORGANIZATION_FILE_NAMES[0];
  const expectedId = options.expectedId ?? null;
  /** @type {object[]} */
  const diagnostics = [];

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push(diagnose("error", "organization-not-object", file, "组织文件必须是一个对象（键值对）。"));
    return { ok: false, organization: null, diagnostics };
  }

  for (const key of Object.keys(value)) {
    if (!ROOT_FIELDS.has(key)) {
      diagnostics.push(
        diagnose(
          "error",
          "unknown-field",
          file,
          `未知字段 "${key}"。组织文件只收 ${[...ROOT_FIELDS].join(" / ")}：` +
            "核对不了的字段不收——写了也不会被任何人验证，只会被误当成事实。",
        ),
      );
    }
  }

  if (value.kind !== ORGANIZATION_KIND) {
    diagnostics.push(
      diagnose("error", "organization-kind", file, `kind 必须是 "${ORGANIZATION_KIND}"，实际是 ${JSON.stringify(value.kind)}。`),
    );
  }

  const id = value.organization;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    diagnostics.push(
      diagnose("error", "organization-id", file, "organization 必须是 2–64 位小写字母/数字/连字符，且以字母或数字开头。"),
    );
  } else if (expectedId !== null && id !== expectedId) {
    diagnostics.push(
      diagnose(
        "error",
        "organization-id-mismatch",
        file,
        `organization 是 "${id}"，但所在目录叫 "${expectedId}"。位置即身份：组织 id 必须等于目录名。`,
      ),
    );
  }

  const title = optionalString(value, "title", LIMITS.titleChars, diagnostics, file, "organization-title");
  optionalString(value, "description", LIMITS.descriptionChars, diagnostics, file, "organization-description");
  optionalString(value, "license", LIMITS.licenseChars, diagnostics, file, "organization-license");

  if (value.homepage !== undefined) {
    const homepage = optionalString(value, "homepage", LIMITS.homepageChars, diagnostics, file, "organization-homepage");
    if (typeof homepage === "string" && !/^https?:\/\/\S+$/i.test(homepage)) {
      diagnostics.push(
        diagnose("error", "organization-homepage", file, "homepage 只收 http(s) 地址：别的写法既打不开也核对不了。"),
      );
    }
  }

  if (value.maintainers !== undefined) {
    if (!Array.isArray(value.maintainers)) {
      diagnostics.push(diagnose("error", "organization-maintainers", file, "maintainers 必须是字符串数组。"));
    } else if (value.maintainers.length > LIMITS.maintainers) {
      diagnostics.push(
        diagnose("error", "organization-maintainers", file, `maintainers 最多 ${LIMITS.maintainers} 项。`),
      );
    } else {
      for (const who of value.maintainers) {
        if (typeof who !== "string" || who.length === 0 || who.length > LIMITS.maintainerChars) {
          diagnostics.push(
            diagnose("error", "organization-maintainer", file, `维护者名字必须是 1–${LIMITS.maintainerChars} 个字符的字符串。`),
          );
          break;
        }
      }
    }
  }

  const rosters = [];
  const rawRosters = value.rosters;
  if (!Array.isArray(rawRosters) || rawRosters.length === 0) {
    diagnostics.push(diagnose("error", "organization-rosters", file, "rosters 必须是非空数组：组织的意义就是登记这些档案。"));
  } else if (rawRosters.length > LIMITS.rosters) {
    diagnostics.push(diagnose("error", "organization-rosters", file, `rosters 最多 ${LIMITS.rosters} 项。`));
  } else {
    const seen = new Set();
    rawRosters.forEach((item, index) => {
      const where = `rosters[${index}]`;
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        diagnostics.push(diagnose("error", "organization-roster-not-object", file, `${where} 必须是对象。`));
        return;
      }
      for (const key of Object.keys(item)) {
        if (!ROSTER_FIELDS.has(key)) {
          diagnostics.push(
            diagnose("error", "unknown-field", file, `${where} 的未知字段 "${key}"（只收 ${[...ROSTER_FIELDS].join(" / ")}）。`),
          );
        }
      }
      if (typeof item.id !== "string" || !ID_PATTERN.test(item.id)) {
        diagnostics.push(diagnose("error", "organization-roster-id", file, `${where}.id 必须是合法档案 id。`));
        return;
      }
      if (seen.has(item.id)) {
        diagnostics.push(
          diagnose("error", "organization-duplicate-roster", file, `档案 "${item.id}" 在组织里登记了两次。`),
        );
        return;
      }
      seen.add(item.id);
      const status = item.status ?? "active";
      if (!ORGANIZATION_STATUSES.includes(status)) {
        diagnostics.push(
          diagnose("error", "organization-roster-status", file, `${where}.status 只能是 ${ORGANIZATION_STATUSES.join(" / ")}。`),
        );
      }
      const entryTitle = optionalString(item, "title", LIMITS.titleChars, diagnostics, file, "organization-roster-title", where);
      const origin = optionalString(item, "origin", LIMITS.titleChars, diagnostics, file, "organization-roster-origin", where);
      const note = optionalString(item, "note", LIMITS.noteChars, diagnostics, file, "organization-roster-note", where);
      rosters.push({
        id: item.id,
        title: entryTitle ?? "",
        status,
        origin: origin ?? "",
        note: note ?? "",
      });
    });
  }

  if (diagnostics.some((item) => item.severity === "error")) {
    return { ok: false, organization: null, diagnostics };
  }

  return {
    ok: true,
    organization: {
      kind: ORGANIZATION_KIND,
      id,
      title: title ?? "",
      description: value.description ?? "",
      license: value.license ?? "",
      homepage: value.homepage ?? "",
      maintainers: Array.isArray(value.maintainers) ? [...value.maintainers] : [],
      rosters,
    },
    diagnostics,
  };
}

/**
 * 读一个可选字符串字段并钉住上限。
 *
 * @param {object} source
 * @param {string} key
 * @param {number} max
 * @param {object[]} diagnostics
 * @param {string} file
 * @param {string} code
 * @param {string} [where]
 * @returns {string|undefined}
 */
function optionalString(source, key, max, diagnostics, file, code, where = "") {
  const value = source[key];
  if (value === undefined) return undefined;
  const label = where === "" ? key : `${where}.${key}`;
  if (typeof value !== "string" || value.length > max) {
    diagnostics.push(diagnose("error", code, file, `${label} 必须是长度不超过 ${max} 的字符串。`));
    return undefined;
  }
  return value;
}

/**
 * 组织声明与磁盘实际情况的交叉核对。
 *
 * 三件事分开说，因为它们的严重度不同：
 * - **缺**（声明了却找不到目录）：error。组织页在撒谎，比没有组织页更糟。
 * - **多**（目录在却没登记）：warn。不是错误，但意味着有人绕过组织加了档案。
 * - **归档仍在**：info。归档是声明，不是删除；提醒一句即可。
 *
 * @param {object|null} organization
 * @param {string[]} rosterIds 磁盘上真正通过校验的档案 id
 * @returns {{declared: number, present: number, missing: string[], undeclared: string[], archived: string[], status: string}}
 */
export function checkOrganization(organization, rosterIds) {
  const onDisk = new Set(rosterIds);
  const declared = new Set(organization === null ? [] : organization.rosters.map((item) => item.id));
  const missing = [...declared].filter((id) => !onDisk.has(id)).sort();
  const undeclared = [...onDisk].filter((id) => !declared.has(id)).sort();
  const archived = organization === null
    ? []
    : organization.rosters.filter((item) => item.status === "archived" && onDisk.has(item.id)).map((item) => item.id).sort();
  return {
    declared: declared.size,
    present: onDisk.size,
    missing,
    undeclared,
    archived,
    status: organization === null ? "absent" : missing.length > 0 ? "incomplete" : "ok",
  };
}

/**
 * 把交叉核对结果折成诊断。
 *
 * @param {object|null} organization
 * @param {object} check {@link checkOrganization} 的返回值
 * @param {string} file 组织文件相对路径
 * @returns {object[]}
 */
export function organizationDiagnostics(organization, check, file) {
  const diagnostics = [];
  if (organization === null) return diagnostics;
  if (check.missing.length > 0) {
    diagnostics.push(
      diagnose(
        "error",
        "organization-roster-missing",
        file,
        `组织声明了 ${check.missing.length} 份档案但库里找不到：${check.missing.join(", ")}。` +
          "要么把目录加回来，要么把它们从 organization 里删掉——组织页不能比磁盘更乐观。",
      ),
    );
  }
  if (check.undeclared.length > 0) {
    diagnostics.push(
      diagnose(
        "warn",
        "organization-roster-undeclared",
        file,
        `库里有 ${check.undeclared.length} 份档案没在组织里登记：${check.undeclared.join(", ")}。` +
          "它们仍会被加载，但组织页看不到它们——补一行登记，或确认它们不该在这里。",
      ),
    );
  }
  if (check.archived.length > 0) {
    diagnostics.push(
      diagnose(
        "info",
        "organization-roster-archived",
        file,
        `已归档但仍在库里的档案：${check.archived.join(", ")}。归档只是声明，不影响加载。`,
      ),
    );
  }
  return diagnostics;
}
