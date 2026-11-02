/**
 * 核对：把"档案里写的"和"运行时实际记下的"逐字段摆在一起。
 *
 * 这一步是整个插件的判据所在：桥接参数生成得再漂亮，成员也可能因为运行时采用了队长默认模型、
 * 或者策略 id 不存在而悄悄降级；只有比对 `team.json` 里的实际值才能发现。
 *
 * 两条补充规则：
 * - `aliases` 让改名后的成员仍然认得出旧名。团队状态里存的是旧名时不算漂移，
 *   否则每次重命名都会制造一堆"未托管"的假报警。
 * - `skills` 是声明层字段，运行时不会帮你加载技能；宿主把技能目录传进来时，
 *   这里只负责回答"声明了但没装"这一件事，不假装已生效。
 *
 * 两条可见性规则（issue #2）：
 * - 每个成员带出 `toolFilter` 的规范化摘要。只比 `toolPolicy` 这个 id 的话，
 *   部署侧改了策略定义、旧成员还拿着旧列表时，核对永远是绿的。
 * - 每个团队带出溯源结论。`team.json` 没有"由哪一版档案建成"的字段，只能读 description
 *   里 `roster:<id>@<version>#<sha8>` 这一行，再与档案文件现在的哈希对比。
 *
 * @module dsh-agent-roster/verify
 */
import {
  buildMemberBinding,
  isBindingFaithful,
  parseProvenanceLine,
  reconcileBinding,
  summarizeBinding,
} from "./bridge.js";
import { checkCapabilities } from "./capabilities.js";
import { shortSha, toolFilterDigest } from "./digest.js";

/**
 * 逐个成员核对档案与团队状态。
 *
 * @param {object[]} rosters 已校验档案
 * @param {object[]} teams `readTeamStates` 产出的团队记录
 * @param {{ knownSkills?: string[], rosterShas?: Record<string, string>,
 *   knownToolPolicies?: string[], capabilitiesById?: Record<string, object> }} [options]
 *   `knownSkills`：宿主已知技能目录，缺省表示无法核对技能；
 *   `rosterShas`：档案 id → 档案文件内容的 sha256，用于核对团队溯源串；
 *   `knownToolPolicies`：部署已声明的策略 id，缺省表示无法核对能力要求里的策略；
 *   `capabilitiesById`：档案 id → 能力要求（`capabilities.yaml`），缺省表示没有声明要求。
 * @returns {{ checks: object[], unmanaged: object[], skills: object[], policyDrift: object[],
 *   provenance: object[], capabilities: { entries: object[], summary: object }, summary: object }}
 */
