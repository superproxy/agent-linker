# Web Vibe Coding 平台：整体方案、功能列表与任务列表

> 版本：MVP v0.1  
> 目标：以成熟 Coding Agent（DSH / ACP 等）作为执行引擎，不自研 Agent Loop；通过云主机统一承载 Web IDE、项目管理、Preview Gateway，并通过成熟反向隧道将远端 Runtime/开发服务器接入云端。

---

## 1. 产品目标

构建一个 Web 化 Vibe Coding 平台，让用户可以：

1. 创建一个项目。
2. 在浏览器中与 Coding Agent 对话。
3. Agent 修改项目文件、安装依赖、运行命令。
4. 自动启动开发服务器。
5. 浏览器直接预览实时页面，并支持 HMR/WebSocket。
6. 在不同网络环境下，Runtime 主动反向连接云主机，不要求用户开放公网端口。
7. 后续支持 Git、部署、生产发布、多人协作和更多 Agent。

核心原则：

- **不自研 Coding Agent**：Agent Loop、Tool Calling、Context、Model Adapter、Permission 等能力交给 DSH / ACP / 其他成熟 Agent。
- **平台负责控制面和产品体验**：Project、Workspace、Session、Preview、发布、权限。
- **Runtime 主动出站连接**：解决 NAT、家庭网络、企业内网、跨网环境。
- **Preview 与 Publish 分离**：开发预览是实时 Dev Server；正式发布是独立 Deploy 流程。

---

# 2. 总体架构

```text
                                   Internet
                                      │
                     ┌────────────────┴────────────────┐
                     │                                 │
                     ▼                                 ▼
               Web Browser                         Runtime
          ┌─────────────────┐              ┌──────────────────┐
          │ Web IDE         │              │ Runtime Agent    │
          │                 │              │                  │
          │ Project         │              │ DSH / ACP        │
          │ File Tree       │              │ Workspace        │
          │ Editor          │              │ Dev Server       │
          │ Agent Chat      │              │ Tunnel Client    │
          │ Preview         │              │                  │
          └────────┬────────┘              └────────┬─────────┘
                   │                                │
                   │ HTTPS / WebSocket              │ outbound
                   ▼                                │ tunnel
          ┌─────────────────────────────────────────┴───────┐
          │                    Cloud Server                  │
          │                                                 │
          │  API Gateway                                    │
          │      │                                          │
          │      ├── Project Service                        │
          │      ├── Agent Session Service                   │
          │      ├── Runtime Registry                        │
          │      ├── Auth / Permission                       │
          │      └── Publish Service                         │
          │                                                 │
          │  Preview Gateway                                │
          │      │                                          │
          │      └── Reverse Tunnel                         │
          │             │                                   │
          │             └── frp / rathole                   │
          │                                                 │
          └─────────────────────────────────────────────────┘
```

---

# 3. 核心组件

## 3.1 Web IDE

职责：

- 项目列表
- 项目创建
- 文件树
- 文件编辑器
- Agent Chat
- Terminal/命令状态
- Build 状态
- Preview
- Publish

建议 MVP：

- React / Next.js
- Monaco Editor
- WebSocket/SSE 用于 Agent 流式输出
- iframe 用于 Preview

---

## 3.2 Project Service

负责：

- Project CRUD
- Project ID
- Project Name
- Project Owner
- Runtime 绑定
- Preview URL
- Git 信息
- Publish 信息

核心对象：

```text
Project
├── id
├── name
├── owner_id
├── runtime_id
├── workspace_id
├── preview_url
├── status
└── created_at
```

---

## 3.3 Agent Session Service

平台不实现 Agent Loop。

平台只负责：

```text
Web IDE
   │
   ▼
Agent Session Service
   │
   ▼
ACP / DSH
   │
   ▼
Workspace
```

职责：

- 创建 Agent Session
- Session ID
- Project 与 Session 绑定
- Agent 状态
- Agent 输出流
- 中断/停止
- 重连
- Session 日志

Agent 可以执行：

```text
npm install
npm run dev
npm run build
git status
git diff
```

平台不重复实现这些 Agent 能力。

---

# 4. Runtime

Runtime 是整个系统跨网络运行的关键。

