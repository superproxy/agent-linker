# 网关 nginx / frps 与 NAT 隧道启动手册

网关进程负责在本机安装并拉起 nginx 和 frps。node 只拉起 code-server。`nat-tunnel` 是独立工程，用 frpc 把一台机器上的本机端口主动连到网关 frps。

```
浏览器 ──▶ 网关 nginx 127.0.0.1:8088/vibe-ide ──▶ 本机 code-server 127.0.0.1:8000
远程机器上的端口 ──▶ nat-tunnel（frpc，出站）──▶ 网关 frps 0.0.0.0:7000 ──▶ 远端端口 10000–50000
```

同一台机器上的 IDE 走 nginx 即可。端口在另一台机器、或在 NAT 后面时，再用 `nat-tunnel`。

## 1. 准备

| 项 | 要求 |
|---|---|
| Node.js | `>= 22.13` |
| 包管理 | 仓库根目录已执行 `pnpm install` |
| 网关出网 | 第一次启动要能访问 `nginx.org` 和 `github.com`，用来下载 nginx 1.26.3 与 frp 0.60.0 |
| Linux / macOS 的 nginx | 系统里已有 `nginx` 命令。这两个系统不下载 nginx 二进制 |
| code-server | 本机 Docker 可用，且 `backend/config/node.yaml` 里 `serveWeb.enabled: true` |
| 远端隧道 | 网关机对 NAT 客户端开放 TCP `7000`，以及实际使用的远端端口（`10000–50000`） |

## 2. 下载

在仓库根目录执行。网关启动时也会下载同一地址；二进制已经在 `.runtime-state/tools/` 里时会跳过。

```powershell
New-Item -ItemType Directory -Force -Path .runtime-state\tools\frp, .runtime-state\tools\nginx | Out-Null
Invoke-WebRequest -Uri "https://github.com/fatedier/frp/releases/download/v0.60.0/frp_0.60.0_windows_amd64.zip" -OutFile .runtime-state\tools\frp\download.bin
tar -xf .runtime-state\tools\frp\download.bin -C .runtime-state\tools\frp
Invoke-WebRequest -Uri "https://nginx.org/download/nginx-1.26.3.zip" -OutFile .runtime-state\tools\nginx\download.bin
tar -xf .runtime-state\tools\nginx\download.bin -C .runtime-state\tools\nginx
docker build -t linkagent-code-server:local -f code-server/Dockerfile code-server
```

原始路线用上面的镜像：宿主机 node 在 `serveWeb.enabled: true` 时 compose 它。`pnpm node` 默认是本机原生进程。同一组命令加上 `--docker`，或设置 `LINKAGENT_NODE_RUNTIME=docker`，改为 Docker 聚合镜像。本机没有 `linkagent-node:local` 时会先构建。没有 `code-server/node-docker/node.env` 时用同目录的 `node.env.example`。强制重新构建用 `pnpm node:docker:build`。

参数说明：

```powershell
pnpm node:help
```

解压后的程序：

```text
.runtime-state\tools\frp\frp_0.60.0_windows_amd64\frps.exe
.runtime-state\tools\frp\frp_0.60.0_windows_amd64\frpc.exe
.runtime-state\tools\nginx\nginx-1.26.3\nginx.exe
```

Linux 只下载 frp（把上面的 zip 换成 `frp_0.60.0_linux_amd64.tar.gz`），nginx 使用系统里的 `nginx`。

## 3. 启动网关

在仓库根目录：

```powershell
pnpm dev
```

网关先监听自己的端口（缺省 `127.0.0.1:8787`），再安装并启动 nginx 与 frps。日志里出现这两行即表示边缘进程已起来：

```text
[edge] frps 已启动，控制端口 7000
[edge] nginx 已在 127.0.0.1:8088 监听
```

第一次启动会把安装包解到 `.runtime-state/tools/`。已经存在的二进制不会重复下载。安装失败只打印 `[edge] 安装或启动失败`，网关 API 仍继续服务。

本机生成的文件：

