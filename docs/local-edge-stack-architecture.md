# 本机 Edge 栈：架构、流程与运维

面向 **local / enhance 单机** 与 **SaaS 同构路径模式** 的总览。命令速查见 [`local-stack-enhance.md`](local-stack-enhance.md)；日常启停与逐步排障见 [`ops-local-components.md`](ops-local-components.md)；路由细节见 [`edge-frpc-apisix.md`](edge-frpc-apisix.md)。

---

## 1. 需求理解与边界

### 1.1 要解决什么问题

| 需求 | 说明 |
|------|------|
| **统一入口** | 浏览器用固定 Host + 路径访问某任务的 dev / code-server / VNC，而不是记一堆本地端口。 |
| **与 SaaS 同构** | 本机 `ide.localhost:9080/<taskId>-web/` 与线上 `hubide…/<taskId>-web/` 走路径模式，gateway 写 APISIX 的规则一致。 |
| **执行面分离** | **gateway** 管鉴权、任务、OpenAI `/v1`、APISIX 路由；**worker（node）** 跑 agent、IDE、dev、**frpc**。 |
| **可运维** | 配置与状态落在安装根 `.runtime-state/`，edge / gateway / PM 分脚本启停，故障能分层定位。 |

### 1.2 不在本栈范围内

- **OpenAI / ACP 对话**不走 APISIX→frps→frpc；worker 出站 **WebSocket** `/api/nodes/ws` 连 gateway。
- **个人微信 / 企微 / 飞书**走 **channels** 进程，与任务浏览器入口无关。
- **APISIX Dashboard** 仅本机 `127.0.0.1:9000` 可视化；生产变更路由仍以 gateway `syncTaskHosts` 为准。

### 1.3 术语（与实现对齐）

| 称谓 | 技术 id / 路径 | 职责 |
|------|----------------|------|
| **gateway** | PM `gateway`，`server:ctl` | Fastify、任务 store、Admin 写 APISIX、frp Login 插件 |
| **worker（工作节点）** | PM `node`，`pnpm worker:*` | 连接器、任务进程、写 `frpc.toml`、spawn **frpc**、15173/18080/16080 适配器 |
| **edge** | `edge-server-ctl` | 宿主机 **frps** + Docker **APISIX/etcd**（+ 可选 Dashboard） |
| **channels** | PM `channels` | channel-gateway（微信等） |

---

## 2. 架构总览

### 2.1 控制面 vs 数据面

```text
                    ┌─────────────────────────────────────────┐
  控制面             │  gateway (:8787 或 listen-port.json)      │
  (配置/状态/API)    │  · 任务 / 用户 / OpenAI /v1               │
                    │  · syncTaskHosts → APISIX Admin :9180     │
                    │  · POST /internal/frp/handler (Login)      │
                    └───────────────┬─────────────────────────┘
                                    │ WS /api/nodes/ws
                    ┌───────────────▼─────────────────────────┐
                    │  worker (node)                           │
                    │  · switchTask → dev-port.json, frpc.toml │
                    │  · spawn frpc, 15173/18080/16080         │
                    └───────────────┬─────────────────────────┘
                                    │ TCP :7000 (frp 控制)
                    ┌───────────────▼─────────────────────────┐
  数据面             │  frps (:7000 / :7080 / :7500)            │
  (浏览器 HTTP)      └───────────────┬─────────────────────────┘
                                    │
                    ┌───────────────▼─────────────────────────┐
                    │  APISIX :9080 → upstream frps:7080      │
                    └─────────────────────────────────────────┘
                                    │
                              用户浏览器
```

- **控制面**：谁连谁、写什么配置、任务切到哪台机器。
- **数据面**：用户打开任务页时的 HTTP/WebSocket（dev、code、vnc）。

### 2.2 enhance 单机进程分布

| 组件 | 形态 | 关键端口 |
|------|------|----------|
| frps | 宿主机进程 | 7000 控制，7080 HTTP vhost，7500 面板 |
| APISIX + etcd | Docker | 9080 入口，9180 Admin（本机），9000 Dashboard（本机） |
| gateway | 宿主机 Node | 见 `gateway/listen-port.json` |
| channels | PM 子进程 | 连 gateway |
| worker | PM 子进程 | 出站 WS；frpc→7000 |
| frpc | worker 拉起 | 读 `ide-proxy/frpc.toml` |
| code-server 等 | Docker `linkagent-code-serve-web` 或任务 cwd 内 dev | 8080/8010；dev 动态端口 |

**Docker 模式**（`local:enhance:docker`）：worker + IDE + frpc 进 **linkagent-node** 容器；gateway/frps/APISIX 仍在宿主机。与单机模式互斥。

---

## 3. 业务流程

### 3.1 用户打开任务 dev 页（路径模式）

