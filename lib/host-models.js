/**
 * 宿主里真正可用的模型目录。
 *
 * 为什么需要它：档案里写的 `captain.route`（provider/model）是**档案作者那一台**
 * 的部署，换一台机器就未必存在。`selectModel` 抛错后我们只能报 `model-not-applied`，
 * 用户拿到的是一句"失败"，看不出该选哪个——所以把宿主声明的模型列出来，
 * 让「创建团队」在提交前就能选，而不是提交后才发现。
 *
 * @module lib/host-models
 */

/** @typedef {{provider: string, label: string, models: {id: string, name: string}[]}} HostModelProvider */

function textOf(value, fallback = "") {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * 列出宿主可选的 provider 与模型。
 *
 * `llm` 缺席（例如在纯 CLI 里跑）时返回空数组——调用方据此显示"读不到模型目录"，
 * 不要伪造一个选项出来。
 *
 * @param {object|null|undefined} llm
 * @returns {Promise<HostModelProvider[]>}
 */
export async function listHostModels(llm) {
  if (!llm || typeof llm.listProviders !== "function" || typeof llm.listModels !== "function") return [];
  let providers = [];
  try {
    providers = llm.listProviders() ?? [];
  } catch {
    return [];
  }
  const result = [];
  for (const item of Array.isArray(providers) ? providers : []) {
    // 目录里的 provider 键就是 `id`（`LlmProviderInfo`）；没有 id 的条目不是可用路由，
    // 不能拿 name 顶替——那会造出一个宿主根本不认识的 provider。
    const provider = textOf(item?.id);
    if (provider === "") continue;
    let models = [];
    try {
      models = (await llm.listModels(provider)) ?? [];
    } catch {
      models = [];
    }
    result.push({
      provider,
      label: textOf(item?.displayName) || textOf(item?.name) || provider,
      models: (Array.isArray(models) ? models : [])
        .map((model) => ({ id: textOf(model?.id), name: textOf(model?.name) || textOf(model?.id) }))
        .filter((model) => model.id !== ""),
    });
  }
  return result.sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * 档案声明的模型是否在这份目录里。
 *
 * @param {HostModelProvider[]} catalog
 * @param {{provider?: string, model?: string}} route
 * @returns {boolean}
 */
export function modelIsAvailable(catalog, route) {
  const provider = textOf(route?.provider);
  const model = textOf(route?.model);
  if (provider === "" || model === "") return false;
  const found = catalog.find((entry) => entry.provider === provider);
  return found !== undefined && found.models.some((item) => item.id === model);
}
