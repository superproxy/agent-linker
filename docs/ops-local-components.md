# 本机组件运维手册

面向 **仓库开发根** 或 **dist 安装根**（`LINKAGENT_HOME`）的日常启停、日志与排障。**架构与数据流总览**见 [`local-edge-stack-architecture.md`](local-edge-stack-architecture.md)；路由原理见 [`edge-frpc-apisix.md`](edge-frpc-apisix.md)；本机命令速查见 [`local-stack-enhance.md`](local-stack-enhance.md)；远程/形态 A/B/C 见 [`edge-apisix-node.md`](edge-apisix-node.md)。

### 称谓：worker vs node

| 称谓 | 含义 |
|------|------|
| **worker（工作节点）** | 连 gateway、跑任务/IDE、写 `frpc.toml` 并拉起 **frpc** 的那一侧进程；文档里优先用此名，避免和 **Node.js 运行时** 混淆。 |
| **node** | 遗留**技术名**（仍有效）：PM 进程 id `node`、`pnpm node:*`、`bin/node.mjs`、`/api/nodes`、`LINKAGENT_NODE_*`。与 worker 指同一组件。 |

**推荐命令**：`pnpm worker:*`、`pnpm local:worker*`、`pnpm --filter @linkagent/backend pm:restart worker`（等价于 `… node`）。`node:*` 保留兼容。

---

## 1. 一张图：谁管什么

```text
                    ┌─────────────────────────────────────────┐
                    │  edge-server-ctl（宿主机 + Docker）      │
                    │    frps :7000 / :7080 / :7500           │
                    │    APISIX+etcd :9080 / Admin :9180      │
                    └───────────────┬─────────────────────────┘
                                    │ Admin API 写路由
┌──────────┐   WS /api/nodes/ws    │         HTTP :9080 浏览器入口
│ gateway  │◀──────────────────────┼──────────────────────────▶ 用户浏览器
│ (Node)   │── syncTaskHosts ──────┘
└────┬─────┘
     │ PM 拉起
     ├── channels（微信等 channel-gateway）
     └── worker / node（连接器 + 写 frpc.toml + 可选 IDE）

worker(node) ──spawn/reload──▶ frpc ──Login :7000──▶ frps（面板可见 HTTP 代理）
              │
              └── 路径模式：本地适配器 15173/18080/16080 → dev/code/vnc
```

**分工牢记**

| 产物 | 谁生成 | 谁消费 |
|------|--------|--------|
| `frps.toml`、token、APISIX yaml | `edge-config-ctl` / `bin/edge.mjs` | frps、APISIX 容器 |
| APISIX 路由（task-*、/frps） | **gateway** 启动后 `syncTaskHosts` | APISIX :9080 |
| `frpc.toml` | **worker（node）**（`serve-web` / `publishSaasFrpc`） | **frpc 进程**（必须常驻） |
| frps 面板里的 HTTP 规则 | — | **frpc 连上 frps 后** 自动登记 |

**APISIX Dashboard**（可视化改路由）：`http://127.0.0.1:9000/`（Compose 服务 `apisix-dashboard`，仅本机映射）；账号 `admin`，密码 `.runtime-state/edge/apisix-dashboard.password`。无 UI 时仍可用 Admin API（`:9180` + `apisix.admin-key`）或 `pnpm local:stack:verify`。

---

## 2. 安装根与状态目录

| 概念 | 说明 |
|------|------|
| **安装根** |  monorepo 根目录，或 dist 解压目录；可设 `LINKAGENT_HOME` |
| **运行时状态** | `<安装根>/.runtime-state/`（不入库） |

| 路径 | 内容 |
|------|------|
| `.runtime-state/edge/` | frps 配置/日志/pid、`frps.token`、`frps.dashboard`、`apisix.admin-key`、`apisix-config.yaml`、`apisix-dashboard.yaml`、`apisix-dashboard.password`、`apisix-dashboard.jwt` |
| `.runtime-state/gateway/` | `listen-port.json`、overlay 端口等 |
| `.runtime-state/ide-proxy/` | 宿主机 `frpc.toml`、`compose.yml`（单机 code-server）、适配器脚本 |
| `.runtime-state/pm/` | PM 管理的 pid（若启用） |
| `.runtime-state/server.log` | 后台 gateway 日志（dev-server-ctl 启动时） |
| `.runtime-state/tools/frp/` | 官方 frp 二进制（edge-config 可下载） |