1. 浏览器请求 `GET http://ide.localhost:9080/<taskId>-web/…`，Host=`ide.localhost`。
2. **APISIX** 匹配 `task-<taskId>-web` 等路由，**pass_host**，上游 **frps:7080**（容器内常为 `host.docker.internal:7080`）。
3. **frps** 按 Host + **location** 最长前缀选中 frpc 登记的 `workspace-dev`，转到 **127.0.0.1:15173**（经 frpc 隧道到 worker 机器）。
4. **worker 内 15173 适配器**（`saas-path.ts`）剥 `/<taskId>-web` 前缀，反代到 **dev-port.json** 里的动态端口（如 Vite `127.0.0.1:50718`）。
5. 若 dev 未监听 → 适配器返回 **502**（APISIX/frps/frpc 仍可能正常）。

code / vnc 同理：**18080 / 16080** → code-server / noVNC，路径 `/<taskId>-code`、`-vnc`。

### 3.2 任务切换（worker 侧）

实现集中在 **`backend/src/node/connector.ts`**（`applyTaskSwitch`）与 **`backend/src/node/serve-web.ts`**（`publishSaasFrpc`、`startNativeHostFrpc`）。模块级步骤与 PM 边界见 [`ops-local-components.md` §5.4](ops-local-components.md)。

1. gateway 经 WS 下发 **switchTask**（taskId、cwd、processes）。
2. worker **`augmentTaskProcessesWithHostDev`**：写 **dev-port.json**、在任务 cwd 拉 dev（宿主机动态口 + 15173 适配器）。
3. worker **`publishSaasFrpc`**：重写 `ide-proxy/frpc.toml` 的 `locations` / `customDomains`；调用已注册的 **`hostFrpcReload`**（kill 旧 frpc → `spawn frpc -c …`）。**不是** `pm restart frpc`。
4. **`serveWeb.switchTask`**（可选）：enhance 下 **重建 code-server Docker compose**，与 frpc reload 并行、互不替代。
5. 容器内聚合形态：`restartBundledCodeServer` 按任务重启 code-server 进程。

### 3.3 frpc 登记（与浏览器链路的先后关系）

1. worker 写 `frpc.toml` → `frpc -c …`。
2. frpc **TCP 7000** Login；frps 调 gateway **`/internal/frp/handler`**（`frps.toml` 里 `addr` 必须等于当前 gateway 端口）。
3. Login 成功后 frps **7080** 上才有 HTTP 代理；**frps 面板 :7500** 可见 `workspace-*`。
4. **APISIX 路由**由 gateway 启动/任务变更时 **syncTaskHosts** 写入，与 frpc 登记相互独立；两者都就绪浏览器才通。

### 3.4 远程 worker 接入（简述）

1. 用户 Web 登录 → 发 **nt_** → 远程机配置 `LINKAGENT_GATEWAY_*` → `pnpm worker:start`。
2. worker WS 注册；任务 **nodeId** 指向该机器时，frpc 在**该机器**登记，APISIX 仍指向 frps:7080。

---

## 4. 数据流转

### 4.1 谁生成、谁消费

| 数据 | 写入方 | 读取方 | 路径 / 接口 |
|------|--------|--------|-------------|
| frps / APISIX 静态配置 | `edge:config`（gateway edge 模块） | frps、APISIX 容器 | `.runtime-state/edge/frps.toml`、`apisix-config.yaml`、`apisix-dashboard.yaml` |
| APISIX 动态路由 | gateway **syncTaskHosts** | APISIX 数据面 | Admin API `:9180`，etcd 前缀 `/apisix` |
| frpc 代理定义 | worker **publishSaasFrpc** | frpc 进程 | `.runtime-state/ide-proxy/frpc.toml` |
| 当前任务 dev 上游口 | worker **host-dev** | 15173 适配器 | `.runtime-state/ide-proxy/dev-port.json` |
| gateway 实际端口 | gateway 启动 | edge:config、frps Login 插件 | `.runtime-state/gateway/listen-port.json` |
| 任务列表 / 激活任务 | gateway store | Web、WS、/v1 | `.runtime-state/tasks/*.json` 等 |
| frps token / admin key | edge 首次生成 | frpc、curl Admin | `frps.token`、`apisix.admin-key` |

### 4.2 关键环境变量（本机 enhance）

| 变量 | 作用 |
|------|------|
| `LINKAGENT_LOCAL_STACK=1` | 强制 frpc `customDomains=ide.localhost` 等本机行为 |
| `LINKAGENT_PUBLIC_HOST` | 本机栈应为 `ide.localhost`，勿留 SaaS 域名 |
| `FRPS_SERVER_ADDR` / `PORT` | 本机 `127.0.0.1:7000` |
| `LINKAGENT_LOCAL_STACK_ENHANCE` | 启用单机 code-server + 宿主机 frpc |

### 4.3 一致性约束（设计时必须满足）

