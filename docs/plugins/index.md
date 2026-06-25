# 插件总览与架构

SPlayer-Next 内置一套插件系统，允许用第三方 JavaScript 扩展应用能力。每个插件都是一段运行在**独立隔离沙箱**中的脚本，通过宿主注入的全局对象 `splayer` 与应用交互。

本文介绍插件系统的整体架构、运行模型与两类插件共用的通用 API。具体的编写方式见：

- [音源插件](/plugins/source)：解析歌曲的播放地址（`musicUrl`）。
- [控制插件](/plugins/control)：监听播放状态、反向控制播放、声明自己的设置项。

最终用户的安装与管理方式见 [插件使用](/plugins-usage)。

## 插件能做什么

| 类型                         | `@type`   | 用途                                                  |
| ---------------------------- | --------- | ----------------------------------------------------- |
| [音源插件](/plugins/source)  | `source`  | 为歌曲提供可播放的 URL，扩展可播放的曲库              |
| [控制插件](/plugins/control) | `control` | 订阅播放/歌词事件，反向控制播放器，并可声明用户设置项 |

一个脚本只能是其中一种类型，由头部 `@type` 决定，缺省为 `source`。

## 技术架构

### 进程模型

**每个启用的插件运行在自己的子进程中**（Electron `utilityProcess.fork`，服务名 `splayer-plugin-<id>`）。子进程内用 Node 的 `vm.createContext` 建立一个隔离的执行上下文，插件脚本在其中运行，既访问不到应用主进程的内存，也访问不到其他插件。

```
┌─────────────── 主进程 (Electron Main) ───────────────┐
│  PluginRegistry  ── 管理生命周期 / 选源 / 崩溃重启      │
│  playerControl   ── 收敛外部播放控制                   │
│  playbackBridge  ── 把播放事件扇出给控制类插件          │
│        │  IPC (postMessage)        ▲ hostCall          │
└────────┼───────────────────────────┼──────────────────┘
         ▼                           │
┌──────────────────┐      ┌──────────────────┐
│ utilityProcess A │      │ utilityProcess B │   …每插件一个进程
│  vm.Context      │      │  vm.Context      │
│  globalThis.splayer     │  globalThis.splayer
│  插件脚本 A       │      │  插件脚本 B       │
└──────────────────┘      └──────────────────┘
```

之所以采用「一插件一进程」而非「共享一个进程跑多个上下文」，是因为插件脚本不可信：单凭 `vm` 沙箱无法阻止脚本写出同步死循环、抛未捕获异常、内存溢出或调用 `process.exit`。进程级隔离换来三件事：

- **独立崩溃恢复**：单个插件崩溃只影响它自己，由注册表自动重启，不波及主程序与其他插件；
- **独立卡死兜底**：心跳丢失时只杀掉卡死的那一个；
- **安全与内存边界**：脚本拿不到宿主内存，单个进程的资源占用相互独立。

代价是每个常驻插件会占用一个 Node 子进程的基础内存。实际占用通常不大——音源插件之间互斥（同时最多启用一个），控制插件按需启用。

### 调用数据流

**音源插件**（拉取式，由播放器主动调用）：

```
播放器需要 URL → router.resolveUrl → 按优先级选中一个 ready 的插件
  → sandbox.sendCall → 子进程内的 musicUrl handler
  → handler 内 splayer.request(...) → hostCall 回主进程发起真实网络请求
  → 结果回传 → 播放器拿到 URL 播放
```

**控制插件**（推送式，由播放状态驱动）：

```
播放/歌词状态变化 → nowPlaying 事件总线 → playbackBridge 聚合
  → 仅在语义变化时 broadcast → sandbox.sendEvent → 子进程内 player.on 回调
反向控制：插件调 splayer.player.play() → hostCall → 主进程 playerControl 执行
```

### 生命周期与状态

```
安装 → 解析头部(manifest) → 落盘 → [启用] → fork 子进程 → 注入 splayer → 跑脚本
     → register() 声明能力 → ready ──(崩溃)──> 自动重启 ──> ready
     → [禁用] → kill 子进程 → disabled
     → 卸载 → 删除脚本与本地数据
```

插件卡片上的状态徽章对应下列内部状态：

| 状态       | 含义                                              |
| ---------- | ------------------------------------------------- |
| `loading`  | 子进程已 fork，等待脚本就绪                       |
| `ready`    | 已就绪，可用                                      |
| `error`    | 加载/运行失败或崩溃超限，卡片下方显示错误码与原因 |
| `disabled` | 已被用户禁用                                      |

::: tip 崩溃自愈
插件子进程崩溃后会按 **2s → 8s → 30s** 退避自动重启，连续失败 3 次后置为 `error`，不再重试。心跳每 10 秒一次，连续 3 次无响应判定卡死并强制重启。
:::

## 脚本头部（Manifest）

脚本以一段头部 JSDoc 块注释声明元数据：

