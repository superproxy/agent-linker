# frpc / frps 与 APISIX 路由

> **启停与配置**：本机 / 远程两套方案（gateway.yaml、node 环境变量、`scripts/edge-ctl.sh` 顺序）见 [`edge-apisix-node.md`](edge-apisix-node.md)。本文只讲路由与 frpc 登记原理。

浏览器访问任务页面时，经过公网入口、APISIX、frps，再到节点容器里的端口。节点上的 agent 不走这条链路：agent 由节点出站 WebSocket 连网关，ACP 是 stdin/stdout。

```
浏览器
  │  https://<publicHost>/<taskId>-web|code|vnc/...
  ▼
SLB
  ▼
APISIX :9080          都转到同一个 frps:7080。默认 Host+路径（locations）与 SaaS 一致；legacy 三 Host 见 `LINKAGENT_FRPC_LEGACY_HOSTS=1`
  ├─ web  ──▶ frps:7080 ──▶ frpc ──▶ 15173（剥 `/-web` + HTML 补前缀）──▶ Vite 动态口（base `/`）
  ├─ code ──▶ frps:7080 ──▶ frpc ──▶ 18080 ──▶ code-server
  └─ vnc  ──▶ frps:7080 ──▶ frpc ──▶ 16080 ──▶ noVNC
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

**谁写 toml、谁 reload frpc 子进程**（`connector.ts` / `serve-web.ts` / `publishSaasFrpc`）：见 [`ops-local-components.md` §5.4](ops-local-components.md)。

聚合容器里 IDE、VNC、frpc 由入口脚本拉起，node 不再 compose 第二个 code-server（`LINKAGENT_NODE_SERVE_WEB=0`）。

1. node 启动后写 `/etc/linkagent/frpc.toml`。`FRPS_TOKEN` 必须和 frps 的 `auth.token` 相同。不要填 `nt_`。只从环境读 `FRPS_SERVER_ADDR`、`FRPS_SERVER_PORT`（缺省 `host.docker.internal:7000`）。
2. 入口脚本等到这个文件出现后执行 `frpc -c /etc/linkagent/frpc.toml`。进程退出则 3 秒后重连。node 不负责拉起 frpc。
3. frpc 连控制口 `7000`。Login 的 `privilege_key` 可以由网关 `POST /internal/frp/handler` 把 `nt_` 改写成服务端令牌。登录之后，0.60 用两边配置里的 `auth.token` 加密控制连接，插件改不了这把密钥。两边不一致时，日志是 `login to server success` 接着马上 `try to connect`，frps 侧没有 `new proxy`。
4. HTTP 代理登记在 `7080`。frps 的匹配键是 Host（`customDomains`）加最长路径前缀（`locations`）。命中之后，原始 Host 和路径原样送到 `localIP:localPort`，frps 自己不剥路径。同一 Host 且没有互斥路径时，后登记的代理会失败，控制连接被关掉。

**默认（本机 `ide.localhost` 与 SaaS 公网域）**：frps **0.60+** 支持 HTTP 代理的 `locations` 路径前缀（日志里可见 `location ["…"]`）。浏览器入口 **一个 Host**，三条 frpc 代理用路径分开；APISIX **不改 Host、不剥路径**。`/<taskId>-web` **仅** frps/frpc 路由区分；node **15173** 对 dev **rewrite 去掉**该前缀再转 Vite（base `/`），并对 HTML `Location` **补回**前缀，避免 `/@vite/client` 打到 9080 根。code/vnc 在 18080/16080 剥 `/-code|vnc`。

frps 取最长前缀，所以 `/<taskId>` 不会吃掉 `/<taskId>-code`：

| 模式 | 浏览器 Host | frpc `customDomains` | APISIX |
|---|---|---|---|
| 默认 path | `edge.publicHost`（如 `ide.localhost` / `hubide.example.com`） | 同上 + `locations` | `pass_host=pass`，路径原样 |
| **host 子域** | `{stem}-web.<apex>` 等（DNS `*.<apex>`） | 每任务三条 FQDN、无 locations | APISIX `*.<apex>` → frps `7080`，Host 原样 |
| legacy | `ide.localhost:9080` 路径仍 `/<taskId>-*` | `dev/ide/vnc.localhost` 三 Host、无 locations | 改 Host + 剥前缀（`LINKAGENT_FRPC_MODE=legacy`） |

SaaS / 默认本机登记示例（`hubide.ljyd.cn` 或 `ide.localhost`）：

| 代理 | frpc 本机口 | 应用端口 | location |
|---|---|---|---|
| dev | `15173`（frpc **固定**登记此口） | Vite **动态口**（`dev-port.json`，如 `50718`；手测 `1573` 需与之一致） | `/<taskId>-web` |
| code | `18080` | `8080` | `/<taskId>-code` |
| vnc | `16080` | `6080` | `/<taskId>-vnc` |

`15173` / `18080` / `16080` 是节点上的适配器。**frpc 不要**把 `workspace-dev` 的 `localPort` 写成 Vite 动态口。APISIX 在默认路径模式下不改 Host、不剥路径，否则 `7080` 匹配不到。

## frps 路由 vs Nginx（对照理解）

frps **7080** 上的 HTTP 代理，行为接近 Nginx 的 **`server_name` + `location` 前缀 + `proxy_pass`（不带 URI 路径）**：选中一条 `location` 后，把**完整原始 URI** 和 **Host** 转到后端，**不会**像 `proxy_pass http://upstream/;` 那样自动去掉 matched 前缀。

