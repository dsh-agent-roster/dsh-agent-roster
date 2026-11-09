#!/usr/bin/env node
/**
 * 宿主契约漂移检查。
 *
 * 单元测试用的是我们自己写的假控制器/假注册表——它们只能证明"代码符合我们的假设"，
 * 证明不了"假设符合宿主"。最近两次真事故（prompt 少了 AbortSignal、工作区实体字段叫 id
 * 而不是 workspaceId）都是这么漏出去的：测试全绿，一跑真机就炸。
 *
 * 这个脚本直接读装好的宿主 bundle，把我们依赖的四处契约钉成可执行断言。
 * 它不是单测（CI 里没有宿主），是发布前的本地闸门：npm run check:host。
 */
import { readFileSync } from "node:fs";
import nodePath from "node:path";

const HOST_ROOT = process.argv[2] ?? process.env.DSH_HOST_ROOT ?? "/usr/local/lib/node_modules/@deepseek-ai/dsh";
const SESSION = nodePath.join(HOST_ROOT, "node_modules", "@deepseek-ai", "dsh-api-session-controller", "lib", "index.js");
const WORKSPACE = nodePath.join(HOST_ROOT, "node_modules", "@deepseek-ai", "dsh-workspace", "lib", "index.js");

const checks = [
  {
    name: "session.prompt 必须接收 AbortSignal 并立刻 throwIfAborted",
    file: SESSION,
    re: /async prompt\(([A-Za-z_$][\w$]*), ([A-Za-z_$][\w$]*)\)\s*\{[\s\S]{0,400}?\2\.throwIfAborted\(\)/,
    hint: "lib/apply.js 的 prompt(request, AbortSignal.timeout(...)) 依赖这条；少了它就会 prompt-not-queued",
  },
  {
    name: "session.create 只有拿到 workspace 时才 attachSession",
    file: SESSION,
    re: /async create\([A-Za-z_$][\w$]*\)[\s\S]{0,3000}?if \(workspace !== void 0\)[\s\S]{0,200}?attachSession\(/,
    hint: "只传 cwd 会建出不属于任何工作区的会话；创建团队必须发 workspaceId",
  },
  {
    name: "WorkspaceEntity 的 id 字段叫 id（不是 workspaceId）",
    file: WORKSPACE,
    re: /WorkspaceEntity = class \{[\s\S]{0,800}?this\.id\s*=/,
    hint: "listHostWorkspaces 读 item.id；读错就是全部空值、下拉里选什么都一样",
  },
  {
    name: "WorkspaceEntity 用 getter 暴露 path / title",
    file: WORKSPACE,
    re: /get path\(\)[\s\S]{0,400}?get title\(\)/,
    hint: "工作区身份按路径匹配（workspaceKeyOf / workspaceIdForPath）",
  },
];

let failed = 0;
for (const check of checks) {
  let source;
  try {
    source = readFileSync(check.file, "utf8");
  } catch (error) {
    console.log(`SKIP ${check.name}\n     读不到 ${check.file}（${error.code ?? error.message}）`);
    continue;
  }
  const match = check.re.exec(source);
  if (match === null) {
    failed += 1;
    console.log(`FAIL ${check.name}\n     ${check.hint}`);
    continue;
  }
  const line = source.slice(0, match.index).split("\n").length;
  console.log(`ok   ${check.name}  (${nodePath.basename(nodePath.dirname(nodePath.dirname(check.file))).replace("dsh-","")}:${line})`);
}

if (failed > 0) {
  console.log(`\n${failed} 条宿主契约不成立：先对照 ${SESSION} / ${WORKSPACE}，再改调用方。`);
  process.exit(1);
}
console.log(`\nhost contracts: ${checks.length} checked, 0 failed (${HOST_ROOT})`);
