# ZCode + GLM-5.3 断联问题 — 交接文档（给 GPT）

> 本文档用于把「ZCode 用 GLM-5.3 频繁断联」一事的**已观察现象**完整移交给你，
> 请你解释成因并给出正确修复方案。文档只陈述事实，不预判机制。

## 一、背景与症状

- 环境：Windows 10，ZCode 客户端（安装于 `D:\Users\Ming\AppData\Local\Programs\ZCode`）。
- 模型：GLM-5.3，使用的 provider 是「BigModel - Coding Plan」（`builtin:bigmodel-coding-plan`）。
- 症状：任务执行中流式连接频繁断开，界面反复显示「重新连接中... N/10」，今天（2026-09-07）尤其集中在 10:44–11:42 这一波。

## 二、ZCode 日志里观察到的现象（关键）

日志文件：
- `C:\Users\Ming\.zcode\cli\log\zcode-2026-09-07.jsonl`
- `C:\Users\Ming\.zcode\v2\logs\2026-09-07.log`

观察到的现象：

1. 今天出现 37 次 `Model network request failed` 事件。
2. 这些失败请求的 `baseURL` **声明为国内端点** `https://open.bigmodel.cn/api/anthropic`，
   但失败原因字段却是：`Cannot connect to API: Connect Timeout Error (attempted address: zcode.z.ai:443, timeout: 10000ms)`
   —— 即**请求声明要去 open.bigmodel.cn，实际 TCP 却连到了海外域名 zcode.z.ai:443 并超时**。
3. 同时出现 35 次 `Provider endpoint routing refresh failed` 事件，字段：
   - `entrypoint: zcode_protocol`
   - `configHost: zcode.z.ai`
   - `error: http_client_error`
   - `retryAfterMs: 30000`
4. 主进程日志里还有 40 次 `ConnectTimeoutError`，全部指向 `zcode.z.ai:443`。
5. 主进程日志里另有周期性（每小时一次）的 `net::ERR_CONNECTION_TIMED_OUT`（来自 auto-update 轮询，也连 zcode.z.ai）。

## 三、本机连通性实测（今天，curl 实测）

| 目标 | 直连结果 | 走本机代理 `http://127.0.0.1:50311` |
|---|---|---|
| `zcode.z.ai` | 连续 5 次全部超时（8s 超时，Connect Timeout）；更早曾有 1 次瞬时返回 307 | 返回 307，连接 1ms |
| `open.bigmodel.cn/api/anthropic` | 稳定返回 200，连接 ~70ms | 返回 200，连接 1ms |

即：**zcode.z.ai 直连不稳定（间歇性超时），open.bigmodel.cn 直连稳定；两者走 Clash 代理都秒通。**

## 四、本机代理 / Clash 相关观察

- `127.0.0.1:50311` 由 `clash-win64.exe`（Clash for Windows）监听，PID 19628。
- 有一个 `AppProxySwitch.exe`（PID 49192）与 `127.0.0.1:50311` 建立了连接。
- Windows 系统代理注册表（`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`）：
  - `ProxyEnable = 0`（系统代理**关闭**）
  - `ProxyServer = 127.0.0.1:50311`（但代理地址**已配置好**）
- 用户环境变量里**原本没有** `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`（本诊断前就是空的）。

## 五、ZCode 如何识别代理（从安装包观察）

在 `ZCode\resources\app.asar` 与 `glm\zcode.cjs` 中检索到以下 token：
`EnvHttpProxyAgent`、`proxyFromEnv`、`HTTP_PROXY`、`HTTPS_PROXY`、`ProxyAgent`。

含义（仅陈述检索事实）：ZCode 的模型 HTTP 客户端（undici）会读取 `HTTP_PROXY` / `HTTPS_PROXY` **环境变量**来决定是否走代理；**未发现读取 Windows 系统代理（ProxyEnable/ProxyServer）的迹象**。

## 六、本次已经做过又已回退的更改

诊断时我曾一度把用户级环境变量设为：

```
HTTP_PROXY  = http://127.0.0.1:50311
HTTPS_PROXY = http://127.0.0.1:50311
NO_PROXY    = localhost,127.0.0.1,::1
```

用户否决（希望走国内直连、不引入全局代理环境变量），**已全部回退删除**，注册表 `HKCU\Environment` 中已无这三项。

## 七、请 GPT 解答的核心疑问

用户的原话：**「为什么没有被设置代理的程序进程，流量也会误入 CFW（Clash for Windows）代理截流？」**

结合本文档现象，需要你解释：

1. 为什么 ZCode 的模型请求 `baseURL` 是 `open.bigmodel.cn`，实际却连到 `zcode.z.ai:443` 并超时？
   （这与上文「Provider endpoint routing」从 `zcode.z.ai` 拉取路由配置、以及 `configHost: zcode.z.ai` 是否有关系？）
2. 为什么一个**没设 `HTTP_PROXY`/`HTTPS_PROXY`、系统代理也关闭**的程序进程，其流量仍会被 CFW 截流 / 劫持？
   （请特别考虑：系统代理 `ProxyEnable=0` 但 `ProxyServer=127.0.0.1:50311` 已配置、`AppProxySwitch.exe` 这个组件、以及 Clash 可能的 TUN / 系统代理接管机制。）
3. 在不引入全局代理环境变量、也不影响其它程序的前提下，**让 ZCode 的 GLM-5.3 稳定走国内直连（open.bigmodel.cn）**的正确方案是什么？

## 八、已观察、但尚未深挖的线索（供你参考，勿据本文档下结论）

- 本机 DNS 服务器是 `fe80::5`（路由器 IPv6），`nslookup` 对两个域名都返回「Query refused」。
- `ipconfig /all` 只看到 `Microsoft Wi-Fi Direct Virtual Adapter`，未见明显的 Clash TUN 网卡（未做更全面检查）。
- 用户环境里 `AppProxySwitch.exe` 连接 Clash 端口的具体作用，未确认。