Runtime 可以运行在：

- 云服务器
- Docker
- 用户本机
- 私有服务器
- 企业内网
- 后续 Kubernetes Pod

Runtime：

```text
Runtime
├── Agent
│   └── DSH / ACP
│
├── Workspace
│   ├── filesystem
│   └── git
│
├── Dev Runtime
│   └── npm run dev
│
└── Tunnel Client
    └── frpc / rathole
```

Runtime 不要求公网入站端口。

Runtime 主动连接云主机：

```text
Runtime ───────── outbound ────────> Cloud Server
```

---

# 5. Preview 架构

Preview 不是生产 Build Artifact，而是实时 Dev Server。

```text
Agent 修改代码
      │
      ▼
Workspace
      │
      ▼
npm run dev
      │
      ▼
localhost:5173
      │
      ▼
Tunnel Client
      │
      ▼
Cloud Preview Gateway
      │
      ▼
https://p123.preview.example.com
      │
      ▼
Browser iframe
```

必须支持：

- HTTP
- HTTPS
- WebSocket
- HMR
- SSE/streaming（视框架需要）

---

# 6. 反向隧道方案

## 6.1 首选：frp

frp 是成熟的内网穿透/反向代理方案，支持 TCP、UDP、HTTP、HTTPS，以及 WebSocket 等通信方式；其 HTTP/HTTPS 模式可以依据 Host 路由到不同服务。

官方文档：
- https://gofrp.org/en/docs/overview/
- https://gofrp.org/en/docs/reference/client-configures/
- https://gofrp.org/en/docs/features/http-https/

架构：

```text
Runtime
  │
  │ frpc outbound
  ▼
Cloud
  │
  │ frps
  ▼
Preview Gateway
```

## 6.2 备选：rathole

rathole 是专门用于 NAT traversal 的轻量反向代理，采用 Server/Client 模式，并支持 TLS/Noise 等安全机制。

官方项目：
- https://github.com/rathole-org/rathole

注意：rathole 官方定位是网络转发，不负责 HTTP Gateway、域名路由、日志和完整负载均衡。因此可以把它作为底层 Tunnel，再由 Nginx/Caddy/自有 Preview Gateway 做 HTTP 层。

## 6.3 MVP 决策

第一版优先：

```text
frp
```

原因：

- 功能成熟
- HTTP/HTTPS Host 路由直接可用
- WebSocket 场景容易接入
- Client/Server 模型与 Runtime 天然匹配
- 后续可以抽象 TunnelProvider

代码抽象：

```text
TunnelProvider
├── FrpProvider
├── RatholeProvider
└── FutureProvider
```

---

# 7. Preview Gateway

域名规划：

```text
app.example.com
api.example.com

p-{project_id}.preview.example.com
```

例如：

```text
p-123.preview.example.com
p-456.preview.example.com
```

Gateway 根据 Host 找到：

```text
Host
 ↓
Project
 ↓
Runtime
 ↓
Tunnel
 ↓
localhost:5173
```

核心数据：

```text
RuntimeRegistry

runtime_id
project_id
tunnel_id
status
last_seen
port
metadata
```

状态：

```text
OFFLINE
CONNECTING
READY
BUSY
STOPPING
ERROR
```

---

# 8. Workspace

MVP：

```text
/project
├── package.json
├── src/
├── public/
└── ...
```

职责：

- 文件系统
- Git
- npm/pnpm
- 环境变量
- Agent 工作目录

第一版建议：

- 每个 Project 一个独立 Workspace
- 每个 Workspace 一个 Runtime
- Docker 隔离
- 不追求复杂 Kubernetes

后续：

```text
Project
  ↓
Workspace Container
  ↓
Persistent Volume
```

---

# 9. Build

MVP 阶段不要做独立 Build Service。

Agent 自己执行：

```bash
npm install
npm run build
npm run dev
```

平台只负责：

- 命令状态
- 日志
- 成功/失败状态

开发：

```text
Workspace
   ↓
npm run dev
   ↓
Preview
```

生产：

```text
Workspace
   ↓
Publish Service
   ↓
Cloudflare Pages / Vercel / Netlify
   ↓
Production URL
```

这样可以避免早期投入 Docker Builder、构建队列、Artifact Service 等复杂基础设施。

