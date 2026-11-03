/**
 * 档案空间（space）：一个可以装很多份档案的目录（通常是 git 仓库）的"封面"。
 *
 * 为什么需要它：一份 `roster.yaml` 只回答"这个团队是谁"；它回答不了
 * "这几十份档案在哪个仓库、用什么布局、我拉下来以后该改哪个文件"。
 * 一旦档案来自 monorepo，拉取就会把文件摊平到本地，编辑和源文件从此对不上。
 * 空间这一级就是用来固定这件事的：**布局是声明出来的，不是猜出来的**。
 *
 * 边界（与 capabilities.yaml / roster 同一条纪律）：
 * - 空间只做**声明与核对**：声明这个空间有哪些档案、什么布局、源在哪；
 *   它不创建团队、不改档案、不进 `agent_teams_add_member`。
 * - 它**能被机械核对**：声明了但目录不在 = error，目录在却没声明 = warn，
 *   归档却还在 = info；单档案布局却登记了多份 = error。
 * - 位置即身份：`space` 必须等于所在目录名（本地副本同样遵守）。
 *
 * 布局只有两种，且只有一种格式：
 * - `flat`：`<space>/<roster-id>/roster.yaml`（v1 时代的一仓多档案，也兼容一仓一份）
 * - `monorepo`：`<space>/roles/<role>/AGENT.md` + `<space>/rosters/<id>/roster.yaml` + `<space>/dist/`
 *
 * @module dsh-agent-roster/space
 */

/** 空间文件的 `kind`。与 roster / registry / capabilities 并列，互不冒充。 */
export const SPACE_KIND = "dsh-agent-roster/space@1";

/** 空间文件允许的文件名，按优先级排列。 */
export const SPACE_FILE_NAMES = ["space.yaml", "space.yml", "space.json"];

/** 布局枚举：只有两种，多一种就得多写一套扫描与拉取。 */
export const SPACE_LAYOUTS = ["flat", "monorepo"];

/** 档案在空间里的状态。归档不等于删除，删除就是没有这个目录。 */
export const SPACE_STATUSES = ["active", "archived"];

/** 长度上限：与档案的 LIMITS 同一套口径，超了报错而不是截断。 */
export const SPACE_LIMITS = {
  rosters: 200,
  roles: 200,
  titleChars: 120,
  descriptionChars: 500,
  licenseChars: 120,
  homepageChars: 200,
  maintainers: 16,
  maintainerChars: 120,
  noteChars: 300,
  repoChars: 200,
  refChars: 120,
  pathChars: 200,
};

/** 空间 id 与档案 id 同形：小写、连字符、首字符必须是字母或数字。 */
export const SPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** `owner/repo`，与 registry 的 repo 同形。 */
export const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ROOT_FIELDS = new Set([
  "kind",
  "space",
  "title",
  "description",
  "license",
  "homepage",
  "maintainers",
  "layout",
  "origin",
  "rosters",
  "roles",
]);

const ROSTER_FIELDS = new Set(["id", "title", "status", "origin", "note"]);

const ORIGIN_FIELDS = new Set(["repo", "ref", "path"]);

/** 顶层字段清单（供 schema 对齐测试反向钉住，避免两处各写一份）。 */
export const SPACE_FIELDS = Object.freeze([...ROOT_FIELDS]);

/** 每条登记项的字段清单。 */
export const SPACE_ROSTER_FIELDS = Object.freeze([...ROSTER_FIELDS]);

/** 本地副本记录来源的字段清单。 */
export const SPACE_ORIGIN_FIELDS = Object.freeze([...ORIGIN_FIELDS]);

function diagnose(severity, code, file, reason, where = "") {
  return { severity, code, path: where, file, reason };
}

function optionalString(source, key, max, diagnostics, file, code, where = "") {
  const value = source[key];
  if (value === undefined) return undefined;
  const label = where === "" ? key : `${where}.${key}`;
  if (typeof value !== "string" || value.length > max) {
    diagnostics.push(diagnose("error", code, file, `${label} 必须是长度不超过 ${max} 的字符串。`, where));
    return undefined;
  }
  return value;
}

