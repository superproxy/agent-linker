# Pi：模型配置与沙箱（云机自装）

> 面向在 Linux 云主机上自装 `pi`、不想用 Docker 的运维。网关只负责 ACP 拉起 `npx -y pi-acp`；**模型清单和 OS 沙箱都在 pi 进程所在机器上**，不在 `config.yaml` 里。

## 1. 和网关的关系

| 层 | 作用 | 覆盖范围 |
|---|---|---|
| 网关 `permissionMode`（缺省 `approve-reads`） | ACP 工具策略：读类可过，写/终端在无 UI 时拒绝 | 所有渠道共用同一 agent 定义 |
| `~/.pi/agent/models.json` | 已注册的 `providerId/modelId` 与 API 地址 | 仅该机 pi |
| `~/.pi/agent/settings.json` | `defaultProvider` / `defaultModel` | 网关未写 `agents[].model` 时沿用 |
| `@erichll/pi-sandbox` | OS 级隔离 bash（及可选子 agent 进程树） | **Linux / macOS**；**Windows 不支持** |

网关默认不绑死会话模型（`defaultAgentDefinitions` 的 pi 无 `model` 字段）。云机用 **`pnpm setup:pi`** 安装 CLI 并生成 `~/.pi/agent` 清单；**不要**在 yaml 里写死 `volcengine/...`。若覆盖 `agents[].model`，必须是该机 `models.json` 已有项（模板 provider 为 `my`）。

两种接法：

- 云机同时跑网关：在该机执行 `pnpm setup:pi`，再按需加沙箱。
- 网关在别处：把这台 Linux 注册为节点，任务打到节点上的 pi。Windows 本机装沙箱无效。

独立部署包含 `scripts/setup-pi.mjs` 与 `server/config/pi-agent/` 模板，包根执行 `npm run setup:pi`。源码仓库执行 `pnpm setup:pi`。

## 2. 一键安装与生成配置

在跑 pi 的用户下（Node `>= 22`）：

```bash
pnpm setup:pi
# 等价：node scripts/setup-pi.mjs
export ARK_API_KEY=你的火山方舟密钥
```

脚本会：

1. `npm i -g --ignore-scripts @earendil-works/pi-coding-agent`
2. `npm i -g pi-acp@0.0.33`（执行机 ACP 桥；网关不需要装）
3. 若 `~/.pi/agent/models.json` 不存在，从 `backend/config/pi-agent/models.json.template` 生成（`apiKey` 为 `${ARK_API_KEY}`）
4. 合并 `settings.json` 的 `defaultProvider=my` / `defaultModel=doubao-seed-2-0-pro-260215`（不覆盖主题、已装包）

常用参数：

| 参数 | 含义 |
|---|---|
| `--skip-install` | 只写配置，不跑 npm 全局安装 |
| `--force` | 覆盖已有 `models.json`，并强制写入默认模型字段 |
| `--home=<dir>` | pi 主目录（默认 `~/.pi`） |
| `--sandbox` | Linux/macOS：有 `rg`/`socat`/`bwrap` 时再 `pi install` 沙箱扩展；缺依赖只打印 apt 命令。Windows 跳过 |

已有清单不想动：不要加 `--force`。后台「安装」仍只装 `pi-acp`；完整初始化请用本脚本。

网关启动命令仍是 `npx -y pi-acp`。`config.yaml` 的 `agents[].model` 请留空。

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

先装系统依赖（§3.1），再：

```bash
pnpm setup:pi --sandbox
# 或已装 CLI 时：
pi install npm:@erichll/pi-auto-review
pi install npm:@erichll/pi-sandbox
pi list
```

先装 `pi-auto-review`，沙箱出网审批依赖它的 broker。

`--sandbox` 会合并 `~/.pi/agent/extensions/pi-sandbox/config.json`（已有项保留，只补缺）：

```json
{
  "subagents": { "provider": "builtin" },
  "filesystem": {
    "additionalAllowRead": [
      "/home/user/.pi/agent/skills",
      "/home/user/.agents/skills"
    ]
  },
  "network": {
    "allowedDomains": ["127.0.0.1"]
  }
}
```

沙箱默认拒绝读整个家目录，bash 里的 `ls` / `read` 因此看不到全局 skills，skill 加载会失败。`additionalAllowRead` 只放开这两个目录。`127.0.0.1` 让沙箱内 `curl` 能打本机网关（任务 skill 的 `LINKAGENT_BASE_URL`）。插件不接受无点的 `localhost`，地址请用 `127.0.0.1`。

插件的 `hostIPC.preflightCommandPrefixes` 只是把某条命令送去一次性审批，没有界面时会直接拒绝，不能当成默认放行 `ls` 或 `curl`。

火山方舟、npm 等其它域名仍按需补进 `allowedDomains`（例如 `ark.cn-beijing.volces.com:443`、`registry.npmjs.org:443`）。不要把可当投递通道的宽域名随手放开。

自检：在工作区外读 `~/.ssh` 或写 `/etc` 应被拒；只改当前工作区应通过。

## 4. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `Sandbox initialization failed: Sandbox dependencies not available: ripgrep (rg) not found, socat not installed` | Linux 上扩展已加载，但 PATH 里没有 `rg` / `socat`（`bwrap` 若已装则不会出现在这条里） | 见 §3.1，装完重启 `pi` / 网关 |
| `Sandbox not supported on win32` / 扩展提示 Windows 不可用 | 适配器不支持 Windows | 把 pi 放到 Linux 云机或 WSL2，不要在 Win 上开沙箱 |
| 会话答非所问 / 设模型失败 / Internal error | yaml 写死了未在 pi 注册的 `volcengine/...` 等 | 清空 `agents[].model`，用 pi 自己的 settings 默认；后台切模型只能选 `models.json` 已有项 |
| bash 卡住等审批 | 出网未进 `allowedDomains`，且无人点审批 | 写 trusted `config.json` 白名单，或关沙箱只留 ACP 策略 |
| 沙箱里 `ls` 不到全局 skills，skill 读不到 `SKILL.md` | 家目录默认拒绝读 | 重跑 `pnpm setup:pi --sandbox`，确认 `additionalAllowRead` 含 `~/.pi/agent/skills` 与 `~/.agents/skills` |
| `curl http://127.0.0.1:...` 被沙箱拒绝 | 回环不在白名单；`localhost` 写法插件不接受 | 白名单写 `127.0.0.1`（`--sandbox` 会补上） |
| `bwrap: ... Operation not permitted` | 云镜像关闭非特权 user namespace | AppArmor / sysctl，见 §3.1 |

## 5. 网关不会自动做的事

- 启动网关**不会**改 `~/.pi`；要初始化请显式跑 `pnpm setup:pi`
- 不代装 `rg` / `socat` / `bwrap`（`--sandbox` 只检测并提示）
- 不把沙箱接到 Windows 本机 agent

安全包、密钥、系统依赖都由云机操作者自己装。
