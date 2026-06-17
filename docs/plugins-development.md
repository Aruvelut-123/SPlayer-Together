# 插件开发指南

插件是一段运行在隔离沙箱中的 JavaScript，通过宿主注入的全局对象 `splayer` 对外提供能力。最终用户的安装方式见 [插件使用](/plugins-usage)。

::: tip 当前能力
目前插件仅支持解析音源播放地址（`musicUrl`），后续会逐步加入更多能力。
:::

## 快速开始

一个最小插件就是一个 `.js` 文件，头部用 JSDoc 声明元数据：

```js
/**
 * @name Example
 * @version 1.0.0
 * @description 示例插件
 * @author you
 * @apiLevel 1
 */

splayer.register({
  sources: {
    demo: {
      name: "Demo 源",
      actions: ["musicUrl"],
      qualities: ["lq", "hq", "lossless"],
    },
  },
});

splayer.on("musicUrl", async (req) => {
  const { musicInfo, quality } = req;
  const resp = await splayer.request(
    `https://api.example.com/url?id=${musicInfo.songmid}&q=${quality}`,
    { responseType: "json" },
  );
  return { url: resp.body.url, quality, expire: resp.body.expire };
});
```

保存为 `example.js`，在 **设置 → 插件管理 → 本地导入** 即可使用。

## 脚本头部（Manifest）

| 字段           | 必填 | 说明                                                     |
| -------------- | ---- | -------------------------------------------------------- |
| `@name`        | ✅   | 插件展示名                                               |
| `@version`     | ✅   | 版本号                                                   |
| `@description` |      | 简介                                                     |
| `@author`      |      | 作者                                                     |
| `@homepage`    |      | 主页 URL                                                 |
| `@platform`    |      | `splayer`（默认）或 `lx`；`gz_` 压缩脚本默认为 `lx`      |
| `@apiLevel`    |      | 声明兼容的 Host API 级别（当前宿主 = 1，超过将拒绝加载） |

缺少 `@name` 或 `@version` 会导入失败。插件 ID 由宿主自动生成，无需手动指定。

## 沙箱环境

插件运行在隔离沙箱中，与应用其余部分相互独立：

- **没有** Node 内置模块（`fs` / `net` 等）、**没有** `require` / `import`、**没有** DOM / Electron API；
- **可用全局**：`splayer`、`Buffer`、`URL` / `URLSearchParams`、`TextEncoder` / `TextDecoder`、`btoa` / `atob`、定时器，以及 `console`（自动转发到 `splayer.log`）；
- 网络只能通过 `splayer.request` 发起，且仅允许 `http://` / `https://`。

## API 参考

宿主在沙箱全局注入 `splayer` 对象，以下为其完整接口。

### 属性

| 属性                 | 类型     | 说明                        |
| -------------------- | -------- | --------------------------- |
| `splayer.pluginId`   | `string` | 宿主分配的插件 ID           |
| `splayer.apiLevel`   | `number` | 宿主 Host API 级别          |
| `splayer.locale`     | `string` | 当前界面语言（如 `zh-CN`）  |
| `splayer.appVersion` | `string` | 应用版本                    |

### `splayer.register(capabilities)`

声明插件支持的音源与能力。建议在脚本同步执行阶段调用——注册后 UI 才能展示插件支持的音源。

**参数**

| 参数           | 类型     | 必填 | 说明                                       |
| -------------- | -------- | ---- | ------------------------------------------ |
| `capabilities` | `object` | ✅   | `{ sources: Record<string, Source> }` |

`Source` 结构：

| 字段        | 类型               | 必填 | 说明                           |
| ----------- | ------------------ | ---- | ------------------------------ |
| `name`      | `string`           | ✅   | 音源展示名                     |
| `actions`   | `("musicUrl")[]`   | ✅   | 支持的动作（当前仅 `musicUrl`）|
| `qualities` | `Quality[]`        |      | 支持的音质                     |

`Quality` 取值：

