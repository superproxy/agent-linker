# AGENTS.md

本文件面向在本仓库工作的 AI 编码助手（CodeBuddy / Codex / Claude Code 等），只保留**上手必需**的信息；细节按主题拆到 `docs/`，见文末索引。

## 项目概览

LinkAgent Gateway —— OpenAI 兼容的本地 Agent 网关：

```
Chatbox / Open WebUI / 任意 OpenAI 客户端 ──▶ /v1 (OpenAI 兼容) ──▶ ACP(acpx) ──▶ 本机 agent
web 后台 (/ui, React)                        ──┘                   (opencode / pi / workbuddy /
个人微信 / 企业微信 / 飞书 ──▶ channels（channel-gateway）──────────┘  trace-cli 等 ACP 类型)
```

- Node `>=22.13`，包管理固定 **pnpm@8.6.5**，ESM、TypeScript 严格模式，`tsx` 直跑源码。
- 网关 Fastify 5 + `ws` + `yaml`；前端 React 18 + Vite 5 + antd 5。
- pnpm monorepo：`backend/`（网关主体）、`shared/`（前后端共享类型/zod）、`web/`（管理后台）、`openclaw-shim/`。

## 快速上手

```bash
pnpm install
pnpm setup:channels                   # 安装并校验企微/飞书 OpenClaw 插件（backend 依赖，一般 install 后执行一次）
pnpm setup:pi                         # 可选：安装 pi / pi-acp 并生成 ~/.pi/agent 模型配置
pnpm dev                              # 网关开发，缺省 0.0.0.0:8787
pnpm typecheck                        # 全部包 tsc --noEmit
pnpm --filter @linkagent/backend test # 后端测试（基线 190 passed）
pnpm --filter @linkagent/web build    # 前端构建
```

## 个人微信：多用户绑定 + channel-gateway（不改 `@tencent-weixin/openclaw-weixin`）

本仓库**只 import 插件**做扫码（`loginWithQrStart` / `loginWithQrWait`），**不改** npm 包源码。

**进程模型（当前）**：个人微信 **不**在 gateway 内嵌；**不**为每登录用户起 `weixin:<username>` 独立进程。PM 统一拉起 **`channels`**（`backend/src/channels/channel-gateway.ts`）。CLI/API 里写 `weixin` / `weixin:<id>` 会 **expand → `channels`**。

收发二选一（或仅开 bot），均在 `channels` 进程内：

| 方式 | 配置 | 说明 |
|------|------|------|
| **ilink 薄 adapter** | `channelGateway.weixin: true`，`weixinPlugin: false` | `weixin-bot.ts` 直连 ilink |
| **OpenClaw 插件收发** | `channelGateway.weixinPlugin: true` | 加载 `@tencent-weixin/openclaw-weixin` |

### 三类数据（不要混成 `<用户名>.json`）

**与 admin / 普通用户角色无关**：凡 web 登录账号（含 `admin`）扫码，一律单独设置 **`OPENCLAW_STATE_DIR`** = `<pluginsRoot>/login-users/<username>/`（见 `weixin-login-state.ts`）。共用顶层 `plugins/openclaw-weixin/accounts/` 会导致任意两人 token 串号、`binded_redirect` 错绑。

| 位置 | 含义 |
|---|---|
| `login-users/<username>/openclaw-weixin/accounts/<botId>-im-bot.json` | 该用户扫码后插件写入的 **ilink 机器人登录态**（token、游标 `.sync.json` 等） |
| `login-users/<username>/openclaw-weixin/bindings/<username>.json` | **绑定表**：该登录用户 → 指向本目录下哪个 `*-im-bot` 文件（`weixin-binding.ts`，KV store） |
| 运行时 overlay → `weixin.accounts` | 哪些登录用户需在 **`channels` 进程内**维护 bot/插件账号（扫码成功后写入；并写 `channels.yaml` 启用 `channelGateway`） |

遗留的共享 `plugins/openclaw-weixin/accounts/` 仅 status 聚合展示；新扫码只写对应用户的 `login-users/<username>/`。

规则：**不复制**插件 json 成 `admin.json`；**没有绑定**时页面不算已绑定，该账号 **不会**被 `channels` 使用，不会借用别的 `*-im-bot`。

### 端到端流程（每个登录用户一份）

1. **注册/登录** web 账号（如 `admin`、`alice`）。
2. **扫码**：`POST /api/weixin/qr` + 轮询 `GET /api/weixin/qr/status`（`accountId` = 当前登录用户名；**不传给插件**，避免插件按用户名另写登录文件）。
3. **插件落盘**：成功时在 **当前用户的** `login-users/<username>/openclaw-weixin/accounts/` 写入 `89b53341f048-im-bot.json`（回传 id 常为 `89b53341f048@im.bot`，网关侧 `normalizeBotAccountId` 再绑定）。
4. **写绑定**：`claimWeixinBinding(username, pluginAccountId)`；若微信 `binded_redirect` 不再下发 token，则 `bindNewestUnclaimed` 把**尚未被其他用户占用**的最新 `*-im-bot` 指给当前用户（仍只写 bindings，不复制文件）。
5. **登记渠道**：`onBound` → `persistEnsureWeixinAccount` 把用户名写入 `weixin.accounts`，并启用 `channelGateway` / `weixin` → **`pm.restart(['channels'])`**。
6. **channels 进程内**：按 `weixin.accounts` 拉起各账号 bot（或插件）；`loadBoundWeixinAccount` → 读绑定指向的 `*-im-bot.json` 做 getUpdates/sendMessage。
7. **任务与目录**：微信联系人 id 仍是 `channel/userId`（会话隔离）；**任务列表、工作目录、`ownerUsername`、`ct_` 缓存**一律用 **登录用户名**：`<tasks.workspaceDir>/<username>/<taskId>`（见 `TaskService.workspaceOwner`）。

