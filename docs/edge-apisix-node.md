# APISIX 边缘启动与 node 侧 frpc 注入

> 浏览器访问任务 web / code / VNC：`浏览器 → APISIX(:9080) → frps(:7080) → frpc（node 注入）→ 节点端口`。  
> 路由原理见 [`edge-frpc-apisix.md`](edge-frpc-apisix.md)。本文按 **单机 / SaaS** × **node 是否用 Docker** 给出配置与启停。

---

## 1. Local 模式 vs SaaS 模式（进程落在哪）

### Local（本机 / `ide.localhost`）

**推荐心智：业务进程由安装根命令在外部拉起；node 侧若需要浏览器 IDE，通常只有 code-server 这一个 Docker 容器。**

| 组件 | 谁管 / 怎么起 | Docker？ |
|---|---|---|
| gateway、channels、node 连接器 | `pnpm server:*`、`pm:restart channels/node`（或 `local:stack:start`） | **否**（宿主机 Node） |
| frps | `pnpm edge:start` | **否**（宿主机） |
| APISIX + etcd | `pnpm edge:start` | **是**（edge 数据面，与业务进程分开 compose） |
| 浏览器 code-server | 仅 **`start:enhance`** 或 `hostCodeServerCompose.enabled: true` | **是**（`linkagent-code-serve-web`，8010→8080；**镜像是为免本机安装 code-server**） |
| **frpc** | PM node 写 `.runtime-state/ide-proxy/frpc.toml`，**宿主机单进程** | **否**（与 gateway/node 一样外部管理；**不进 code-server 容器**） |
| dev / VNC | enhance 时由同一 IDE 容器映射 5173/6080 到回环；frpc 仍指宿主机这些口 | enhance 时进程在容器内，隧道在宿主机 frpc |

**不要**在 Local 推荐栈里再开 **`linkagent-node` 形态 C**（与 PM node 二选一）。`local:stack:start` 会主动 `node:docker:stop`。

### SaaS（公网 / `edge.publicHost` 非 `.localhost`）

**与 Local 相同：执行能力仍落在「执行机这一台宿主机」上**——agent、dev、frpc 无论是 PM 直跑还是装进 Docker，都是该机器上的 workload，不是网关进程里虚拟出来的远程运行时。

差别只在 **浏览器入口与 frpc 登记方式**（同域名 + `/<taskId>-web|code|vnc`，见 `renderSaasWorkspaceFrpc`），以及 node 环境变量 **`LINKAGENT_PUBLIC_HOST`** 必须与网关机 `gateway.yaml` 一致。网关机仍可能是：APISIX 在容器、frps 在宿主机。

---

## 2. 先分清：edge 与其它组件

### edge 怎么起（当前只有这一种）

**网关进程不会内嵌拉起 edge**，只写 `.runtime-state/edge/*` 并通过 Admin API 同步 APISIX 路由。对外 HTTP 入口 **必须**先单独起 edge：

| 步骤 | 命令（安装根） | 作用 |
|---|---|---|
| 首次构建 APISIX 镜像 | `pnpm edge:build` | `scripts/edge/Dockerfile` |
| 启停 | `pnpm edge:start` / `edge:stop` / `edge:restart` | Windows → `scripts/edge.ps1`，Unix → `scripts/edge.sh` |
| 状态 / 日志 | `pnpm edge:status` / `edge:log` | frps 日志 + APISIX compose 日志 |

edge 一次启动包含两部分：

| 组件 | Docker？ | 说明 |
|---|---|---|
| **APISIX + etcd** | **是** | Compose 项目（默认 `linkagent-edge-*`），数据面 **9080**，Admin **9180** |
| **frps** | **否** | 安装包解到 `.runtime-state/tools/frp/`，**宿主机进程**（7000 / 7080 / 7500） |

本机一键（**默认原生**）：`pnpm local:stack:start` = edge → gateway → channels → **PM node + 宿主机 frpc**（无 Docker IDE）。  
**enhance**（`pnpm local:stack:start:enhance`）：在默认原生栈上同时增强 **edge** 与 **code-server**（服务/端口速查见 [`local-stack-enhance.md`](local-stack-enhance.md)）：

