# Vibecoding 远程运维IDE解决方案 设计方案与交接文档

## 一、项目概述
### 1.1 项目目标
为LinkAgent网关新增完整的远程运维能力，支持：
- ✅ 多Agent统一管理（Cursor/pi/WorkBuddy等）
- ✅ 在线IDE界面，支持远程文件管理、代码编辑、终端执行
- ✅ 多Cursor Agent实例自动负载均衡，独立工作目录隔离
- ✅ 内置Nginx反向代理、FRP内网穿透服务端能力
- ✅ 零额外第三方依赖，完全兼容现有LinkAgent体系

### 1.2 开发进度
| 功能模块 | 状态 | 说明 |
|---------|------|------|
| IDE菜单入口 | ✅ 已完成 | Web管理后台「我的」板块新增「在线IDE」菜单 |
| IDE基础页面框架 | ✅ 已完成 | 支持Agent选择、后续将扩展文件管理/编辑/终端功能 |
| 多Cursor实例配置 | ✅ 已完成 | 3个Cursor实例，独立工作目录，内置用户提供的Token |
| 负载均衡逻辑 | ✅ 已完成 | 网关层自动分发请求到空闲Cursor实例 |
| FRPS内网穿透服务端 | ✅ 已部署 | 已集成到网关进程管理，支持多客户端接入 |
| Nginx反向代理 | ✅ 已配置 | 统一80端口入口，自动转发到网关、FRPS Dashboard |
| 远程运维API | ✅ 已就绪 | `/api/remote/*` 系列接口，支持Agent管理、命令下发 |

## 二、系统架构
### 2.1 整体分层架构
```
┌─────────────────┐
│   前端Web界面   │  React + Ant Design，IDE菜单/远程管理界面
├─────────────────┤
│  Nginx反向代理  │  统一80端口入口，负载均衡、静态资源服务
├─────────────────┤
│ LinkAgent网关   │  Fastify 5，OpenAI兼容API、Agent调度、远程运维接口
├─────────────────┤
│  FRPS穿透服务端 │  支持多客户端内网穿透，暴露本地服务到公网
├─────────────────┤
│ 多Agent集群     │  Cursor/pi/WorkBuddy等，独立工作目录隔离
└─────────────────┘
```

### 2.2 核心模块调用链
```
用户访问Web IDE → Nginx(80端口) → LinkAgent网关(8787) → 调度到对应Agent → 执行操作/返回结果
外部FRPC客户端 → FRPS服务端(7000端口) → 映射内网服务到公网8080端口
```

## 三、核心功能实现
### 3.1 在线IDE菜单
- 菜单位置：Web后台「我的」板块 → 「在线IDE」
- 路由：`/ide`，对应页面文件：`/root/agent-linker/web/src/pages/Ide.tsx`
- 菜单配置：`/root/agent-linker/web/src/lib/constants.tsx` 中新增 `ide` Tab项
- 接口：依赖 `/api/remote/*` 系列接口实现Agent管理、远程操作

### 3.2 多Cursor实例负载均衡
- 实例配置：共3个Cursor实例，ID分别为 `cursor` / `cursor-2` / `cursor-3`
- 工作目录：`/root/agent-linker/.runtime-state/cursor-instances/[1/2/3]`
- 配置位置：`/root/agent-linker/backend/config/gateway.yaml` 中 `agents` 部分
- 负载逻辑：网关层根据请求量自动分发到空闲实例，支持平滑扩容
- API Token：已配置用户提供的 `crsr_9dbe93e3247e6dd8223048dd515477aabb41a7dedeb63785a014cbeb98ddcf3f`

### 3.3 FRPS内网穿透服务端
- 版本：v0.60.0
- 部署路径：`/usr/local/bin/frps`
- 配置文件：`/root/agent-linker/.runtime-state/frps/frps.ini`
- 端口配置：
  - 客户端连接端口：7000
  - HTTP虚拟主机端口：8080
  - Dashboard管理端口：7500（已通过Nginx反向代理到 `/frps/` 路径）
- 认证信息：
  - 连接Token：`linkagent_frp_token_2024`
  - Dashboard账号：`admin`，密码：`linkagent@2024`
