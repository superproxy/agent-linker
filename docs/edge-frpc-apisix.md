# frpc / frps 与 APISIX 路由

浏览器访问任务页面时，经过公网入口、APISIX、frps，再到节点容器里的端口。节点上的 agent 不走这条链路：agent 由节点出站 WebSocket 连网关，ACP 是 stdin/stdout。

```
浏览器
  │  https://<publicHost>/<taskId>-web|code|vnc/...
  ▼
SLB
  ▼
APISIX :9080          三条都转到 frps:7080，用 Host 区分是哪一条 frpc 代理
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

1. node 启动后写 `/etc/linkagent/frpc.toml`。令牌优先用 `FRPS_TOKEN`，否则用 `LINKAGENT_GATEWAY_TOKEN`（`nt_`）。只从环境读 `FRPS_SERVER_ADDR`、`FRPS_SERVER_PORT`（缺省 `host.docker.internal:7000`）。**SaaS 不在节点上配置公网域名**；`customDomains` 固定为 `ide.localhost`、`dev.localhost`、`vnc.localhost`，公网 `hubide.ljyd.cn` 等由 APISIX 在转发到 frps:7080 时改写 Host。
2. 入口脚本等到这个文件出现后执行 `frpc -c /etc/linkagent/frpc.toml`。进程退出则 3 秒后重连。node 不负责拉起 frpc。
3. frpc 用明文 TCP 连 `serverPort`（控制口 `7000`）。`auth.method = "token"`。frps 只认 `.runtime-state/edge/frps.token` 里的服务端令牌；节点的 `nt_` 由网关 `POST /internal/frp/handler` 在 Login 时改写成服务端令牌。
4. 登记三条 HTTP 代理，都暴露在 frps 的 `7080` 上，靠域名区分：

   | 代理 | 本机端口 | frps 用来匹配的 Host |
   |---|---|---|
   | web | `5173` | `dev.localhost` |
   | code | `8000` | `ide.localhost` |
   | vnc | `6080` | `vnc.localhost` |

   `customDomains` 只写主机名，配置里的 `:端口` 会被去掉。

登录成功只表示控制连接建立。frps 日志里出现对应代理名，才算 HTTP 路由挂上。`proxy added` 是 frpc 本地列表，还没有完成服务端登记。

主机模式是同一份配置：node 把 toml 写到运行目录再挂进 IDE 容器。聚合镜像改为 node 直接写容器内的 `/etc/linkagent/frpc.toml`，不再挂载，也不用环境变量生成这个文件。

## APISIX 规则

网关在任务创建、删除、改名、开关，以及进程启动时的 `syncTaskHosts`，通过 Admin API 写入。节点上线不会改这些规则。`127.0.0.1` 上游会改写成 `host.docker.internal`，因为 APISIX 跑在容器里。

公网 Host 是 `edge.publicHost`（例如 `hubide.ljyd.cn`）。路径是 `/<taskId>-web|code|vnc`。

三条路由的上游都是 frps `7080`。frps 只看 Host，所以 APISIX 要把 Host 改成 frpc 登记的域名。

| 路由 id | 匹配 | 上游 | Host | 再由 frpc 转到 |
|---|---|---|---|---|
| `task-<taskId>` | `/<taskId>-web*` | frps `7080` | `dev.localhost` | `5173` |
| `task-code-<taskId>` | `/<taskId>-code*` | frps `7080` | `ide.localhost` | code-server `8000` |
| `task-vnc-<taskId>` | `/<taskId>-vnc*` | frps `7080` | `vnc.localhost` | VNC `6080` |
| `code-localhost` | `/vibe-ide*` | frps `7080` | `ide.localhost` | code-server `8000` |

code 去掉任务前缀后把路径改成 `/vibe-ide/...`。vnc 去掉 `/<taskId>-vnc` 前缀。公网域名不能当作 frps 的 Host，否则 `7080` 上找不到对应的 frpc 代理。

以 `https://hubide.ljyd.cn/t_2fc1aed6-vnc/vnc.html` 为例：

1. APISIX 命中 `/t_2fc1aed6-vnc*`，上游是 frps `7080`。
2. 路径变成 `/vnc.html`，Host 变成 `vnc.localhost`。
3. frps 按这个 Host 找到 frpc 的 vnc 代理，转到本机 VNC。

web、code 同样先到 `7080`，Host 分别是 `dev.localhost` 和 `ide.localhost`。

WebSocket（noVNC 的 `/websockify`）走同一条规则，APISIX 打开了 `enable_websocket`。