| 能力 | 默认 `local:stack:start` | enhance |
|---|---|---|
| frps + APISIX | `edge:start` | `edge:build` → `edge:restart` → **`server:restart`**（重同步 APISIX 路由） |
| node | PM 原生 + **宿主机 frpc** | 同上 + **`LINKAGENT_LOCAL_STACK_ENHANCE=1`** |
| 浏览器 IDE | 无（仅 dev/vnc 隧道若本机有进程） | **仅** Docker **code-server:8010**；**frpc 宿主机共享**，**9080 仅** `/<taskId>-code`（`/vibe-ide` 只在网关 `/ui` 同源） |
| 桌面 VS Code | 直接打开任务 `cwd` | 同左；enhance 不负责桌面版 |

**桌面 VS Code / Cursor**：不经过本仓库隧道；浏览器入口才依赖 enhance 或 `hostCodeServerCompose.enabled: true`。  
验证：`pnpm local:stack:verify` / `local:stack:status`。

### 其它进程

| 组件 | Docker？ | 说明 |
|---|---|---|
| **gateway** | **否** | `pnpm server:*`、`pnpm dev` 或 dist `start.bat` |
| **channels** | **否** | PM 托管 `channel-gateway`（企微/飞书/微信 ilink）；`pnpm --filter @linkagent/backend pm:restart channels`；**无 HTTP 健康检查**，验证看 pid/日志 |
| **node 执行面** | **形态 C：一个聚合容器** | `pnpm node:docker`（node + code-server + dev + frpc）；与 edge 的 APISIX 栈 **不是**同一个 compose |

**node 的三种形态**（与单机/SaaS 正交）：

| 形态 | 命令 / 条件 | IDE + VNC + frpc |
|---|---|---|
| **A. 全原生** | `pnpm node:start`，`hostCodeServerCompose.enabled: false` | 无浏览器 IDE 隧道（仅 WS 回连网关跑 agent） |
| **B. 原生 node + Docker IDE** | `pnpm node:start`，`hostCodeServerCompose.enabled: true` | node 写 `frpc.toml`，**docker compose** 只起 `linkagent-code-serve-web` |
| **C. Docker 聚合节点** | `pnpm node:docker` / `LINKAGENT_NODE_RUNTIME=docker` | 镜像 `linkagent-node:local` 内 IDE+VNC+frpc；`LINKAGENT_NODE_SERVE_WEB=0`，node 只写 `/etc/linkagent/frpc.toml` |

**单机 vs SaaS**（由 **网关机** `config/gateway.yaml` → `edge.publicHost` 决定；**执行机仍是宿主机**，见 §1）：

| 模式 | `edge.publicHost` 示例 | APISIX | frpc 登记 |
|---|---|---|---|
| **单机（本机入口）** | `ide.localhost` | Host/路径原样进 frps | 同 Host + `locations`（默认）；可选 legacy 三 Host（`LINKAGENT_FRPC_LEGACY_HOSTS=1`） |
| **SaaS（公网入口）** | `hubide.example.com` | 同上 | node **`LINKAGENT_PUBLIC_HOST`** 与 `edge.publicHost` 一致（不设则本机默认 `ide.localhost`） |

代码判定：`shared/src/task-host.ts` 的 `isSaasPublicHost()`（`.localhost` → 单机，否则 SaaS）。

---

## 3. 四象限总览

```
                    │  node 非 Docker（A/B）     │  node Docker 聚合（C）
────────────────────┼──────────────────────────┼──────────────────────────
单机 gateway+node   │  §3.1 开发机联调           │  §3.2 本机隔离执行环境
同机                │  B：compose 仅 code-server │  pnpm node:docker
────────────────────┼──────────────────────────┼──────────────────────────
SaaS 网关机+远程node│  §4.1 远程裸机 / dist 包   │  §4.2 远程标准执行机（推荐）
                    │  B：远程 Docker 只跑 IDE   │  镜像 + node.env
```

