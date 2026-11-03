/**
 * 找一份档案，而不是浏览一堆合集。
 *
 * 面板原来的组织单位是「合集」：先展开一个来源，再在里面翻。但真实任务几乎总是反向的——
 * 「我需要一个能盯数据质量的队伍」，先知道自己要什么，再去找谁有。所以这里把搜索做成
 * 一等能力：一个问题，横跨本机与所有订阅来源，命中的每一行都要说清**为什么命中**。
 *
 * 两条刻意的规则：
 * 1. **多词是「且」**：`data quality` 要求每个词都落在某个字段里，任一落空即不入选。
 *    否则「评分」会把一堆只沾了「分」的档案捞上来，搜索结果比列表更难读。
 * 2. **命中要有出处**：每行返回 `hits[{field,label,text}]`，界面直接显示「命中 标签：数据质量」。
 *    只给分数是没法解释的——用户凭什么信这一条排在前面。
 *
 * 纯函数：不读文件、不联网，输入就是已经装配好的档案视图。
 */

export const SEARCH_LIMIT = 20;

/** 字段权重：id 是名字，title 是自我描述，tags 是别人怎么找它。 */
export const SEARCH_FIELDS = [
  { field: "id", weight: 100, label: "档案 id" },
  { field: "title", weight: 56, label: "标题" },
  { field: "tags", weight: 48, label: "标签" },
  { field: "skills", weight: 40, label: "技能要求" },
  { field: "requires", weight: 36, label: "能力要求" },
  { field: "memberRole", weight: 34, label: "成员角色" },
  { field: "memberName", weight: 26, label: "成员名" },
  { field: "memberTitle", weight: 22, label: "成员标题" },
  { field: "description", weight: 18, label: "描述" },
  { field: "notes", weight: 12, label: "备注" },
];

const WEIGHT = new Map(SEARCH_FIELDS.map((item) => [item.field, item]));

/** 把一个词切成可比较的片段：空白与中文标点都算分隔。 */
export function tokenize(query) {
  if (typeof query !== "string") return [];
  return query
    .toLowerCase()
    .split(/[\s,，、;；|/]+/)
    .map((token) => token.trim())
    .filter((token) => token !== "");
}

function push(list, field, text) {
  if (typeof text !== "string") return;
  const value = text.trim();
  if (value === "") return;
  const meta = WEIGHT.get(field);
  if (meta === undefined) return;
  list.push({ field, label: meta.label, text: value, weight: meta.weight });
}

/**
 * 把一份档案摊成「可被搜到的字段」。同一字段里的多个值各自成条，
 * 这样「标签：数据质量」能精确指出是哪一条标签命中，而不是含糊地说"标签命中"。
 */
export function searchableFields(roster) {
  const fields = [];
  if (roster === null || typeof roster !== "object") return fields;
  push(fields, "id", roster.id);
  push(fields, "title", roster.title);
  push(fields, "description", roster.description);
  push(fields, "notes", roster.notes);
  for (const tag of Array.isArray(roster.tags) ? roster.tags : []) push(fields, "tags", tag);
  for (const member of Array.isArray(roster.members) ? roster.members : []) {
    push(fields, "memberName", member?.name);
    push(fields, "memberRole", member?.role);
    push(fields, "memberTitle", member?.title);
    for (const skill of Array.isArray(member?.skills) ? member.skills : []) push(fields, "skills", skill);
  }
  const requires = roster.requires !== null && typeof roster.requires === "object" ? roster.requires : null;
  if (requires !== null) {
    for (const skill of Array.isArray(requires.skills) ? requires.skills : []) push(fields, "skills", skill);
    for (const policy of Array.isArray(requires.toolPolicies) ? requires.toolPolicies : []) push(fields, "requires", policy);
  }
  return fields;
}

/**
 * 一条 token 落在哪个字段上最值钱。
 * 前缀命中与完全命中各加一点：搜 `data` 时 `data-quality` 应该排在 `reconcile-metadata` 前面。
 */
function bestMatch(token, fields) {
  let best = null;
  for (const item of fields) {
    const haystack = item.text.toLowerCase();
    const index = haystack.indexOf(token);
    if (index === -1) continue;
    let score = item.weight;
    if (index === 0) score += item.weight * 0.4;
    if (haystack === token) score += item.weight * 0.8;
    if (best === null || score > best.score) best = { score, item };
  }
  return best;
}

/**
 * @param {string} query
 * @param {{scope: "local" | "remote", roster: object, libraryId?: string|null,
 *          collectionId?: string|null, collectionTitle?: string|null, file?: string|null}[]} entries
 * @returns {{ok: true, q: string, tokens: string[], total: number,
 *            matches: {scope: string, rosterId: string, title: string, description: string,
 *                      tags: string[], members: number, libraryId: string|null,
 *                      collectionId: string|null, collectionTitle: string|null, file: string|null,
 *                      score: number, hits: {field: string, label: string, text: string}[]}[]}}
 */
export function searchRosters(query, entries, { limit = SEARCH_LIMIT } = {}) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return { ok: true, q: "", tokens: [], total: 0, matches: [] };

  const matches = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const roster = entry?.roster;
    if (roster === null || typeof roster !== "object") continue;
    const fields = searchableFields(roster);
    let score = 0;
    const hits = [];
    const seen = new Set();
    let complete = true;
    for (const token of tokens) {
      const found = bestMatch(token, fields);
      if (found === null) {
        complete = false;
        break;
      }
      score += found.score;
      if (!seen.has(found.item.field)) {
        seen.add(found.item.field);
        hits.push({ field: found.item.field, label: found.item.label, text: found.item.text });
      }
    }
    if (!complete) continue;
    const id = typeof roster.id === "string" ? roster.id : "";
    // 同名匹配下，短 id 更可能是"那一个"：`data-quality` 先于 `data-quality-and-observability-review`。
    score += Math.max(0, 24 - id.length);
    matches.push({
      scope: entry.scope === "remote" ? "remote" : "local",
      rosterId: id,
      title: typeof roster.title === "string" ? roster.title : "",
      description: typeof roster.description === "string" ? roster.description : "",
      tags: Array.isArray(roster.tags) ? roster.tags.slice(0, 6) : [],
      members: Array.isArray(roster.members) ? roster.members.length : 0,
      libraryId: entry.libraryId ?? null,
      collectionId: entry.collectionId ?? null,
      collectionTitle: entry.collectionTitle ?? null,
      file: entry.file ?? null,
      // 收藏与"已在本机"跟着条目走：搜索结果也要能直接收藏，不能只给标题。
      rootDir: entry.rootDir ?? entry.local?.rootDir ?? null,
      favorite: entry.favorite === true || entry.local?.favorite === true,
      installed: entry.scope === "local" || entry.local !== null,
      score: Math.round(score),
      hits,
    });
  }

  matches.sort((left, right) => right.score - left.score || left.rosterId.localeCompare(right.rosterId));
  return { ok: true, q: query.trim(), tokens, total: matches.length, matches: matches.slice(0, limit) };
}
