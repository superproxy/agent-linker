# Pi：模型配置与沙箱（云机自装）

> 面向在 Linux 云主机上自装 `pi`、不想用 Docker 的运维。网关只负责 ACP 拉起 `npx -y pi-acp`；**模型清单和 OS 沙箱都在 pi 进程所在机器上**，不在 `config.yaml` 里。

## 1. 和网关的关系

| 层 | 作用 | 覆盖范围 |
|---|---|---|
| 网关 `permissionMode`（缺省 `approve-reads`） | ACP 工具策略：读类可过，写/终端在无 UI 时拒绝 | 所有渠道共用同一 agent 定义 |
| `~/.pi/agent/models.json` | 已注册的 `providerId/modelId` 与 API 地址 | 仅该机 pi |
| `~/.pi/agent/settings.json` | `defaultProvider` / `defaultModel` | 网关未写 `agents[].model` 时沿用 |
| `@erichll/pi-sandbox` | OS 级隔离 bash（及可选子 agent 进程树） | **Linux / macOS**；**Windows 不支持** |

网关默认不绑死会话模型（`defaultAgentDefinitions` 的 pi 无 `model` 字段）。**不要**在 yaml 里写死 `volcengine/...`、`my/doubao-...` 等厂商模型；模型由本机 pi / pi-acp 安装注册。若覆盖 `agents[].model`，必须是该机 `~/.pi/agent/models.json` 已有项。

两种接法：

- 云机同时跑网关：在该机装 pi + 模型文件 +（可选）沙箱。
- 网关在别处：把这台 Linux 注册为节点，任务打到节点上的 pi。Windows 本机装沙箱无效。

独立部署包可能带上 `server/config/pi-agent/README.md` 说明，**不附带厂商模型 JSON 模板**。

## 2. 模型初始化（交给 pi / ACP）

网关不提供、也不要拷贝火山方舟等写死的 `models.json`。在跑 pi 的用户下：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # pi CLI
npm i -g pi-acp                                                    # 或后台点「安装」
# 用 pi 自己的方式登录 / 注册 provider（写入 ~/.pi/agent/models.json、settings.json）
```

`pi` 需在 PATH（Node `>= 22`）。网关启动命令仍是 `npx -y pi-acp`。

改默认模型：编辑 pi 的 `settings.json`，或确认 `models.json` 已有该项后再在后台切换。`config.yaml` 的 `agents[].model` 请留空。

## 3. 沙箱：不用 Docker

pi **没有内置沙箱**。工具默认以启动 pi 的用户权限跑。可选扩展 `@erichll/pi-sandbox` 走 Anthropic `sandbox-runtime`：

- Linux：`bubblewrap` 命名空间 + seccomp + `socat` 代理桥
- macOS：系统 Seatbelt + `ripgrep`
- 体积：npm 包很小，**无镜像、无 Docker daemon**；依赖的是系统包（通常几 MB）
- 主要罩 **bash / 子 agent 进程树** 的文件系统和出网；pi 进程内的 `read` / `write` / `edit` 仍靠网关 `permissionMode`

官方说明：**Windows is not supported by this Pi adapter.** 在 Windows 上装了也会 fail-closed。

### 3.1 系统依赖

Ubuntu / Debian：

```bash
sudo apt-get update
sudo apt-get install -y ripgrep socat bubblewrap
```

其它发行版：Fedora 用 `dnf install ripgrep socat bubblewrap`；Alpine 用 `apk add ripgrep socat bubblewrap`。

核对（必须在 **pi 进程的 PATH** 里，Cursor/Windows 的 `rg.exe` 不算）：

```bash
command -v rg && command -v socat && command -v bwrap
bwrap --unshare-user --unshare-net echo ok
```

Ubuntu 24.04 若 `bwrap` 报 user namespace 被拒：给 bubblewrap 配 AppArmor，或按发行版处理 `kernel.apparmor_restrict_unprivileged_userns`。

### 3.2 安装扩展（全局，不要 `-l`）

安全包必须进用户全局 `~/.pi/agent/npm/`，不要装进工作区，否则 agent 能改沙箱配置。

```bash
pi install npm:@erichll/pi-auto-review
pi install npm:@erichll/pi-sandbox
pi list
```

先装 `pi-auto-review`，沙箱出网审批依赖它的 broker。

可选白名单 `~/.pi/agent/extensions/pi-sandbox/config.json`（无人值守时至少放行模型/包管理域名，否则 bash 出网会卡住）：

```json
{
  "subagents": { "provider": "builtin" },
  "network": {
    "allowedDomains": ["registry.npmjs.org:443"]
  }
}
```

火山方舟实际域名按你 `models.json` 的 `baseUrl` 补进 `allowedDomains`（例如 `ark.cn-beijing.volces.com:443`）。不要把可当投递通道的宽域名随手放开。

自检：在工作区外读 `~/.ssh` 或写 `/etc` 应被拒；只改当前工作区应通过。

## 4. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `Sandbox initialization failed: Sandbox dependencies not available: ripgrep (rg) not found, socat not installed` | Linux 上扩展已加载，但 PATH 里没有 `rg` / `socat`（`bwrap` 若已装则不会出现在这条里） | 见 §3.1，装完重启 `pi` / 网关 |
| `Sandbox not supported on win32` / 扩展提示 Windows 不可用 | 适配器不支持 Windows | 把 pi 放到 Linux 云机或 WSL2，不要在 Win 上开沙箱 |
| 会话答非所问 / 设模型失败 / Internal error | yaml 写死了未在 pi 注册的 `volcengine/...` 等 | 清空 `agents[].model`，用 pi 自己的 settings 默认；后台切模型只能选 `models.json` 已有项 |
| bash 卡住等审批 | 出网未进 `allowedDomains`，且无人点审批 | 写 trusted `config.json` 白名单，或关沙箱只留 ACP 策略 |
| `bwrap: ... Operation not permitted` | 云镜像关闭非特权 user namespace | AppArmor / sysctl，见 §3.1 |

## 5. 网关不会代做的事

- 不安装 `rg` / `socat` / `bwrap`
- 不自动写入 `~/.pi`（避免覆盖本机已有 models / settings）
- 不把沙箱接到 Windows 本机 agent

安全包、密钥、系统依赖都由云机操作者自己装。