---

## 3. 组件速查表

| 组件 | 进程形态 | 运维入口 | 主要端口 | 日志 / 状态 |
|------|----------|----------|----------|-------------|
| **frps** | 宿主机 | `pnpm edge:*` | 7000 控制、7080 HTTP vhost、7500 面板 | `.runtime-state/edge/frps.log`、`frps.pid` |
| **APISIX + etcd** | Docker Compose | 同上 | 9080 数据面、127.0.0.1:9180 Admin | `.runtime-state/edge/apisix.log`；`docker ps` |
| **APISIX Dashboard** | Docker Compose | 随 `edge:start` | 127.0.0.1:9000 UI | 密码 `.runtime-state/edge/apisix-dashboard.password` |
| **gateway** | 宿主机 Node | `pnpm server:*` / PM `gateway` | 配置 `8787`，冲突时见 `listen-port.json` | `.runtime-state/server.log` |
| **channels** | PM 子进程 | `pnpm --filter @linkagent/backend pm:* channels` | 无对外固定口（连 gateway） | `.runtime-state/pm/channels.log` |
| **node** | PM 子进程 | `pm:* node` / `pnpm local:node` | WS 连 gateway；frpc 连 7000 | PM logs；node 控制台 |
| **frpc** | 宿主机或容器内 | **node 拉起**（见 §5） | 出站 → frps:7000 | frpc  stdout；frps 面板 |
| **code-server 单机** | Docker | enhance 时 node 写 compose | 8010 等 | `docker logs linkagent-code-serve-web` |
| **linkagent-node** | Docker 聚合 | `pnpm node:docker` | 容器内 frpc + IDE | `pnpm node:docker:log` |

---

## 4. 运维脚本对照

### 4.1 边缘（frps + APISIX）

| 命令 | 作用 |
|------|------|
| `pnpm edge:config` | 只写配置（`edge-config-ctl.mjs` → `bin/edge.mjs` / `gateway/edge/cli.ts`），**不启进程** |
| `pnpm edge:build` | 构建 `linkagent-apisix:local` 镜像（首次 enhance 需要） |
| `pnpm edge:start` / `stop` / `restart` | `edge-server-ctl` → 宿主机 frps + Docker APISIX |
| `pnpm edge:status` / `edge:log` | 状态与 tail 日志 |

兼容：`edge-ctl.*`、`edge.sh` 转发到 `edge-server-ctl`。

**改 gateway 监听端口后**：必须 `pnpm edge:config` 并 `pnpm edge:restart`，否则 `frps.toml` 里 Login 插件仍指向旧端口，**frpc 会登录失败**。

### 4.2 网关

| 命令 | 作用 |
|------|------|
| `pnpm server:start` / `stop` / `restart` | 开发根：`dev-server-ctl` 后台 gateway |
| `pnpm server:log` | 跟随 `server.log` |
| dist | `./server-ctl.sh` / `server-ctl.mjs` |

gateway 启动后会 **异步** `syncTaskHosts`（APISIX 未就绪时会退避重试）。日志关键字：`[edge] APISIX 路由同步`。

### 4.3 PM（gateway / channels / node）

在 `backend` 包内：

```bash
pnpm --filter @linkagent/backend pm:status
pnpm --filter @linkagent/backend pm:restart gateway
pnpm --filter @linkagent/backend pm:restart channels
pnpm --filter @linkagent/backend pm:restart node
pnpm --filter @linkagent/backend pm:logs
```

**注意**：`pnpm server:*` 与 PM 里的 `gateway` 是两套 gateway 启法；本机 **local 栈** 一般用 `dev-server-ctl` + PM 的 channels/node，勿重复起两个 gateway。

### 4.4 本机一键栈

| pnpm | 含义 |
|------|------|
| `local:start` | edge + gateway + channels + **原生 node**（可无 IDE） |
| `local:enhance` | 上者 + 单机 Docker code-server + **宿主机 frpc** |
| `local:node:docker` | Docker `linkagent-node`（**容器内 frpc**） |
| `local:stack:verify` | `scripts/dev-verify-stack.mjs` |

