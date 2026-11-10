import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  findAgencyAssets,
  planAgencyLibrary,
  readAgencyExperts,
  writeAgencyLibrary,
} from "../lib/agency.js";

function scratch() {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), "agency-test-"));
}

function writeExpert(dir, domain, slug, { name, description, body }) {
  const target = nodePath.join(dir, "assets", "agency-agents-zh", domain);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    nodePath.join(target, `${slug}.md`),
    `---\nname: "${name}"\ndescription: "${description}"\nemoji: "🎯"\ncolor: "#fff"\n---\n\n${body}\n`,
  );
}

test("agency：从包目录找到 assets，读到 name/description/正文与哈希", () => {
  const pkg = scratch();
  writeExpert(pkg, "hr", "hr-recruiter", { name: "招聘专家", description: "全流程招聘", body: "你是招聘专家。" });
  const found = findAgencyAssets(pkg);
  assert.equal(found.ok, true);
  assert.equal(found.lang, "zh");
  const { experts, diagnostics } = readAgencyExperts(found.dir);
  assert.equal(diagnostics.length, 0);
  assert.equal(experts.length, 1);
  assert.equal(experts[0].domain, "hr");
  assert.equal(experts[0].slug, "hr-recruiter");
  assert.equal(experts[0].name, "招聘专家");
  assert.match(experts[0].sha256, /^[0-9a-f]{64}$/);
});

test("agency：领域内按 24 人分块，角色带来源注记，超预算的专家被跳过并给原因", () => {
  const pkg = scratch();
  for (let index = 0; index < 30; index += 1) {
    writeExpert(pkg, "engineering", `engineer-${String(index).padStart(2, "0")}`, {
      name: `工程师 ${index}`,
      description: "写代码",
      body: `你是第 ${index} 位工程师。`,
    });
  }
  writeExpert(pkg, "engineering", "too-long", {
    name: "太长",
    description: "超预算",
    body: "字".repeat(13000),
  });
  const found = findAgencyAssets(pkg);
  const { experts } = readAgencyExperts(found.dir);
  const plan = planAgencyLibrary(experts, { spaceId: "agency-test" });
  assert.equal(plan.stats.experts, 31);
  assert.equal(plan.stats.roles, 30);
  assert.equal(plan.stats.rosters, 2);
  assert.equal(plan.skipped, 1);
  assert.ok(plan.diagnostics.some((item) => item.code === "agency-too-long"));
  const first = plan.rosters.find((item) => item.path.includes("agency-engineering-1/"));
  assert.ok(first.text.includes("as: engineer-00"));
  assert.equal((first.text.match(/  - as: /g) ?? []).length, 24);
  const second = plan.rosters.find((item) => item.path.includes("agency-engineering-2/"));
  assert.equal((second.text.match(/  - as: /g) ?? []).length, 6);
  const role = plan.roles.find((item) => item.path.endsWith("agency-engineer-00/AGENT.md"));
  assert.ok(role.text.includes("name: agency-engineer-00"));
  assert.ok(role.text.includes("hr") === false);
  assert.match(role.text, /sha256:[0-9a-f]{12}/);
});

test("agency：8000-12000 字的正文拆成 parts/rest.md 并声明 prompt.parts", () => {
  const pkg = scratch();
  writeExpert(pkg, "research", "long-expert", {
    name: "长专家",
    description: "正文超 8000 但不到 12000",
    body: `${"第一段。".repeat(1500)}\n\n${"第二段。".repeat(700)}`,
  });
  const found = findAgencyAssets(pkg);
  const { experts } = readAgencyExperts(found.dir);
  const plan = planAgencyLibrary(experts, { spaceId: "agency-test" });
  assert.equal(plan.stats.roles, 1);
  const agent = plan.roles.find((item) => item.path.endsWith("/AGENT.md"));
  assert.match(agent.text, /prompt:\n  parts:\n    - parts\/rest\.md/);
  const part = plan.roles.find((item) => item.path.endsWith("/parts/rest.md"));
  assert.ok(part !== undefined);
  assert.ok(part.text.length > 0);
});

test("agency：目标库非空默认拒绝写；--force 才覆盖", () => {
  const pkg = scratch();
  writeExpert(pkg, "hr", "hr-recruiter", { name: "招聘专家", description: "全流程招聘", body: "你是招聘专家。" });
  const found = findAgencyAssets(pkg);
  const { experts } = readAgencyExperts(found.dir);
  const plan = planAgencyLibrary(experts, { spaceId: "agency-test" });
  const target = nodePath.join(scratch(), "agency-test");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(nodePath.join(target, "README.md"), "已有内容\n");
  const refused = writeAgencyLibrary(target, plan, { force: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "target-not-empty");
  const written = writeAgencyLibrary(target, plan, { force: true });
  assert.equal(written.ok, true);
  assert.ok(fs.existsSync(nodePath.join(target, "space.yaml")));
  assert.ok(fs.existsSync(nodePath.join(target, "roles/agency-hr-recruiter/AGENT.md")));
  assert.ok(fs.existsSync(nodePath.join(target, "NOTICE-agency.txt")));
  assert.equal(fs.readFileSync(nodePath.join(target, "space.yaml"), "utf8").includes("rosters:"), true);
});