---

# 10. Publish

Publish 与 Preview 完全分开。

```text
Preview
localhost:5173
     ↓
Tunnel
     ↓
preview.example.com

Publish
Workspace
     ↓
Build
     ↓
Deploy API
     ↓
Production
```

MVP 支持一个 Provider 即可。

建议先抽象：

```text
DeployProvider
├── CloudflarePages
├── Vercel
└── Netlify
```

---

# 11. 数据模型

## User

```text
User
├── id
├── email
└── created_at
```

## Project

```text
Project
├── id
├── name
├── owner_id
├── runtime_id
├── workspace_id
├── status
├── preview_url
└── created_at
```

## Runtime

```text
Runtime
├── id
├── project_id
├── token
├── status
├── hostname
├── last_seen
└── created_at
```

## AgentSession

```text
AgentSession
├── id
├── project_id
├── runtime_id
├── agent_type
├── status
├── started_at
└── ended_at
```

## Preview

```text
Preview
├── id
├── project_id
├── runtime_id
├── host
├── port
├── status
└── created_at
```

## Deployment

```text
Deployment
├── id
├── project_id
├── provider
├── status
├── url
├── commit
└── created_at
```

---

# 12. 功能列表

## P0：必须完成

### 项目

- [ ] 创建项目
- [ ] 删除项目
- [ ] 项目列表
- [ ] Project ID
- [ ] Runtime 绑定

### Workspace

- [ ] 创建 Workspace
- [ ] 文件树
- [ ] 文件读取
- [ ] 文件保存
- [ ] Git 初始化

### Agent

- [ ] 创建 Agent Session
- [ ] DSH/ACP 接入
- [ ] Agent Chat
- [ ] 流式输出
- [ ] Agent Stop
- [ ] Agent 状态
- [ ] Agent 执行命令

### Runtime

- [ ] Runtime 启动
- [ ] Runtime 注册
- [ ] Runtime 心跳
- [ ] Runtime 状态
- [ ] Runtime 与 Project 绑定

### Preview

- [ ] 启动 Dev Server
- [ ] frp Client
- [ ] frp Server
- [ ] Preview Gateway
- [ ] 动态 Preview Domain
- [ ] HTTP 转发
- [ ] WebSocket 转发
- [ ] iframe Preview
- [ ] Preview Reload

### 基础安全

- [ ] Runtime Token
- [ ] API Authentication
- [ ] Project 权限检查
- [ ] Preview URL 鉴权
- [ ] Runtime 隔离

---

# 13. P1：第二阶段

### IDE

- [ ] Monaco Editor
- [ ] 多文件编辑
- [ ] Search
- [ ] Diff
- [ ] Git Diff
- [ ] Terminal
- [ ] Error Panel

### Agent

- [ ] 多 Agent Provider
- [ ] Agent Session Resume
- [ ] Session History
- [ ] Context 管理
- [ ] Agent Permission
- [ ] Agent Tool Logs

### Runtime

- [ ] Docker Runtime
- [ ] Runtime 自动创建
- [ ] Runtime 自动销毁
- [ ] Runtime Reconnect
- [ ] CPU/Memory 限制
- [ ] Runtime Health Check

### Git

- [ ] Git Status
- [ ] Commit
- [ ] Branch
- [ ] Push
- [ ] Pull
- [ ] GitHub Integration

### Preview

- [ ] Preview Logs
- [ ] Restart Dev Server
- [ ] Port Detection
- [ ] 多端口
- [ ] Preview Error Page

---

# 14. P2：生产能力

- [ ] Publish
- [ ] Production Domain
- [ ] Custom Domain
- [ ] HTTPS
- [ ] Deployment History
- [ ] Rollback
- [ ] Environment Variables
- [ ] Secrets
- [ ] Build Cache
- [ ] Artifact Storage

---

# 15. P3：平台化

- [ ] 多用户
- [ ] Team
- [ ] Organization
- [ ] RBAC
- [ ] 多 Runtime
- [ ] Kubernetes
- [ ] Runtime Pool
- [ ] GPU Runtime
- [ ] Billing
- [ ] Quota
- [ ] Usage Metering
- [ ] Audit Log

