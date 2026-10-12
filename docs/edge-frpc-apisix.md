# frpc / frps 与 APISIX 路由

> **启停与配置**：本机 / 远程两套方案（gateway.yaml、node 环境变量、`scripts/edge.sh` 顺序）见 [`edge-apisix-node.md`](edge-apisix-node.md)。本文只讲路由与 frpc 登记原理。

浏览器访问任务页面时，经过公网入口、APISIX、frps，再到节点容器里的端口。节点上的 agent 不走这条链路：agent 由节点出站 WebSocket 连网关，ACP 是 stdin/stdout。

```
浏览器
  │  https://<publicHost>/<taskId>-web|code|vnc/...
  ▼
SLB
  ▼
APISIX :9080          都转到同一个 frps:7080。本机用 Host 区分，SaaS 用路径区分
  ├─ web  ──▶ frps:7080 ──▶ frpc ──▶ 本机 5173
  ├─ code ──▶ frps:7080 ──▶ frpc ──▶ 本机 code-server 8000
  └─ vnc  ──▶ frps:7080 ──▶ frpc ──▶ 本机 VNC
```

frpc 另有一条出站连接，用来登记上面的域名。它连的是 frps 控制口 `7000`，协议是 frp 自己的二进制协议，不是 HTTP。

## 端口

| 端口 | 进程 | 作用 |
|---|---|---|
| `9080` | APISIX 数据面 | 公网 HTTP 入口。管理 API 在 `127.0.0.1:9180`，路由存在 etcd，网关通过 Admin API 写入，不直接写 etcd |
| `7000` | frps `bindPort` | frpc 登录、登记代理、维持控制连接 |
| `7080` | frps `vhostHTTPPort` | HTTP 虚拟主机。`type = "http"` 的代理登记后从这里按 Host 转发。公网可以把 `443` 转到这个口 |
| `7500` | frps 面板 | 查看已登记的代理和动态端口。监听 `0.0.0.0`，用户名 `admin`，密码在 `.runtime-state/edge/frps.dashboard` |
| `10000–50000` | frps `allowPorts` | 只给 TCP/UDP 端口转发用。frps 启动时不占用整段，某条代理需要远端端口时才从这里分配。当前 dev / VNC 是 HTTP 域名，不占这段 |
| `5173` | 节点上的 web / dev | frpc 的 web 代理转到这里 |
| `8000` | 节点上的 code-server | frpc 的 code 代理转到这里。容器内进程听 `8080` 时，对 frpc 来说的本机口是映射出来的 `8000` |
| `6080` | 节点上的 noVNC | frpc 的 vnc 代理转到这里 |

`7080` 是固定的 HTTP 入口。动态的是 TCP/UDP 代理分到的 `10000–50000` 中的某一个端口，在面板 `7500` 上查看。

## frpc 登记

聚合容器里 IDE、VNC、frpc 由入口脚本拉起，node 不再 compose 第二个 code-server（`LINKAGENT_NODE_SERVE_WEB=0`）。

1. node 启动后写 `/etc/linkagent/frpc.toml`。`FRPS_TOKEN` 必须和 frps 的 `auth.token` 相同。不要填 `nt_`。只从环境读 `FRPS_SERVER_ADDR`、`FRPS_SERVER_PORT`（缺省 `host.docker.internal:7000`）。
2. 入口脚本等到这个文件出现后执行 `frpc -c /etc/linkagent/frpc.toml`。进程退出则 3 秒后重连。node 不负责拉起 frpc。
3. frpc 连控制口 `7000`。Login 的 `privilege_key` 可以由网关 `POST /internal/frp/handler` 把 `nt_` 改写成服务端令牌。登录之后，0.60 用两边配置里的 `auth.token` 加密控制连接，插件改不了这把密钥。两边不一致时，日志是 `login to server success` 接着马上 `try to connect`，frps 侧没有 `new proxy`。
4. HTTP 代理登记在 `7080`。frps 的匹配键是 Host（`customDomains`）加最长路径前缀（`locations`）。命中之后，原始 Host 和路径原样送到 `localIP:localPort`，frps 自己不剥路径。同一 Host 且没有互斥路径时，后登记的代理会失败，控制连接被关掉。