1. **frps Login 插件 `addr` 端口 = gateway `listen-port.json`**，否则 frpc Login 失败、面板无 HTTP 规则。
2. **frpc `auth.token` = frps `auth.token`**（`edge:config` 与 `frps.token` 对齐）。
3. **7000 仅 frps**，其它进程占用会导致 frpc 被 RST。
4. **任务 active + switchTask** 后 `frpc.toml` locations 与 APISIX 路径使用同一 **taskId**。
5. **15173 502** 表示适配器在、**dev 动态端口未监听**（与 frps/APISIX 无关）。

---

## 5. 运维与维护

### 5.1 推荐启停顺序（enhance）

```text
edge:build（首次）→ edge:start → server:start → edge:config（若 gateway 非 8787）→ edge:restart（若改了 frps.toml）
→ pm:restart channels（若需要）→ pm:restart worker
```

一键：`pnpm local:enhance`。停止逆序：`local:stack:stop`。

### 5.2 观测点（分层）

| 层级 | 健康信号 | 常见日志 / 文件 |
|------|----------|-----------------|
| APISIX | `:9080` 有响应；Admin routes > 0 | `edge/apisix.log`，`dev-verify-stack` |
| frps | `:7000` 为 frps.exe；`:7500` HTTP 代理列表 | `edge/frps.log` |
| frpc | `login to server success`；面板有 workspace-* | `pm/logs/node.log` |
| 15173/18080/16080 | `netstat` 为 node 监听 | `saas-path` 在 worker 进程内 |
| dev 上游 | `dev-port.json` 的 port 在 LISTENING | node.log `[dev]` 行 |

### 5.3 故障分层（先定位再修）

| 现象 | 先查层 | 文档 |
|------|--------|------|
| frps 面板无 HTTP 代理 | frpc ↔ frps（7000、Login 插件、token） | [`ops-local-components.md` §9.2](ops-local-components.md) |
| 9080 404 | APISIX 路由 / Host / 路径 | ops §9.4 |
| 9080 / 15173 **502** | dev 或 code-server 上游 | 本文 §3.1、§4.3；`dev-port.json` + node.log |
| 9080 502 但 15173 200 | frpc/frps 或 APISIX upstream | frps.log、frpc 是否在线 |
| 两个 gateway | 勿同时 `server:start` 与 PM gateway | ops §9.4 |

### 5.4 变更与升级

| 变更 | 必做动作 |
|------|----------|
| 改 gateway 端口 | `edge:config` + `edge:restart` + `worker:restart` |
| 改 `edge.publicHost` / 任务域名 | `server:restart`（sync APISIX）+ `worker:restart`（frpc） |
| 升级 APISIX 镜像 | `edge:build` + `edge:restart` |
| 仅改任务 cwd / 切换任务 | gateway API 或 UI；worker 自动 switchTask |

### 5.5 管理入口汇总

| 用途 | URL |
|------|-----|
| LinkAgent 后台 | `http://127.0.0.1:<gateway>/` |
| 任务 dev | `http://ide.localhost:9080/<taskId>-web/` |
| frps 面板 | `http://127.0.0.1:7500/` 或 `http://ide.localhost:9080/frps/` |
| APISIX Dashboard | `http://127.0.0.1:9000/`（admin + `apisix-dashboard.password`） |
| APISIX Admin API | `http://127.0.0.1:9180/` + `X-API-KEY` |

---

## 6. 文档索引

| 文档 | 用途 |
|------|------|
| [`local-edge-stack-architecture.md`](local-edge-stack-architecture.md) | 本文：需求、架构、流程、数据流、运维分层 |
| [`ops-local-components.md`](ops-local-components.md) | 组件表、命令、逐步排障 |
| [`local-stack-enhance.md`](local-stack-enhance.md) | pnpm / 脚本速查 |
| [`edge-frpc-apisix.md`](edge-frpc-apisix.md) | frpc 登记与 APISIX 路由规则 |
| [`ops-local-components.md` §5.4](ops-local-components.md) | worker 写 `frpc.toml` / reload frpc 的代码路径 |
| [`edge-apisix-node.md`](edge-apisix-node.md) | 形态 A/B/C、远程 worker env |
| [`architecture.md`](architecture.md) | 全仓库后端分层与鉴权 |

---

## 7. 设计备忘（后续演进）

- **worker 命名**：产品文案与 `pnpm worker:*` 已别名；API `/api/nodes`、PM id `node` 仍保留兼容。
- **dev 启动**：worker 仅追加 `--host 127.0.0.1 --port <动态>`；公网路径前缀由 15173 适配器剥掉，不要求改项目 `vite` 的 `--base`。
- **Dashboard 镜像**：首次需 Docker 拉取 `apache/apisix-dashboard:3.0.1`；拉取失败不阻塞 9080 数据面。