**任意象限网关机侧相同顺序**：

1. `bash scripts/edge.sh build`（首次）→ `bash scripts/edge.sh start`  
2. `pnpm server:start`（**APISIX 已监听 9180** 后再起或重启 gateway，以便同步路由）  
3. 按象限起 node（下表）

| 象限 | node 启动 | frps 令牌 |
|---|---|---|
| 单机 + 非 Docker B | `pnpm image:code-server` → `pnpm node:start` | 读安装根 `.runtime-state/edge/frps.token`；`FRPS_SERVER_ADDR=127.0.0.1` |
| 单机 + Docker C | `pnpm node:docker:build` → `pnpm node:docker` | `node.env` 中 `FRPS_SERVER_ADDR=host.docker.internal`，必要时 `FRPS_TOKEN=` 粘贴 token |
| SaaS + 非 Docker B | 执行机 `pnpm node:start` 或 dist `start.sh` | **必须** `FRPS_TOKEN` + `FRPS_SERVER_ADDR` + `LINKAGENT_PUBLIC_HOST` |
| SaaS + Docker C | 执行机 `pnpm node:docker` | 同上 + `LINKAGENT_NODE_SERVE_WEB=0` |

---

## 4. 单机方案（gateway 与 node 同一安装根或同一台机）

### 3.1 单机 + 形态 C 聚合节点（推荐：命令启停、任务 switchTask + dev）

网关机与 §3.2 相同；**执行面**不拆 PM node 与 IDE compose，一条命令：

```bash
pnpm node:docker:build   # 首次
pnpm node:docker         # 或 pnpm local:stack:start（edge → gateway → node:docker）
```

配置 `code-server/node-docker/node.env`（从 `node.env.example` 复制）：`LINKAGENT_GATEWAY_URL=ws://host.docker.internal:8787`、`FRPS_*` 指向本机 edge、`LINKAGENT_WORKSPACE` 指向安装根下 `.runtime-state/tasks-workspace`。**不要**设 SaaS 的 `LINKAGENT_PUBLIC_HOST`（保持 `ide.localhost` 三 Host）。

`config/node.yaml` 中 **`hostCodeServerCompose.enabled: false`**，避免 PM 再起第二个 IDE 容器。任务 dev / code / VNC 与 frpc 均在 **`linkagent-node`** 容器内，由 node 收 **`switchTask`**（`LINKAGENT_DEV_BY_NODE=1`，入口已设）。

浏览器仍走 `http://ide.localhost:9080/<taskId>-web|code|vnc`；**不**依赖宿主机映射 8010/5173（隧道经 frps）。

---

### 3.1b 单机 + node 非 Docker（形态 B，IDE 单独 compose）

**网关** `config/gateway.yaml`：

```yaml
server:
  host: 127.0.0.1
  port: 8787
edge:
  publicHost: ide.localhost
  publicPort: 9080
```

**节点** `config/node.yaml`：

```yaml
enabled: true
hostCodeServerCompose:
  enabled: true
  image: linkagent-code-server:local
  host: 127.0.0.1
  port: 8010
  basePath: /vibe-ide
  # 形态 B 且 workspace 已在宿主机 npm install（含私服包）时：
  # useHostNodeModules: true
  # 形态 C（node 与其它进程全在容器）保持默认 false，在容器/镜像内 install。
```

**命令**（安装根 = 仓库根）：

```bash
bash scripts/edge.sh build && bash scripts/edge.sh start
pnpm image:code-server
pnpm server:start
pnpm node:start    # 或 pnpm restart:all（含 PM 托管 node）
```

**frpc 注入**：node 读 `.runtime-state/edge/frps.token`，写 `.runtime-state/ide-proxy/frpc.toml` 并挂进 IDE 容器；frpc 默认连 `127.0.0.1:7000`（未设 `FRPS_*` 时）。

**浏览器（9080）**：`http://ide.localhost:9080/<taskId>-code`（本机路由见 [`edge-frpc-apisix.md`](edge-frpc-apisix.md)）。

