# pi-commit

基于 [pi](https://pi.dev) 的交互式 Git 提交助手：从 staged 变更生成 Conventional Commit，通过反馈或编辑改到满意，再确认提交。

- 复用 pi 的模型配置和认证，支持自定义 provider。
- 支持中英文、按 type 自动添加 emoji、多轮改稿和外部编辑器。
- 提交前检查 HEAD 与暂存区变化，会话历史仅保存在内存中。

## 安装

需要 Git、Node.js ≥ 22.19.0、pnpm 11，以及可用的 pi 模型配置。

```sh
git clone https://github.com/oolongcha024/pi-commit.git
cd pi-commit
pnpm install --frozen-lockfile
pnpm build
pnpm add -g .
```

尚未配置模型认证时，先在 pi 中运行 `/login`，或配置对应 provider 的环境变量。详见 [pi 模型与认证配置](https://pi.dev/docs/latest/providers)。

## 使用

在要提交的仓库中运行：

```sh
git add <paths>
pi-commit --language zh --emoji "主要解决重连后的状态丢失"
```

生成草稿后，输入修改意见继续改稿，或选择：

| 输入 | 操作 |
| --- | --- |
| 普通文本 | 根据反馈重新生成 |
| `y` | 使用当前草稿提交 |
| `e` | 用外部编辑器修改 |
| `r` | 重新生成；请求失败后重试上一条反馈 |
| `q` | 退出 |

编辑器优先使用 `$VISUAL`，其次是 `$EDITOR`，例如：

```sh
export EDITOR='code --wait'
```

手动编辑后同样校验格式，emoji 根据 type 和开关重新生成。若 HEAD 或暂存区发生变化，提交会暂停；Git hook 拒绝提交时保留草稿。

空回车不提交，`Ctrl+C` 取消并退出。支持窄终端及浅色、深色终端背景；设置 `NO_COLOR=1` 可关闭颜色，`TERM=dumb` 使用静态文本提示。

若已有同名 shell 函数，可用 `command pi-commit` 调用本工具。

### 命令选项

| 选项 | 说明 |
| --- | --- |
| `--language <zh\|en>` | 消息语言，默认 `en` |
| `--emoji` / `--no-emoji` | 启用或关闭 emoji，默认关闭 |
| `--model <provider/model>` | 覆盖本次使用的模型 |
| `--agent-dir <path>` | 指定 pi 配置目录 |
| `-h, --help` | 查看帮助 |
| `-v, --version` | 查看版本 |

## 配置

首次未指定模型时，会列出可用模型并保存所选模型。个人偏好位于 `~/.config/pi-commit/config.json`；设置了 `XDG_CONFIG_HOME` 时，使用其下的 `pi-commit/config.json`：

```json
{
  "model": "provider/model",
  "language": "en",
  "emoji": false
}
```

命令行选项覆盖个人偏好，仅影响本次运行。

pi 配置目录默认遵循 `PI_CODING_AGENT_DIR`，通常为 `~/.pi/agent`。本工具复用其中的认证和自定义模型配置，不复制 token、不修改 pi 偏好；SDK 的 OAuth 刷新可能更新共享凭据。

## 行为与限制

- 一条消息覆盖整个 index。没有 staged 变更时不调用模型。
- 仅支持 Conventional Commits。模型从 index/HEAD 读取仓库规范；格式不兼容或本轮未交付有效草稿时，打印说明并退出。
- 程序校验消息结构；语言、措辞、事实和兼容的仓库要求由模型判断。不主动执行 commitlint，仓库现有 Git hooks 正常运行。
- 模型使用完整 bash；只读分析和禁止自行提交由 prompt 约定，不提供命令沙箱。
- 不加载 pi extensions、MCP、其他 skills 或 prompt templates；暂不支持由 extension 动态注册的 provider。

## 开发与贡献

欢迎提交 Issue 或 Pull Request。开发使用 pnpm，提交前运行 `pnpm check`。

```sh
pnpm dev --help  # 从源码运行
pnpm check      # lint、类型检查、测试和构建
pnpm format     # 格式化并应用可自动修复的检查
```

自动化测试使用临时 Git 仓库和本地模拟模型端点，不需要真实凭据。也可使用已有 pi 认证运行实际模型验证：

```sh
pnpm smoke provider/model
```

该验证会向指定 provider 发起请求，检查生成、反馈改稿和规范冲突处理；只使用临时仓库，不执行提交。

## 许可证

[MIT](LICENSE)
