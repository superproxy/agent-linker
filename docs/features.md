# 功能特性（产品能力总览）

> 本文件汇总 LinkAgent Gateway 对外提供的产品能力。工程结构与约定见根 `AGENTS.md` 与 `docs/architecture.md`。

## OpenAI 兼容网关

- **统一 `/v1` 入口**：Chatbox / Open WebUI / 任意 OpenAI 客户端零改造接入；支持 `/v1/chat/completions`（流式 SSE）与 `/v1/models`。
- **多 Agent 后端**：经 ACP（acpx）桥接本机多种编码 Agent——opencode / pi / workbuddy / trace-cli / cursor 等 20+ 内置类型（见 `AGENT_CATALOG`），把会话模型参数 `agent:<id>` 路由到对应 agent。
- **会话事件归一**：把各 agent 的 ACP 事件收敛为统一的 text / thought(推理) / tool(工具活动) 流式回调，并回传 sessionId 续接。

## 多任务与按机器（节点）路由

- **任务（Task）模型**：每个登录用户一份任务列表（文件 `username.web.username.json`），各自绑定「机器（节点）+ agent + 工作目录」，任务 key（`k_`）直连锁定路由。
- **每人独立任务空间**：任务按**登录账号**隔离，不按微信联系人拆分。微信连接器（`weixin:<用户名>`）只切换该用户的当前任务；微信 `/task` 与后台「激活」写入同一 `activeTaskId`。会话记忆仍按联系人隔离（`owner:weixin:wxid:task:id`）。管理员可看全部登录空间，普通用户只看自己的。未归属的旧渠道文件仅管理员可见。默认任务也可删除；后台支持全选与批量删除。列表为空时微信普通消息回落到全局默认 agent。
- **Agent 是「按机器开通」的，不是全局配置**：
  - **本机节点 `local`**：agent 来自 `config.yaml` 的 `gateway.agents`，由网关进程在本机拉起；后台可启停、切模型、设为新任务默认（`GET /api/agents/by-node` 返回完整可编辑运行态）。
  - **Agent 工具权限策略（`permissionPolicy`）**：agent 定义可配 `permissionPolicy`（`autoApprove`/`autoDeny`/`escalate`/`defaultAction`，按工具名匹配，优先于 `permissionMode`）。策略挂在本机 agent 定义层，**微信/企微 bot、openclaw 插件任务与 `/v1` 共用同一策略**——渠道消息按路由「代入」agentId（微信侧判断激活任务/默认 agent），最终都汇聚到网关定义层执行，不会因渠道不同而绕过。
  - **远程机器**：每台跑节点连接器（`backend/src/node/connector.ts`），用环境变量 `LINKAGENT_NODE_AGENTS`（或 `config.node.agents`）声明**本机开通了哪些 agent**，WebSocket 握手时自报注册；网关侧**只读**，不能远程改动其开通情况（需在该机器调整后重连生效）。
  - **本机节点（supervisor 托管）不读环境变量**：`config.yaml node.enabled=true` 经进程管理器拉起的本机 node 连接器，其 agent 只认共享 config 的 `node.agents`（缺省内置默认），`LINKAGENT_NODE_AGENTS` 被管理器显式屏蔽——shell/systemd/docker 里残留的环境变量不会隐式改变本机节点上线内容；独立节点脚本/命令仍可用该环境变量。
  - **本机进程回连地址只认本地配置**：supervisor 托管的本机 weixin / node 进程同样显式屏蔽 `LINKAGENT_GATEWAY_URL` / `LINKAGENT_GATEWAY_TOKEN`——回连地址只认共享 config 的 `weixin.gatewayUrl` / `node.gatewayUrl`（未配置则由 `gateway.server` 推导本机地址），残留环境变量不会把本机 bot/节点带到远程网关；独立进程（`node:connect`、直接跑 `weixin-bot`）仍环境变量优先。
  - 路由只在「在线且已自报该 agent」的节点上成立；离线节点不参与可路由列表。

## 多机器接入与审批

