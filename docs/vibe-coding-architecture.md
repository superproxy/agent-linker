# Vibe Coding 系统架构

对话走现有 ACP node。IDE、文件树、页面预览走 Nginx + frp + `code serve-web`。远程桌面走 MeshCentral。三条链路互不替代。

## 目标架构

```mermaid
flowchart TB
  subgraph browser [浏览器]
    Chat[现有对话页]
    Vibe[Vibe 页]
  end

  subgraph public [公网机]
    GW[LinkAgent 网关]
    NGX[Nginx 按域名]
    FRPS[frps]
    MC[MeshCentral]
  end

  subgraph machine [每台机器]
    ACP[ACP node]
    CODE["code serve-web"]
    FRPC[frpc]
    AGENT[MeshAgent]
    PAGE[本机页面 localhost]
  end

  Chat -->|/v1| GW
  GW <-->|出站 WebSocket /api/nodes/ws| ACP

  Vibe -->|打开 IDE / 查看页面| NGX
  NGX -->|ide-nodeId.preview.域名| FRPS
  FRPS <-->|出站| FRPC
  FRPC --> CODE
  CODE --> PAGE

  Vibe -->|打开远程桌面| MC
  MC <-->|出站| AGENT
```

## 三条链路

```mermaid
flowchart LR
  subgraph chatLink [对话]
    C1[对话页] --> G1[网关 /v1]
    G1 --> A1[ACP node]
  end

  subgraph ideLink [IDE 与页面]
    C2[Vibe 页] --> N1[Nginx]
    N1 --> S1[frps]
    S1 --> P1[frpc]
    P1 --> W1["code serve-web"]
    W1 --> L1[localhost 页面]
  end

  subgraph deskLink [远程桌面]
    C3[Vibe 页] --> M1[MeshCentral]
    M1 --> G2[MeshAgent]
  end
```

| 链路 | 入口 | 节点上的进程 | 不经过 |
|---|---|---|---|
| 对话 | 现有网关 `/v1`、`/api/nodes/ws` | ACP node | frp、MeshCentral |
| IDE、文件树、页面预览 | `https://ide-{nodeId}.preview.<域名>` | `code serve-web` + frpc | ACP WebSocket、MeshCentral |
| 远程桌面 | MeshCentral | MeshAgent | frp |

页面预览用 VS Code Web 的 Ports，打开该节点上的 `localhost` 端口。Nginx 必须转发 `Host`，并打开 WebSocket。`code serve-web` 对外必须带 connection token，或由 Nginx 做登录校验。

## 从本机到云端

图的形状不变。先在本机跑通 IDE，再把公网入口装上，最后把同一套进程放到每台机器。

```mermaid
flowchart LR
  L1["1. 本机<br/>code serve-web<br/>127.0.0.1:8000"]
  L2["2. 本机走域名<br/>Nginx + frps + frpc"]
  L3["3. 每台机器<br/>ACP node 旁再跑<br/>serve-web + frpc"]
  L4["4. 公网机<br/>MeshCentral"]

  L1 --> L2 --> L3 --> L4
```

当前只完成第 1 步：本机 `code serve-web` 听 `http://127.0.0.1:8000`，工作区为仓库目录，未出公网。