/**
 * 校验一份空间文件。
 *
 * 与 roster 的校验同一条纪律：**能核对的才收**。`origin.repo` 只校验形态，不联网；
 * `origin` 只出现在本地副本上——远端仓库里的空间文件不该声称自己有个源，
 * 那是第二真源。
 *
 * @param {unknown} value 解析后的 JSON/YAML 值
 * @param {{file?: string, expectedId?: string|null, allowOrigin?: boolean}} [options]
 * @returns {{ok: boolean, space: object|null, diagnostics: object[]}}
 */
export function validateSpace(value, options = {}) {
  const file = options.file ?? SPACE_FILE_NAMES[0];
  const expectedId = options.expectedId ?? null;
  const allowOrigin = options.allowOrigin === true;
  /** @type {object[]} */
  const diagnostics = [];

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push(diagnose("error", "space-not-object", file, "空间文件必须是一个对象（键值对）。"));
    return { ok: false, space: null, diagnostics };
  }

  for (const key of Object.keys(value)) {
    if (!ROOT_FIELDS.has(key)) {
      diagnostics.push(
        diagnose(
          "error",
          "unknown-field",
          file,
          `未知字段 "${key}"。空间文件只收 ${[...ROOT_FIELDS].join(" / ")}：` +
            "核对不了的字段不收——写了也不会被任何人验证，只会被误当成事实。",
        ),
      );
    }
  }

  if (value.kind !== SPACE_KIND) {
    diagnostics.push(
      diagnose("error", "space-kind", file, `kind 必须是 "${SPACE_KIND}"，实际是 ${JSON.stringify(value.kind)}。`),
    );
  }

  const id = value.space;
  if (typeof id !== "string" || !SPACE_ID_PATTERN.test(id)) {
    diagnostics.push(
      diagnose("error", "space-id", file, "space 必须是 2–64 位小写字母/数字/连字符，且以字母或数字开头。"),
    );
  } else if (expectedId !== null && id !== expectedId) {
    diagnostics.push(
      diagnose(
        "error",
        "space-id-mismatch",
        file,
        `space 是 "${id}"，但所在目录叫 "${expectedId}"。位置即身份：空间 id 必须等于目录名。`,
      ),
    );
  }

  const layout = value.layout ?? "flat";
  if (!SPACE_LAYOUTS.includes(layout)) {
    diagnostics.push(diagnose("error", "space-layout", file, `layout 只能是 ${SPACE_LAYOUTS.join(" / ")}。`));
  }

  const title = optionalString(value, "title", SPACE_LIMITS.titleChars, diagnostics, file, "space-title");
  optionalString(value, "description", SPACE_LIMITS.descriptionChars, diagnostics, file, "space-description");
  optionalString(value, "license", SPACE_LIMITS.licenseChars, diagnostics, file, "space-license");

  if (value.homepage !== undefined) {
    const homepage = optionalString(value, "homepage", SPACE_LIMITS.homepageChars, diagnostics, file, "space-homepage");
    if (typeof homepage === "string" && !/^https?:\/\/\S+$/i.test(homepage)) {
      diagnostics.push(diagnose("error", "space-homepage", file, "homepage 只收 http(s) 地址：别的写法既打不开也核对不了。"));
    }
  }

  if (value.maintainers !== undefined) {
    if (!Array.isArray(value.maintainers)) {
      diagnostics.push(diagnose("error", "space-maintainers", file, "maintainers 必须是字符串数组。"));
    } else if (value.maintainers.length > SPACE_LIMITS.maintainers) {
      diagnostics.push(diagnose("error", "space-maintainers", file, `maintainers 最多 ${SPACE_LIMITS.maintainers} 项。`));
    } else {
      for (const who of value.maintainers) {
        if (typeof who !== "string" || who.length === 0 || who.length > SPACE_LIMITS.maintainerChars) {
          diagnostics.push(
            diagnose("error", "space-maintainer", file, `维护者名字必须是 1–${SPACE_LIMITS.maintainerChars} 个字符的字符串。`),
          );
          break;
        }
      }
    }
  }

  let origin = null;
  if (value.origin !== undefined) {
    if (!allowOrigin) {
      diagnostics.push(
        diagnose(
          "error",
          "space-origin-not-allowed",
          file,
          "仓库里的空间文件不该写 origin：源就是这个仓库本身，再写一遍就是第二真源。" +
            "origin 只出现在本地拉取出来的副本上。",
        ),
      );
    } else if (value.origin === null || typeof value.origin !== "object" || Array.isArray(value.origin)) {
      diagnostics.push(diagnose("error", "space-origin", file, "origin 必须是 { repo, ref, path } 对象。"));
    } else {
      for (const key of Object.keys(value.origin)) {
        if (!ORIGIN_FIELDS.has(key)) {
          diagnostics.push(diagnose("error", "unknown-field", file, `origin.${key} 不是合法字段（只收 ${[...ORIGIN_FIELDS].join(" / ")}）。`));
        }
      }
      const repo = value.origin.repo;
      const ref = value.origin.ref ?? "main";
      const originPath = value.origin.path ?? "";
      if (typeof repo !== "string" || repo.length > SPACE_LIMITS.repoChars || !REPO_PATTERN.test(repo)) {
        diagnostics.push(diagnose("error", "space-origin-repo", file, "origin.repo 必须是 owner/name。"));
      }
      if (typeof ref !== "string" || ref.length === 0 || ref.length > SPACE_LIMITS.refChars) {
        diagnostics.push(diagnose("error", "space-origin-ref", file, "origin.ref 必须是 1–120 个字符的分支/tag/提交。"));
      }
      if (typeof originPath !== "string" || originPath.length > SPACE_LIMITS.pathChars) {
        diagnostics.push(diagnose("error", "space-origin-path", file, "origin.path 必须是字符串（仓库内的相对目录，根目录为空串）。"));
      } else if (originPath !== "" && (originPath.startsWith("/") || originPath.includes("..") || originPath.includes("\\"))) {
        diagnostics.push(diagnose("error", "space-origin-path", file, "origin.path 必须是安全的相对路径。"));
      }
      origin = { repo: String(repo ?? ""), ref: String(ref ?? "main"), path: String(originPath ?? "") };
    }
  }

  const roles = [];
  if (value.roles !== undefined) {
    if (!Array.isArray(value.roles) || value.roles.length > SPACE_LIMITS.roles) {
      diagnostics.push(diagnose("error", "space-roles", file, `roles 必须是不超过 ${SPACE_LIMITS.roles} 项的数组（只收角色名）。`));
    } else {
      for (const name of value.roles) {
        if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
          diagnostics.push(diagnose("error", "space-role-name", file, "roles 里每项都必须是角色名（字母/数字/点/下划线/连字符）。"));
          break;
        }
        roles.push(name);
      }
    }
  }

  const rosters = [];
  const rawRosters = value.rosters;
  if (!Array.isArray(rawRosters) || rawRosters.length === 0) {
    diagnostics.push(diagnose("error", "space-rosters", file, "rosters 必须是非空数组：空间的意义就是登记这些档案。"));
  } else if (rawRosters.length > SPACE_LIMITS.rosters) {
    diagnostics.push(diagnose("error", "space-rosters", file, `rosters 最多 ${SPACE_LIMITS.rosters} 项。`));
  } else {
    const seen = new Set();
    rawRosters.forEach((item, index) => {
      const where = `rosters[${index}]`;
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        diagnostics.push(diagnose("error", "space-roster-not-object", file, `${where} 必须是对象。`, where));
        return;
      }
      for (const key of Object.keys(item)) {
        if (!ROSTER_FIELDS.has(key)) {
          diagnostics.push(
            diagnose("error", "unknown-field", file, `${where} 的未知字段 "${key}"（只收 ${[...ROSTER_FIELDS].join(" / ")}）。`, where),
          );
        }
      }
      if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(item.id)) {
        diagnostics.push(diagnose("error", "space-roster-id", file, `${where}.id 必须是合法档案 id。`, where));
        return;
      }
      if (seen.has(item.id)) {
        diagnostics.push(diagnose("error", "space-duplicate-roster", file, `档案 "${item.id}" 在空间里登记了两次。`, where));
        return;
      }
      seen.add(item.id);
      const status = item.status ?? "active";
      if (!SPACE_STATUSES.includes(status)) {
        diagnostics.push(diagnose("error", "space-roster-status", file, `${where}.status 只能是 ${SPACE_STATUSES.join(" / ")}。`, where));
      }
      const entryTitle = optionalString(item, "title", SPACE_LIMITS.titleChars, diagnostics, file, "space-roster-title", where);
      const entryOrigin = optionalString(item, "origin", SPACE_LIMITS.titleChars, diagnostics, file, "space-roster-origin", where);
      const note = optionalString(item, "note", SPACE_LIMITS.noteChars, diagnostics, file, "space-roster-note", where);
      rosters.push({ id: item.id, title: entryTitle ?? "", status, origin: entryOrigin ?? "", note: note ?? "" });
    });
  }

  if (diagnostics.some((item) => item.severity === "error")) {
    return { ok: false, space: null, diagnostics };
  }

  return {
    ok: true,
    space: {
      kind: SPACE_KIND,
      id,
      title: title ?? "",
      description: value.description ?? "",
      license: value.license ?? "",
      homepage: value.homepage ?? "",
      maintainers: Array.isArray(value.maintainers) ? [...value.maintainers] : [],
      layout,
      origin,
      roles,
      rosters,
    },
    diagnostics,
  };
}