| frps / frpc（0.60+） | Nginx 近似写法 | 说明 |
|----------------------|----------------|------|
| `vhostHTTPPort = 7080` | `listen 7080;` | HTTP 入口 |
| `customDomains = ["ide.localhost"]` | `server_name ide.localhost;` | 先按 Host 选虚拟主机 |
| `locations = ["/t_6795b0f8-web"]` | `location /t_6795b0f8-web { ... }` | 同一 Host 下再按**最长路径前缀**选 `location` |
| `localPort = 15173` | `proxy_pass http://127.0.0.1:15173;`（**无**尾斜杠 URI） | 转发 **`/t_6795b0f8-web/@vite/client` 整段**，不是 `/@vite/client` |
| （frps 自身） | **没有** `rewrite` | 路径改写必须在 APISIX（legacy）或本机 15173/18080/16080 |

**本仓库默认路径模式**（`ide.localhost:9080` / SaaS 单 Host）可拆成两段 Nginx 类比：

```nginx
# ① APISIX :9080 — 只做反向代理，不改 Host/URI（pass_host=pass）
server {
  listen 9080;
  server_name ide.localhost;
  location /t_6795b0f8-web/ {
    proxy_pass http://127.0.0.1:7080;   # 原样 Host + URI 进 frps
    proxy_set_header Host $host;
  }
  # 另有 task-* 路由匹配 /t_*-code、-vnc、/-web 等，upstream 均为 frps:7080
}

# ② frps :7080 — 按 Host + location 前缀选 frpc 登记的后端（仍不 rewrite）
server {
  listen 7080;
  server_name ide.localhost;
  location /t_6795b0f8-web {           # frpc workspace-dev 的 locations
    proxy_pass http://127.0.0.1:15173; # URI 仍为 /t_6795b0f8-web/...
  }
  location /t_6795b0f8-code {
    proxy_pass http://127.0.0.1:18080;
  }
  location /t_6795b0f8-vnc {
    proxy_pass http://127.0.0.1:16080;
  }
}

# ③ 本机 15173（node saas-path）— dev：rewrite 剥前缀 + sub_filter 补 HTML；code/vnc 同理
server {
  listen 15173;
  location /t_6795b0f8-web/ {
    rewrite ^/t_6795b0f8-web(.*)$ $1 break;
    proxy_pass http://127.0.0.1:50718;   # upstream 见 /、/@vite/client（Vite base /）
    sub_filter 'src="/' 'src="/t_6795b0f8-web/';  # 实现上等价 rewriteDevHtmlForPublicPath
  }
}
server {
  listen 18080;
  location /t_6795b0f8-code/ {
    rewrite ^/t_6795b0f8-code(.*)$ $1 break;
    proxy_pass http://127.0.0.1:8080;
  }
}
```

**最长前缀**（frps 与 Nginx `location` 类似）：若同时登记 `/<taskId>` 与 `/<taskId>-code`，请求 `/-code` 会命中更长的 `-code` 规则；因此 dev 只登记 `/<taskId>-web`，不要再用裸 `/<taskId>` 盖住 `-code` / `-vnc`。

**Legacy 模式**（`LINKAGENT_FRPC_LEGACY_HOSTS=1`）：路径剥前缀 + 改 Host 放在 **APISIX**（像 Nginx 的 `rewrite` + `proxy_set_header Host dev.localhost`），frps 上只有三个 `server_name`（`dev/ide/vnc.localhost`），**无** `locations`——等价于「APISIX 做 rewrite，frps 只做按 Host 转发」。