```js
/**
 * @name        Example
 * @version     1.0.0
 * @description 示例插件
 * @author      you
 * @homepage    https://example.com
 * @type        source
 * @apiLevel    2
 */
```

| 字段           | 必填 | 说明                                                                           |
| -------------- | ---- | ------------------------------------------------------------------------------ |
| `@name`        | ✅   | 插件展示名（最长 24 字符）                                                     |
| `@version`     | ✅   | 版本号                                                                         |
| `@description` |      | 简介                                                                           |
| `@author`      |      | 作者                                                                           |
| `@homepage`    |      | 主页 URL                                                                       |
| `@type`        |      | `source`（默认）或 `control`，决定插件类型                                     |
| `@platform`    |      | `splayer`（默认）或 `lx`；`gz_` 压缩脚本默认按 `lx` 处理                       |
| `@apiLevel`    |      | 声明兼容的 Host API 级别，当前宿主 = **2**，超过则拒绝加载；控制类需声明为 `2` |

::: warning
缺少 `@name` 或 `@version` 会导致导入失败。插件 ID 由宿主依据「名称 + 源码哈希」自动生成，**无需也无法手动指定**——同一份脚本的 ID 始终一致，改动脚本会生成新 ID。
:::

## 沙箱环境

插件脚本运行在受限沙箱中，与应用其余部分相互隔离：

- **没有** Node 内置模块（`fs` / `net` / `path` 等）、**没有** `require` / `import`、**没有** DOM 与 Electron API；
- **可用全局**：`splayer`、`Buffer`、`URL` / `URLSearchParams`、`TextEncoder` / `TextDecoder`、`btoa` / `atob`、`Promise`、`queueMicrotask`、定时器（`setTimeout` / `setInterval` / `setImmediate` 及其 clear 版本），以及 `console`（自动转发到 `splayer.log`）；
- **网络**只能经 `splayer.request` 发起，且仅允许 `http://` / `https://`；
- 脚本**顶层同步执行**有 5 秒时限，超时视为加载失败。请把耗时逻辑放进异步处理器，不要在顶层做同步重计算。

## 通用 API

宿主在沙箱全局注入 `splayer` 对象。下列接口对**音源**与**控制**两类插件通用；类型特定的接口（`splayer.register` 的入参、`splayer.on` / `splayer.player` 等）见各自的文档。

### 属性

| 属性                 | 类型     | 说明                       |
| -------------------- | -------- | -------------------------- |
| `splayer.pluginId`   | `string` | 宿主分配的插件 ID          |
| `splayer.apiLevel`   | `number` | 宿主 Host API 级别         |
| `splayer.locale`     | `string` | 当前界面语言（如 `zh-CN`） |
| `splayer.appVersion` | `string` | 应用版本                   |

### `splayer.request(url, options?)`

发起 HTTP 请求。仅允许 `http://` / `https://`，并遵循系统代理。

| 参数      | 类型     | 必填 | 说明           |
| --------- | -------- | ---- | -------------- |
| `url`     | `string` | ✅   | 请求地址       |
| `options` | `object` |      | 请求选项，见下 |

`options` 结构：

| 字段           | 类型                                  | 默认     | 说明                       |
| -------------- | ------------------------------------- | -------- | -------------------------- |
| `method`       | `"GET" \| "POST"`                     | `"GET"`  | 请求方法                   |
| `headers`      | `Record<string, string>`              | —        | 请求头                     |
| `body`         | `string \| ArrayBuffer \| Uint8Array` | —        | 请求体                     |
| `timeout`      | `number`                              | `15000`  | 超时（毫秒，最大 `60000`） |
| `responseType` | `"text" \| "json" \| "arraybuffer"`   | `"text"` | 响应解析方式               |

返回 `Promise<Result>`：

| 字段      | 类型                     | 说明                                                         |
| --------- | ------------------------ | ------------------------------------------------------------ |
| `status`  | `number`                 | HTTP 状态码                                                  |
| `headers` | `Record<string, string>` | 响应头                                                       |
| `body`    | `unknown`                | `text` → 字符串；`json` → 对象；`arraybuffer` → `Uint8Array` |

```js
const resp = await splayer.request("https://api.example.com/song?id=1", {
  method: "GET",
  headers: { "User-Agent": "..." },
  responseType: "json",
});
console.log(resp.status, resp.body);
```

### `splayer.storage`

插件私有的键值存储，每个插件独立命名空间，卸载插件时一并清除。

| 方法                      | 返回                 | 说明       |
| ------------------------- | -------------------- | ---------- |
| `storage.get(key)`        | `Promise<T \| null>` | 读取一个键 |
| `storage.set(key, value)` | `Promise<void>`      | 写入一个键 |
| `storage.remove(key)`     | `Promise<void>`      | 删除一个键 |
| `storage.keys()`          | `Promise<string[]>`  | 列出所有键 |

### `splayer.getSetting(key)`