/**
 * 空间声明与磁盘实际情况的交叉核对。
 *
 * - **缺**（声明了却找不到目录）：error。空间页在撒谎，比没有空间页更糟。
 * - **多**（目录在却没登记）：warn。不是错误，但意味着有人绕过空间加了档案。
 * - **归档仍在**：info。归档是声明，不是删除。
 *
 * @param {object|null} space
 * @param {string[]} rosterIds 磁盘上真正通过校验的档案 id
 * @returns {{declared: number, present: number, missing: string[], undeclared: string[], archived: string[], status: string}}
 */
export function checkSpace(space, rosterIds) {
  const onDisk = new Set(rosterIds);
  const declared = new Set(space === null ? [] : space.rosters.map((item) => item.id));
  const missing = [...declared].filter((id) => !onDisk.has(id)).sort();
  const undeclared = [...onDisk].filter((id) => !declared.has(id)).sort();
  const archived =
    space === null
      ? []
      : space.rosters.filter((item) => item.status === "archived" && onDisk.has(item.id)).map((item) => item.id).sort();
  return {
    declared: declared.size,
    present: onDisk.size,
    missing,
    undeclared,
    archived,
    status: space === null ? "absent" : missing.length > 0 ? "incomplete" : "ok",
  };
}

/**
 * 把交叉核对结果折成诊断。
 *
 * @param {object|null} space
 * @param {object} check {@link checkSpace} 的返回值
 * @param {string} file 空间文件相对路径
 * @returns {object[]}
 */
export function spaceDiagnostics(space, check, file) {
  const diagnostics = [];
  if (space === null) return diagnostics;
  if (check.missing.length > 0) {
    diagnostics.push(
      diagnose(
        "error",
        "space-roster-missing",
        file,
        `空间声明了 ${check.missing.length} 份档案但目录里找不到：${check.missing.join(", ")}。` +
          "要么把目录加回来，要么把它们从空间里删掉——空间页不能比磁盘更乐观。",
      ),
    );
  }
  if (check.undeclared.length > 0) {
    diagnostics.push(
      diagnose(
        "warn",
        "space-roster-undeclared",
        file,
        `目录里有 ${check.undeclared.length} 份档案没在空间里登记：${check.undeclared.join(", ")}。` +
          "它们仍会被加载，但空间页看不到它们——补一行登记，或确认它们不该在这里。",
      ),
    );
  }
  if (check.archived.length > 0) {
    diagnostics.push(
      diagnose(
        "info",
        "space-roster-archived",
        file,
        `已归档但仍在目录里的档案：${check.archived.join(", ")}。归档只是声明，不影响加载。`,
      ),
    );
  }
  return diagnostics;
}