脚本会为本机栈设置 `LINKAGENT_LOCAL_STACK=1`、`LINKAGENT_PUBLIC_HOST=ide.localhost`（Docker 远程节点模式除外）。

---

## 5. frpc 启动方式（维护重点）

配置文件 **不等于** 已在 frps 登记；**必须有 frpc 进程** 且 **7000 登录成功**。

### 5.1 谁启动 frpc

代码调用链见 **§5.4**。

| 场景 | 配置路径 | 启动者 | 命令等价 |
|------|----------|--------|----------|
| **local 原生 / enhance 单机** | `.runtime-state/ide-proxy/frpc.toml` | node 内 `startNativeHostFrpc` | `frpc -c <frpc.toml>` |
| **任务切换（路径模式）** | 同上，被 `publishSaasFrpc` 重写 | 写盘后 **reload** 已注册的宿主机 frpc | 见 node 日志 |
| **Docker 聚合 node** | 容器内 `/etc/linkagent/frpc.toml` | `code-server/entrypoint.sh` 循环 `frpc -c …` | 等 node 写入后 entrypoint 拉起 |
| **仅写 toml、无进程** | — | 若 node 未起 frpc 或登录失败退出 | 需手动或 `pm:restart node` |

二进制路径：`.runtime-state/edge/frpc.path`（与 frps 同包）。

### 5.2 手动启 frpc（排障）

```powershell
# 安装根下
$bin = (Get-Content .runtime-state\edge\frpc.path).Trim()
& $bin -c .runtime-state\ide-proxy\frpc.toml
```

成功：frps 面板 `:7500` → **HTTP 代理** 出现 `workspace-*`，域名 `ide.localhost`（本机路径模式）。

### 5.3 frpc 环境变量

| 变量 | 含义 |
|------|------|
| `FRPS_SERVER_ADDR` / `FRPS_SERVER_PORT` | 默认本机 `127.0.0.1:7000` |
| `FRPS_TOKEN` | 与 `.runtime-state/edge/frps.token` 一致 |
| `LINKAGENT_PUBLIC_HOST` | frpc `customDomains`；本机栈应为 `ide.localhost` |
| `LINKAGENT_LOCAL_STACK=1` | 强制本机 `ide.localhost`，忽略误留的 SaaS 域名 |
| `LINKAGENT_FRPC_PATH` | 默认 `ide-proxy/frpc.toml` |
| `LINKAGENT_FRPC_LEGACY_HOSTS=1` | 三域名 legacy，非路径模式 |

### 5.4 代码路径：谁写 `frpc.toml`、谁 reload frpc

**结论**：PM 里的 **worker（进程 id `node`）** 统一负责；**不是** gateway、**不是** PM 单独再起一个 `frpc` 项。frpc 是 node 子进程，任务切换时 **kill + 再 spawn**（`pm:restart node` 会连带重做一遍，但日常换任务不必重启整个 worker）。

| 角色 | 源码路径 | 职责 |
|------|----------|------|
| 进程入口 | `backend/src/node/connector.ts` | `pnpm node:connect` / `bin/node.mjs`；连 gateway WS、收 `switchTask` |
| IDE + frpc 编排 | `backend/src/node/serve-web.ts` | `startNodeServeWeb`、`startNativeHostFrpc`、`publishSaasFrpc` |
| 路径适配器 | `backend/src/node/saas-path.ts` | 15173/18080/16080；`ensureSaasLocalAdapter` |
| 宿主机 dev | `backend/src/node/host-dev.ts` | 切换任务写 `dev-port.json`、spawn Vite |
| 运行时文件 | `.runtime-state/ide-proxy/` | `frpc.toml`、`current-task`、`dev-port.json`、`compose.yml` |

**启动时（worker 拉起）**

```text
connector main()
  → 设 LINKAGENT_FRPC_PATH = ide-proxy/frpc.toml（容器内为 /etc/linkagent/frpc.toml）
  → restoreDevPortFromRuntime(ide-proxy)
  → startNodeServeWeb({ runtimeDir: ide-proxy, frpsTokenFile: edge/frps.token })
       → startNativeHostFrpc()
            · renderWorkspaceFrpc / renderSaasWorkspaceFrpc → 写 frpc.toml
            · ensureSaasLocalAdapter（15173/18080/16080）
            · spawn(frpc -c frpc.toml)          # 首次起 frpc
            · registerHostFrpcReload(startFrpc) # 登记「写盘后如何重启 frpc」
  → 若设 LINKAGENT_TASK_ID：bootTask() → applyTaskSwitch → publishSaasFrpc（再写盘 + reload）
```

