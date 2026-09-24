# 功能特性（产品能力总览）

> 本文件汇总 LinkAgent Gateway 对外提供的产品能力。工程结构与约定见根 `AGENTS.md` 与 `docs/architecture.md`。

## OpenAI 兼容网关

- **统一 `/v1` 入口**：Chatbox / Open WebUI / 任意 OpenAI 客户端零改造接入；支持 `/v1/chat/completions`（流式 SSE）与 `/v1/models`。
- **多 Agent 后端**：经 ACP（acpx）桥接本机多种编码 Agent——opencode / pi / workbuddy / trace-cli / cursor 等 20+ 内置类型（见 `AGENT_CATALOG`），把会话模型参数 `agent:<id>` 路由到对应 agent。
- **会话事件归一**：把各 agent 的 ACP 事件收敛为统一的 text / thought(推理) / tool(工具活动) 流式回调，并回传 sessionId 续接。

## 多任务与按机器（节点）路由

- **任务（Task）模型**：每个登录用户一份任务列表（文件 `username.web.username.json`），各自绑定「机器（节点）+ agent + 工作目录」，任务 key（`k_`）直连锁定路由。
  - **每人独立任务空间**：任务按**登录账号**隔离，不按微信联系人拆分。工作目录同样按登录用户：`<workspaceDir>/<用户名>/<taskId>`，不按微信联系人建目录。`channels` 进程内微信 bot 只切换该用户的当前任务；微信 `/task` 与后台「激活」写入同一 `activeTaskId`。会话记忆仍按联系人隔离（`owner:weixin:wxid:task:id`）。后台任务页只显示当前登录账号自己的任务（管理员同样如此）。未归属的旧渠道文件仅管理员可见。**内建默认任务固定本机 `pi`**（旧数据加载时自动钉死），不能改绑 agent/节点；普通用户不能把其它任务绑到本机 agent，也不能读取本机 agent 目录/启停/安装。默认任务也可删除；删掉后可在后台点「创建默认任务」，或在微信发送 `/task new default` 重建（固定本机 `pi` 并激活）。后台支持全选与批量删除。列表为空时微信普通消息回落到全局兜底 agent。**仅默认任务**注入任务管理 skill：启动本机 pi 时带 `LINKAGENT_*`（`pat_`，用户级），cwd 只写 `.agents/skills/linkagent-tasks/SKILL.md`，不把 token 写进文件。
- **Agent 是「按机器开通」的，不是全局配置**：
  - **本机节点 `local`**：agent 来自 **有效配置**（`gateway.yaml` 的 `agents` + 运行时层合并，见 [`docs/architecture.md`](architecture.md)）；由网关进程在本机拉起；后台可启停、切模型、设为新任务默认（`GET /api/agents/by-node` 返回完整可编辑运行态）。**启停等可变项写入运行时仓储（默认 `.runtime-state/gateway/overlay.json`，后续可切 SQLite），不再改 yaml**；切模型仍为内存热更新。pi 用 `pnpm setup:pi` 安装 CLI 并生成 `~/.pi/agent` 模型清单（见 [`docs/pi.md`](pi.md)）。
  - **Agent 工具权限策略（`permissionPolicy`）**：agent 定义可配 `permissionPolicy`（`autoApprove`/`autoDeny`/`escalate`/`defaultAction`，按工具名匹配，优先于 `permissionMode`）。策略挂在本机 agent 定义层，**微信/企微 bot、openclaw 插件任务与 `/v1` 共用同一策略**——渠道消息按路由「代入」agentId（微信侧判断激活任务/默认 agent），最终都汇聚到网关定义层执行，不会因渠道不同而绕过。
  - **远程机器**：每台跑节点连接器（`backend/src/node/connector.ts`），用环境变量 `LINKAGENT_NODE_AGENTS`（或 `config.node.agents`）声明**本机开通了哪些 agent**，WebSocket 握手时自报注册；网关侧**只读**，不能远程改动其开通情况（需在该机器调整后重连生效）。
  - **本机节点（supervisor 托管）不读环境变量**：`node.yaml` 的 `enabled=true` 经进程管理器拉起的本机 node 连接器，其 agent 只认 `node.agents`（缺省内置默认），`LINKAGENT_NODE_AGENTS` 被管理器显式屏蔽——shell/systemd/docker 里残留的环境变量不会隐式改变本机节点上线内容；独立节点脚本/命令仍可用该环境变量。
  - **本机进程回连地址只认本地配置**：supervisor 托管的本机 `channels` / node 进程同样显式屏蔽 `LINKAGENT_GATEWAY_URL` / `LINKAGENT_GATEWAY_TOKEN`——回连地址只认共享 config（未配置则由 `gateway.server` 推导本机地址），残留环境变量不会把本机渠道/节点带到远程网关；独立调试（`node:connect`、直接跑 `weixin-bot`）仍环境变量优先。
  - 路由只在「在线且已自报该 agent」的节点上成立；离线节点不参与可路由列表。

## 多机器接入与审批

- 其他机器通过节点连接器 WebSocket 接入。可用**网关静态 token**直连、用户颁发的**机器 token（`nt_`，一机一证、归属该用户）**直连，或匿名申请后由管理员审批；节点自报名称、版本、开通 agent 列表，网关签发重连凭证（secret）。后台「接入」可按 **env 文件 / Bash / PowerShell** 生成环境变量片段。

## 渠道接入（微信 / 企微）