- 其他机器通过节点连接器 WebSocket 接入。可用**网关静态 token**直连、用户颁发的**机器 token（`nt_`，一机一证、归属该用户）**直连，或匿名申请后由管理员审批；节点自报名称、版本、开通 agent 列表，网关签发重连凭证（secret）。后台「接入」可按 **env 文件 / Bash / PowerShell** 生成环境变量片段。

## 渠道接入（微信）

- **个人微信 / 企业微信**：两种实现形态——插件运行时（openclaw 插件）或网关内嵌/独立进程的 botAgent（`channels/weixin-bot.ts`、`wecom-bot.ts`）。
- `weixin.mode` 三选一：`weixin-bot`（默认，网关内嵌 adapter）、`openclaw-weixin-plugin`、`external`（进程管理器单独拉起）。
- **多账号**：每个**登录用户**绑定自己的微信（账号槽 = 用户名，进程 `weixin:<username>`）。流程是：**注册/登录账号 → 扫码绑定 → 重启该用户微信进程**。扫码成功后写入 `weixin.accounts` 并将 `weixin.mode` 设为 `external`、打开 `weixin.enabled`，由进程管理器为该用户单独拉起 bot（pid/日志/登录态隔离）。`pnpm restart:all` 只拉起**已绑定**的 `weixin:<用户名>`，未绑定不会空跑默认 `weixin`。管理员在「本机 · 进程」可见全部实例；普通用户只在「微信登录」页看自己的绑定与进程状态。yaml 里仍可用 `weixin.accounts` 预置账号。
- 支持扫码登录与**取消绑定**（删除该用户登录态、从 `weixin.accounts` 移除并停止 `weixin:<用户名>`）；绑定成功后**重启**对应用户的微信进程，吊销 `ct_`、清掉 bot 本地 token 缓存（含插件生成的 `*-im-bot.user-tokens.json`），并**重签该用户任务 key（`k_`）**。后台「任务 / Key」页展示的是 `k_`，换绑后应变新。
- **任务切换**：每个登录用户一份任务列表。微信里 `/task list|use|new|default` 由该用户的微信连接器解析并写入同一空间；后台「激活」写同一 `activeTaskId`，连接器短缓存后按新任务路由。不同联系人共用任务列表，对话上下文按联系人分开。

## 管理后台（web /ui）

- React + antd 单页，分组导航：
  - **本机**（仅管理员）：网关、进程、节点、agent。网关模式下普通用户看不到本组。
  - **远程**：网关（管理员）、节点（审批/接入；普通用户只看自己的机器）、agent（普通用户可看自己机器上连接器自报的开通列表；本机目录/启停/安装仅管理员）。
  - **通用**：概览、对话、key、任务管理（每人一份登录用户任务空间；当前任务由微信 `/task` 或后台「激活」切换）。
  - **系统**：我的 Token、微信登录（每用户独立绑定与进程）；渠道凭据、真实用户仅管理员。
  - 侧栏可折叠（状态保存在浏览器 localStorage）。
- **对话页**：React/antd 实现（不嵌入 `chat.html`）。未绑定时 oneshot 测试；从任务进入时带 `taskKey` 或 `channel/userId/task/agent` 走 `/v1` 任务路由，与微信渠道同一套会话隔离。
- 后台支持运行时热更新（启停/切模型立即生效，重启还原 yaml）与持久化配置（默认 agent 写回 config.yaml）。

## 鉴权与多账号

- 三种网关鉴权模式：`local`（按运行模式免登录为本机管理员，不区分访问地址）/ `token`（静态管理员 token 或账号会话）/ `open`（不鉴权）。
- 登录账号 + 角色（admin/user）、需要登录时首次访问才生成随机 admin 密码并强制改密、scrypt 加盐哈希；个人长期 API token（`pat_`）、渠道用户 token（`ct_`）、用户颁发的机器 token（`nt_`）、任务 key（`k_`）分级凭据（详见 `docs/architecture.md` 的「鉴权与凭据模型」）。

## 运维与进程守护

- `supervisor/` 多进程守护（`pm start/stop/restart/status/logs/fg`），可分别托管网关与微信进程。
- 通用 KV 存储（JSON 原子写、损坏隔离）统一落盘 `.runtime-state/`；提供 `server:*` / `node:*` 运维脚本与 probe/smoke 排障脚本。
