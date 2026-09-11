# 聊天机器人绑定（多渠道抽象）设计

日期：2026-09-11
状态：已确认（方案 1：概念改名 + 为多渠道预留）

## 背景与目标

web 后台目前用「微信扫码登录」管理个人微信渠道（openclaw-weixin 扫码 / weixin-bot 独立 adapter）。
用户希望把「微信登录」这一用户可见概念改为「聊天机器人绑定」，并且后续要接入更多渠道
（企业微信、Telegram、Discord 等）。

**目标：**
1. 用户可见语义从「登录」改为「绑定」：web 后台展示「聊天机器人绑定」，微信是第一个可绑定的渠道。
2. 后端 API 抽象出统一的「渠道绑定」概念（`/api/channels/*`），微信作为第一个实现；
   后续新增渠道只需实现统一契约并注册，前端无需大改。
3. 兼容现状：旧 `/api/weixin/*` 保留（标记 deprecated），现有脚本/文档不受破坏。

**非目标（YAGNI）：**
- 不实现任何新渠道（企微/Telegram 等只是契约预留，不在本次范围）。
- 不改动微信扫码登录的底层机制（仍复用 openclaw-weixin 扫码 / weixin-bot adapter）。

## 现状梳理

### 后端
- `backend/src/gateway/weixin-login.ts`：
  - `WeixinLoginService`：封装 openclaw-weixin 扫码（`loginWithQrStart` / `loginWithQrWait`），
    登录态扫描 `accounts/`，`reloadBot` 热重启 weixin-bot adapter。
  - `registerWeixinApi(app, service, checkAuth, deps)`：注册 4 个微信专属路由：
    - `GET  /api/weixin/status`
    - `POST /api/weixin/qr`
    - `GET  /api/weixin/qr/status`
    - `POST /api/weixin/reload`
- `backend/src/gateway/index.ts`：`buildServer()` 中创建 `WeixinLoginService` 并调用 `registerWeixinApi`。

### 前端
- `web/src/api.ts`：`WeixinClient`（status / startQr / qrStatus / reload）+ 微信专属类型
  （`WeixinStatus` / `WeixinQrResult` / `WeixinQrStatus`）。
- `web/src/App.tsx`：`<section className="card"><h2>微信渠道</h2>`——展示登录状态、
  账号列表、扫码登录按钮、二维码、重启渠道按钮。文案均为「登录」语义。

## 设计

### 1. 后端：渠道绑定契约 + 注册表

新增 `backend/src/gateway/channels/types.ts`：

```ts
/** 一个可绑定聊天机器人渠道的统一契约 */
export interface ChannelBindingService {
  /** 渠道 id（如 'weixin'、'wecom'），路由与存储均以此为准 */
  readonly channelId: string;
  /** 展示名（如 '微信'） */
  readonly displayName: string;
  /** 绑定状态（账号/账号列表/当前激活） */
  status(): ChannelStatus;
  /** 发起绑定：返回绑定所需内容（微信=二维码内容）+ 会话 key */
  startBind(opts?: { force?: boolean }): Promise<{ sessionKey?: string; content: string }>;
  /** 轮询绑定结果（阻塞到确认或超时） */
  waitBind(opts?: { sessionKey?: string; timeoutMs?: number }): Promise<ChannelBindResult>;
  /** 可选：绑定后热重启渠道 adapter */
  reload?(): Promise<void>;
}

export interface ChannelStatus {
  configured: boolean;
  accounts: ChannelAccount[];
  activeAccountId?: string;
}

export interface ChannelAccount {
  id: string;
  userId?: string;
  savedAt?: string;
}

export interface ChannelBindResult {
  connected: boolean;
  accountId?: string;
  message?: string;
}

export interface ChannelBindingRegistry {
  list(): ChannelBindingService[];
  get(channelId: string): ChannelBindingService | undefined;
  register(svc: ChannelBindingService): void;
}
```

实现：`backend/src/gateway/channels/registry.ts` 提供简单注册表（Map 封装）。

### 2. 后端：微信渠道适配

新增 `backend/src/gateway/channels/weixin.ts`：把 `WeixinLoginService` 适配成
`ChannelBindingService`：

- `channelId = 'weixin'`，`displayName = '微信'`。
- `status()` / `startBind()` / `waitBind()` 直接委托给内部 `WeixinLoginService` 同名方法
  （`startBind` 内部把 `qrDataUrl` 作为 `content`，二维码 PNG 渲染逻辑保留在服务层/调用方）。
- `reload()` 委托给传入的 `reloadBot`（可为空）。

`weixin-login.ts` 本体不动：二维码 PNG 渲染 `qrDataUrlOf`、扫码机制、accounts 扫描均复用。
新增的 `/api/channels` 路由在发起绑定成功后同样返回 `qrDataUrl`（对微信渠道）或原始 `content`
（对纯内容型渠道），由前端按渠道能力展示。

### 3. 后端：统一 API `/api/channels/*`

