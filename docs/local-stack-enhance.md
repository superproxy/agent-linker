# Local 本机栈与 enhance 速查

> 路由原理见 [`edge-frpc-apisix.md`](edge-frpc-apisix.md)。APISIX / frps / node frpc 配置细节见 [`edge-apisix-node.md`](edge-apisix-node.md)（文内「形态 A/B/C」为架构术语）。  
> 日常启停只需区分：**单机模式** 与 **Docker 模式**。

---

## 1. 命令怎么选

**启动脚本（本机 PM，非 `pnpm dev` 源码模式）**

| 方式 | 原生完整栈 | enhance 单机 | 纯 node | Docker 节点 |
|---|---|---|---|---|
| Bash | `bash scripts/local-stack.sh` | `bash scripts/local-stack-enhance.sh` | `bash scripts/local-node.sh` | `bash scripts/local-node-docker.sh` |
| Windows | `scripts\local-stack.bat` | `local-stack-enhance.bat` | `local-node.bat` | `local-node-docker.bat` |
| pnpm | `pnpm local:start` | `pnpm local:enhance` | `pnpm local:node` | `pnpm local:node:docker` |

| 命令 | 模式 | 执行面 / IDE / frpc |
|---|---|---|
| `pnpm local:stack:start` / `local:start` | 原生 | 宿主机 **PM node**，一般无浏览器 IDE |
| `pnpm local:stack:start:enhance` / `local:enhance` | **单机模式** | PM node + **`linkagent-code-serve-web`**；**frpc 在宿主机** |
| `pnpm local:stack:start:enhance:docker` / `local:enhance:docker` | **Docker 模式** | **`linkagent-node` 聚合容器**（node + IDE + **容器内 frpc**） |

**单机模式** 与 **Docker 模式** 不要同时开。  
- 起 **单机模式** 时会尝试停 Docker 模式节点；未在跑则只提示「Docker 模式节点未在运行」。  
- 起 **Docker 模式** 时会停 PM node 与单机 code-server 容器。

两种 enhance 都会 **增强 edge**（APISIX build → 重启 frps/APISIX → **重启 gateway**）。

辅助：`pnpm local:stack:stop` / `status` / `verify`；Docker 模式日志 `pnpm node:docker:log`；任务链接 `pnpm task:links`。

---

## 2. 单机模式（`start:enhance`）

| 组件 | 跑在哪 | 说明 |
|---|---|---|
| gateway、channels、node | 宿主机 PM | node 回连网关、跑 agent |
| frps、APISIX + etcd | 宿主机 / edge Docker | 与下表相同 |
| code-server / dev / VNC | **`linkagent-code-serve-web`** | 镜像 `linkagent-code-server:local` |
| frpc | **宿主机** | `.runtime-state/ide-proxy/frpc.toml` → `127.0.0.1:7000` |

终端步骤示例：`单机模式：PM node + code-server（8010）` → `单机模式：停止 Docker 模式节点（若存在）`。

---

## 3. Docker 模式（`start:enhance:docker`）

| 组件 | 跑在哪 | 说明 |
|---|---|---|
| gateway、channels、frps、APISIX | 同 §2 网关机侧 | edge 增强相同 |
| node + IDE + frpc | **`linkagent-node`** | `pnpm node:docker`；配置 `code-server/node-docker/node.env` |
| PM node、单机 IDE 容器 | **停止** | 与单机模式互斥 |

容器内 node 回连 **`ws://host.docker.internal:<gateway端口>/api/nodes/ws`**；frpc 连 **`host.docker.internal:7000`**。  
建议 `hostCodeServerCompose.enabled: false`、`LINKAGENT_NODE_SERVE_WEB=0`（见 [`edge-apisix-node.md`](edge-apisix-node.md) §3.2）。

---

## 4. 浏览器路径

**单机模式**（frps **路径** + 本地适配器，与 SaaS 同一模型）：