export function verifyBindings(rosters, teams, options = {}) {
  const knownSkills =
    Array.isArray(options.knownSkills) && options.knownSkills.length > 0
      ? new Set(options.knownSkills.filter((name) => typeof name === "string" && name !== ""))
      : null;
  const rosterShas = options.rosterShas ?? {};

  const checks = [];
  const managedNames = new Set();

  for (const roster of rosters) {
    for (const member of roster.members) {
      managedNames.add(member.name);
      const aliases = new Set(Array.isArray(member.aliases) ? member.aliases : []);
      for (const alias of aliases) managedNames.add(alias);

      const matches = [];
      for (const team of teams) {
        const found = team.members.find(
          (candidate) => candidate.name === member.name || aliases.has(candidate.name),
        );
        if (found !== undefined) matches.push({ team, teamMember: found });
      }

      if (matches.length === 0) {
        checks.push({
          rosterId: roster.id,
          rosterVersion: roster.version,
          member: member.name,
          role: member.role,
          found: false,
          teamId: null,
          teamName: null,
          matchedAs: null,
          binding: null,
          toolPolicy: "",
          toolFilter: null,
          faithful: false,
          summary: null,
        });
        continue;
      }

      for (const { team, teamMember } of matches) {
        const { binding } = buildMemberBinding(roster, member);
        reconcileBinding(binding, teamMember);
        // 通过别名匹配上时，`name` 本来就该不同：把它记成"降级"会让每次改名都变成假报警。
        if (teamMember.name !== member.name) {
          const nameField = binding.fields.find((field) => field.field === "name");
          if (nameField !== undefined) {
            nameField.status = "applied";
            nameField.actual = teamMember.name;
            nameField.note = `运行时以曾用名 "${teamMember.name}" 记录`;
          }
        }
        checks.push({
          rosterId: roster.id,
          rosterVersion: roster.version,
          member: member.name,
          role: member.role,
          found: true,
          teamId: team.id,
          teamName: team.name,
          matchedAs: teamMember.name,
          binding,
          toolPolicy: typeof teamMember.toolPolicy === "string" ? teamMember.toolPolicy : "",
          toolFilter: toolFilterDigest(teamMember.toolFilter),
          faithful: isBindingFaithful(binding),
          summary: summarizeBinding(binding),
        });
      }
    }
  }

  const unmanaged = [];
  for (const team of teams) {
    for (const member of team.members) {
      if (managedNames.has(member.name)) continue;
      unmanaged.push({
        teamId: team.id,
        teamName: team.name,
        name: typeof member.name === "string" ? member.name : "",
        provider: typeof member.provider === "string" ? member.provider : "",
        model: typeof member.model === "string" ? member.model : "",
        toolPolicy: typeof member.toolPolicy === "string" ? member.toolPolicy : "",
      });
    }
  }

  const skills = [];
  for (const roster of rosters) {
    for (const member of roster.members) {
      const declared = Array.isArray(member.skills) ? member.skills : [];
      if (declared.length === 0) continue;
      const missing = knownSkills === null ? [] : declared.filter((name) => !knownSkills.has(name));
      skills.push({
        rosterId: roster.id,
        member: member.name,
        declared,
        missing,
        checked: knownSkills !== null,
      });
    }
  }

  // 同一个 toolPolicy 在同一支团队里必须物化成同一份 deny 列表。
  // 这条不变量今天成立，所以它恰恰最该被断言——一旦部署侧改了策略定义、
  // 而旧成员仍拿着旧列表，只比 id 的核对永远看不出来。
  const policyDrift = [];
  for (const team of teams) {
    const byPolicy = new Map();
    for (const member of team.members) {
      const policy = typeof member.toolPolicy === "string" ? member.toolPolicy : "";
      if (policy === "") continue;
      const digest = toolFilterDigest(member.toolFilter);
      if (digest === null) continue;
      if (!byPolicy.has(policy)) byPolicy.set(policy, new Map());
      const bySha = byPolicy.get(policy);
      if (!bySha.has(digest.sha)) bySha.set(digest.sha, { sha: digest.sha, deny: digest.deny, members: [] });
      bySha.get(digest.sha).members.push(typeof member.name === "string" ? member.name : "");
    }
    for (const [policy, bySha] of byPolicy) {
      if (bySha.size < 2) continue;
      policyDrift.push({
        teamId: team.id,
        teamName: team.name,
        toolPolicy: policy,
        variants: [...bySha.values()].sort((left, right) => right.members.length - left.members.length),
      });
    }
  }

  // 溯源：团队是哪一版档案建的。只读 description，不改它。
  const provenance = teams.map((team) => {
    const parsed = parseProvenanceLine(team.description ?? "");
    const base = { teamId: team.id, teamName: team.name, declared: parsed === null ? null : parsed.raw };
    if (parsed === null) return { ...base, status: "absent", rosterId: null, version: null, sha: null, currentSha: null };
    const current = typeof rosterShas[parsed.id] === "string" ? rosterShas[parsed.id] : null;
    if (current === null) {
      return { ...base, status: "unknown-roster", rosterId: parsed.id, version: parsed.version, sha: parsed.sha, currentSha: null };
    }
    const currentSha = shortSha(current);
    if (parsed.sha === null) {
      return { ...base, status: "id-only", rosterId: parsed.id, version: parsed.version, sha: null, currentSha };
    }
    return {
      ...base,
      status: parsed.sha === currentSha ? "match" : "differ",
      rosterId: parsed.id,
      version: parsed.version,
      sha: parsed.sha,
      currentSha,
    };
  });

  // 能力要求是档案级（不是成员级），单独一栏：它回答"这台机器有没有条件把这支队伍建起来"。
  const capabilityReport = checkCapabilities(rosters, options.capabilitiesById ?? {}, {
    knownSkills: options.knownSkills ?? null,
    knownToolPolicies: options.knownToolPolicies ?? null,
  });

  // 三个互斥的判读桶，加未部署：每个成员只会落进一个桶，避免"忠实 3 + 降级 2"这种加起来对不上的账。
  const buckets = { faithful: 0, drift: 0, unverified: 0, missing: 0 };
  for (const check of checks) buckets[memberVerdict(check)] += 1;

  const summary = {
    members: checks.length,
    deployed: checks.filter((check) => check.found).length,
    faithful: buckets.faithful,
    /** 真降级：运行时换了值，或团队里根本没有这个成员。 */
    drift: buckets.drift,
    /** 只有"发了却没留痕"的字段（今天只有 systemPrompt）：无法核对，不等于没生效。 */
    unverified: buckets.unverified,
    /** 不忠实总数 = drift + unverified，保留旧字段名供旧调用方使用。 */
    degraded: buckets.drift + buckets.unverified,
    missing: buckets.missing,
    unmanaged: unmanaged.length,
    skillsDeclared: skills.length,
    skillsMissing: skills.filter((item) => item.missing.length > 0).length,
    skillsUnverified: skills.filter((item) => !item.checked).length,
    toolFilterChecked: checks.filter((check) => check.found && check.toolFilter !== null).length,
    toolFilterMissing: checks.filter((check) => check.found && check.toolFilter === null).length,
    policyDrift: policyDrift.length,
    provenanceAbsent: provenance.filter((item) => item.status === "absent").length,
    provenanceDiffer: provenance.filter((item) => item.status === "differ").length,
    /** 能力要求总数 / 缺失 / 核对不到 / 会拦住建队的档案数。 */
    capabilityDeclared: capabilityReport.summary.declared,
    capabilityMissing: capabilityReport.summary.missing,
    capabilityUnknown: capabilityReport.summary.unknown,
    capabilityBlocked: capabilityReport.summary.blocked,
  };

  return { checks, unmanaged, skills, policyDrift, provenance, capabilities: capabilityReport, summary };
}

