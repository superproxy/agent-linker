# 操作记录：推送网关机 + 本机 Docker 节点连远程（2026-10-12）

## 目标

- 将 `main` 上 dev 路径 / APISIX / 宿主机动态 dev 相关修复推到 GitHub，并在**网关机**更新部署。
- 在**开发机 Windows** 用 **形态 C**（`linkagent-node` 聚合容器）作为执行节点，回连 **SaaS 网关机** `hubide.ljyd.cn`，与本地 PM 原生 node **二选一**。

参考：[`edge-apisix-node.md`](edge-apisix-node.md) §4.2、[`deployment.md`](deployment.md) 升级节。

---

## 1. 代码推送（已完成）

```powershell
cd D:\yxz\projects\agent-linker
git push origin main
```

结果：`d593f6e..b76db3d  main -> main`（commit：`fix: 路径模式下宿主机动态 dev 与 APISIX/-web 路由对齐`）。

---

## 2. 网关机更新（需在 Linux 安装目录执行）

OpenSSH **`ssh my-server`**（`~/.ssh/config` → `150.5.142.161`）在 **BatchMode** 下会 `Permission denied (publickey,password)`，需交互输密码或配密钥。自动化可用 Paramiko（勿把密码写进仓库；`.ssh` 文件勿提交）。

已在服务器执行（2026-10-12）：

```bash
# 1) 未跟踪的 config/pi-agent/* 挡住 merge → 先 mv 到 backup 目录
# 2) git pull --ff-only → b76db3d
# 3) bash scripts/server-install-update.sh --no-pull --restart
```

手工等价命令：

```bash
cd /opt/agent-linker   # 或你的 LINKAGENT_INSTALL / git clone 路径
git pull --ff-only
bash scripts/server-install-update.sh --restart
```

说明：

- `server-install-update` 会 `pnpm build:dist` 并同步到安装根，**不覆盖** 已有 `config/`、`.runtime-state/`。
- `--restart` 在安装目录执行 `./start.sh restart gateway`（APISIX 需已监听后再同步路由；edge 未改则通常只需 gateway）。
- 公网探活：`curl -sI https://hubide.ljyd.cn/` 有响应（LB 404 属正常，任务路径走 APISIX `9080`）。

从网关机读取 frps 令牌（执行机 `FRPS_TOKEN` 必须一致）：

```bash
cat "$LINKAGENT_HOME/.runtime-state/edge/frps.token"
# 或安装根下 .runtime-state/edge/frps.token
```

---

## 3. 本机准备 `node.env`（SaaS Docker C）

模板：`code-server/node-docker/node.env.remote.example` → 复制为 `code-server/node-docker/node.env`。

| 变量 | 说明 |
|------|------|
| `LINKAGENT_GATEWAY_URL` | `wss://hubide.ljyd.cn` |
| `LINKAGENT_GATEWAY_TOKEN` | 后台「远程 · 节点」颁发的 **nt_**（或 `LINKAGENT_NODE_CLAIM=nu_` 审批） |
| `FRPS_SERVER_ADDR` | 网关机 frps 控制口 IP（文档/测试示例 `150.5.140.64`，以运维为准） |
| `FRPS_TOKEN` | 与网关机 `frps.token` 相同 |
| `LINKAGENT_PUBLIC_HOST` | `hubide.ljyd.cn`，与 `gateway.yaml` 的 `edge.publicHost` 一致 |
| `LINKAGENT_WORKSPACE` | 宿主机任务根，挂载到容器 `/root/workspace/<LINKAGENT_NODE_USER>` |

**不要**在本方案同时起：

- PM `node`（`pnpm pm:restart node`）
- `local:stack:start` 默认原生栈（会起 PM node）
- 本机 `edge` + 本地 gateway（除非仍要做本机联调；纯远程执行机只需 Docker node）

---

## 4. 本机启停 Docker 节点（**部署脚本**，勿用 `pnpm node:docker*`）