**网关切换任务时**

```text
gateway WS 消息 type=switchTask
  → NodeConnector.applyTaskSwitch(taskId, cwd, processes?)
       · augmentTaskProcessesWithHostDev（可选起 dev、更新 dev-port.json）
       · switchIdeTask → serveWeb.switchTask   # 仅 Docker code-server compose，不管 frpc
       · 路径模式：publishSaasFrpc(taskId)
            · 重写 frpc.toml（locations / customDomains / taskId）
            · 写 current-task
            · ensureSaasLocalAdapter
            · hostFrpcReload() → SIGTERM 旧 frpc → spawn 新 frpc
       · taskProcesses.switchTo（在任务 cwd 拉 dev 等子进程）
```

**与 PM / gateway 的边界**

| 动作 | 谁做 |
|------|------|
| APISIX `task-*` 路由 | **gateway** `syncTaskHosts`（任务增删、gateway 启动） |
| `frpc.toml` 内容 | **worker** `publishSaasFrpc` |
| frps 面板 HTTP 代理列表 | **frpc 连上 frps:7000** 后自动登记 |
| `pm:restart worker` | 整个 node 进程重启 → 再次 `startNativeHostFrpc` + 可能 `bootTask` |

**日志**：`.runtime-state/pm/logs/node.log`（或 PM 配置的 node 日志）。关键字：`宿主机 frpc 已启动`、`切换任务 taskId=`、`frpc 退出 code=`。

**例外（容器聚合镜像）**

- `LINKAGENT_NODE_SERVE_WEB=0` 且 node 跑在 IDE 容器内：node 只写 `/etc/linkagent/frpc.toml`，**frpc 由 `code-server/entrypoint.sh` 循环拉起**，不走宿主机 `registerHostFrpcReload`。
- `local:node:docker`：frpc 在容器内；宿主机 `ide-proxy/frpc.toml` 可能不存在或由不同形态写入。

架构总览中的任务切换时序见 [`local-edge-stack-architecture.md` §3.2–3.3](local-edge-stack-architecture.md)。

---

## 6. 推荐启停顺序

### 6.1 日常启动（enhance 单机）

```text
1. pnpm edge:build          # 仅首次或 Dockerfile 变更
2. pnpm edge:start          # frps + APISIX
3. pnpm server:start        # gateway（或 local:enhance 已包含）
4. pnpm edge:config         # 若 gateway 端口非默认 8787，把 frps Login 插件 addr 写对
5. pnpm edge:restart        # 仅当上一步改动了 frps.toml
6. pnpm pm:restart channels # 若启用微信等
7. pnpm pm:restart worker  # 写 frpc + 拉 frpc + IDE（等价 pm:restart node）
```

或使用：`pnpm local:enhance`。**勿在 frps / gateway 未就绪前单独起 worker**，否则 frpc 一次 Login 失败可能直接退出（见 §9.2）。

### 6.2 停止（逆序）

```text
node / Docker 节点 → channels → server:stop → edge:stop
```

`pnpm local:stack:stop` 会按此顺序调用。

### 6.3 改任务 / 改 edge 公网 Host 后

```text
改 gateway.yaml edge.publicHost 或任务列表
  → server:restart（同步 APISIX）
  → pm:restart node（publishSaasFrpc + frpc reload）
```

---

## 7. 面板与 API 入口

| 用途 | URL / 方式 |
|------|------------|
| LinkAgent 管理后台 | `http://127.0.0.1:<gateway>/`（端口见 `listen-port.json`） |
| OpenAI `/v1` | 同上 `/v1` |
| 任务浏览器入口 | `http://ide.localhost:9080/<taskId>-web/` 等 |
| frps 隧道面板 | `http://127.0.0.1:7500/` 或 `http://127.0.0.1:9080/frps/` |
| **APISIX Dashboard** | `http://127.0.0.1:9000/`（用户 `admin`，密码 `apisix-dashboard.password`） |
| APISIX Admin API（无 UI） | `curl -H "X-API-KEY: …" http://127.0.0.1:9180/apisix/admin/routes`（key 见 `apisix.admin-key`） |