| 值         | 含义                                          |
| ---------- | --------------------------------------------- |
| `hi-res`   | 高解析度无损（采样率 ≥ 96kHz + 位深 ≥ 24bit） |
| `lossless` | 无损（flac / ape / wav 等）                   |
| `hq`       | 有损 ≥ 320kbps                                |
| `sq`       | 有损 ≥ 192kbps                                |
| `lq`       | 有损 < 192kbps                                |

**返回**：`void`

### `splayer.on(action, handler)`

注册某个动作的处理器。每个动作最多一个处理器，重复注册时后者覆盖前者。

**参数**

| 参数      | 类型                          | 必填 | 说明                       |
| --------- | ----------------------------- | ---- | -------------------------- |
| `action`  | `string`                      | ✅   | 动作名（当前仅 `musicUrl`）|
| `handler` | `(req) => Promise<res>`       | ✅   | 处理函数，异步返回结果     |

**`musicUrl` 请求（`req`）**

| 字段                | 类型      | 说明              |
| ------------------- | --------- | ----------------- |
| `source`            | `string`  | 音源 key          |
| `quality`           | `Quality` | 请求的音质        |
| `musicInfo.songmid` | `string`  | 歌曲 ID           |
| `musicInfo.name`    | `string?` | 歌曲名            |
| `musicInfo.singer`  | `string?` | 艺术家            |

**`musicUrl` 返回（`res`）**

| 字段      | 类型      | 必填 | 说明           |
| --------- | --------- | ---- | -------------- |
| `url`     | `string`  | ✅   | 播放地址       |
| `quality` | `Quality` |      | 实际音质       |
| `expire`  | `number`  |      | 过期时间戳（ms）|

处理器抛出的异常会被宿主捕获并透传错误码；超时未返回会被取消。

### `splayer.request(url, options?)`

发起 HTTP 请求。仅允许 `http://` / `https://`，并遵循系统代理。

**参数**

| 参数      | 类型     | 必填 | 说明           |
| --------- | -------- | ---- | -------------- |
| `url`     | `string` | ✅   | 请求地址       |
| `options` | `object` |      | 请求选项，见下 |

`options` 结构：

| 字段           | 类型                                | 默认      | 说明                       |
| -------------- | ----------------------------------- | --------- | -------------------------- |
| `method`       | `"GET" \| "POST"`                   | `"GET"`   | 请求方法                   |
| `headers`      | `Record<string, string>`            | —         | 请求头                     |
| `body`         | `string \| ArrayBuffer \| Uint8Array` | —       | 请求体                     |
| `timeout`      | `number`                            | `15000`   | 超时（毫秒，最大 `60000`） |
| `responseType` | `"text" \| "json" \| "arraybuffer"` | `"text"`  | 响应解析方式               |

**返回**：`Promise<Result>`

| 字段      | 类型                     | 说明                                                  |
| --------- | ------------------------ | ----------------------------------------------------- |
| `status`  | `number`                 | HTTP 状态码                                            |
| `headers` | `Record<string, string>` | 响应头                                                |
| `body`    | `unknown`                | `text` → 字符串；`json` → 对象；`arraybuffer` → `Uint8Array` |

**示例**

```js
const resp = await splayer.request("https://api.example.com/song?id=1", {
  method: "GET",
  headers: { "User-Agent": "..." },
  responseType: "json",
});
console.log(resp.status, resp.body);
```

### `splayer.storage`

插件私有的键值存储，每个插件独立命名空间，卸载插件时自动清除。

| 方法                       | 返回                | 说明           |
| -------------------------- | ------------------- | -------------- |
| `storage.get(key)`         | `Promise<T \| null>`| 读取一个键     |
| `storage.set(key, value)`  | `Promise<void>`     | 写入一个键     |
| `storage.remove(key)`      | `Promise<void>`     | 删除一个键     |
| `storage.keys()`           | `Promise<string[]>` | 列出所有键     |

### `splayer.getSetting(key)`

同步读取用户为该插件配置的值。

