#!/usr/bin/env node
/**
 * 本机栈验证：edge → gateway → channels（若启用）→ 原生 PM node；enhance 模式另检 Docker code-server。
 * 安装根：LINKAGENT_HOME 或 cwd。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function installRoot() {
  const env = process.env.LINKAGENT_HOME?.trim();
  return resolve(env || process.cwd());
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), status: r.status ?? 1 };
}

function curlOk(url) {
  const r = run("curl", ["-sS", "-m", "3", "-o", "NUL", "-w", "%{http_code}", url], { shell: process.platform === "win32" });
  const code = parseInt(r.out, 10);
  return Number.isFinite(code) && code >= 200 && code < 400;
}

function dockerRunning(name) {
  const r = run("docker", ["inspect", "-f", "{{.State.Running}}", name]);
  return r.ok && r.out === "true";
}

const root = installRoot();
const state = join(root, ".runtime-state");
let failed = 0;

function line(label, ok, detail) {
  const mark = ok ? "OK" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
}

console.log(`安装根: ${root}\n`);

const listenFile = join(state, "gateway", "listen-port.json");
let gwPort = 8787;
const listenRec = existsSync(listenFile) ? readJson(listenFile) : null;
if (listenRec?.port >= 1 && listenRec.port <= 65535 && pidAlive(listenRec.pid)) {
  gwPort = listenRec.port;
} else {
  const portScript = join(root, "scripts", "dev-resolve-gateway-port.mjs");
  if (existsSync(portScript)) {
    const r = run(process.execPath, [portScript], { cwd: root });
    if (r.ok && r.out) gwPort = parseInt(r.out, 10) || 8787;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const apisix = dockerRunning("linkagent-edge-agent-linker-apisix-1") || dockerRunning("linkagent-edge-apisix-1");
line("edge APISIX 容器", apisix, apisix ? "9080 数据面" : "pnpm edge:start");

const frpsPid = join(state, "edge", "frps.pid");
const frpsUp = existsSync(frpsPid);
line("edge frps（宿主机）", frpsUp, frpsUp ? `pid 文件 ${frpsPid}` : "随 edge start 拉起");

const gwHealth = curlOk(`http://127.0.0.1:${gwPort}/healthz`);
line("gateway（宿主机 Node）", gwHealth, `http://127.0.0.1:${gwPort}/ （resolve-gateway-port）`);

if (listenRec) {
  line(
    "gateway listen-port.json",
    listenRec.port === gwPort && pidAlive(listenRec.pid),
    `port=${listenRec.port} configured=${listenRec.configuredPort} pid=${listenRec.pid}`,
  );
}

const verifyMode = (process.env.LINKAGENT_STACK_VERIFY_MODE ?? "").trim().toLowerCase();
const enhanceMode = verifyMode === "enhance";
const dockerMode = verifyMode === "enhance-docker";

const nodeC = dockerRunning("linkagent-node");
const codeWeb = dockerRunning("linkagent-code-serve-web");
const pmNodeFile = join(state, "pm", "node.pid");
const pmNodePid = readPidFile(pmNodeFile);
const pmNodeUp = pmNodePid != null && pidAlive(pmNodePid);

if (dockerMode) {
  line("edge enhance（APISIX 容器）", apisix, apisix ? "9080 数据面" : "pnpm edge:restart");
  line("Docker 模式 linkagent-node", nodeC, nodeC ? "运行中" : "pnpm local:stack:start:enhance:docker");
  line("单机 PM node 应停止", !pmNodeUp, pmNodeUp ? "pnpm pm:stop node" : "OK");
  line("单机 code-server 容器应关闭", !codeWeb, codeWeb ? "compose down ide-proxy" : "OK");
} else if (enhanceMode) {
  line("edge enhance（APISIX 容器）", apisix, apisix ? "9080 数据面" : "pnpm edge:restart");
  line("单机模式 PM node", pmNodeUp, pmNodeUp ? `pid ${pmNodePid}` : "pnpm local:stack:start:enhance");
  line("单机模式 code-server（8010）", codeWeb, codeWeb ? "linkagent-code-serve-web" : "需 LINKAGENT_LOCAL_STACK_ENHANCE");
  line("Docker 模式节点应关闭", !nodeC, nodeC ? "pnpm node:docker:stop" : "OK");
} else {
  line("PM 原生 node", pmNodeUp, pmNodeUp ? `pid ${pmNodePid}` : "pnpm --filter @linkagent/backend pm:restart node");
  line("Docker 模式节点应关闭", !nodeC, nodeC ? "pnpm node:docker:stop" : "OK");
  if (codeWeb) {
    line("Docker code-server（可选 enhance）", true, "enhance 模式或 serveWeb.enabled 时预期运行");
  }
}

const channelsWanted = channelsRequired(root);
const channelsPidFile = join(state, "pm", "channels.pid");
const channelsPid = readPidFile(channelsPidFile);
const channelsUp = channelsPid != null && pidAlive(channelsPid);
if (channelsWanted) {
  line(
    "channels（宿主机 PM，channel-gateway）",
    channelsUp,
    channelsUp ? `pid ${channelsPid}，日志 .runtime-state/pm/channels.log` : "pnpm --filter @linkagent/backend pm:restart channels",
  );
} else {
  line(
    "channels（可选）",
    true,
    "config 未启用 channelGateway 且无微信账号，不要求运行",
  );
}

const apisixRoutes = run("curl", ["-sS", "-m", "3", "-H", "X-API-KEY: " + (readAdminKey(root) || ""), "http://127.0.0.1:9180/apisix/admin/routes"]);
if (readAdminKey(root)) {
  const total = apisixRoutes.ok && apisixRoutes.out.includes('"total"')
    ? JSON.parse(apisixRoutes.out).total
    : null;
  line("APISIX 路由已同步", total != null && total > 0, total != null ? `routes=${total}` : "需 gateway 启动后 sync");
} else {
  line("APISIX 路由", false, "无 apisix.admin-key");
}

console.log("");
if (failed === 0) {
  const ch = channelsWanted ? " → channels" : "";
  const mode = enhanceMode ? "enhance（含 Docker IDE）" : "原生 node";
  console.log(`验证通过：edge → gateway${ch} → ${mode}。`);
  process.exit(0);
}
console.log(`验证未通过：${failed} 项。顺序建议 pnpm local:stack:restart`);
process.exit(1);

function readAdminKey(r) {
  const p = join(r, ".runtime-state", "edge", "apisix.admin-key");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8").trim();
}

function readPidFile(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  const pid = parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** 与 supervisor Manager.isEnabled('channels') 对齐的粗判（仅读 config/*.yaml） */
function channelsRequired(rootDir) {
  const cgPath = join(rootDir, "config", "channels.yaml");
  if (existsSync(cgPath)) {
    const text = readFileSync(cgPath, "utf8");
    const block = text.match(/channelGateway:\s*\n([\s\S]*?)(?=^\S|\s*$)/m);
    if (block && /^\s+enabled:\s*true\s*$/m.test(block[1])) return true;
  }
  const wxPath = join(rootDir, "config", "weixin.yaml");
  if (!existsSync(wxPath)) return false;
  const wx = readFileSync(wxPath, "utf8");
  if (/^\s*enabled:\s*false\s*$/m.test(wx.replace(/^weixin:\s*\n/m, ""))) return false;
  return /accounts:\s*\n\s+-\s+\S/m.test(wx) || /^\s+accountId:\s*\S/m.test(wx);
}