frps 面板账号：`admin`，密码文件 `.runtime-state/edge/frps.dashboard`。

**首次启用 Dashboard**：`pnpm edge:config` 生成 `apisix-dashboard.yaml` → `pnpm edge:restart` 拉起 `apisix-dashboard` 容器。`:9080` 是数据面，**没有** APISIX 管理页。

---

## 8. 巡检与验收

```bash
node scripts/dev-verify-stack.mjs
# 或
pnpm local:stack:verify
```

检查项包括：APISIX 容器、frps :7500、gateway health、PM node/channels、APISIX 路由数、enhance 时 Docker IDE。

---

## 9. 问题排查

### 9.1 先分清：frps 面板 vs APISIX

| 看哪里 | 表示什么 | 谁负责 |
|--------|----------|--------|
| **frps 面板**（`:7500` 或 `:9080/frps/`）里的 **HTTP 代理** | frpc 已 Login，并把 `frpc.toml` 里的 proxy 登记到 frps | **frpc 进程** |
| **APISIX** 里的 `task-*` 等路由 | 浏览器从 `:9080` 进站的转发规则 | **gateway** `syncTaskHosts` |

**面板没有 HTTP 规则** → 先按 **§9.2** 查 frpc ↔ frps，不要先用 APISIX 路由是否为空来推断。

**数据链**（本机路径模式）：

```text
worker 写 frpc.toml → spawn frpc
  → TCP 127.0.0.1:7000 → frps
  → frps 调 Login 插件 → http://127.0.0.1:<gateway端口>/internal/frp/handler
  → Login 成功 → 面板出现 workspace-* HTTP 代理

浏览器：9080(APISIX) → frps:7080(vhost) → frpc → 本机 15173/18080/16080
```

**dev 两段口（不要混）**

| 端口 | 谁监听 | frpc `workspace-dev` |
|------|--------|----------------------|
| **15173** | worker 路径适配器（剥 `/<taskId>-web`） | **`localPort` 固定登记这里** |
| **动态口**（如 50718；手测可用 1573 + `LINKAGENT_DEV_FIXED_PORT=1573`） | 任务目录 Vite | **不要**写进 frpc；由 15173 反代 |

