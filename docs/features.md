# 功能特性（产品能力总览）

> 本文件汇总 LinkAgent Gateway 对外提供的产品能力。工程结构与约定见根 `AGENTS.md` 与 `docs/architecture.md`。

## OpenAI 兼容网关

- **统一 `/v1` 入口**：Chatbox / Open WebUI / 任意 OpenAI 客户端零改造接入；支持 `/v1/chat/completions`（流式 SSE）与 `/v1/models`。
- **多 Agent 后端**：经 ACP（acpx）桥接本机多种编码 Agent——opencode / pi / workbuddy / trace-cli 等 20+ 内置类型（见 `AGENT_CATALOG`），把会话模型参数 `agent:<id>` 路由到对应 agent。
- **会话事件归一**：把各 agent 的 ACP 事件收敛为统一的 text / thought(推理) / tool(工具活动) 流式回调，并回传 sessionId 续接。

## 多任务与按机器（节点）路由

- **任务（Task）模型**：可为每个渠道用户创建多个任务，各自绑定「机器（节点）+ agent + 工作目录」，任务 key（`k_`）直连锁定路由。
- **Agent 是「按机器开通」的，不是全局配置**：
  - **本机节点 `local`**：agent 来自 `config.yaml` 的 `gateway.agents`，由网关进程在本机拉起；后台可启停、切模型、设为新任务默认（`GET /api/agents/by-node` 返回完整可编辑运行态）。
  - **远程机器**：每台跑节点连接器（`backend/src/node/connector.ts`），用环境变量 `LINKAGENT_NODE_AGENTS`（或 `config.node.agents`）声明**本机开通了哪些 agent**，WebSocket 握手时自报注册；网关侧**只读**，不能远程改动其开通情况（需在该机器调整后重连生效）。
  - 路由只在「在线且已自报该 agent」的节点上成立；离线节点不参与可路由列表。

## 多机器接入与审批

- 其他机器通过节点连接器 WebSocket 接入。可用**网关静态 token**直连、用户颁发的**机器 token（`nt_`，一机一证、归属该用户）**直连，或匿名申请后由管理员审批；节点自报名称、版本、开通 agent 列表，网关签发重连凭证（secret）。

## 渠道接入（微信）

- **个人微信 / 企业微信**：两种实现形态——插件运行时（openclaw 插件）或网关内嵌/独立进程的 botAgent（`channels/weixin-bot.ts`、`wecom-bot.ts`）。
- `weixin.mode` 三选一：`weixin-bot`（默认，网关内嵌 adapter）、`openclaw-weixin-plugin`、`external`（进程管理器单独拉起）。
- 支持扫码登录、登录态热重启；渠道用户自动签发作用域凭据（`ct_`）。

## 管理后台（web /ui）

- React + antd 单页，分组导航：
  - **监控**：概览 / 测试台。
  - **运行时**：Agent 管理（按机器分组卡片：本机可编辑置顶，远程机器只读）、任务管理、节点管理（审批/接入）。
  - **凭据**：Key 管理、我的 Token（个人 `pat_`）、用户凭据（渠道 `ct_`，管理员）。
  - **渠道**：微信登录；**系统**：登录账号、网关设置（管理员）。
- 后台支持运行时热更新（启停/切模型立即生效，重启还原 yaml）与持久化配置（默认 agent 写回 config.yaml）。

## 鉴权与多账号

- 三种网关鉴权模式：`local`（按运行模式免登录为本机管理员，不区分访问地址）/ `token`（静态管理员 token 或账号会话）/ `open`（不鉴权）。
- 登录账号 + 角色（admin/user）、需要登录时首次访问才生成随机 admin 密码并强制改密、scrypt 加盐哈希；个人长期 API token（`pat_`）、渠道用户 token（`ct_`）、用户颁发的机器 token（`nt_`）、任务 key（`k_`）分级凭据（详见 `docs/architecture.md` 的「鉴权与凭据模型」）。

## 运维与进程守护

- `supervisor/` 多进程守护（`pm start/stop/restart/status/logs/fg`），可分别托管网关与微信进程。
- 通用 KV 存储（JSON 原子写、损坏隔离）统一落盘 `.runtime-state/`；提供 `server:*` / `node:*` 运维脚本与 probe/smoke 排障脚本。