| 路径 | 内容 |
|---|---|
| `.runtime-state/edge/nginx.conf` | nginx 配置，`daemon off` |
| `.runtime-state/edge/frps.toml` | frps 配置 |
| `.runtime-state/edge/frps.token` | frps 令牌。给 `nat-tunnel` 用，不要提交 |
| `.runtime-state/edge/frps.dashboard` | 面板密码，用户名固定 `admin` |
| `.runtime-state/edge/frpc.path` | 解压出来的 frpc 绝对路径 |

端口：

| 进程 | 地址 | 作用 |
|---|---|---|
| 网关 | 配置里的 host/port，缺省 `127.0.0.1:8787` | `/v1` 与管理后台 |
| nginx | `127.0.0.1:8088` | `/vibe-ide` 转到 `127.0.0.1:8000` |
| frps | `0.0.0.0:7000` | 接收 frpc |
| frps 面板 | `127.0.0.1:7500` | 只在本机看隧道状态 |

面板：浏览器打开 `http://127.0.0.1:7500`，用户 `admin`，密码读 `.runtime-state/edge/frps.dashboard`。

`Ctrl+C` 停网关时，会一并停掉它拉起的 nginx 和 frps。

## 4. 启动 node（code-server）

IDE 需要 Docker。在另一个终端、仓库根目录：

```bash
pnpm --filter @linkagent/backend node:connect
```

`node.yaml` 的 `serveWeb.enabled` 为 `true` 时，node 执行 `docker compose up -d`，只发布：

```text
127.0.0.1:8000 → 容器 8080
```

看到 `[node] 启动 IDE 容器 linkagent-code-serve-web，发布 127.0.0.1:8000` 后，在网关机上打开：

```text
http://127.0.0.1:8088/vibe-ide
```

`serveWeb.workspace` 为空时，挂进容器的目录是仓库根。node 退出时执行 `docker compose down`。

## 5. 启动 nat-tunnel

`nat-tunnel` 不在 pnpm workspace 里，依赖单独安装。它要和待暴露的端口在同一台机器上。

```bash
cd nat-tunnel
pnpm install
```

令牌用网关刚生成的文件，frpc 用网关解压出来的二进制。PowerShell（路径按 nat-tunnel 目录写）：

```powershell
$env:NAT_TUNNEL_TOKEN = (Get-Content ..\.runtime-state\edge\frps.token -Raw).Trim()
$env:FRPC_BIN = (Get-Content ..\.runtime-state\edge\frpc.path -Raw).Trim()
pnpm dev
```

bash：

```bash
export NAT_TUNNEL_TOKEN="$(tr -d '[:space:]' < ../.runtime-state/edge/frps.token)"
export FRPC_BIN="$(tr -d '[:space:]' < ../.runtime-state/edge/frpc.path)"
pnpm dev
```

客户端和 frps 不在同一台机器时，把 `nat-tunnel/config/default.yaml` 的 `frps.serverAddr` 改成网关机可达地址，端口保持 `7000`。同机保持 `127.0.0.1`。

服务监听 `127.0.0.1:9898`。健康检查：

```bash
curl http://127.0.0.1:9898/healthz
```

## 6. 开一条隧道

远端端口必须在 `10000–50000`。下面把客户端的 `127.0.0.1:8000` 映到网关的 `18000`：

```bash
curl -X POST http://127.0.0.1:9898/api/tunnels -H "content-type: application/json" -d "{\"name\":\"ide-8000\",\"localPort\":8000,\"remotePort\":18000}"
```

成功后网关机上 `0.0.0.0:18000` 转到这条隧道的本机 `8000`。

查看与关闭：

```bash
curl http://127.0.0.1:9898/healthz
curl -X DELETE http://127.0.0.1:9898/api/tunnels/ide-8000
```

未设置 `NAT_TUNNEL_TOKEN` 时，创建接口返回 `400`。`name` 只能是字母、数字、`.`、`_`、`-`。

## 7. 停止顺序

先停 `nat-tunnel`（`Ctrl+C`，它会停掉自己拉起的 frpc），再停 node，最后停网关。网关退出会停 nginx 和 frps。code-server 容器由 node 的 `docker compose down` 收掉。