| 现象 | 常见误解 | 对照 Nginx |
|------|----------|------------|
| 打开 `/-web/` 正常，但 `/@vite/client` 404 | 以为 frps 会剥前缀 | frps 从不剥；**15173** 剥前缀给 Vite，并 **rewrite HTML** 把 `src="/…"` 补成 `/-web/…` |
| frps 面板有规则但 502 | 只看了 APISIX | frps ≈ 第二层 `proxy_pass`；502 可能是 15173 后 Vite 未监听 |
| 9080 404、7080 200 | APISIX 缺路由 | 第一层 server 缺 `location`；与 frps 无关 |

**跳过 APISIX、直连 frps 数据口**（本机 `7080`）：

```powershell
curl.exe -s -o NUL -w "7080:%{http_code}`n" -H "Host: ide.localhost" "http://127.0.0.1:7080/<taskId>-web/"
```

与走 `9080` 相同：7080 → frpc → **15173** → 动态 Vite 口。

登录成功只表示控制连接建立。frps 日志里出现对应代理名，才算 HTTP 路由挂上。`proxy added` 是 frpc 本地列表，还没有完成服务端登记。

主机模式是同一份配置：node 把 toml 写到运行目录再挂进 IDE 容器。聚合镜像改为 node 直接写容器内的 `/etc/linkagent/frpc.toml`，不再挂载，也不用环境变量生成这个文件。

## APISIX 规则

网关在任务创建、删除、改名、开关，以及进程启动时的 `syncTaskHosts`，通过 Admin API 写入。节点上线不会改这些规则。`127.0.0.1` 上游会改写成 `host.docker.internal`，因为 APISIX 跑在容器里。

公网 apex 是 `edge.publicHost`（例如 `hubide.ljyd.cn`）。

**`edge.taskRouting: host`（或 `LINKAGENT_TASK_ROUTING=host`）** — 试 `*.hubide.ljyd.cn`：

- 浏览器：`https://{名称}-{taskId}-web.hubide.ljyd.cn/`（code 为 `-ide`，vnc 为 `-vnc`）
- DNS：`* .hubide.ljyd.cn` → SLB/APISIX；证书：通配符 SAN
- APISIX：一条 `task-wildcard-subdomain`，`host: *.hubide.ljyd.cn` → frps `7080`，**无** per-task `task-*` 路径路由
- frpc：三条 HTTP 代理，各自 `customDomains` 为上述 FQDN，**无** `locations`；切任务 reload frpc
- 15173/18080/16080：**不**剥 `/-web` 前缀（upstream 已是 `/`）
- 与 **`LINKAGENT_FRPC_MODE=tcp` 不要同开**（子域依赖 frps HTTP Host 匹配）

**`taskRouting: path`（默认）** — 单 Host + 路径 `/<taskId>-web|code|vnc`；APISIX 上游均为 frps `7080`，`pass_host=pass`，路径原样。legacy/tcp 见 `LINKAGENT_FRPC_MODE`。

下面表为 **legacy**（`LINKAGENT_FRPC_LEGACY_HOSTS=1`）。默认路径模式见上节。

| 路由 id | 匹配 | 上游 | 本机模式的 Host | 再由 frpc 转到 |
|---|---|---|---|---|
| `task-<taskId>` | `/<taskId>-web*` | frps `7080` | `dev.localhost` | `5173` |
| `task-code-<taskId>` | `/<taskId>-code*` | frps `7080` | `ide.localhost` | code-server `8000` |
| `task-vnc-<taskId>` | `/<taskId>-vnc*` | frps `7080` | `vnc.localhost` | VNC `6080` |

**不在 APISIX 登记** `/vibe-ide`（`code-localhost` 已删除）；code-server 浏览器入口仅为 `/<taskId>-code`。网关进程上的 `/vibe-ide` 只服务管理后台 iframe，直连本机 code-server，不经过 9080。

本机模式里，`-code` / `-vnc` 在 APISIX 剥任务前缀后改 Host；`-web` 同理。SaaS 不能在 APISIX 做 Host/路径改写（`pass_host=pass`）。

本机模式以 `https://ide.localhost:9080/t_2fc1aed6-vnc/vnc.html` 为例：APISIX 把路径改成 `/vnc.html`、Host 改成 `vnc.localhost`，frps 只凭 Host 找到 vnc 代理。

SaaS 以 `https://hubide.ljyd.cn/t_2fc1aed6-vnc/vnc.html` 为例：APISIX 不改 Host 和路径。frps 用 `hubide.ljyd.cn` + `/t_2fc1aed6-vnc` 选中 vnc 代理，把原始路径送到节点 `16080`，适配器再变成 `/vnc.html` 交给 `6080`。

WebSocket（noVNC 的 `/websockify`）走同一条规则，APISIX 打开了 `enable_websocket`。
