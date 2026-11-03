# dsh-opencode-session-fix

[![npm](https://img.shields.io/npm/v/dsh-opencode-session-fix.svg)](https://www.npmjs.com/package/dsh-opencode-session-fix)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 实测环境：DSH Desktop **0.2.1-rc.5**（Windows 11，Node 26.12.1），profile 内启用
> `@deepseek-ai/dsh-experimental-auto-review` 与 `@deepseek-ai/dsh-llm-pi-ai`，
> provider 为 `opencode-go`。
>
> English documentation: [README.md](./README.md)

> **DSH 0.2.2 已修复该问题。** 本插件只作为旧版本（0.2.1-rc.5 及更早）的补丁存在，
> 不随新版本继续更新；在 0.2.2+ 上是 no-op，可以直接卸载。

一个只管宿主的 DSH 插件，修的是这一个具体故障：权限模式选**自动审查**（`EXP`）、
当前模型走 opencode 系 provider 时，每一次受审工具调用都在执行前失败：

```
auto-review: reviewer ended with error INVALID_REQUEST: 400:
{"type":"MissingSessionID","message":"Request is missing x-opencode-session ..."}
```

插件给「没有带会话 id 的 opencode 请求」补一个 session id，让 pi-ai 能生成
`x-opencode-session` 请求头。已经带 session id 的请求（主对话）完全不动。

## 根因

| 环节 | 位置 | 关键点 |
| --- | --- | --- |
| 自动审查构造请求 | `dsh-experimental-auto-review/lib/index.js`（`classifyRisk`） | 冻结的 `{ provider, model, system, messages, temperature, signal }`，**没有 `sessionId`**，然后 `ctx.llm.stream(options)` |
| 主 agent 构造请求 | `dsh-agent-loop/lib/index.js` | 同一个调用**带上** `sessionId: this.session.id` |
| 分发 | `dsh-llm/lib/index.js` | `stream()` → `llm/stream` 瀑布 → `adapterStream()` → `registration.adapter.prepareCall()` → 该对象上的 `stream(preparedOptions)` |
| 构造参数 | `dsh-llm-pi-ai/lib/index.js` | `...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }` |
| 真正加头 | `@earendil-works/pi-ai/dist/providers/opencode-headers.js` | `if (!options?.sessionId) return options`，没有 id 就不加头 |

所以 reviewer 请求到达 opencode 时没有路由头，被 `400 MissingSessionID` 拒掉。
provider 配置本身没有问题。

## 为什么落在这里

- `llm/stream` 瀑布改不了请求：监听器签名是 `(options, next)`，`next` 不带参数，
  监听器只能包裹「已经交给 adapter」的那条流。
- 重新注册 provider 会被 `DUPLICATE_ADAPTER` 拒绝；在 provider 上写死静态 `headers`
  会把主对话也压进 reviewer 的同一个桶。
- 所有分发路径——`llm.stream()` 和 prepared call——都要经过已注册 adapter 的
  `prepareCall()` 返回的那个对象。插件包裹的就是这个对象上的 `stream`，外加
  adapter 自身的 `stream()`。

**必须包 `prepareCall()`，只包 `stream()` 不够。** 0.2.1-rc.5 里 pi-ai 的
`prepareCall()` 返回的 `stream` 闭包直接调用自己的快照实现，根本不走实例的
`stream()` 方法：

```js
prepareCall(provider, model, _signal) {
  const snapshot = this.current()
  return Promise.resolve({
    model: this.modelInfo(snapshot, provider, model),
    stream: (options) => this.streamWithSnapshot(options, snapshot),
  })
}
```

只包 `stream()` 的话 reviewer 那条路照旧 400。`test/wrapper.test.mjs` 就是照这个
adapter 形状写的伪造实现，专门盯这个坑。

## 行为

- 默认处理的 provider：`opencode-go` 与 `opencode`，可配置。
- 缺 `sessionId`（或为空白串）→ 注入一个稳定 id
  （`dsh-opencode-session-<uuid>`，每次激活生成一个；也可用 `config.sessionId` 固定）。
- 已有 `sessionId` → 原样转发，主对话仍是真实 session id、自己的路由桶。
- 同一 adapter 实例服务的其它 provider → 不碰，因为按 `options.provider` 逐个请求过滤。
- 冻结的请求（自动审查会 `deepFreeze`）只复制、不改写。
- 监听 `llm/adapters-updated`，配置变更重建 adapter 后补丁跟到新实例；
  插件卸载时逐个还原（原本来自原型的函数用 `delete` 撤掉，不留影子方法）。
- 如果 `llm.adapters` 不是 `Map`：只 warn 一次并放弃，不会拖垮 profile 加载。

## 安装

```powershell
dsh plugin --profile web add dsh-opencode-session-fix
dsh --profile web --dump-config
```

把 `web` 换成你自己的 profile 名，dump 里应出现 `- id: opencode-session-fix`。
包已发到 npm，应用内「插件中心」也能直接搜到。

桌面版（`desktop` profile 由 Electron 独占，CLI 会拒绝）：**设置 → 插件 → 安装**，
填包名 `dsh-opencode-session-fix`，或本仓库地址。

源码安装（不走 npm）：`dsh plugin --profile web add github:imx123/dsh-opencode-session-fix`，
或本地目录路径。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖本插件插入的行（覆盖会替换整个 `config`）：

```yaml
- id: opencode-session-fix
  name: dsh-opencode-session-fix
  config:
    providers: ['opencode-go']   # 默认 ['opencode-go', 'opencode']
    sessionId: ''                # 留空 = 每次激活生成新 UUID
```

## 验证

```powershell
node --check lib/index.js
node test/wrapper.test.mjs
```

真机：开自动审查（`EXP`），选 `opencode-go` 模型，让一次 `write` 被审查。
会话日志里能看到把关的预设：

```
{"type":"permission/preset","seq":286,"time":1793718502130,"data":{"preset":"auto"}}
```

而那一次受审的 `write` 正常返回，不再是
`auto-review of tool "write" failed ... 400 MissingSessionID`。

回归：主对话的 `x-opencode-session` 仍应等于真实 session id（不是插件的 id）。
卸载插件后 `400` 应该回来，说明补丁可逆。

## 风险与范围

只作用于进程内：自己不联网、不碰凭据、不写盘、不写会话事件。插件包裹的是宿主
进程里的一个对象，卸载时还原，所以它能影响的只有配置路由上那个
`x-opencode-session` 请求头。

社区插件，与 DeepSeek 官方无隶属关系。

## 边界

| 项 | 说明 |
| --- | --- |
| 依赖内部字段 | `ctx.llm.adapters` 是 `llm` 服务的公开类字段，但不是文档化的扩展点；真被改名时插件退化为 warn。 |
| 共享桶 | 所有被修补的请求共用一个 id。opencode 只拿它做路由/缓存，功能正常，但缓存粒度不如真实会话。 |
| 上游修复 | 已经修了：DSH 0.2.2 起 `auto-review` 自己带上 `sessionId`（`fix(auto-review): route review requests by their Session`，6fcb9b6c）。本插件定位是 0.2.1 及更早版本的补丁，不随新版本更新。 |
| 没有做的事 | 不改 `app.asar`；不给无关 provider 灌 id；不在 `llm/stream` 里尝试改 `options`。 |

## 许可

MIT。
