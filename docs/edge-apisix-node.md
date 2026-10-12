# APISIX 边缘启动与 node 侧 frpc 注入

> 浏览器访问任务 web / code / VNC：`浏览器 → APISIX(:9080) → frps(:7080) → frpc（node 注入）→ 节点端口`。  
> 路由原理见 [`edge-frpc-apisix.md`](edge-frpc-apisix.md)。本文按 **单机 / SaaS** × **node 是否用 Docker** 给出配置与启停。

---

## 1. 先分清：谁一定用 Docker、谁不用

| 组件 | Docker？ | 说明 |
|---|---|---|
| **gateway / channels** | **否**（仓库现状） | Node 进程：`pnpm server:*`、`pnpm dev` 或 dist `start.bat` |
| **APISIX + etcd** | **是** | 仅 `scripts/edge.sh` 用 Compose 拉起；**与 node 是否 Docker 无关** |
| **frps** | **否** | 宿主机二进制，由 `edge.sh` 启动 |
| **node 连接器** | 可选 | 始终是 Node 进程；差异在 **IDE/VNC/frpc 是否进容器** |

**node 的三种形态**（与单机/SaaS 正交）：

| 形态 | 命令 / 条件 | IDE + VNC + frpc |
|---|---|---|
| **A. 全原生** | `pnpm node:start`，`serveWeb.enabled: false` | 无浏览器 IDE 隧道（仅 WS 回连网关跑 agent） |
| **B. 原生 node + Docker IDE** | `pnpm node:start`，`serveWeb.enabled: true` | node 写 `frpc.toml`，**docker compose** 只起 `linkagent-code-serve-web` |
| **C. Docker 聚合节点** | `pnpm node:docker` / `LINKAGENT_NODE_RUNTIME=docker` | 镜像 `linkagent-node:local` 内 IDE+VNC+frpc；`LINKAGENT_NODE_SERVE_WEB=0`，node 只写 `/etc/linkagent/frpc.toml` |

**单机 vs SaaS**（由 **网关机** `config/gateway.yaml` → `edge.publicHost` 决定，全链路一致）：

| 模式 | `edge.publicHost` 示例 | APISIX | frpc 登记 |
|---|---|---|---|
| **单机（本机入口）** | `ide.localhost` | 改 Host → `dev/ide/vnc.localhost` | 三个 `*.localhost`，**不要**设 SaaS 的 `LINKAGENT_PUBLIC_HOST` |
| **SaaS（公网入口）** | `hubide.example.com` | Host/路径原样进 frps | 同域名 + `/<taskId>-web|code|vnc`；node **必须** `LINKAGENT_PUBLIC_HOST` 与网关相同 |

代码判定：`shared/src/task-host.ts` 的 `isSaasPublicHost()`（`.localhost` → 单机，否则 SaaS）。

---

## 2. 四象限总览

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

## 3. 单机方案（gateway 与 node 同一安装根或同一台机）

### 3.1 单机 + node 非 Docker（形态 B，最常见开发）

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
serveWeb:
  enabled: true
  image: linkagent-code-server:local
  host: 127.0.0.1
  port: 8000
  basePath: /vibe-ide
```

**命令**（安装根 = 仓库根）：

```bash
bash scripts/edge.sh build && bash scripts/edge.sh start
pnpm image:code-server
pnpm server:start
pnpm node:start    # 或 pnpm restart:all（含 PM 托管 node）
```

**frpc 注入**：node 读 `.runtime-state/edge/frps.token`，写 `.runtime-state/ide-proxy/frpc.toml` 并挂进 IDE 容器；frpc 默认连 `127.0.0.1:7000`（未设 `FRPS_*` 时）。

**浏览器**：`http://ide.localhost:9080/<taskId>-code`、`/vibe-ide/`（本机路由见 [`edge-frpc-apisix.md`](edge-frpc-apisix.md)）。

**形态 A**（不要 IDE 隧道）：`serveWeb.enabled: false`，仅 `pnpm node:start` 回连网关；**不**写 frpc、**不**起 code-server 容器。

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

## 4. SaaS 方案（公网域名 + 远程执行机）

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
serveWeb:
  enabled: true
  host: 127.0.0.1
  port: 8000
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

## 5. 角色与端口（通用）

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
| `8000` | 宿主机 code-server 映射（形态 B） |

**Windows（非开发 / 生产式）**：

| 步骤 | 命令（安装根 = 独立包目录或仓库根） |
|---|---|
| 一键本机 | `pnpm local:stack:start`（edge → gateway → **pm 重启 node**，含 serveWeb + frpc） |
| 分步 | `pnpm edge:build`（首次）→ `pnpm edge:start` → `pnpm server:start` → `pnpm restart:all` 或 `pnpm --filter @linkagent/backend pm:restart node` |
| dist | `edge.bat start` + `start.bat start` |
| Docker 聚合 node | `pnpm node:docker`（与 PM node 二选一） |

脚本与 Linux 对齐：`scripts/edge.ps1` + `edge-ctl.mjs`（`edge.sh` 仍可在 Git Bash 使用）。需 **Docker Desktop**。

**停止顺序**：node → `bash scripts/edge.sh stop` → `pnpm server:stop`。

---

## 6. 常见问题

| 现象 | 排查 |
|---|---|
| `pnpm edge:build` 报 `failed to get console` | 已通过 `edge.ps1` 无控制台模式调用 docker；仍失败时在**本机 PowerShell** 执行 `pnpm edge:build` 或确认 Docker Desktop 已启动 |
| frpc 断线 / 无 `new proxy` | `FRPS_TOKEN` ≠ frps.toml；误用 `nt_` |
| APISIX 404 | 先 edge 再 gateway；或重启 gateway 触发 `syncTaskHosts` |
| SaaS 路径 404 | node 未设 `LINKAGENT_PUBLIC_HOST` 或与 `edge.publicHost` 不一致 |
| 单机 WebSocket 失败 | 必须经 **9080** 访问 `*.localhost:9080` |
| 同机两套 gateway | 各安装根独立 edge 状态；**7000/9080 仍只能一套** |

---

## 7. 相关文档

| 文档 | 内容 |
|---|---|
| [`edge-frpc-apisix.md`](edge-frpc-apisix.md) | Host/路径、frpc 登记表、APISIX 路由表 |
| [`edge-startup.md`](edge-startup.md) | 工具下载、nat-tunnel（补充） |
| [`deployment.md`](deployment.md) | 网关/node 部署总览 |
| [`faq.md`](faq.md) | 同机多 gateway、Edge 端口 |