**参数**：`key: string`

**返回**：`T | undefined`（未配置时为 `undefined`）

### `splayer.log`

输出日志，转发到宿主日志系统；脚本中的 `console.*` 也会转发到同一通道。

| 方法                  | 说明 |
| --------------------- | ---- |
| `log.debug(...args)`  | 调试 |
| `log.info(...args)`   | 信息 |
| `log.warn(...args)`   | 警告 |
| `log.error(...args)`  | 错误 |

### `splayer.utils`

常用工具的安全封装，无需自行引入 Node 模块。

| 命名空间          | 方法                                                                              |
| ----------------- | --------------------------------------------------------------------------------- |
| `utils.crypto`    | `md5` / `sha1` / `sha256` / `hmac` / `randomBytes` / `aesEncrypt` / `aesDecrypt` / `rsaEncrypt` |
| `utils.buffer`    | `from` / `bufToString` / `concat`                                                 |
| `utils.base64`    | `encode` / `decode`                                                               |
| `utils.zlib`      | `inflate` / `deflate` / `gunzip` / `gzip`                                          |

## 错误码

处理器抛异常时可通过 `err.code` 携带错误码，未携带时默认 `PLUGIN_HANDLER_ERROR`：

| Code                        | 含义                                          |
| --------------------------- | --------------------------------------------- |
| `PLUGIN_ACTION_UNSUPPORTED` | 插件未注册该动作                              |
| `PLUGIN_SCRIPT_ERROR`       | 脚本语法或运行错误                            |
| `PLUGIN_INVALID_MANIFEST`   | 头部字段缺失或不合法                          |
| `PLUGIN_API_LEVEL_MISMATCH` | 声明的 apiLevel 高于宿主                      |
| `PLUGIN_REQUEST_TIMEOUT`    | 请求超时                                      |
| `PLUGIN_NETWORK_ERROR`      | 网络错误                                      |
| `PLUGIN_URL_NOT_ALLOWED`    | URL 协议不在白名单                            |
| `PLUGIN_INVALID_RESULT`     | 返回结果不合法（`musicUrl` 必须含字符串 url） |
| `PLUGIN_HANDLER_ERROR`      | 处理器默认错误码                              |

## 完整示例

```js
/**
 * @name My Plugin
 * @version 1.0.0
 * @description 多源聚合示例
 * @author you
 * @apiLevel 1
 */

splayer.register({
  sources: {
    sa: { name: "SA 音源", actions: ["musicUrl"], qualities: ["lq", "hq"] },
    sb: { name: "SB 音源", actions: ["musicUrl"], qualities: ["lq", "hq", "lossless"] },
  },
});

const apis = {
  sa: async ({ musicInfo, quality }) => ({ url: "https://...", quality }),
  sb: async ({ musicInfo, quality }) => ({ url: "https://...", quality }),
};

splayer.on("musicUrl", async (req) => {
  const fn = apis[req.source];
  if (!fn) {
    throw Object.assign(new Error("source not supported"), {
      code: "PLUGIN_ACTION_UNSUPPORTED",
    });
  }
  return fn(req);
});
```

## 调试

在应用的 DevTools 控制台可直接调用插件接口验证：

```js
await window.api.plugins.list();
await window.api.plugins.resolveUrl({
  pluginId: "my-plugin-xxxxxxxx",
  source: "sa",
  quality: "hq",
  musicInfo: { songmid: "123" },
});
```

修改脚本后重新导入一次即可（旧版本会被自动替换）。

## 兼容 lx 插件

SPlayer-Next 提供 `lx` 垫片，覆盖 lx-music-desktop user_api 的常用接口（`lx.request` / `lx.on("request")` / `lx.send("inited")` / `lx.utils`），多数现有 lx 脚本无需修改即可运行。头部写 `@platform lx`，或以 `gz_` 压缩分发，会自动启用垫片。

> 编写**新插件**请直接使用 `splayer.*` API；lx 垫片仅用于兼容存量脚本。