/**
 * 一个成员的判读结论，四个互斥取值。
 *
 * - `faithful`：被运行时承载的字段全部拿到回执且一致；
 * - `unverified`：只有"发了却没留痕"的字段（今天只有 systemPrompt），无法核对，但没看到漂移；
 * - `drift`：运行时换了值，或团队里根本没有这个成员——这才是要动手修的；
 * - `missing`：档案定义了、运行时没有同名成员。
 *
 * @param {object} check `verifyBindings` 产出的单条核对记录
 * @returns {"faithful" | "unverified" | "drift" | "missing"}
 */
export function memberVerdict(check) {
  if (check === null || check.found !== true) return "missing";
  if (check.faithful === true) return "faithful";
  const summary = check.summary ?? { counts: {}, unverified: 0 };
  const realDrift = (summary.counts.overridden ?? 0) > 0 || (summary.counts.unconfirmed ?? 0) > 0;
  return realDrift ? "drift" : "unverified";
}

/**
 * 只核对指定成员（工具的参数级筛选）；其余成员不进入结果。
 *
 * 筛选同时接受成员名与它的别名，免得对着旧名筛不出东西。
 *
 * @param {object} report `verifyBindings` 的结果
 * @param {string[]} names 成员名或别名
 * @returns {object}
 */
export function filterChecks(report, names) {
  if (!Array.isArray(names) || names.length === 0) return report;
  const wanted = new Set(names);
  const checks = report.checks.filter(
    (check) => wanted.has(check.member) || (check.matchedAs !== null && wanted.has(check.matchedAs)),
  );
  const buckets = { faithful: 0, drift: 0, unverified: 0, missing: 0 };
  for (const check of checks) buckets[memberVerdict(check)] += 1;
  const summary = {
    ...report.summary,
    members: checks.length,
    deployed: checks.filter((check) => check.found).length,
    faithful: buckets.faithful,
    drift: buckets.drift,
    unverified: buckets.unverified,
    degraded: buckets.drift + buckets.unverified,
    missing: buckets.missing,
    toolFilterChecked: checks.filter((check) => check.found && check.toolFilter !== null).length,
    toolFilterMissing: checks.filter((check) => check.found && check.toolFilter === null).length,
  };
  return { ...report, checks, summary };
}
