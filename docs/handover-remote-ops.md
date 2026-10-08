# vibecoding 远程运维解决方案交接文档

## 📋 一、已完成交付清单

### ✅ 已完成功能
1. ✅ vibecoding全栈框架（Server/Agent/Client SDK）
2. ✅ LinkAgent后端集成，新增`/api/remote/*`系列接口
3. ✅ 3个Cursor实例配置，独立工作目录隔离，自动负载均衡
4. ✅ FRPS内网穿透服务端部署，支持多客户端接入
5. ✅ Nginx反向代理配置，统一入口80端口
6. ✅ Web UI新增「在线IDE」菜单入口
7. ✅ 所有代码已推送到远程仓库main分支：`git@github.com:superproxy/agent-linker.git`

### 📍 关键配置路径
| 配置项 | 路径 | 说明 |
|-------|------|------|
| 网关主配置 | `/root/agent-linker/backend/config/gateway.yaml` | 包含Agent列表、Cursor配置、FRP/Nginx配置 |
| FRPS配置 | `/root/agent-linker/.runtime-state/frps/frps.ini` | 内网穿透服务端配置 |
| FRPS日志 | `/root/agent-linker/.runtime-state/frps/frps.log` | 运行日志 |
| Nginx配置 | `/etc/nginx/conf.d/linkagent.conf` | 反向代理规则 |
| 前端构建产物 | `/root/agent-linker/web/dist` | Web UI静态资源 |
| Cursor实例工作目录 | `/root/agent-linker/.runtime-state/cursor-instances/*` | 3个实例独立目录 |

## 🔑 二、访问凭证与地址

### 访问地址
| 服务 | 地址 | 说明 |
|------|------|------|
| LinkAgent管理后台 | http://216.19.4.113 | 主入口 |
| FRPS管理后台 | http://216.19.4.113/frps/ | 内网穿透管理 |
| OpenAI兼容API | http://216.19.4.113/v1 | 支持所有OpenAI客户端接入 |

### 账号信息
| 服务 | 账号 | 密码/Token | 权限 |
|------|------|------------|------|
| FRPS Dashboard | `admin` | `linkagent@2024` | 管理员 |
| FRP客户端连接Token | - | `linkagent_frp_token_2024` | 所有frpc客户端连接使用 |
| Cursor API Token | - | `crsr_9dbe93e3247e6dd8223048dd515477aabb41a7dedeb63785a014cbeb98ddcf3f` | 3个Cursor实例共用 |

## 🛠️ 三、运维指南

### 1. 服务启停命令
```bash
# 查看所有运行服务
ps aux | grep -E "(frps|nginx|node)" | grep -v grep

# 重启FRPS服务
pkill frps
nohup frps -c /root/agent-linker/.runtime-state/frps/frps.ini > /root/agent-linker/.runtime-state/frps/frps.log 2>&1 &

# 重启Nginx
nginx -t && nginx -s reload

# 重启网关服务
cd /root/agent-linker
pkill -f "pnpm dev.*backend"
nohup pnpm dev --filter @linkagent/backend > /root/agent-linker/.runtime-state/backend-dev.log 2>&1 &
```

### 2. 端口占用说明
| 端口 | 服务 | 对外暴露 | 说明 |
|------|------|----------|------|
| 80 | Nginx | 是 | 统一入口 |
| 7000 | FRPS | 是 | 客户端连接端口 |
| 8080 | FRPS HTTP代理 | 是 | 内网HTTP服务暴露端口 |
| 7500 | FRPS Dashboard | 否 | 已通过Nginx反向代理到80端口 |
| 8787 | LinkAgent网关 | 否 | 已通过Nginx反向代理到80端口 |

### 3. 常见问题排查
| 问题现象 | 排查步骤 |
|---------|----------|
| 管理后台无法访问 | 1. 检查nginx是否运行：`ps aux | grep nginx` <br> 2. 检查网关是否运行：`ss -tunlp | grep 8787` <br> 3. 查看nginx日志：`/var/log/nginx/error.log` |
| FRP客户端无法连接 | 1. 检查7000端口是否开放：`telnet 216.19.4.113 7000` <br> 2. 检查客户端Token是否正确：与配置中`linkagent_frp_token_2024`一致 <br> 3. 查看frps日志：`/root/agent-linker/.runtime-state/frps/frps.log` |
| Cursor实例无响应 | 1. 查看网关日志：`/root/agent-linker/.runtime-state/backend-dev.log` <br> 2. 检查实例工作目录是否存在：`ls /root/agent-linker/.runtime-state/cursor-instances/` |

## 🚀 四、后续迭代计划

### P0 待开发功能
1. 完善在线IDE页面：文件浏览器、代码编辑器、终端功能
2. 远程桌面功能：集成VNC/RDP协议，支持远程桌面访问
3. FRPC客户端自动配置：在Web后台一键生成frpc配置文件
4. 多Cursor实例监控：页面展示实例运行状态、负载情况

### P1 优化功能
1. 支持跨机器Agent管理：多节点集群部署
2. 任务调度中心：定时执行远程命令、脚本
3. 审计日志：记录所有远程操作行为
4. 权限控制：细粒度用户权限分配

## 📝 五、代码提交规范
- 提交协议：优先使用SSH协议
- 仓库地址：`git@github.com:superproxy/agent-linker.git`
- 分支规范：主分支`main`，功能开发新建feature/*分支
- 提交信息：使用简体中文，清晰说明改动内容

## 📞 六、联系人
- 开发负责人：[你的名称]
- 联系方式：[联系方式]
- 问题响应：24小时内处理线上问题