### 多用户并行

- `alice` 与 `admin` 各绑各的微信 → **同一** `channels` 进程内多账号 bot（pid/日志为 `channels.*`）。
- 同一 `*-im-bot` **不能**绑两个登录用户（`claim` 返回 `taken`）。
- **解绑**：删 bindings 项 + 清该用户/对应机器人的 token 缓存 + `notifyBotStop` + 必要时 `restart channels`；插件 json 可留在磁盘，**无绑定则不会被使用**。

实现入口：`backend/src/channels/channel-gateway.ts`、`weixin-binding.ts`、`backend/src/gateway/weixin-login.ts`、`backend/src/supervisor/manager.ts`（`expand` / `weixinUsesChannels`）。细节与待办见 [`docs/handoff-channel-gateway.md`](docs/handoff-channel-gateway.md)。

## 必须遵守的约定

- **严格 TS**：数组/Map 取值视为可能 `undefined`，不用非空断言；相对导入带 `.js` 后缀；类型导入用 `import type`。
- **单向分层**：`api → service → store`；共享契约放 `shared/src`，不重复定义；持久化复用 `gateway/store/` KV，不新造裸文件读写。
- **鉴权**统一走 `users/auth.ts` 的 `AuthGuard`，不在 handler 内另判凭据；新增凭据类型需同步 auth/me、store/api、shared、测试（凭据分级见 `docs/architecture.md`）。
- 错误用 `openaiError(...)`（/v1）或 `errBody(...)`（管理接口）；密码 scrypt 加盐，不提交明文密钥。
- 启动前配置：推荐 `backend/config/` 下 **`gateway.yaml` / `weixin.yaml` / `node.yaml`**（有 `gateway.yaml` 则忽略同目录 `config.yaml`）；`.runtime-state/` 与上述 yaml 不入库；`.codebuddy/` 是项目数据目录，**不要删除**。
- **新增功能必须补测试**，重构后保持全量通过。

## 开发流程（强制）

**未先写清流程、原理与方案，不得改代码。** 用户若已明确「按某方案直接改 / 只写代码」，视为方案已确认，可进入实现。

助手在动手改仓库前，回复里须按顺序包含（可合并小节，但三块都要有）：

| 步骤 | 内容 |
|------|------|
| **1. 现状与原理** | 当前行为、相关模块与调用链（本仓库路径/接口）；问题根因或需求在架构上的含义。 |
| **2. 流程** | 端到端步骤（谁触发、数据存哪、进程/接口顺序）；必要时用列表或简图。 |
| **3. 方案** | 改什么、**不改什么**、影响范围与风险；与现有约定（分层、鉴权、store）是否一致。 |

**4. 实现**：仅在上文已给出、或用户已确认方案后，再做最小 diff；不顺手大重构无关文件。

**例外（仍须简短说明原理，可省略长流程表）**：

- 纯问答 / 读代码 / Code Review，且用户未要求改仓库。
- 单行 typo、依赖版本、明显测试断言与已说明行为不一致等，原因一句话可覆盖的 fix。

其它约定：不要未说明原因就一连串澄清问题；功能/界面类方案须写改动点；提交信息与文档用简体中文。

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/features.md`](docs/features.md) | 产品功能特性总览（/v1、按机器路由、节点审批、微信渠道、后台、鉴权、运维） |
| [`docs/channels.md`](docs/channels.md) | 个人微信 + 企微两套方案、channel-gateway 单进程、channels.yaml、后台企微配置 |
| [`docs/handoff-channel-gateway.md`](docs/handoff-channel-gateway.md) | channel-gateway 交接：已完成项、待办 P0–P2、关键路径（给其他智能体） |
| [`docs/architecture.md`](docs/architecture.md) | monorepo 结构、后端分层、鉴权与凭据模型 |
| [`docs/faq.md`](docs/faq.md) | 常用命令、测试方法、TS/ESM 坑、错误与密钥处理、已知遗留 |
| [`docs/design.md`](docs/design.md) / [`docs/deployment.md`](docs/deployment.md) | 设计记录 / 部署说明 |
| [`docs/pi.md`](docs/pi.md) | Pi 模型模板、云机自装、`pi-sandbox`（无 Docker）与缺 `rg`/`socat` 排障 |
| [`skills/linkagent-tasks/SKILL.md`](skills/linkagent-tasks/SKILL.md) | 默认任务任务管理 skill：启动 pi 注入 `LINKAGENT_*`（`pat_`），创建/列出/切换任务 |
