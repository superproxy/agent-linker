# Nginx反向代理 & FRPS服务功能使用说明

## 一、反向代理功能（内置Fastify实现）
### 配置说明
在 `gateway.yaml` 中新增 `proxy` 配置段：
```yaml
gateway:
  proxy:
    - location: /api/example
      upstream: http://127.0.0.1:8080
      rewrite: true  # 是否去掉location前缀，请求到upstream的路径为/xxx而不是/api/example/xxx
      websocket: false  # 是否支持WebSocket代理
      addHeaders:
        X-Forwarded-For: $remote_addr
        X-Proxy-By: linkagent-gateway
      removeHeaders:
        - X-Private-Header
      enabled: true
    - location: /dashboard
      upstream: http://127.0.0.1:7500
      rewrite: true
      enabled: true
```

### 功能特性
1. ✅ 多规则匹配，支持前缀匹配
2. ✅ 路径重写（去掉匹配前缀）
3. ✅ 自定义请求头（添加/删除）
4. ✅ WebSocket代理支持
5. ✅ 规则热重载（修改配置后重启网关生效）

## 二、FRPS内网穿透服务
### 依赖要求
需要先在系统中安装frps：
```bash
# 下载安装frp
wget https://github.com/fatedier/frp/releases/download/v0.60.0/frp_0.60.0_linux_amd64.tar.gz
tar -zxvf frp_0.60.0_linux_amd64.tar.gz
cd frp_0.60.0_linux_amd64
cp frps /usr/local/bin/
```

### 配置说明
在网关配置目录新增 `frp.yaml`：
```yaml
frp:
  enabled: true
  bindAddr: 0.0.0.0
  bindPort: 7000
  authToken: your-secret-token  # 留空则自动生成随机token
  dashboard:
    enabled: true
    port: 7500
    user: admin
    password: your-dashboard-password
  allowPorts:
    - start: 10000
      end: 20000
  maxConnections: 1000
```

### 功能特性
1. ✅ 集成frps服务，网关启动时自动拉起
2. ✅ 配置自动生成，无需手动编写frps.yaml
3. ✅ 内置仪表盘支持，方便查看代理状态
4. ✅ 端口范围限制，防止端口滥用
5. ✅ 自动启停，网关关闭时自动停止frps进程

## 三、启用方式
1. 按上面的说明添加配置到对应的yaml文件
2. 重启网关：`pnpm dev` 或 `pnpm start`
3. 查看启动日志确认功能已启用：
   - 反向代理：会打印 `已注册反向代理规则: xxx → xxx`
   - FRPS：会打印 `[frp] frps已启动，绑定端口: 7000`
