# hubide.ljyd.cn 访问本机 Docker 远程节点（web / code / vnc）

## 目标链路

1. **node** 出站 `wss://hubide.ljyd.cn/api/nodes/ws` → 网关注册、收 `switchTask`
2. **frpc** 出站 `150.5.142.161:7000` → 在 frps 登记 `hubide.ljyd.cn` + `/<taskId>-web|code|vnc`
3. 浏览器 `https://hubide.ljyd.cn/<taskId>-web/` → SLB → APISIX:9080 → frps:7080 → 本机 Docker 15173/18080/16080

## 必做（否则永远超时）

| 项 | 说明 |
|---|---|
| **云安全组** | 网关机公网 IP 入站 **TCP 7000**（frpc 控制口）。本机 Docker 不在机房内网时必须放行。8787 可在 APISIX 反代 `/api/nodes/ws` 后不必公网暴露。 |
| **APISIX 路由** | SaaS 需 `gateway-node-ws`：`Host=hubide.ljyd.cn`，`/api/nodes/ws` → `host.docker.internal:8787`。网关 `syncTaskHosts` 会自动写入；或运行 `.runtime-state/_ssh_apisix_node_ws.py`。 |
| **LB** | `hubide.ljyd.cn:443` 需转发到 APISIX **9080**（任务路径与 `/api/nodes/ws` 同入口）。若 volcalb 只转部分路径，需在控制台补规则。 |
| **节点凭证** | `.runtime-state/node.env` 中 `LINKAGENT_GATEWAY_TOKEN=nt_…`（后台颁发）；无 token 则 `LINKAGENT_NODE_CLAIM=nu_` 待审批。 |
| **任务绑定** | 后台任务指定该节点；节点在线后 `switchTask` 才会写 frpc locations。 |

## 本机配置（部署脚本 + 配置文件）

```text
<安装根>/.runtime-state/node.env     # 网关 / frps / PUBLIC_HOST / nt_
code-server/node-docker/node.env   # 可选：WORKSPACE、NODE_USER
config/node.yaml                   # serveWeb.enabled: false（形态 C）
```

启停（勿用 `pnpm node:docker`）：

```powershell
cd code-server\node-docker
.\start.bat restart
.\start.bat log
```

**勿**在 shell 长期 export `LINKAGENT_GATEWAY_URL`（会盖掉配置文件；ctl 已改为文件优先）。

## 验收

1. `docker logs linkagent-node`：`login to server success`（frpc）、无持续 `7000 i/o timeout`
2. frps 面板 `:7500` 见 `workspace-*` 且 location 含任务 id
3. `https://hubide.ljyd.cn/<taskId>-web/`、`-code`、`-vnc/vnc.html` 可开