```text
浏览器 → APISIX :9080（Host/路径原样）
  → frps :7080（Host=ide.localhost + location=/<taskId>-code|web|vnc）
  → 宿主机 frpc → 127.0.0.1:18080|15173|16080（剥前缀、修 Location）
  → 8010 code-server / 5173 dev / 6080 VNC
```

**不要**直接打开 `http://ide.localhost:9080/`（APISIX 无 `/` 路由）。**不要**在 frps:7080 上只测 `/<taskId>-code` 却不带已登记的 Host——路径路由是 **Host + locations** 一起匹配。legacy 三 Host 仅当 `LINKAGENT_FRPC_LEGACY_HOSTS=1`。

**Docker 模式**：9080 → frps → **容器内** frpc → 容器内 8080 / 5173 / 6080。

`config/gateway.yaml` 示例：

```yaml
edge:
  publicHost: ide.localhost
  publicPort: 9080
```

| 能力 | URL（`<taskId>` 如 `t_abc`） |
|---|---|
| 任务 dev / web | `http://ide.localhost:9080/<taskId>-web/` |
| 任务浏览器 IDE | `http://ide.localhost:9080/<taskId>-code/` |
| 任务 VNC | `http://ide.localhost:9080/<taskId>-vnc/` |

**9080 上没有** `/vibe-ide` 路由；浏览器 code-server 只用 **`/<taskId>-code`**。管理后台嵌 IDE 走 **网关同源** `http://127.0.0.1:<gateway>/vibe-ide/`（不经 APISIX）。

**5173 / dev / VNC / code-server 跟「当前激活任务」**：网关激活或切换任务时会向属主 PM 节点发 `switchTask`；node 将 **任务 `cwd` 挂进 IDE 容器** 并 **`docker compose up --force-recreate`**，由入口脚本重启 dev（5173）、code-server、VNC。enhance 时建议 **`hostCodeServerCompose.workspace` 留空**（勿写死桌面项目路径），等激活任务下发后再起容器。节点上线时也会同步一次当前激活任务。

---

## 5. 常用端口

| 端口 | 用途 |
|---|---|
| gateway `server.port`（或 `listen-port.json`） | `/v1`、`/ui`、节点 WS |
| **9080** | APISIX，浏览器任务入口 |
| **9180** | APISIX Admin |
| **7000** / **7080** / **7500** | frps 控制 / HTTP / 面板 |
| **8010** / **5173** / **6080** | **单机模式**本机调试（映射 IDE 容器） |

---

## 6. 状态与日志

| 路径 | 内容 |
|---|---|
| `.runtime-state/ide-proxy/` | 单机模式 compose、宿主机 frpc |
| `.runtime-state/pm/logs/node.log` | 单机模式 node |
| `pnpm node:docker:log` | Docker 模式 |
| `.runtime-state/server.log` | gateway |

---

## 7. 三种 start 对照

| 项 | `start` | 单机 `start:enhance` | Docker `start:enhance:docker` |
|---|---|---|---|
| edge | 普通 start | 增强 | 增强 |
| node | PM | PM + 单机 IDE 容器 | `linkagent-node` |
| frpc | 视配置 | 宿主机 | 容器内 |

---

## 8. 自检

**单机模式**：有 `linkagent-code-serve-web`，无 `linkagent-node`；`node.log` 有「宿主机 frpc 已启动」。

**Docker 模式**：有 `linkagent-node`，PM node 停、无 `linkagent-code-serve-web`。

```bash
pnpm local:stack:status
docker ps --filter name=linkagent
```

---

## 9. 相关文档

| 文档 | 内容 |
|---|---|
| [`edge-frpc-apisix.md`](edge-frpc-apisix.md) | Host/路径、APISIX 路由 |
| [`edge-apisix-node.md`](edge-apisix-node.md) | 形态 A/B/C、SaaS、远程 node |