直连 frps 数据口（不经过 9080）：`curl -H "Host: ide.localhost" http://127.0.0.1:7080/<taskId>-web/` → 与上表相同，仍到 **15173**，再到 Vite 动态口。
```

### 9.2 frps 面板无 HTTP 代理（逐步排查）

严格按 **A → B → … → G** 顺序；某步不通过则停在该步修复，不要跳步。

#### 步骤 A — 7000 上必须是 frps

```powershell
netstat -ano | findstr ":7000 "
tasklist /FI "PID eq <上一步最后一列 PID>"
```

| 结果 | 处理 |
|------|------|
| 进程名为 **frps.exe** | 继续 B |
| 其它进程（如 python、旧隧道） | 停占端口进程 → `pnpm edge:restart` → 重做 A |
| 无 LISTENING | `pnpm edge:restart` → 看 `.runtime-state/edge/frps.log` 末尾是否有 `frps started successfully` |

#### 步骤 B — frps Login 插件与 gateway 端口一致

1. 读 `.runtime-state/gateway/listen-port.json` → 记下 `port`。
2. 读 `.runtime-state/edge/frps.toml` → `[[httpPlugins]]` 的 `addr`（应为 `127.0.0.1:<port>`）。

不一致 → `pnpm edge:config` → `pnpm edge:restart` → 重做 A、B。

#### 步骤 C — gateway 已就绪（Login 插件能打到）

```powershell
curl.exe http://127.0.0.1:<port>/healthz
```

期望 HTTP 200。失败 → `pnpm server:restart`（或整栈脚本里的 gateway 段）→ 若端口变化，回到 B。

#### 步骤 D — `frpc.toml` 符合本机栈

文件：`.runtime-state/ide-proxy/frpc.toml`。

| 字段 | 本机 enhance 期望 |
|------|-------------------|
| `serverAddr` | `127.0.0.1`（勿留 `host.docker.internal` / 远程域名） |
| `serverPort` | `7000` |
| `auth.token` | 与 `.runtime-state/edge/frps.toml` 中 `auth.token` **完全一致** |
| `customDomains` | `ide.localhost` |
| `[[proxies]]` | 含 `workspace-dev/ide/vnc` 与当前任务的 `locations` |

不对 → `pnpm local:stack:restart:enhance` 或切换任务后 `pnpm worker:restart`，让 worker 重写 toml。

#### 步骤 E — frpc 进程是否存在

```powershell
tasklist | findstr /I frpc
```

无进程 → 看 F、H；有进程但仍无面板规则 → 仍做 F（可能 Login 失败后已退出又被人手动拉起，或旧实例）。

#### 步骤 F — 手动跑一次 frpc（最直观）

```powershell
$bin = (Get-Content .runtime-state\edge\frpc.path).Trim()
& $bin -c .runtime-state\ide-proxy\frpc.toml
```

看终端输出（前台运行，便于读错）：

| 输出 | 含义 | 下一步 |
|------|------|--------|
| `login to server success`、`proxy added` | frpc ↔ frps 正常 | 步骤 G |
| `forcibly closed by the remote host` | 7000 对端非 frps，或 Login 阶段被掐 | A；若 A 已是 frps → B、C |
| token / auth 错误 | token 不一致 | D；必要时 `pnpm edge:config` 后 restart |
| `loginFailExit` 后立刻退出 | 一次失败不重试 | 修完 A–D 后 `pnpm worker:restart` |

#### 步骤 G — 确认 frps 已登记 HTTP 规则

- 浏览器：`http://127.0.0.1:7500/`（账号 `admin`，密码见 `.runtime-state/edge/frps.dashboard`），或 `http://ide.localhost:9080/frps/`。
- 期望：`workspace-dev`、`workspace-ide`、`workspace-vnc` 等，`customDomains` 为 `ide.localhost`。

F 成功但 G 仍空：硬刷新；确认 A 的 frps PID 与 `frps.log` 最新启动时间一致（避免看错旧实例）。

#### 步骤 H — worker 日志

文件：`.runtime-state/pm/logs/node.log`（PM 未启用时看 worker 前台终端）。

- 应有 frpc 子进程里的 `login to server success`（或同等字样）。
- 常见失败：`frpc 退出 code=1`、`forcibly closed` → 按 F 表回到 A–D。
- 只有「已写 frpc.toml」、无 spawn / login → `pnpm worker:restart`。

#### 排查记录表（可选）

| 步骤 | 结果 | 通过 |
|------|------|------|
| A 7000 = frps.exe PID= | | |
| B plugin addr 端口 = gateway port | | |
| C healthz 200 | | |
| D frpc.toml server/token/domain | | |
| E frpc 进程存在 | | |
| F 手动 frpc 输出摘要 | | |
| G 面板 HTTP 代理条数 | | |

卡住时保留 **F 的完整输出** 与 **A 的 tasklist 一行** 即可定位。

### 9.3 整栈重启竞态（避免面板空）

`local:stack:restart:enhance` 若 gateway 多次重启，worker 可能在 frps / gateway 未就绪时拉 frpc，导致一次 Login 失败退出。推荐顺序：

```text
pnpm edge:restart
pnpm server:restart
pnpm edge:config          # gateway 端口与 frps 插件不一致时
pnpm edge:restart         # 仅当上一步改了 frps.toml
pnpm worker:restart
```

### 9.4 其它现象（速查）

| 现象 | 优先检查 |
|------|----------|
| APISIX **无 task-* 路由** | gateway 是否在 APISIX 之后启动；日志 `[edge] APISIX 路由同步` / `fetch failed`（与 frps 面板无关，见 §9.1） |
| 9080 / **15173 502** | **§9.6**（多为 dev 未监听；frpc/APISIX 可能仍正常） |
| 9080 **404** | Host 是否为 `ide.localhost`；路径是否为 `/<taskId>-web` 而非裸 `/` |
| 配置已是 **hubide…** 本机仍不通 | 清 `LINKAGENT_PUBLIC_HOST` 或 `local:enhance` 重起 worker；见 `frpc.toml` 的 `customDomains` |
| 两个 gateway | 勿同时 `server:start` 与 `pm:start gateway` |
| **code-server 容器名冲突**、任务目录无 `package.json` | 影响 IDE 容器，**不阻止** frps 登记 HTTP 代理；IDE 单独排 |

