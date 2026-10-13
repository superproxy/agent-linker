# hubide.ljyd.cn 访问本机 Docker 远程节点（web / code / vnc）

## 目标链路

1. **node** 出站 `wss://hubide.ljyd.cn/api/nodes/ws` → 网关注册、收 `switchTask`
2. **frpc** 出站 `<网关机 IP>:7000`（运维示例 **150.5.140.64**）→ 在 frps 登记 `hubide.ljyd.cn` + `/<taskId>-web|code|vnc`
3. 浏览器 `https://hubide.ljyd.cn/<taskId>-web/` → SLB → APISIX:9080 → frps:7080 → 本机 Docker 15173/18080/16080

## 公网 URL（task 前缀 + 后缀区分服务）

路径用 **任务 id `t_…`**，不用任务 key `k_…`。磁盘 **cwd**（如 `private-cloud-h5`）不出现在 URL 里。

| 服务 | 公网路径 | 示例 |
|---|---|---|
| Dev（Vite） | `/<taskId>-web/` | `https://hubide.ljyd.cn/t_2fc1aed6-web/` |
| Code | `/<taskId>-code/` | `https://hubide.ljyd.cn/t_2fc1aed6-code/` |
| VNC | `/<taskId>-vnc/` | `https://hubide.ljyd.cn/t_2fc1aed6-vnc/vnc.html` |

Dev 公网入口 **`/<taskId>-web/`**；frps `workspace-dev` 只登记该 location，15173 剥前缀后 Vite 仍用 base `/`。

契约：`shared/src/task-host.ts` 的 `taskPublicPath(taskId, 'web'|'code'|'vnc')`。

### frps 与节点适配器（谁改路径）

| 环节 | 行为 |
|---|---|
| APISIX | 默认 `pass_host=pass`，**不剥**路径 |
| frps `:7080` | 按 `Host` + **最长** `locations` 选 `workspace-dev|ide|vnc`，**原样转发** |
| 本机 **15173 / 18080 / 16080** | Dev 把 `-web` 归成 Vite base；code/vnc 剥 `/-code|vnc` 后转 8080/6080 |

### Vite 与公网 `-web` 路径

宿主机 worker **不**给 Vite 注入 `--base`。公网路径前缀只在 **15173 适配器**剥掉：

```text
浏览器  /t_xxx-web/assets/x.js
  → frps:7080 → frpc（location /t_xxx-web，localPort 15173）
  → 15173  →  /assets/x.js  →  Vite 127.0.0.1:<动态口>（base /）
```

前端应用应使用 `import.meta.env.BASE_URL` / 相对路径，不要写死工程目录名。Code 浏览器侧始终是 `-code`；容器内 code-server 用 `--abs-proxy-base-path /t_xxx-code`。

## 网关机 frps 端口（150.5.140.64 等）

| 端口 | 用途 |
|---|---|
| **7000** | frpc 控制连接（`FRPS_SERVER_ADDR` / 安全组必放行） |
| **7080** | HTTP 虚拟主机（任务 web/code/vnc 流量；APISIX 上游） |
| **7500** | frps Dashboard（`admin`，密码见网关机 `.runtime-state/edge/frps.dashboard`） |

`:80` 上的 Nginx 默认页 **不是** frps 面板；查隧道请访问 **`:7500`**。

## 必做（否则永远超时）

| 项 | 说明 |
|---|---|
| **云安全组** | 网关机公网 IP 入站 **TCP 7000**（frpc 控制口）。本机 Docker 不在机房内网时必须放行。可选 **7500** 便于外网看 frps 面板。8787 可在 APISIX 反代 `/api/nodes/ws` 后不必公网暴露。 |
| **APISIX 路由** | SaaS 需 `gateway-node-ws`：`Host=hubide.ljyd.cn`，`/api/nodes/ws` → `host.docker.internal:8787`。网关 `syncTaskHosts` 会自动写入；或运行 `.runtime-state/_ssh_apisix_node_ws.py`。 |
| **LB** | `hubide.ljyd.cn:443` 需转发到 APISIX **9080**（任务路径与 `/api/nodes/ws` 同入口）。若 volcalb 只转部分路径，需在控制台补规则。 |
| **节点凭证** | `.runtime-state/node.env` 中 `LINKAGENT_GATEWAY_TOKEN=nt_…`（后台颁发）；无 token 则 `LINKAGENT_NODE_CLAIM=nu_` 待审批。 |
| **任务绑定** | 后台任务指定该节点；节点在线后 `switchTask` 才会写 frpc locations。 |

## 网关机 Release 安装与启停

运行目录示例 **`/opt/agent-linker`**（dist 解压包，**不要**在该目录 `git pull`）：

```bash
sudo ./install.sh --restart          # 或 LINKAGENT_INSTALL=... ./install.sh
cd /opt/agent-linker
./edge-ctl.sh build                  # 首次
./edge-ctl.sh start
./server-ctl.sh start
```

源码机构建后同步：仓库内 `bash scripts/deploy-server-install-update.sh --restart`（等价于 build dist + `install.sh` 逻辑）。

## 本机配置（部署脚本 + 配置文件）

```text
<安装根>/.runtime-state/node.env     # LINKAGENT_GATEWAY_URL、FRPS_SERVER_ADDR=<网关机 IP>、LINKAGENT_PUBLIC_HOST=hubide.ljyd.cn、nt_
code-server/node-docker/node.env   # 可选：WORKSPACE、NODE_USER
config/node.yaml                   # hostCodeServerCompose.enabled: false（形态 C）
```

启停（勿用 `pnpm node:docker`）：

```powershell
cd code-server\node-docker
.\start.bat restart
.\start.bat restart -f ..\.runtime-state\node.env   # 或任意 dotenv 路径
.\start.bat log
pnpm node -- --docker -f .runtime-state\node.env
```

**勿**在 shell 长期 export `LINKAGENT_GATEWAY_URL`（会盖掉配置文件；ctl 已改为文件优先）。

## 验收

1. `docker logs linkagent-node`：`login to server success`（frpc）、无持续 `7000 i/o timeout`
2. frps 面板 `:7500` 见 `workspace-*` 且 location 含任务 id
3. `https://hubide.ljyd.cn/<taskId>-web/`、`-code`、`-vnc/vnc.html` 可开