---

# 16. 任务列表

## Milestone 0：技术验证

目标：证明完整链路可工作。

### T0.1 云主机

- [ ] 准备 VPS
- [ ] 配置 Docker
- [ ] 配置域名
- [ ] 配置 HTTPS
- [ ] 配置防火墙

### T0.2 frp

- [ ] 部署 frps
- [ ] Runtime 部署 frpc
- [ ] 建立 Runtime → VPS 长连接
- [ ] 将 localhost:5173 暴露到 VPS
- [ ] 验证 HTTP
- [ ] 验证 WebSocket
- [ ] 验证 Vite HMR

### T0.3 Preview

- [ ] 创建 preview 子域名
- [ ] 配置 wildcard DNS
- [ ] 配置 Gateway
- [ ] iframe 加载 Preview
- [ ] 修改代码验证 HMR

### T0.4 Agent

- [ ] DSH/ACP 启动
- [ ] Agent 修改文件
- [ ] Agent 启动 npm run dev
- [ ] 浏览器看到修改结果

验收：

```text
Browser
  ↓
Web IDE
  ↓
Agent
  ↓
修改 React 项目
  ↓
npm run dev
  ↓
frpc
  ↓
VPS
  ↓
preview.example.com
  ↓
Browser
```

---

# 17. Milestone 1：MVP

## Backend

- [ ] API Server
- [ ] PostgreSQL
- [ ] Project Service
- [ ] Runtime Registry
- [ ] Agent Session Service
- [ ] Preview Service
- [ ] Auth

## Frontend

- [ ] Project List
- [ ] Project Detail
- [ ] File Tree
- [ ] Editor
- [ ] Chat
- [ ] Preview
- [ ] Runtime Status

## Runtime

- [ ] Runtime Image
- [ ] Workspace
- [ ] DSH/ACP
- [ ] frpc
- [ ] Dev Server
- [ ] Health Check

---

# 18. Milestone 2：稳定性

- [ ] Runtime 自动重连
- [ ] Agent Session Resume
- [ ] Preview 自动恢复
- [ ] Tunnel Health Check
- [ ] Runtime Heartbeat
- [ ] Timeout
- [ ] Retry
- [ ] Crash Recovery
- [ ] 日志集中化

---

# 19. Milestone 3：发布

- [ ] Build
- [ ] Deployment API
- [ ] Production URL
- [ ] Deployment History
- [ ] Rollback
- [ ] Environment Variables

---

# 20. Milestone 4：规模化

```text
                    Load Balancer
                         │
             ┌───────────┴───────────┐
             │                       │
          API Node                API Node
             │                       │
             └───────────┬───────────┘
                         │
                    PostgreSQL
                         │
              ┌──────────┴──────────┐
              │                     │
          Runtime Pool          Runtime Pool
              │                     │
        ┌─────┼─────┐         ┌─────┼─────┐
        ▼     ▼     ▼         ▼     ▼     ▼
       R1    R2    R3        R4    R5    R6
```

后续再考虑：

- Kubernetes
- Runtime Scheduler
- Queue
- Object Storage
- Redis
- Build Worker
- GPU Worker

---

# 21. 推荐技术栈

## Frontend

```text
Next.js / React
Monaco Editor
WebSocket
iframe
```

## Backend

推荐：

```text
Node.js / TypeScript
```

或者：

```text
Go
```

如果希望快速做产品，Backend 先用 TypeScript。

## Database

```text
PostgreSQL
```

## Agent

```text
DSH
ACP
```

平台不自研 Agent Loop。

## Runtime

```text
Docker
Linux
Node.js
pnpm/npm
```

## Tunnel

第一版：

```text
frp
```

第二选择：

```text
rathole
```

## Gateway

```text
Nginx / Caddy
+
frp
```

后续可以替换成自己的 Preview Gateway。

## Deploy

第一版：

```text
Cloudflare Pages
```

后续：

```text
Vercel
Netlify
自建 Docker Deploy
```

---

# 22. 第一版不做什么

为了控制 MVP 范围，明确不做：

