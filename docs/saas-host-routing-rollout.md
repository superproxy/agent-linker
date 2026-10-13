# SaaS 子域路由上线（hubide.ljyd.cn）

本地验证通过后，按此顺序更新线上。**gateway 与 worker 必须同一套 `taskRouting: host`。**

## 0. 前置

- DNS：`*.hubide.ljyd.cn`（及 apex `hubide.ljyd.cn`）→ SLB / APISIX `:9080`（或 443 终结后转 9080）
- 证书：通配符 `*.hubide.ljyd.cn`（或 SLB 统一证书）
- 代码：含 `taskRouting: host`、`wildcardTaskSubdomainRouteSpec`、`renderHostWorkspaceFrpc`

## 1. 本地验证（先做）

```powershell
# 安装根
cd D:\yxz\projects\agent-linker

# config/gateway.yaml 已有 edge.taskRouting: host
# .runtime-state/node.env：
#   LINKAGENT_TASK_ROUTING=host
#   LINKAGENT_PUBLIC_HOST=ide.localhost

pnpm server:restart
node scripts/dev-node-ctl.mjs restart -f .runtime-state/node.env
powershell -File scripts/verify-host-routing.ps1
```

通过标准：

| 检查项 | 期望 |
|--------|------|
| `GET /api/edge` | `"taskRouting":"host"` |
| APISIX `task-wildcard-subdomain` | `"host":"*.ide.localhost"` → `:7080` |
| `frpc.toml` | `type = "http"` + `customDomains = ["…-web.ide.localhost"]`，**无** `tcp` |
| `curl -H "Host: {stem}-web.ide.localhost" http://127.0.0.1:9080/` | 非 404（502 则查 dev/15173） |

浏览器：`http://default-web.ide.localhost:9080/`（激活任务为 default 时）。

切换激活任务后，在后台点任务链接或 `publishSaasFrpc` 后 `frpc.toml` 应变为对应 `{stem}-*.ide.localhost`。

若 frps 面板仍残留旧 TCP/路径代理：重启 frpc 或 `pnpm edge:restart`。

## 2. 网关（edge 机）

`config/gateway.yaml`（或 overlay）：

```yaml
edge:
  publicHost: hubide.ljyd.cn
  publicPort: 443
  taskRouting: host
```

进程环境（若未写 yaml）：

```text
LINKAGENT_TASK_ROUTING=host
LINKAGENT_PUBLIC_HOST=hubide.ljyd.cn
```

部署新 backend/web 后：

```bash
pnpm server:restart   # 或安装根等价命令
```

验收：Admin API 存在 `task-wildcard-subdomain`，`host` 为 `*.hubide.ljyd.cn`；**无**（或逐步删）旧 `task-*` 路径路由。

`GET https://hubide.ljyd.cn/api/edge` → `taskRouting: host`。

## 3. 远程 worker（node）

`.runtime-state/node.env` 或 `code-server/node-docker/node.env`：

```text
LINKAGENT_PUBLIC_HOST=hubide.ljyd.cn
LINKAGENT_TASK_ROUTING=host
FRPS_SERVER_ADDR=<frps 内网或 host.docker.internal>
FRPS_SERVER_PORT=7000
FRPS_TOKEN=<与 edge/frps.token 一致>
# 勿设 LINKAGENT_FRPC_MODE=tcp
```

重启 node / 容器；切换一次激活任务，确认 `frpc.toml` 为：

```toml
customDomains = ["<stem>-web.hubide.ljyd.cn"]
# 无 locations
```

## 4. 浏览器 URL

| 能力 | URL |
|------|-----|
| Web | `https://{stem}-web.hubide.ljyd.cn/` |
| Code | `https://{stem}-ide.hubide.ljyd.cn/` |
| VNC | `https://{stem}-vnc.hubide.ljyd.cn/…` |

管理后台 `/ui` 任务链接随 `/api/edge` 自动用子域。

## 5. 回滚

- `edge.taskRouting: path`（或删 `taskRouting`）
- 删 APISIX `task-wildcard-subdomain`，`server:restart` 重建 `task-*` 路径路由
- worker：`LINKAGENT_TASK_ROUTING=path`，重启并 `publishSaasFrpc` 恢复 locations