- 集成：已集成到LinkAgent进程管理，网关启动时自动拉起frps服务

### 3.4 Nginx反向代理
- 配置文件：`/etc/nginx/conf.d/linkagent.conf`
- 规则：
  1. 根路径 `/` → 转发到网关服务 `127.0.0.1:8787`，支持WebSocket
  2. `/frps/` 路径 → 转发到FRPS Dashboard `127.0.0.1:7500`
- 热重载：配置修改后执行 `nginx -s reload` 生效

## 四、当前环境信息
### 4.1 访问地址
| 服务 | 地址 | 凭据 |
|------|------|------|
| LinkAgent管理后台 | http://216.19.4.113 | 自行注册/登录 |
| FRPS管理后台 | http://216.19.4.113/frps/ | 账号：admin，密码：linkagent@2024 |
| OpenAI兼容API | http://216.19.4.113/v1 | 使用个人用户Token |
| FRPC客户端连接 | 216.19.4.113:7000 | Token：linkagent_frp_token_2024 |

### 4.2 关键路径
| 内容 | 路径 |
|------|------|
| 网关配置目录 | `/root/agent-linker/backend/config/` |
| 网关运行时状态 | `/root/agent-linker/.runtime-state/` |
| FRPS配置与日志 | `/root/agent-linker/.runtime-state/frps/` |
| Cursor实例工作目录 | `/root/agent-linker/.runtime-state/cursor-instances/` |
| 前端代码 | `/root/agent-linker/web/` |
| 后端代码 | `/root/agent-linker/backend/` |

## 五、维护指南
### 5.1 服务启停
```bash
# 启动所有服务
cd /root/agent-linker && pnpm dev

# 仅启动网关后端
pnpm --filter @linkagent/backend dev

# 仅启动前端开发服务
pnpm --filter @linkagent/web dev

# 手动启动frps
frps -c /root/agent-linker/.runtime-state/frps/frps.ini

# 重启nginx
nginx -s reload
```

### 5.2 日志查看
```bash
# 网关日志
/root/agent-linker/.runtime-state/backend-dev.log

# FRPS日志
/root/agent-linker/.runtime-state/frps/frps.log

# Nginx日志
/var/log/nginx/access.log
/var/log/nginx/error.log
```

### 5.3 配置修改
- 修改网关配置：编辑 `/root/agent-linker/backend/config/gateway.yaml`，重启网关生效
- 修改FRPS配置：编辑 `/root/agent-linker/.runtime-state/frps/frps.ini`，重启frps生效
- 修改Nginx配置：编辑 `/etc/nginx/conf.d/linkagent.conf`，执行 `nginx -s reload` 生效

## 六、后续开发计划
### 6.1 高优
1. 完善IDE页面功能：文件浏览器、代码编辑器、在线终端
2. 新增FRPC客户端管理界面，支持Web端配置穿透规则
3. 新增多实例监控面板，展示每个Agent的负载、在线状态
4. 实现IDE中直接发起对话，自动关联对应Agent

### 6.2 低优
1. 支持多机部署Agent集群，跨机器调度
2. 支持IDE在线调试功能，断点、变量查看
3. 支持文件上传下载、批量操作
4. 新增终端会话持久化，支持多标签页

## 七、常见问题排查
### 7.1 无法访问管理后台
1. 检查nginx是否运行：`ps aux | grep nginx`
2. 检查网关是否运行：`ss -tunlp | grep 8787`
3. 查看nginx错误日志：`tail -f /var/log/nginx/error.log`

### 7.2 FRPC客户端连接失败
1. 检查frps是否运行：`ps aux | grep frps`
2. 检查服务器7000端口是否开放：`telnet 216.19.4.113 7000`
3. 确认客户端配置的Token是否正确：`linkagent_frp_token_2024`

### 7.3 Cursor实例无响应
1. 检查网关配置中Cursor实例的工作目录是否存在
2. 查看网关日志中是否有相关错误信息
3. 重启网关服务：`pkill -f "pnpm dev.*backend" && cd /root/agent-linker && nohup pnpm dev --filter @linkagent/backend > /root/agent-linker/.runtime-state/backend-dev.log 2>&1 &`
