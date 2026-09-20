# 功能特性（产品能力总览）

> 本文件汇总 LinkAgent Gateway 对外提供的产品能力。工程结构与约定见根 `AGENTS.md` 与 `docs/architecture.md`。

## OpenAI 兼容网关

- **统一 `/v1` 入口**：Chatbox / Open WebUI / 任意 OpenAI 客户端零改造接入；支持 `/v1/chat/completions`（流式 SSE）与 `/v1/models`。
- **多 Agent 后端**：经 ACP（acpx）桥接本机多种编码 Agent——opencode / pi / workbuddy / trace-cli / cursor 等 20+ 内置类型（见 `AGENT_CATALOG`），把会话模型参数 `agent:<id>` 路由到对应 agent。
- **会话事件归一**：把各 agent 的 ACP 事件收敛为统一的 text / thought(推理) / tool(工具活动) 流式回调，并回传 sessionId 续接。

## 多任务与按机器（节点）路由

- **任务（Task）模型**：可为每个渠道用户创建多个任务，各自绑定「机器（节点）+ agent + 工作目录」，任务 key（`k_`）直连锁定路由。
- **Agent 是「按机器开通」的，不是全局配置**：
  - **本机节点 `local`**：agent 来自 `config.yaml` 的 `gateway.agents`，由网关进程在本机拉起；后台可启停、切模型、设为新任务默认（`GET /api/agents/by-node` 返回完整可编辑运行态）。
  - **Agent 工具权限策略（`permissionPolicy`）**：agent 定义可配 `permissionPolicy`（`autoApprove`/`autoDeny`/`escalate`/`defaultAction`，按工具名匹配，优先于 `permissionMode`）。策略挂在本机 agent 定义层，**微信/企微 bot、openclaw 插件任务与 `/v1` 共用同一策略**——渠道消息按路由「代入」agentId（微信侧判断激活任务/默认 agent），最终都汇聚到网关定义层执行，不会因渠道不同而绕过。
  - **远程机器**：每台跑节点连接器（`backend/src/node/connector.ts`），用环境变量 `LINKAGENT_NODE_AGENTS`（或 `config.node.agents`）声明**本机开通了哪些 agent**，WebSocket 握手时自报注册；网关侧**只读**，不能远程改动其开通情况（需在该机器调整后重连生效）。
  - **本机节点（supervisor 托管）不读环境变量**：`config.yaml node.enabled=true` 经进程管理器拉起的本机 node 连接器，其 agent 只认共享 config 的 `node.agents`（缺省内置默认），`LINKAGENT_NODE_AGENTS` 被管理器显式屏蔽——shell/systemd/docker 里残留的环境变量不会隐式改变本机节点上线内容；独立节点脚本/命令仍可用该环境变量。
  - **本机进程回连地址只认本地配置**：supervisor 托管的本机 weixin / node 进程同样显式屏蔽 `LINKAGENT_GATEWAY_URL` / `LINKAGENT_GATEWAY_TOKEN`——回连地址只认共享 config 的 `weixin.gatewayUrl` / `node.gatewayUrl`（未配置则由 `gateway.server` 推导本机地址），残留环境变量不会把本机 bot/节点带到远程网关；独立进程（`node:connect`、直接跑 `weixin-bot`）仍环境变量优先。
  - 路由只在「在线且已自报该 agent」的节点上成立；离线节点不参与可路由列表。

## 多机器接入与审批

- 其他机器通过节点连接器 WebSocket 接入。可用**网关静态 token**直连、用户颁发的**机器 token（`nt_`，一机一证、归属该用户）**直连，或匿名申请后由管理员审批；节点自报名称、版本、开通 agent 列表，网关签发重连凭证（secret）。

## 渠道接入（微信）

- **个人微信 / 企业微信**：两种实现形态——插件运行时（openclaw 插件）或网关内嵌/独立进程的 botAgent（`channels/weixin-bot.ts`、`wecom-bot.ts`）。
- `weixin.mode` 三选一：`weixin-bot`（默认，网关内嵌 adapter）、`openclaw-weixin-plugin`、`external`（进程管理器单独拉起）。
- **多账号**：`external` 模式下配置 `weixin.accounts`（账号 id 白名单），进程管理器为每个账号拉起独立 bot 进程（实例 `weixin:<accountId>`，pid/日志/登录态相互隔离）；后台「本机 · 进程」页可单独启停/重启/看日志，CLI 用 `pm start/stop/restart weixin:<accountId>`。未配置 `accounts` 保持单实例（跑 `accountId` 或第一个账号）。
- 支持扫码登录、登录态热重启（内嵌模式）；渠道用户自动签发作用域凭据（`ct_`）。

## 管理后台（web /ui）

- React + antd 单页，分组导航：
  - **本机**：网关、进程、节点、agent、概览、对话。
  - **远程**：网关、节点（审批/接入）、agent（只读，连接器自报）。
  - **通用**：key、任务管理（可点「对话」跳入该任务的持久会话页）。
  - **系统**：我的 Token、渠道凭据、微信登录、真实用户（管理员项按角色过滤）。
- **对话页**：React/antd 实现（不嵌入 `chat.html`）。未绑定时 oneshot 测试；从任务进入时带 `taskKey` 或 `channel/userId/task/agent` 走 `/v1` 任务路由，与微信渠道同一套会话隔离。
- 后台支持运行时热更新（启停/切模型立即生效，重启还原 yaml）与持久化配置（默认 agent 写回 config.yaml）。

## 鉴权与多账号

- 三种网关鉴权模式：`local`（按运行模式免登录为本机管理员，不区分访问地址）/ `token`（静态管理员 token 或账号会话）/ `open`（不鉴权）。
- 登录账号 + 角色（admin/user）、需要登录时首次访问才生成随机 admin 密码并强制改密、scrypt 加盐哈希；个人长期 API token（`pat_`）、渠道用户 token（`ct_`）、用户颁发的机器 token（`nt_`）、任务 key（`k_`）分级凭据（详见 `docs/architecture.md` 的「鉴权与凭据模型」）。

## 运维与进程守护

- `supervisor/` 多进程守护（`pm start/stop/restart/status/logs/fg`），可分别托管网关与微信进程。
- 通用 KV 存储（JSON 原子写、损坏隔离）统一落盘 `.runtime-state/`；提供 `server:*` / `node:*` 运维脚本与 probe/smoke 排障脚本。
