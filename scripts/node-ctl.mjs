#!/usr/bin/env node
/**
 * 跨平台调度。默认原生：Unix 走 scripts/node.sh，Windows 走 scripts/node.ps1。
 * Docker：--docker，或 LINKAGENT_NODE_RUNTIME=docker。--native 强制原生。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(dir);

export const NODE_LAUNCH_HELP = `用法
  pnpm node [命令] [实例名]
  pnpm node -- [--native|--docker]
  pnpm node:help

命令（缺省 start）
  start [name]        后台启动。name 只对原生生效，用来再开一个本机实例
  stop [name]         停止
  restart [name]      重启
  status [name]       状态。原生不带 name 时列出全部实例
  log [name]          跟随日志
  foreground [name]   前台运行，Ctrl-C 停止。等价 pnpm node:dev
  build               只在 Docker 时重新构建镜像 linkagent-node:local

运行方式（默认 native）
  --native                      本机进程
  --docker                      Docker 聚合镜像。本机没有镜像时先构建
  LINKAGENT_NODE_RUNTIME        native 或 docker。命令行开关优先于这个环境变量

连接参数（原生读环境变量和 node.yaml；Docker 读 code-server/node-docker/node.env。已有环境变量优先）
  LINKAGENT_GATEWAY_URL         回连地址，例如 ws://127.0.0.1:8787。容器里可用 host.docker.internal
  LINKAGENT_GATEWAY_TOKEN       nt_ 机器凭证。不能填 pat_、任务 key（k_）或申明码（nu_）
  LINKAGENT_NODE_CLAIM          nu_ 归属申明码，只用于匿名申请，不能当作 TOKEN
  LINKAGENT_NODE_NAME           节点展示名
  LINKAGENT_NODE_AGENTS         逗号分隔的 agent，例如 pi
  LINKAGENT_NODE_ID             指定节点 id。缺省由网关签发并记住
  LINKAGENT_NODE_VERBOSE        设为 1 时打印 turn 文本预览

仅 Docker
  ARK_API_KEY                   模型密钥，启动时注入，不写进镜像
  FRPS_TOKEN                    不填则用 LINKAGENT_GATEWAY_TOKEN（nt_）。每台节点一枚
  FRPS_SERVER_ADDR              frps 地址，缺省 host.docker.internal
  FRPS_SERVER_PORT              frpc 控制口，缺省 7000
  LINKAGENT_IDE_DOMAIN          code-server，缺省 ide.localhost:7080
  LINKAGENT_DEV_DOMAIN          工作区 dev，缺省 dev.localhost:7080，容器内 5173
  LINKAGENT_VNC_DOMAIN          noVNC，缺省 vnc.localhost:7080，容器内 6080
  LINKAGENT_WORKSPACE           宿主机任务根，缺省 code-server/node-docker/workspace
  LINKAGENT_NODE_USER           用户名。Docker 只挂载 <workspace>/<用户>，node 在这一层启动
  LINKAGENT_AGENT_HOME          宿主机 agent 配置目录，缺省 ~/.pi，挂到容器 /root/.pi
  LINKAGENT_NODE_IMAGE          镜像名，缺省 linkagent-node:local

示例
  pnpm node
  pnpm node start builder-01
  pnpm node:status
  pnpm node -- --docker
  pnpm node:stop -- --docker
  pnpm node:docker:build
`;

export function resolveNodeLaunch(argv, envRuntime) {
  if (argv.some((arg) => arg === "help" || arg === "--help" || arg === "-h")) return { help: true };
  const dockerFlag = argv.includes("--docker");
  const nativeFlag = argv.includes("--native");
  if (dockerFlag && nativeFlag) return { error: "不能同时指定 --docker 和 --native" };
  const rest = argv.filter((arg) => arg !== "--docker" && arg !== "--native");
  const fromEnv = (envRuntime ?? "").trim().toLowerCase();
  let runtime = "native";
  if (dockerFlag) runtime = "docker";
  else if (nativeFlag) runtime = "native";
  else if (fromEnv === "docker" || fromEnv === "native") runtime = fromEnv;
  else if (fromEnv) return { error: "LINKAGENT_NODE_RUNTIME 只能是 native 或 docker" };
  return { runtime, args: rest.length > 0 ? rest : ["start"] };
}

function spawnNode(launch) {
  const isWin = process.platform === "win32";
  const child = launch.runtime === "docker"
    ? spawn(process.execPath, [path.join(repo, "code-server", "node-docker", "ctl.mjs"), ...launch.args], {
        stdio: "inherit",
      })
    : isWin
      ? spawn(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "node.ps1"), ...launch.args],
          { stdio: "inherit", windowsHide: false },
        )
      : spawn("bash", [path.join(dir, "node.sh"), ...launch.args], { stdio: "inherit" });
  child.on("error", (err) => {
    console.error(err.message);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}

const self = fileURLToPath(import.meta.url);
const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (self === entry) {
  const launch = resolveNodeLaunch(process.argv.slice(2), process.env.LINKAGENT_NODE_RUNTIME);
  if (launch.help) {
    console.log(NODE_LAUNCH_HELP);
    process.exit(0);
  }
  if (launch.error) {
    console.error(launch.error);
    process.exit(1);
  }
  spawnNode(launch);
}
