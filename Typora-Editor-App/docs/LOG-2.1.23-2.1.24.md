# 2.1.23 / 2.1.24 记录（2026-09-15）

## 一、2.1.23：AI 补全的四处故障

### 1. 地址写法不统一导致 HTTP 404
- 复现：`https://api.deepseek.com`、`.../v1` 会被拼成不存在的路径，实测返回 404；`.../anthropic` 12/12 正常返回片段。
- 修改：`endpoint()` 对已知服务商（`api.deepseek.com`、`open.bigmodel.cn`）归一化同端点写法；自定义子路径保持独立。
- 修改：非 2xx 响应的错误信息带上服务商原文与实际请求地址。

### 2. 只返回思考内容被当作空建议
- 复现：部分模型把预算用在 thinking 上（`stop_reason=max_tokens`、无 text 块），旧解析得到空文本，界面只提示「暂无建议」。
- 修改：区分仅返回思考内容、被 `max_tokens` 截断、未返回文本、片段与已有内容重复四种情况；GLM 5.2+ 的 `reasoning_effort: none` 由公式扩展到散文。

### 3. AI 建议框不可滚动、点击即关闭
- 复现（对 2.1.22 运行验收场景 93，14 条断言中 7 条失败）：`pointer-events: none` 使 `elementFromPoint` 命中背后正文；高度上限写死 180px；文档级 `mousedown` 守卫未包含建议框，点击即关闭并移动光标；框内滚动触发重新落位。
- 修改：`pointer-events: auto`、`overflow-y: auto`、`overscroll-behavior: contain`；框内 `mousedown` 不落光标；守卫跳过框内事件；高度上限 `min(520px, 60vh)`。

### 4. 改模型名导致密钥看似被清空
- 原因：密钥槽由「协议 + 端点字符串」决定，地址写法变化即换槽。
- 修改：地址归一化后同一端点只有一个槽；改模型名不影响密钥；切换平台时明确提示。

### 配置模型
- 移除内置服务商与模型预设；`PROVIDER_TEMPLATES` 只预填协议与地址。
- 新增导入配置（`settings.json` 的 `env` 块、扁平 JSON、`KEY=VALUE`）与删除模型配置（含该端点密钥）。
- 移除 API-free 发行线：`public-release/`、`build-flavor`、`apiEnabled` 门控、`pack.py --public`、公版桌面构建与审计脚本。

## 二、2.1.24：地址与协议不一致（2.1.23 安装后仍失败的原因）

IDE 扩展状态库（`state.vscdb`）中读到的配置：

```
protocol = chat-completions        baseUrl = https://api.deepseek.com/anthropic
ai = false                         model   = deepseek-flash
```

- 由该配置得到的请求地址为 `https://api.deepseek.com/anthropic/chat/completions`，服务商无此路径，返回 404。
- 同时 `ai` 为关闭状态；已保存的密钥属于另一个地址写法对应的槽，因此即使打开 AI 也会提示需要填写密钥。
- 扩展本身加载正常（`exthost.log` 中 2.1.23 成功激活，扩展目录 519 个文件，`build-flavor.mjs` 已不存在）。

修改：`protocolFor()` 由地址判定协议并在 `settings()`、`profiles()`、`endpoint()` 三处生效（旧配置读取时纠正）；修改地址不再改动 `ai`/`automaticAI`；缺少密钥的提示说明密钥按「协议 + 地址」分槽保存。

## 三、验证数据

| 项目 | 结果 |
| --- | --- |
| 扩展单元测试 | 68/68 |
| 桌面补全套件 | 通过 |
| 验收场景 93（2.1.24） | 14/14 |
| 验收场景 93（2.1.22，A/B） | 7/14 |
| 四方哈希链 | 518 扩展文件 / 496 共享渲染文件，四处逐字节一致 |
| 密钥审计 | VSIX 520 文件、app.asar 531 文件，0 处命中（含指定密钥逐字比对） |
| 服务商实测 | Anthropic 兼容地址 12/12 返回片段；`/v1` 写法返回 404 |

## 四、产物

| 产物 | SHA256 |
| --- | --- |
| `markpilot-2.1.24.vsix` | 见 `SHA256SUMS.txt` |
| `markpilot-Setup-2.1.24.exe` | 见 `SHA256SUMS.txt` |
| `markpilot-v2.1.24-portable.exe` | 见 `SHA256SUMS.txt` |

安装状态：桌面 2.1.24 已安装；VS Code 已侧载 2.1.24；Trae 仍在运行，侧载按纪律停止，待 IDE 关闭后执行。

## 五、未完成

- Trae 的 2.1.24 侧载（IDE 运行中）。
- 本轮调试使用的一把 DeepSeek 密钥已进入对话记录，建议在服务商后台轮换。