- 不自研 LLM Agent
- 不自研 Tool Calling
- 不自研 Context Engine
- 不自研 LSP
- 不自研 Docker Build Engine
- 不做 Kubernetes
- 不做复杂 CI/CD
- 不做多人实时编辑
- 不做 Billing
- 不做复杂权限体系
- 不做多云调度
- 不做自定义网络协议
- 不做自己的 NAT Traversal

---

# 23. 最终 MVP 架构

```text
┌────────────────────────────────────────────────────────────┐
│                         Web IDE                            │
│                                                            │
│  Projects │ Files │ Editor │ Agent Chat │ Preview          │
└───────────────────────────┬────────────────────────────────┘
                            │
                     HTTPS / WebSocket
                            │
                            ▼
┌────────────────────────────────────────────────────────────┐
│                       Cloud Server                         │
│                                                            │
│  API                                                        │
│   ├── Project                                               │
│   ├── Agent Session                                         │
│   ├── Runtime Registry                                      │
│   └── Publish                                                │
│                                                            │
│  Preview Gateway                                             │
│       │                                                     │
│       ▼                                                     │
│      frps                                                   │
└───────────────────────────┬────────────────────────────────┘
                            │
                     outbound tunnel
                            │
                            ▼
┌────────────────────────────────────────────────────────────┐
│                         Runtime                            │
│                                                            │
│  DSH / ACP                                                  │
│       │                                                     │
│       ▼                                                     │
│  Workspace                                                  │
│       │                                                     │
│       ├── package.json                                      │
│       ├── src/                                              │
│       └── ...                                               │
│       │                                                     │
│       ▼                                                     │
│  npm run dev                                                │
│       │                                                     │
│       ▼                                                     │
│  localhost:5173                                             │
│                                                            │
│  frpc ────────────────────────────────> Cloud Server        │
└────────────────────────────────────────────────────────────┘
```

---

# 24. 最关键的 MVP 用户流程

```text
1. 用户打开 Web IDE
        ↓
2. 创建 Project
        ↓
3. 平台创建 Runtime
        ↓
4. Runtime 启动
        ↓
5. Runtime 连接 VPS
        ↓
6. Runtime 注册成功
        ↓
7. 用户输入：
   "帮我创建一个 Todo App"
        ↓
8. DSH / ACP 执行
        ↓
9. Agent 创建文件
        ↓
10. Agent npm install
        ↓
11. Agent npm run dev
        ↓
12. Runtime 暴露 :5173
        ↓
13. Preview URL 自动生成
        ↓
14. Web IDE iframe 打开 Preview
        ↓
15. Agent 继续修改代码
        ↓
16. Vite HMR
        ↓
17. 浏览器实时看到结果
```

---

# 25. 产品边界

最终形成三个清晰层次：

```text
┌────────────────────────────────────────────┐
│ Product Layer                              │
│ Web IDE / Project / Chat / Preview / Deploy│
├────────────────────────────────────────────┤
│ Agent Layer                                │
│ DSH / ACP / Codex / Claude / Others        │
├────────────────────────────────────────────┤
│ Runtime Layer                              │
│ Workspace / Dev Server / Tunnel / Docker   │
└────────────────────────────────────────────┘
```

平台真正需要自己长期掌握的核心资产是：

1. Project/Workspace 生命周期
2. Agent Session 管理
3. Runtime 管理
4. Preview Gateway
5. Publish/Deployment
6. 用户体验

而 Agent、Tunnel、Build 等底层能力尽量通过成熟组件组合。

---

# 26. 建议实施顺序

严格按照以下顺序：

```text
Phase 1
frp + Vite + iframe
        ↓
Phase 2
DSH / ACP
        ↓
Phase 3
Project + Runtime Registry
        ↓
Phase 4
Web IDE
        ↓
Phase 5
Agent Session
        ↓
Phase 6
Preview Gateway
        ↓
Phase 7
Publish
        ↓
Phase 8
多 Runtime / Docker / Scale
```

**第一阶段的唯一目标不是“做完整平台”，而是跑通：**

```text
自然语言
   ↓
Coding Agent
   ↓
修改代码
   ↓
Dev Server
   ↓
反向隧道
   ↓
云主机
   ↓
Preview URL
   ↓
浏览器实时看到结果
```

只要这条链路跑通，后续所有功能都是在它上面逐层产品化。