### 9.5 worker 进程里都有什么（便于对 `tasklist`）

PM 进程 id 仍为 **`node`**；入口 `backend/src/node/connector.ts`。架构细节见 [`local-edge-stack-architecture.md`](local-edge-stack-architecture.md) §3。

| 能力 | OS 进程？ | 谁拉 / 在哪 | 运维怎么认 |
|------|-----------|-------------|------------|
| **WS 连 gateway** | 否（worker 主线程） | `NodeConnector` | `node.log`：`已连接网关`、`switchTask` |
| **15173 / 18080 / 16080** | **否**（worker 内 HTTP 适配器） | `saas-path.ts` `ensureSaasLocalAdapter` | `netstat` 见 **node.exe** 占 15173 等 |
| **frpc** | **是** `frpc.exe` | `serve-web.ts` `startNativeHostFrpc` | `tasklist \| findstr frpc` |
| **dev（Vite 等）** | **是**（子进程） | 网关 `switchTask` → `TaskProcessGroup` spawn | `node.log` 行首 `[dev]`；端口见 `dev-port.json` |
| **code-server 容器** | Docker | `serve-web.ts` `docker compose up` | `docker ps` → `linkagent-code-serve-web` |

**触发顺序（enhance + 路径模式）**

1. worker 启动 → `startNodeServeWeb`：写 `frpc.toml`、spawn **frpc**、起 **15173/18080/16080** 适配器；可选起 IDE 容器。
2. 网关下发 **`switchTask`** → 写 **`dev-port.json`**、spawn **`npm run dev`**（任务 **cwd**）、`publishSaasFrpc` 刷新 locations、必要时 **重建 IDE 容器**。

未配置 `node.yaml` 的 `taskProcesses` 且 `LINKAGENT_DEV_BY_NODE=1`（enhance 会自动设）时，dev 命令由 worker 生成，**不是**你在项目里裸跑的 `pnpm dev`。

### 9.6 9080 / 15173 **502**（dev 上游未就绪）

**含义**：APISIX → frps → frpc 可能都正常；**15173 适配器**反代到 `dev-port.json` 里的动态端口失败 → 502。裸开 `http://127.0.0.1:15173/` 无任务路径也常 502，应测 `http://127.0.0.1:15173/<taskId>-web/` 或走 9080 同路径。

#### 步骤 W1 — 分层确认 502 出在哪一跳

```powershell
# 替换为当前 taskId
curl.exe -s -o NUL -w "9080:%{http_code} " -H "Host: ide.localhost" "http://127.0.0.1:9080/t_XXXX-web/"
curl.exe -s -o NUL -w "7080:%{http_code} " -H "Host: ide.localhost" "http://127.0.0.1:7080/t_XXXX-web/"
curl.exe -s -o NUL -w "15173:%{http_code} " "http://127.0.0.1:15173/t_XXXX-web/"
```

| 结果 | 结论 |
|------|------|
| 9080/7080/15173 **都是 502** | 几乎一定是 **dev 动态端口未监听**（见 W2–W4） |
| 9080 502，15173 **200** | 查 APISIX 路由 / frpc（§9.1） |
| 15173 200，9080 502 | APISIX 或 Host/路径 |

#### 步骤 W2 — dev 上游端口是否在听

```powershell
Get-Content .runtime-state\ide-proxy\dev-port.json
netstat -ano | findstr "<上一步 port 字段>"
```

| 结果 | 处理 |
|------|------|
| 无 LISTENING | dev 子进程未起或已退出 → W3、W4 |
| 有 LISTENING | 在任务 cwd 手动 `curl http://127.0.0.1:<port>/`；仍失败则看 Vite base 路径 |

#### 步骤 W3 — 看 worker 日志里的 `[dev]`

文件：`.runtime-state/pm/logs/node.log`（或 worker 前台）。