本机模式靠三个不同的 Host，不写 `locations`：

   | 代理 | 本机端口 | frps 用来匹配的 Host |
   |---|---|---|
   | web | `5173` | `dev.localhost` |
   | code | `8000` | `ide.localhost` |
   | vnc | `6080` | `vnc.localhost` |

   `customDomains` 只写主机名，配置里的 `:端口` 会被去掉。APISIX 把公网 Host 改成这三个名字，并去掉 `/<taskId>` 前缀，本机进程才能看到自己的路径。

SaaS 模式只有一个公网 Host（如 `hubide.ljyd.cn`），三条代理用路径分开。frps 取最长前缀，所以 `/<taskId>` 不会吃掉 `/<taskId>-code`：

| 代理 | frpc 本机口 | 应用端口 | location |
|---|---|---|---|
| dev | `15173` | `5173` | `/<taskId>`、`/<taskId>-web` |
| code | `18080` | `8080` | `/<taskId>-code` |
| vnc | `16080` | `6080` | `/<taskId>-vnc` |

`15173` / `18080` / `16080` 是节点上的适配器。dev 把 `/<taskId>-web` 收成 `/<taskId>`（Vite 的 base）。code、vnc 去掉任务前缀，进程仍挂在 `/`。APISIX 在 SaaS 下不改 Host、不剥路径，否则 `7080` 匹配不到。

登录成功只表示控制连接建立。frps 日志里出现对应代理名，才算 HTTP 路由挂上。`proxy added` 是 frpc 本地列表，还没有完成服务端登记。

主机模式是同一份配置：node 把 toml 写到运行目录再挂进 IDE 容器。聚合镜像改为 node 直接写容器内的 `/etc/linkagent/frpc.toml`，不再挂载，也不用环境变量生成这个文件。

## APISIX 规则

网关在任务创建、删除、改名、开关，以及进程启动时的 `syncTaskHosts`，通过 Admin API 写入。节点上线不会改这些规则。`127.0.0.1` 上游会改写成 `host.docker.internal`，因为 APISIX 跑在容器里。

公网 Host 是 `edge.publicHost`（例如 `hubide.ljyd.cn`）。路径是 `/<taskId>-web|code|vnc`。

本机模式的三条路由上游都是 frps `7080`。frpc 登记的是 localhost Host，所以 APISIX 要改写 Host。SaaS 模式同一条上游，但 `pass_host=pass`，路径保持浏览器原来的样子。

下面这张表是本机模式。SaaS 的 Host 列改为原样传递公网域名，路径列不改写。

| 路由 id | 匹配 | 上游 | 本机模式的 Host | 再由 frpc 转到 |
|---|---|---|---|---|
| `task-<taskId>` | `/<taskId>-web*` | frps `7080` | `dev.localhost` | `5173` |
| `task-code-<taskId>` | `/<taskId>-code*` | frps `7080` | `ide.localhost` | code-server `8000` |
| `task-vnc-<taskId>` | `/<taskId>-vnc*` | frps `7080` | `vnc.localhost` | VNC `6080` |
| `code-localhost` | `/vibe-ide*` | frps `7080` | `ide.localhost` | code-server `8000` |

本机模式里，code 去掉任务前缀后把路径改成 `/vibe-ide/...`，vnc 去掉 `/<taskId>-vnc`。这是 APISIX 在 frps 匹配之前做的，只适用于 localhost Host。SaaS 不能在 APISIX 做这一步。

本机模式以 `https://ide.localhost:9080/t_2fc1aed6-vnc/vnc.html` 为例：APISIX 把路径改成 `/vnc.html`、Host 改成 `vnc.localhost`，frps 只凭 Host 找到 vnc 代理。

SaaS 以 `https://hubide.ljyd.cn/t_2fc1aed6-vnc/vnc.html` 为例：APISIX 不改 Host 和路径。frps 用 `hubide.ljyd.cn` + `/t_2fc1aed6-vnc` 选中 vnc 代理，把原始路径送到节点 `16080`，适配器再变成 `/vnc.html` 交给 `6080`。

WebSocket（noVNC 的 `/websockify`）走同一条规则，APISIX 打开了 `enable_websocket`。
