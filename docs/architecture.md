# 架构与工程结构

> 本文件说明 monorepo 布局、后端分层与鉴权凭据模型。功能特性见 `docs/features.md`，命令/测试/排障见 `docs/faq.md`。

## 工作区结构（pnpm monorepo）

`pnpm-workspace.yaml` 包含 4 个包：

| 包 | 路径 | 职责 |
|---|---|---|
| `@linkagent/backend` | `backend/` | 网关主体：`/v1` OpenAI 端点、`/api/*` 管理接口、渠道 bot、节点连接器、进程守护 |
| `@linkagent/shared` | `shared/` | 前后端共享类型与 zod 配置（`config.ts`/`openai.ts`/`user.ts`/`adapter.ts`/`node.ts`） |
| `@linkagent/web` | `web/` | React 管理后台，Vite 构建为静态文件，由网关同源挂到 `/ui` |
| `openclaw-shim` | `openclaw-shim/` | openclaw 工作区垫片（pnpm override `openclaw: workspace:*`） |

后端源码 `backend/src/`：

- `gateway/` —— 网关核心。`index.ts`（Fastify 装配 + `/v1` handler）、`config.ts`；子目录：
  - `agents/` agent/ACP 引擎管理；`nodes/` 节点注册与审批；`tasks/` 多任务路由（api→service→store）；
  - `users/` 登录账号、会话、`AuthGuard`、渠道用户凭据（`ct_`）、个人 API token（`pat_`）、机器 token（`nt_`）；
  - `plugins/` 渠道插件运行时；`pm/` 进程管理；`prefs/` 用户偏好；`store/` 通用 KV（原子写/损坏隔离）。
- `channels/` —— 独立 botAgent：`weixin-bot.ts`、`wecom-bot.ts`。
- `node/connector.ts` —— 节点连接器（WebSocket 接入网关）。
- `supervisor/` —— 多进程守护（`cli.ts` 提供 `pm:*` 命令）。
- `install/` —— 安装/布局；`dev/` —— 探针与冒烟脚本（probe / smoke-plugin 等）。

测试与源码同构：`backend/test/<模块>/*.test.ts`。

## 分层与依赖方向

- 单向分层：`api → service → store`，不要反向依赖或跨层。
- 鉴权统一走 `users/auth.ts` 的 `AuthGuard`，不要在 handler 内另写凭据判断。
- 持久化优先复用 `gateway/store/` 的通用 KV（JSON 原子写、损坏隔离），落盘到 `.runtime-state/`；不要新造裸文件读写。
- 前后端共享契约放 `shared/src`，经 `@linkagent/shared` 引用，不要两端重复定义。

## 鉴权与凭据模型（改动时务必对齐）

`AuthGuard.resolve` 产出的凭据态：`disabled | token | local | session | personal | channelUser | none`；`resolveChat` 额外识别 `task`。

- 静态 token（`auth.token`）：管理员级机器凭据；`local` 模式下无凭据即本机默认用户（不区分访问地址）。
- 会话 token：浏览器登录。
- **个人 API token（`pat_` 前缀）**：一个登录账号一枚长期 token，自助 4 接口 `GET/POST ensure/POST rotate/DELETE /api/personal-tokens`，语义等同账号本人（在 `checkAuth/sessionUser/isAuth/isAdmin` 与 `/api/auth/me` 中与 `session` 同等放行）。
- **渠道用户 token（`ct_` 前缀）**：作用域凭据，仅代表其 `channel/userId`，只能访问 `/v1` 与自己的资源，不放行管理接口。
- **用户颁发的机器 token（`nt_` 前缀）**：登录用户为每台远程机器签发，仅用于节点 WebSocket 握手，连上后机器归该用户；与网关静态 token 均可接入。

新增凭据类型时，需同时更新：`auth.ts`（解析 + 三个守卫）、`/api/auth/me`、对应 store/api、shared 类型与测试。

后台按角色隔离：**管理员**可见本机菜单、全部任务/key、本机 agent；**普通登录用户**只能看自己的远程节点及其连接器上报的 agent、自己的任务空间（`web/<用户名>`，任务管理 / key / 概览统计）、通用对话，以及自己的微信绑定（账号槽=用户名，进程 `weixin:<username>`）。本机 agent 目录/启停/安装 API 返回 403。`canSeeNode` 对非管理员不包含内建 `local` 节点。**内建默认任务固定本机 `pi`，普通用户不能改绑，也不能把其它任务绑到本机 agent。** 微信 bot 用网关 token 读取登录用户任务列表；渠道 `ct_` 仍可读写自己的 `/v1` 会话。

## 其他设计文档

- `docs/design.md` —— 设计记录。
- `docs/deployment.md` —— 部署说明。