- **总览文档**：[`docs/channels.md`](channels.md)（两套方案、单进程 `channels`、四文件配置、后台与迁移）；交接与待办见 [`docs/handoff-channel-gateway.md`](handoff-channel-gateway.md)。
- **个人微信 / 企业微信**：两套接入方案——**A** 薄 adapter `weixin-bot`（或 `channelGateway.weixinPlugin` 插件收发）；**B** 企微 OpenClaw 插件（或 legacy `wecom-bot`）。**推荐**启用 **`channelGateway`**，由 **一个 `channels` 进程**按需同时挂载。gateway **不再内嵌** weixin-bot；CLI 的 `weixin` / `weixin:<id>` **展开为 `channels`**（无每用户独立微信进程）。
- **配置边界**：企微 OpenClaw 的 `channels.wecom` / `plugins` 写在 **`channels.yaml`**，不写 `gateway.yaml`。
- `weixin.mode`：生产路径用 `external`（由 `channels` 托管 bot）；`openclaw-weixin-plugin` 对应插件收发；旧值 `weixin-bot`（曾表示网关内嵌）已废弃，启动时会归一。
- **多账号**：每个**登录用户**（含管理员账号）绑定自己的微信（账号槽 = 用户名）。流程是：**注册/登录账号 → 扫码绑定 → `pm restart channels`**。插件状态按用户名隔离：`login-users/<用户名>/`（`OPENCLAW_STATE_DIR`），**所有人同一规则**。扫码成功后写入 overlay `weixin.accounts`、启用 `channelGateway`/`weixin`，由 **`channels` 进程内**按账号拉起 bot（pid/日志为 `channels.*`）。未绑定账号会被跳过，不会空跑。「微信登录」页每人只看自己的绑定；管理员在「本机 · 进程」看 **`channels`**。yaml / overlay 仍可用 `weixin.accounts` 预置账号。
- 扫码登录复用 npm 包 **`@tencent-weixin/openclaw-weixin`**（只 import，不改包内代码）拿二维码和 token；消息收发默认是 `weixin-bot` 直连 ilink（或插件收发）。插件把登录态写到该用户目录下 `openclaw-weixin/accounts/<botId>-im-bot.json`；**绑定**在同目录 `bindings/`（登录用户 → 机器人文件 id）。不复制成 `<用户名>.json`。插件若返回「已连接过此 OpenClaw」，表示该机器人已绑定且不再下发 token；此时若**该用户目录**有未被其他登录用户占用的 `*-im-bot`，重新扫码只会**更新绑定指向**，不复制文件。无绑定则该账号不会被 `channels` 使用，不会借用其它机器人文件。
- 支持扫码登录与**取消绑定 / 清空登录态**（删除绑定指向、清 ct_/bot 缓存、`notifyBotStop`；插件 `*-im-bot.json` 可残留但无绑定则不用。从 `weixin.accounts` 移除并 **`restart channels`**）。手机微信若仍显示已连接，需要在手机上退出该机器人后，新的扫码才会拿到 token。绑定成功后**重启 `channels`**，吊销 `ct_`、清掉相关 token 缓存，并**重签该用户任务 key（`k_`）**。任务工作目录按**登录用户名**：`<workspaceDir>/<用户名>/<taskId>`。
- **任务切换**：每个登录用户一份任务列表。微信里 `/task list|use|new|default` 由该用户的微信连接器解析并写入同一空间；后台「激活」写同一 `activeTaskId`，连接器短缓存后按新任务路由。不同联系人共用任务列表，对话上下文按联系人分开。

## 管理后台（web /ui）

- React + antd 单页，分组导航：
  - **我的**（管理员可见）：**企业微信**、**飞书**（OpenClaw 配置 + 启停 channels，位于「微信」之后）。
  - **本机**（仅管理员）：网关、进程、节点、agent。网关模式下普通用户看不到本组。
  - **远程**：网关（管理员）、节点（审批/接入；普通用户只看自己的机器）、agent（普通用户可看自己机器上连接器自报的开通列表；本机目录/启停/安装仅管理员）。
  - **通用**：概览、对话、key、任务管理（每人一份登录用户任务空间；当前任务由微信 `/task` 或后台「激活」切换）。
  - **系统**：我的 Token、微信登录（每用户独立绑定；渠道进程为 `channels`）；渠道凭据、真实用户仅管理员。

  - 侧栏可折叠（状态保存在浏览器 localStorage）。
- **对话页**：React/antd 实现（不嵌入 `chat.html`）。未绑定时 oneshot 测试；从任务进入时带 `taskKey` 或 `channel/userId/task/agent` 走 `/v1` 任务路由，与微信渠道同一套会话隔离。
- 后台支持运行时热更新（启停/切模型立即生效）与持久化配置（默认 agent、微信账号等写运行时层，yaml 保持启动前模板）。

## 鉴权与多账号

- 三种网关鉴权模式：`local`（按运行模式免登录为本机管理员，不区分访问地址）/ `token`（静态管理员 token 或账号会话）/ `open`（不鉴权）。
- 登录账号 + 角色（admin/user）、需要登录时首次访问才生成随机 admin 密码并强制改密、scrypt 加盐哈希；个人长期 API token（`pat_`）、渠道用户 token（`ct_`）、用户颁发的机器 token（`nt_`）、任务 key（`k_`）分级凭据（详见 `docs/architecture.md` 的「鉴权与凭据模型」）。

## 运维与进程守护

- `supervisor/` 多进程守护（`pm start/stop/restart/status/logs/fg`），可分别托管网关与微信进程。
- 通用 KV 存储（JSON 原子写、损坏隔离）统一落盘 `.runtime-state/`；提供 `server:*` / `node:*` 运维脚本与 probe/smoke 排障脚本。