同步读取用户为该插件配置的值，未配置时返回 `undefined`。控制类插件通过 `splayer.register` 声明设置项，详见 [控制插件 · 设置项](/plugins/control#设置项)。

### `splayer.log`

输出日志，转发到宿主日志系统；脚本中的 `console.*` 也会转发到同一通道。

| 方法                 | 说明 |
| -------------------- | ---- |
| `log.debug(...args)` | 调试 |
| `log.info(...args)`  | 信息 |
| `log.warn(...args)`  | 警告 |
| `log.error(...args)` | 错误 |

### `splayer.utils`

常用工具的安全封装，无需自行引入 Node 模块。

| 命名空间       | 方法                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `utils.crypto` | `md5` / `sha1` / `sha256` / `hmac` / `randomBytes` / `aesEncrypt` / `aesDecrypt` / `rsaEncrypt` |
| `utils.buffer` | `from` / `bufToString` / `concat`                                                               |
| `utils.base64` | `encode` / `decode`                                                                             |
| `utils.zlib`   | `inflate` / `deflate` / `gunzip` / `gzip`                                                       |

## 资源约束与安全

| 约束         | 值    | 说明                                     |
| ------------ | ----- | ---------------------------------------- |
| 加载超时     | 10 秒 | 从 fork 到收到就绪信号，超时判为加载失败 |
| 顶层执行超时 | 5 秒  | 脚本同步部分的执行时限                   |
| 网络默认超时 | 15 秒 | `splayer.request` 默认值                 |
| 网络最大超时 | 60 秒 | `request` 的 `timeout` 上限              |
| 每插件并发   | 4     | 单个插件同时进行的调用上限               |
| 在线导入大小 | ~9 MB | 在线安装脚本的体积上限                   |

- 网络仅允许 `http(s)`，其余协议（`file://` 等）一律拒绝；
- 插件无法访问文件系统，唯一的持久化途径是 `splayer.storage`；
- 反向播放控制经主进程 `playerControl` 收敛与校验（如音量限定 `0~1`、`seek` 不得为负）。

## 数据存储

```
{userData}/app-data/plugins/
├── scripts/        # 已安装脚本（明文 .js）
├── data/           # 各插件 storage 数据
└── manifest.json   # 已装插件的元数据索引
```

便携版整体迁移 `app-data` 目录即可带走全部插件与数据。

## 错误码

处理器抛异常时可通过 `err.code` 携带错误码，未携带时默认 `PLUGIN_HANDLER_ERROR`：

| Code                        | 含义                                           |
| --------------------------- | ---------------------------------------------- |
| `PLUGIN_ACTION_UNSUPPORTED` | 插件未注册该动作                               |
| `PLUGIN_SCRIPT_ERROR`       | 脚本语法或运行错误                             |
| `PLUGIN_INVALID_MANIFEST`   | 头部字段缺失或不合法                           |
| `PLUGIN_API_LEVEL_MISMATCH` | 声明的 `apiLevel` 高于宿主                     |
| `PLUGIN_REQUEST_TIMEOUT`    | 请求超时                                       |
| `PLUGIN_CANCELLED`          | 请求被取消（如切歌）                           |
| `PLUGIN_NETWORK_ERROR`      | 网络错误                                       |
| `PLUGIN_URL_NOT_ALLOWED`    | URL 协议不在白名单                             |
| `PLUGIN_INVALID_RESULT`     | 返回结果不合法（如 `musicUrl` 未含字符串 url） |
| `PLUGIN_NOT_READY`          | 插件未就绪                                     |
| `PLUGIN_WORKER_CRASHED`     | 子进程崩溃                                     |
| `PLUGIN_HANDLER_ERROR`      | 处理器默认错误码                               |

## 调试

在应用的 DevTools 控制台可直接调用插件接口验证：

```js
// 列出全部插件及状态
await window.api.plugins.list();

// 直接触发一次音源解析
await window.api.plugins.resolveUrl({
  pluginId: "my-plugin-xxxxxxxx",
  source: "sa",
  quality: "hq",
  musicInfo: { songmid: "123" },
});

// 修改某控制类插件的设置（会实时下发到插件）
await window.api.plugins.setSetting("my-plugin-xxxxxxxx", "someKey", true);
```

插件内的 `console.*` / `splayer.log.*` 输出会汇入应用主日志（`{userData}/app-data/logs/`）。修改脚本后重新导入一次即可，旧版本会被自动替换。

## 兼容 lx 插件

SPlayer-Next 提供 `lx` 垫片，覆盖 [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) user*api 的常用接口（`lx.request` / `lx.on("request")` / `lx.send("inited")` / `lx.utils`），多数现有 lx 音源脚本无需修改即可运行。头部写 `@platform lx`，或以 `gz*` 压缩分发，会自动启用垫片。

::: tip
编写**新插件**请直接使用 `splayer.*` 原生 API；lx 垫片仅用于兼容存量脚本，且只覆盖音源能力（控制类能力为 SPlayer-Next 原生特性，无 lx 对应物）。
:::