配置：`code-server/node-docker/node.env`（见 `node.env.remote.example`）。

```powershell
cd D:\yxz\projects\agent-linker

# 勿与 PM 原生 node 同跑
pnpm --filter @linkagent/backend pm:stop node

# 清除 shell 里残留的 LINKAGENT_*（否则会覆盖 node.env）
Remove-Item Env:LINKAGENT_GATEWAY_URL, Env:LINKAGENT_GATEWAY_TOKEN, `
  Env:LINKAGENT_PUBLIC_HOST, Env:FRPS_SERVER_ADDR, Env:FRPS_TOKEN -ErrorAction SilentlyContinue

# 构建：dist/linkagent-node + 镜像（与 Releases 执行机一致）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-node.ps1

# 启停（与 dist 包旁的 node-docker 相同）
cd code-server\node-docker
.\start.bat stop
.\start.bat start
.\start.bat status
.\start.bat log

# Linux：./start.sh {start|stop|restart|status|log}
# 仅原生 PM 节点（非 Docker）才用 dist/linkagent-node/start.bat + .runtime-state/node.env
```

开发仓库里的 `pnpm node:docker` / `local:stack:start:enhance:docker` 仅用于本机联调，**远程执行机形态 C 请用上面 `build-node.ps1` + `start.bat`**。

---

## 5. 网关机侧验收

1. 后台 **节点**：新节点待审批则 **批准**；状态在线。
2. frps 面板（若开放 `7500`）：可见远程 `workspace-*` 代理。
3. 任务链接：`pnpm task:links` 或 UI 打开 `https://hubide.ljyd.cn/<taskId>-web/`、`-code`、`-vnc`。
4. 容器内 dev：路径模式 + `LINKAGENT_DEV_BY_NODE=1` 时，dev 在容器内动态口；与本次 commit 在**远程裸机 PM node** 上的宿主机 dev 行为不同，以实际 `node.env` / 镜像版本为准。

---

## 6. 本次会话环境快照

| 项 | 值 |
|----|-----|
| 推送 | `origin/main` @ `b76db3d` |
| 本机 PM（操作前） | gateway / channels / **node** 均在运行 |
| 本机 `config/node.yaml` | `hostCodeServerCompose.enabled: false`（enhance 靠 `LINKAGENT_LOCAL_STACK_ENHANCE` 或 Docker C） |
| 原 `node.env` | 指向 `host.docker.internal`（单机形态 C 联调），连远程需按 §3 改写 |

---

## 7. 本机已执行步骤（2026-10-12 会话）

| 步骤 | 结果 |
|------|------|
| `git push origin main` | ✅ `b76db3d` |
| SSH 网关机 `my-server` / `150.5.142.161` | ✅ Paramiko 密码登录；OpenSSH 需密钥或交互密码 |
| `server-install-update` → `/opt/agent-linker` + restart gateway | ✅ 已至 `b76db3d` |
| `pm:stop node` | ✅ 已停 PM node（gateway/channels 仍运行） |
| `pnpm node:docker:build` | ✅ `linkagent-node:local` 已重建（含本次 dist 节点包） |
| `pnpm node:docker` | ✅ 容器 `linkagent-node` running |
| 当前 `node.env` | 仍为 **单机** `ws://host.docker.internal:8787` + `FRPS_SERVER_ADDR=host.docker.internal` |
| 容器内 frpc | ✅ `login to server success`，代理 `workspace-ide/dev/vnc` |
| 切远程 | 按 §3 改写 `node.env` 后 `pnpm node:docker:restart`；日志勿提交 **nt_** / **FRPS_TOKEN** |

---

## 8. 回退本机单机 enhance（形态 B）

```powershell
pnpm node:docker:stop
$env:LINKAGENT_LOCAL_STACK_ENHANCE = '1'
pnpm --filter @linkagent/backend pm:restart node
pnpm local:stack:restart:enhance   # 或 dev-local-stack.ps1 restart -Enhance
```