**形态 A**（不要 IDE 隧道）：`hostCodeServerCompose.enabled: false`，仅 `pnpm node:start` 回连网关；**不**写 frpc、**不**起 code-server 容器。

---

### 3.2 单机 + node Docker 聚合（形态 C）

网关 `edge` 与 §3.1 相同。网关在宿主机；**node 在容器**内回连与登记 frpc。

**配置** `code-server/node-docker/node.env`（复制 `node.env.example`）：

```env
LINKAGENT_GATEWAY_URL=ws://host.docker.internal:8787
FRPS_SERVER_ADDR=host.docker.internal
FRPS_SERVER_PORT=7000
FRPS_TOKEN=<粘贴 .runtime-state/edge/frps.token 内容>
LINKAGENT_NODE_SERVE_WEB=0
LINKAGENT_NODE_AGENTS=pi
LINKAGENT_NODE_USER=local
```

**不要**设置 `LINKAGENT_PUBLIC_HOST`（或勿设为公网域名），保持单机三 Host frpc。

**命令**：

```bash
bash scripts/edge.sh start
pnpm server:start
pnpm node:docker:build
pnpm node:docker
pnpm node:docker:status
pnpm node:docker:log
```

PM 里的 `pnpm restart:all` **不会**自动用 Docker node；Docker 节点与 PM node **二选一**（或 `node.yaml` 里 `enabled: false` 关掉 PM node）。

---

## 5. SaaS 方案（公网域名 + 远程执行机）

网关机与执行机分离；浏览器走 **HTTPS 域名**，执行机 **出站** `7000`（frpc）+ WS 连 gateway。

### 4.1 SaaS + node 非 Docker（形态 B 或 A）

**网关机** `config/gateway.yaml`：

```yaml
server:
  host: 0.0.0.0
  port: 8787
auth:
  mode: token
  token: "<强随机>"
edge:
  publicHost: hubide.example.com
  publicPort: 443
```

网关机：`edge.sh start` + `pnpm server:start`；SLB **443 → APISIX 9080**；对执行机开放 **7000**；分发 **`frps.token`**（≠ `nt_`）。

**远程执行机** — 环境文件（如 `.runtime-state/node.env` 或 systemd `Environment=`）：

```env
LINKAGENT_GATEWAY_URL=wss://hubide.example.com
LINKAGENT_GATEWAY_TOKEN=nt_xxxxxxxx
FRPS_SERVER_ADDR=<网关机 IP 或内网 LB>
FRPS_SERVER_PORT=7000
FRPS_TOKEN=<与网关机 frps.token 相同>
LINKAGENT_PUBLIC_HOST=hubide.example.com
```

**形态 B** 远程仍可在执行机装 Docker，仅用于 IDE：

```yaml
# 执行机 config/node.yaml
hostCodeServerCompose:
  enabled: true
  host: 127.0.0.1
  port: 8010
```

执行机本地**没有**网关的 `frps.token` 文件时，**必须** `FRPS_TOKEN` 环境变量；`frpcToken()` 不会用 `nt_` 作 frps 加密 token。

**SaaS 任务切换**：node 根据 `LINKAGENT_PUBLIC_HOST` 重写 frpc 的 `locations`（`publishSaasFrpc`）。容器单任务可加 `LINKAGENT_TASK_ID=<taskId>`。

**浏览器**：`https://hubide.example.com/<taskId>-code`（APISIX 不改路径，见 [`edge-frpc-apisix.md`](edge-frpc-apisix.md) SaaS 节）。

---

### 4.2 SaaS + node Docker 聚合（形态 C，推荐远程标准机）

网关机配置同 §4.1。执行机只跑容器，不装 pnpm  monorepo 亦可（使用 dist `linkagent-node` + 同目录 `node-docker`）。

**执行机** `code-server/node-docker/node.env`：