新增 `backend/src/gateway/channels/api.ts`：`registerChannelsApi(app, registry, checkAuth, deps)`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/channels` | 渠道列表：`{ channels: [{ id, displayName, status }] }` |
| GET | `/api/channels/:id` | 单渠道状态 |
| POST | `/api/channels/:id/bind` | 发起绑定 → `{ sessionKey?, content, qrDataUrl?(微信) }` |
| GET | `/api/channels/:id/bind/status` | 轮询绑定结果（`sessionKey`、`timeoutMs` 查询参数，沿用现有超时上限 30s） |
| POST | `/api/channels/:id/reload` | 热重启渠道 adapter（渠道未提供 `reload` 时返回 400） |

错误处理：
- 未知 `:id` → `404 { error: 'unknown channel: <id>' }`
- 渠道未实现 `reload` → `400 { error: '<id> 渠道不支持热重启' }`
- 绑定/轮询底层异常 → `500 { error: message }`
- 未通过 `checkAuth` → `401`

### 4. 后端：网关装配

`backend/src/gateway/index.ts` `buildServer()` 中：

1. 创建 `WeixinLoginService`（现状不变）。
2. 创建 `ChannelBindingRegistry`，注册微信适配器。
3. 调用 `registerChannelsApi(...)`（`checkAuth` 与 reload 注入沿用现状）。
4. 保留 `registerWeixinApi(...)` 不动（deprecated 兼容层，代码注释标注）。

### 5. 前端：API 客户端泛化

`web/src/api.ts`：

- 类型：`WeixinStatus` → `ChannelStatus`、`WeixinQrResult` → `ChannelBindStartResult`、
  `WeixinQrStatus` → `ChannelBindResult`（与契约中绑定轮询返回类型同名同构，字段语义不变）。
- `WeixinClient` → `ChannelClient`，方法泛化为带渠道 id：
  - `listChannels(): Promise<{ channels: ChannelInfo[] }>`
  - `status(channelId)`
  - `startBind(channelId)`
  - `bindStatus(channelId, sessionKey, timeoutMs?)`
  - `reload(channelId)`
- 路由全部指向 `/api/channels/...`（旧 `/api/weixin/*` 不再被前端使用）。

### 6. 前端：页面改造

`web/src/App.tsx`「微信渠道」卡片 →「聊天机器人绑定」卡片：

- 标题：`微信渠道` → `聊天机器人绑定`。
- 内容：从 `listChannels()` 动态渲染渠道列表；每个渠道一个行/子卡片，展示
  `displayName`、绑定状态（已绑定/未绑定 + 账号 id）、操作按钮。当前只有一个 weixin 渠道，
  渲染结果与现状等价，但结构上已支持多渠道。
- 文案对照：
  - `扫码登录` / `重新扫码登录` → `绑定微信机器人` / `重新绑定`
  - `请用手机微信「扫一扫」登录` → `请用手机微信扫一扫，完成机器人绑定`
  - `✅ 登录成功：账号 …` → `✅ 绑定成功：账号 …`
  - `未登录` / `已登录` → `未绑定` / `已绑定`
  - `重启渠道` 保留（语义不变）。
- 状态轮询逻辑、取消逻辑、二维码展示逻辑保持现状，仅换 API 调用对象与方法名。

### 7. 测试

新增 `backend/test/channels/channel-api.test.ts`（沿用现有 `tsx --test` 风格，参考
`backend/test/tasks/api.test.ts` / `gateway.test.ts` 的 buildServer 用法）：

- 注册表：register / get / list / 重复注册覆盖。
- `/api/channels` 路由：
  - 未鉴权 401（若 auth 开启）。
  - 列表返回已注册渠道。
  - 未知渠道 404。
  - 微信渠道 `bind` 返回 `content`（用 stub 服务注入，不依赖真实 openclaw-weixin）。
  - 无 `reload` 的渠道调用 reload 返回 400。
- 现有测试全量通过（`pnpm --filter @linkagent/backend test`）。

### 8. 兼容性

- `/api/weixin/*` 保留原样，仅注释标记 deprecated，README 中「多渠道」章节后续可补充说明。
- 不改变微信扫码底层机制、账号文件格式（`accounts/`）、weixin-bot adapter 行为。

## 验收标准

1. web 后台「聊天机器人绑定」卡片显示微信渠道，绑定流程（扫码→轮询→成功/失败）与现状等价。
2. 文案无「登录」残留（用户可见 UI 层面）。
3. `curl /api/channels` 返回 `[{ id: 'weixin', displayName: '微信', status: {...} }]`。
4. 新增渠道（如企微）只需实现 `ChannelBindingService` + `registry.register()` + 前端渠道
   展示已按列表渲染，无需改动卡片结构。
5. `pnpm --filter @linkagent/backend test` 与 `pnpm --filter @linkagent/backend typecheck` 通过。

## 后续（不在本次范围）

- wecom 等渠道的 `ChannelBindingService` 实现（企微是 botId/secret 配置型，可能只需 status + reload）。
- 渠道卡片按渠道能力动态展示绑定方式（扫码 / 配置表单 / 链接跳转）。