| 日志 | 含义 | 处理 |
|------|------|------|
| `dev 127.0.0.1:<port> taskId=…（frpc → 15173 → <port>` | 已分配端口并尝试 spawn | 继续往下看 `[dev]` |
| `[dev] 任务目录没有 package.json` | cwd 不对 | 后台改任务工作目录 → 再 `switchTask` / `pnpm worker:restart` |
| `[dev] Unknown option \`--allowedHosts\`` 等 CLI 报错 | 旧版 worker 给 Vite 5 加了不支持的参数 | 升级仓库 worker；当前版已去掉 CLI `allowedHosts`，15173 适配器会把 Host 改为 `127.0.0.1:<port>` |
| `[dev] 退出 code=1` | dev 启动失败 | 到任务 cwd **手动**执行日志里同等命令（见 W4） |
| 无 `[dev]`、只有 `processes=-` | 未 spawn dev | 确认已 **激活任务** 且网关发过 `switchTask`；`LINKAGENT_DEV_BY_NODE` / enhance 是否开启 |

#### 步骤 W4 — 手跑 `pnpm dev` 正常，经 9080 仍 502

| 对比项 | 你在项目里 `pnpm dev` | worker 拉起 dev |
|--------|----------------------|-----------------|
| 工作目录 | 当前 shell 目录 | 任务 **cwd**（网关任务配置） |
| 命令 | 多为 `vite` | `npm run dev -- --host 127.0.0.1 --port <动态>`（**不**注入 `--strictPort` / `--base`） |
| 路径前缀 | — | 由 **15173 适配器**剥 `/<taskId>-web` → 上游 `/`，与本地 dev 的 base `/` 一致 |
| 访问方式 | 常开 `localhost:5173` | 必须走 `/<taskId>-web/`（9080 或 15173） |

在 **任务 cwd** 下用 `dev-port.json` 里的端口执行 `npm run dev -- --host 127.0.0.1 --port <port>` 试跑；能起则 `pnpm worker:restart` 或后台 **切换激活任务** 让 gateway 再发 `switchTask`。

#### 步骤 W5 — code / vnc 502（非 dev）

| 路径后缀 | 适配器口 | 默认上游 |
|----------|----------|----------|
| `-web` | 15173 | dev 动态端口（剥前缀后 upstream `/`） |
| `-code` | 18080 | enhance 常见 Docker **8010** → 容器 8080 |
| `-vnc` | 16080 | 容器 **6080** |

`docker ps` 看 `linkagent-code-serve-web`；code 502 而 dev 502 时分开查。

#### 502 记录表（可选）

| 步骤 | 结果 |
|------|------|
| W1 9080 / 7080 / 15173 状态码 | |
| W2 dev-port.json + netstat | |
| W3 node.log 最近 `[dev]` 摘要 | |
| W4 任务 cwd 手跑 dev 是否成功 | |

---


## 10. 开发根 vs dist 安装包

| 项 | 开发（monorepo） | dist |
|----|------------------|------|
| edge 启停 | `pnpm edge:*` → `scripts/edge-server-ctl.*` | `./edge-server-ctl.sh` |
| edge 配置 | `pnpm edge:config` | `node bin/edge.mjs` |
| gateway | `pnpm server:*` / `tsx` dev | `./server-ctl.sh` |
| PM | `pnpm --filter @linkagent/backend pm:*` | `node bin/pm.mjs` |
| node 连接 | `pnpm --filter @linkagent/backend node:connect` | `node bin/node.mjs` |

Release 运维脚本命名见 [`scripts/README.md`](../scripts/README.md)（`ops-*` 拷贝到 dist 时去前缀）。

---

## 11. 相关文档

| 文档 | 内容 |
|------|------|
| [`local-edge-stack-architecture.md`](local-edge-stack-architecture.md) | 需求、架构、业务流程、数据流转、运维分层 |
| [`local-stack-enhance.md`](local-stack-enhance.md) | 单机 / Docker 模式命令与 URL |
| [`edge-apisix-node.md`](edge-apisix-node.md) | 形态 A/B/C、远程 node.env |
| [`edge-startup.md`](edge-startup.md) | edge 与 gateway 历史说明 |
| [`deployment.md`](deployment.md) | 服务器安装升级 |
| [`channels.md`](channels.md) | 微信 channel-gateway |
| [`faq.md`](faq.md) | 通用排障 |
