#!/usr/bin/env node
/**
 * 打印已登记 node 与各任务的浏览器入口 + 本机/SaaS 转发链路（只读 config 与 .runtime-state）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.env.LINKAGENT_HOME?.trim() || process.cwd());
const state = join(root, ".runtime-state");
const FRPS_VHOST = 7080;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readEdgePublic() {
  const gw = join(root, "config", "gateway.yaml");
  let host = "ide.localhost";
  let port = 9080;
  if (existsSync(gw)) {
    const t = readFileSync(gw, "utf8");
    const hm = t.match(/^\s*publicHost:\s*(\S+)/m);
    const pm = t.match(/^\s*publicPort:\s*(\d+)/m);
    if (hm) host = hm[1].replace(/["']/g, "");
    if (pm) port = parseInt(pm[1], 10) || port;
  }
  return { host, port };
}

function isSaasHost(host) {
  const text = host.trim().toLowerCase().replace(/\.$/, "");
  if (!text || text === "localhost" || text.endsWith(".localhost")) return false;
  return true;
}

function origin(host, port) {
  if (port === 443) return `https://${host}`;
  if (port === 80) return `http://${host}`;
  return `http://${host}:${port}`;
}

function taskPath(taskId, kind) {
  const id = taskId.trim();
  return id ? `/${id}-${kind}` : "";
}

function dockerRunning(name) {
  const r = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name], {
    encoding: "utf8",
    windowsHide: true,
  });
  return r.status === 0 && r.stdout.trim() === "true";
}

function dockerFrpcSummary() {
  if (!dockerRunning("linkagent-node")) return null;
  const r = spawnSync(
    "docker",
    ["exec", "linkagent-node", "sh", "-c", "cat /etc/linkagent/frpc.toml 2>/dev/null; echo '---ENV---'; env"],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 },
  );
  if (r.status !== 0) return null;
  const [toml, envBlock] = r.stdout.split("---ENV---");
  const env = {};
  for (const line of (envBlock || "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  const taskIds = [...toml.matchAll(/locations\s*=\s*\["\/([^"/]+)/g)].map((m) => m[1].replace(/-code$|-web$|-vnc$/, "").replace(/-.+$/, ""));
  const domains = [...toml.matchAll(/customDomains\s*=\s*\["([^"]+)"/g)].map((m) => m[1]);
  return { toml: toml.trim(), env, domains: [...new Set(domains)], taskIds: [...new Set(taskIds.filter(Boolean))] };
}

function listNodes() {
  const dir = join(state, "nodes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const rec = readJson(join(dir, f));
      if (!rec) return null;
      return {
        nodeId: rec.nodeId,
        name: rec.name,
        status: rec.status,
        lastSeenAt: rec.lastSeenAt,
        disabled: rec.disabled === true,
      };
    })
    .filter(Boolean);
}

function collectTasks() {
  const dir = join(state, "tasks");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const data = readJson(join(dir, f));
    if (!data?.tasks?.length) continue;
    for (const t of data.tasks) {
      out.push({
        id: t.id,
        name: t.name ?? "",
        nodeId: t.nodeId ?? "local",
        agentId: t.agentId,
        cwd: t.cwd,
        owner: data.ownerUsername || data.userId,
        channel: data.channel,
        active: data.activeTaskId === t.id,
      });
    }
  }
  return out;
}

function printLocalChains(edge, task) {
  const { host, port } = edge;
  const id = task.id;
  const base = origin(host, port);
  const rows = [
    {
      kind: "web (dev)",
      url: `${base}${taskPath(id, "web")}`,
      chain: [
        `浏览器 → APISIX :9080 Host=${host} 路径 ${taskPath(id, "web")}*`,
        `→ frps HTTP :${FRPS_VHOST}（改写 Host=dev.localhost，去掉 /${id}-web 前缀）`,
        `→ frpc 登记 dev.localhost → 节点 127.0.0.1:5173（switchTask 工作区 npm/vite dev）`,
      ],
    },
    {
      kind: "dev 直达",
      url: `${base}/${id}`,
      chain: [
        `浏览器 → APISIX 路径 /${id}*（优先级低于 -code/-vnc）`,
        `→ 同上 dev.localhost → :5173`,
      ],
    },
    {
      kind: "code (IDE)",
      url: `${base}${taskPath(id, "code")}`,
      chain: [
        `浏览器 → APISIX 路径 ${taskPath(id, "code")}*`,
        `→ frps（Host=ide.localhost，去掉 /${id}-code 前缀）`,
        `→ frpc ide.localhost → 127.0.0.1:8080（形态 C 容器内 code-server）`,
      ],
    },
    {
      kind: "vnc",
      url: `${base}${taskPath(id, "vnc")}/vnc.html`,
      chain: [
        `浏览器 → APISIX 路径 ${taskPath(id, "vnc")}*`,
        `→ frps（Host=vnc.localhost）`,
        `→ frpc vnc.localhost → 127.0.0.1:6080（noVNC）`,
      ],
    },
    {
      kind: "agent /v1",
      url: `(无浏览器) nodeId=${task.nodeId} → 网关 WS /v1`,
      chain: [
        task.nodeId === "local"
          ? "本机 ACP：任务 cwd 在网关进程或本地 pi/acpx"
          : `远程 node ${task.nodeId} WebSocket 回连 gateway，switchTask 切 cwd/dev`,
      ],
    },
  ];
  for (const r of rows) {
    console.log(`    [${r.kind}] ${r.url}`);
    for (const step of r.chain) console.log(`      · ${step}`);
  }
}

function printSaasChains(edge, task, frpcDomain) {
  const { host, port } = edge;
  const id = task.id;
  const pub = frpcDomain && frpcDomain !== host ? frpcDomain : host;
  const base = origin(pub, port);
  const rows = [
    {
      kind: "web / dev",
      url: `${base}/${id}-web 或 ${base}/${id}`,
      chain: [
        `浏览器 → APISIX Host=${host} 路径 /${id}* 或 /${id}-web*`,
        `→ frps :${FRPS_VHOST}（路径原样）`,
        `→ frpc locations ["/${id}", "/${id}-web"] domain=${pub} → :15173（saas 适配器）→ :5173`,
      ],
    },
    {
      kind: "code",
      url: `${base}/${id}-code`,
      chain: [
        `→ frpc location /${id}-code → :18080 → :8080 code-server`,
      ],
    },
    {
      kind: "vnc",
      url: `${base}/${id}-vnc`,
      chain: [`→ frpc location /${id}-vnc → :16080 → :6080`],
    },
  ];
  for (const r of rows) {
    console.log(`    [${r.kind}] ${r.url}`);
    for (const step of r.chain) console.log(`      · ${step}`);
  }
}

console.log(`安装根: ${root}\n`);

const edge = readEdgePublic();
const saas = isSaasHost(edge.host);
console.log(`网关 edge 配置: ${edge.host}:${edge.port}（${saas ? "SaaS 路径模式" : "本机 ide.localhost 三 Host 模式"}）\n`);

console.log("── 已登记 node ──");
const nodes = listNodes();
if (!nodes.length) console.log("  （无 .runtime-state/nodes/*.json）");
for (const n of nodes) {
  const seen = n.lastSeenAt ? new Date(n.lastSeenAt).toISOString() : "—";
  console.log(`  ${n.nodeId}  ${n.name ?? ""}  status=${n.status}  lastSeen=${seen}${n.disabled ? "  [disabled]" : ""}`);
}

console.log("\n── 运行中 linkagent-node 容器（形态 C）──");
const docker = dockerFrpcSummary();
if (!docker) {
  console.log("  未运行 linkagent-node（或 docker exec 失败）");
} else {
  console.log(`  LINKAGENT_GATEWAY_URL=${docker.env.LINKAGENT_GATEWAY_URL ?? "—"}`);
  console.log(`  LINKAGENT_PUBLIC_HOST=${docker.env.LINKAGENT_PUBLIC_HOST ?? "（空=本机三域名）"}`);
  console.log(`  LINKAGENT_TASK_ID=${docker.env.LINKAGENT_TASK_ID ?? "—"}`);
  console.log(`  FRPS=${docker.env.FRPS_SERVER_ADDR ?? "?"}:${docker.env.FRPS_SERVER_PORT ?? "7000"}`);
  if (docker.domains.length) console.log(`  frpc customDomains: ${docker.domains.join(", ")}`);
  if (docker.taskIds.length) console.log(`  frpc 当前登记任务: ${docker.taskIds.join(", ")}`);
  if (docker.env.LINKAGENT_PUBLIC_HOST && docker.env.LINKAGENT_PUBLIC_HOST !== edge.host) {
    console.log(
      `  ⚠ 容器公网域名 ${docker.env.LINKAGENT_PUBLIC_HOST} 与 gateway.yaml edge.publicHost=${edge.host} 不一致，浏览器入口以 gateway.yaml + APISIX 为准，frpc 以容器 env 为准。`,
    );
  }
  if (docker.env.LINKAGENT_GATEWAY_URL && !docker.env.LINKAGENT_GATEWAY_URL.includes(String(edge.port))) {
    const portFile = readJson(join(state, "gateway", "listen-port.json"));
    const gwPort = portFile?.port ?? 8787;
    if (!docker.env.LINKAGENT_GATEWAY_URL.includes(`:${gwPort}`)) {
      console.log(`  ⚠ 容器回连 ${docker.env.LINKAGENT_GATEWAY_URL} 与当前 gateway 监听端口 ${gwPort} 可能不一致。`);
    }
  }
}

const tasks = collectTasks();
console.log(`\n── 任务链路（共 ${tasks.length} 条，来自 .runtime-state/tasks/*.json）──\n`);
if (!tasks.length) {
  console.log("  无任务记录。");
  process.exit(0);
}

for (const t of tasks) {
  console.log(`▸ ${t.id}  「${t.name}」  owner=${t.owner}  channel=${t.channel}${t.active ? "  [active]" : ""}`);
  console.log(`  nodeId=${t.nodeId}  agent=${t.agentId}`);
  if (t.cwd) console.log(`  cwd=${t.cwd}`);
  if (saas) printSaasChains(edge, t, docker?.domains[0]);
  else printLocalChains(edge, t);
  console.log("");
}