```env
LINKAGENT_GATEWAY_URL=wss://hubide.example.com
LINKAGENT_GATEWAY_TOKEN=nt_xxxxxxxx
FRPS_SERVER_ADDR=203.0.113.10
FRPS_SERVER_PORT=7000
FRPS_TOKEN=<frps.token>
LINKAGENT_PUBLIC_HOST=hubide.example.com
LINKAGENT_NODE_SERVE_WEB=0
LINKAGENT_NODE_AGENTS=pi
LINKAGENT_WORKSPACE=/data/linkagent-workspace
LINKAGENT_NODE_USER=alice
```

```bash
pnpm node:docker:build   # 或拉取预构建 linkagent-node:local
pnpm node:docker
docker logs -f linkagent-node
```

验证：网关机 frps 面板 `7500` 见远程 `workspace-*` 代理；浏览器打开任务 code/vnc 路径。

---

## 6. 角色与端口（通用）

| 组件 | 谁启动 | 作用 |
|---|---|---|
| gateway | `pnpm server:*` | 写 `.runtime-state/edge/`，Admin API 同步 APISIX |
| frps | `scripts/edge.sh start` | `7000` 控制 / `7080` HTTP vhost |
| APISIX | `edge.sh`（Docker） | `9080` 浏览器入口 / `9180` Admin |
| node | §3–§4 各象限 | 写 **frpc.toml**，不直接写 APISIX |

| 端口 | 说明 |
|---|---|
| `8787` | gateway `/v1` + 节点 WS |
| `9080` | APISIX 数据面 |
| `7000` | frpc → frps（执行机需能连网关机） |
| `7080` | APISIX → frps 上游 |
| `8010` | 宿主机 code-server 映射（形态 B，容器内 8080） |

**Windows（非开发 / 生产式）**：

| 步骤 | 命令（安装根 = 独立包目录或仓库根） |
|---|---|
| 一键本机 | `pnpm local:stack:start`（edge → gateway → **pm 重启 node**，含 hostCodeServerCompose + frpc） |
| 分步 | `pnpm edge:build`（首次）→ `pnpm edge:start` → `pnpm server:start` → `pnpm restart:all` 或 `pnpm --filter @linkagent/backend pm:restart node` |
| dist | `edge.bat start` + `start.bat start` |
| Docker 聚合 node | `pnpm node:docker`（与 PM node 二选一） |

脚本与 Linux 对齐：`scripts/edge.ps1` + `edge-ctl.mjs`（`edge.sh` 仍可在 Git Bash 使用）。需 **Docker Desktop**。

**停止顺序**：node → `bash scripts/edge.sh stop` → `pnpm server:stop`。

---

## 7. 常见问题

| 现象 | 排查 |
|---|---|
| `pnpm edge:build` 报 `failed to get console` | 已通过 `edge.ps1` 无控制台模式调用 docker；仍失败时在**本机 PowerShell** 执行 `pnpm edge:build` 或确认 Docker Desktop 已启动 |
| frpc 断线 / 无 `new proxy` | `FRPS_TOKEN` ≠ frps.toml；误用 `nt_` |
| APISIX 404 | 先 edge 再 gateway；或重启 gateway 触发 `syncTaskHosts` |
| SaaS 路径 404 | node 未设 `LINKAGENT_PUBLIC_HOST` 或与 `edge.publicHost` 不一致 |
| 单机 WebSocket 失败 | 必须经 **9080** 访问 `*.localhost:9080` |
| 同机两套 gateway | 各安装根独立 edge 状态；**7000/9080 仍只能一套** |

---

## 8. 相关文档

| 文档 | 内容 |
|---|---|
| [`local-stack-enhance.md`](local-stack-enhance.md) | Local `local:stack:start` / `start:enhance` 服务、端口、浏览器 URL |
| [`edge-frpc-apisix.md`](edge-frpc-apisix.md) | Host/路径、frpc 登记表、APISIX 路由表 |
| [`edge-startup.md`](edge-startup.md) | 工具下载、nat-tunnel（补充） |
| [`deployment.md`](deployment.md) | 网关/node 部署总览 |
| [`faq.md`](faq.md) | 同机多 gateway、Edge 端口 |
