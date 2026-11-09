/**
 * 宿主模型目录：只报"宿主真的声明了的模型"，读不到就是空。
 *
 * 这条目录存在的理由：档案里的 `captain.route` 是作者那台部署的模型，
 * 换机器后可能不存在；面板要在提交前把可选模型列出来，而不是提交后报
 * `model-not-applied`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { listHostModels, modelIsAvailable } from "../lib/host-models.js";

const llm = {
  listProviders() {
    return [
      { id: "tsing", displayName: "Tsing 内部网关" },
      { id: "empty", displayName: "没有模型的服务" },
      { name: "no-id" },
    ];
  },
  async listModels(provider) {
    if (provider === "tsing") {
      return [
        { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      ];
    }
    if (provider === "empty") return [];
    throw new Error("unknown provider");
  },
};

test("listHostModels：按宿主声明的 provider/模型列出，读不到的 provider 不伪造", async () => {
  const catalog = await listHostModels(llm);
  assert.deepEqual(
    catalog.map((entry) => entry.provider),
    ["empty", "tsing"],
  );
  const tsing = catalog.find((entry) => entry.provider === "tsing");
  assert.deepEqual(tsing.models.map((item) => item.id), ["deepseek-v4.1-flash", "deepseek-v4-pro"]);
  assert.equal(tsing.label, "Tsing 内部网关");
});

test("listHostModels：没有 llm 服务时返回空数组（界面显示读不到，不编选项）", async () => {
  assert.deepEqual(await listHostModels(null), []);
  assert.deepEqual(await listHostModels({}), []);
});

test("listHostModels：某个 provider 抛错不影响其它 provider", async () => {
  const flaky = {
    listProviders: () => [{ id: "bad" }, { id: "tsing" }],
    listModels: async (provider) => {
      if (provider === "bad") throw new Error("boom");
      return [{ id: "deepseek-v4.1-flash", name: "flash" }];
    },
  };
  const catalog = await listHostModels(flaky);
  assert.deepEqual(catalog.map((entry) => [entry.provider, entry.models.length]), [["bad", 0], ["tsing", 1]]);
});

test("modelIsAvailable：只认 provider+model 同时命中", () => {
  const catalog = [{ provider: "tsing", models: [{ id: "deepseek-v4.1-flash" }] }];
  assert.equal(modelIsAvailable(catalog, { provider: "tsing", model: "deepseek-v4.1-flash" }), true);
  assert.equal(modelIsAvailable(catalog, { provider: "tsing", model: "deepseek-flash" }), false);
  assert.equal(modelIsAvailable(catalog, { provider: "deepseek-official", model: "deepseek-v4.1-flash" }), false);
  assert.equal(modelIsAvailable(catalog, {}), false);
});
