# 音源插件

音源插件（`@type source`）为歌曲提供可播放的 URL。当播放器需要播放一首歌时，会按优先级调用一个已就绪的音源插件，由插件返回真实播放地址。

阅读本文前请先了解 [插件总览与架构](/plugins/)，其中的通用 API（`splayer.request` / `storage` / `log` / `utils` 等）对音源插件同样适用，这里不再重复。

## 快速开始

一个最小音源插件就是一个 `.js` 文件：

```js
/**
 * @name        Example
 * @version     1.0.0
 * @description 示例音源
 * @author      you
 * @type        source
 * @apiLevel    2
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

::: tip
`@type source` 可省略（缺省即为 `source`）。音源插件不依赖控制类能力，`@apiLevel` 写 `1` 或 `2` 均可。
:::

## `splayer.register(capabilities)`

声明插件提供的音源与能力。请在脚本同步执行阶段调用——注册后 UI 才能展示插件支持的音源。

```js
splayer.register({
  sources: {
    // key 是音源标识，play 时由播放器传回 req.source
    demo: {
      name: "Demo 源",
      actions: ["musicUrl"],
      qualities: ["lq", "hq", "lossless", "hi-res"],
    },
  },
});
```

`sources` 是一个 `Record<string, Source>`，每个 `Source`：

| 字段        | 类型             | 必填 | 说明                            |
| ----------- | ---------------- | ---- | ------------------------------- |
| `name`      | `string`         | ✅   | 音源展示名                      |
| `actions`   | `("musicUrl")[]` | ✅   | 支持的动作（当前仅 `musicUrl`） |
| `qualities` | `Quality[]`      |      | 支持的音质                      |

`Quality` 取值：

| 值         | 含义                                          |
| ---------- | --------------------------------------------- |
| `hi-res`   | 高解析度无损（采样率 ≥ 96kHz + 位深 ≥ 24bit） |
| `lossless` | 无损（flac / ape / wav 等）                   |
| `hq`       | 有损 ≥ 320kbps                                |
| `sq`       | 有损 ≥ 192kbps                                |
| `lq`       | 有损 < 192kbps                                |

一个插件可声明多个音源，同一份脚本聚合多家接口。

## `splayer.on("musicUrl", handler)`

注册 `musicUrl` 动作的处理器。每个动作最多一个处理器，重复注册时后者覆盖前者。处理器异步返回播放地址。

**请求 `req`**

| 字段                | 类型      | 说明                                 |
| ------------------- | --------- | ------------------------------------ |
| `source`            | `string`  | 音源 key（对应 `register` 中的键名） |
| `quality`           | `Quality` | 请求的音质                           |
| `musicInfo.songmid` | `string`  | 歌曲 ID                              |
| `musicInfo.name`    | `string?` | 歌曲名                               |
| `musicInfo.singer`  | `string?` | 艺术家                               |

**返回 `res`**

| 字段      | 类型      | 必填 | 说明             |
| --------- | --------- | ---- | ---------------- |
| `url`     | `string`  | ✅   | 播放地址         |
| `quality` | `Quality` |      | 实际返回的音质   |
| `expire`  | `number`  |      | 过期时间戳（ms） |

::: warning
返回值必须是包含字符串 `url` 的对象，否则宿主判为 `PLUGIN_INVALID_RESULT`。处理器抛出的异常会被宿主捕获并透传错误码；超时（默认 20 秒）未返回会被取消并报 `PLUGIN_CANCELLED`。
:::

## 多源聚合

当一个插件声明多个音源时，用 `req.source` 分发到对应实现：

```js
/**
 * @name     Multi Source
 * @version  1.0.0
 * @type     source
 * @apiLevel 2
 */

splayer.register({
  sources: {
    sa: { name: "SA 音源", actions: ["musicUrl"], qualities: ["lq", "hq"] },
    sb: { name: "SB 音源", actions: ["musicUrl"], qualities: ["lq", "hq", "lossless"] },
  },
});

const apis = {
  sa: async ({ musicInfo, quality }) => ({ url: await fetchSa(musicInfo, quality), quality }),
  sb: async ({ musicInfo, quality }) => ({ url: await fetchSb(musicInfo, quality), quality }),
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

## 优先级与互斥

- 当多个已启用插件支持同一音源动作时，由播放器按用户设置的**优先级**自动选用第一个就绪的插件。
- 音源插件之间**互斥**：安装一个新音源插件时，已启用的其他音源插件会被自动停用（新装者优先）。用户仍可在插件管理中手动启停。

## 调试

在应用的 DevTools 控制台直接触发解析：

```js
await window.api.plugins.resolveUrl({
  pluginId: "example-xxxxxxxx",
  source: "demo",
  quality: "hq",
  musicInfo: { songmid: "123", name: "歌名", singer: "歌手" },
});
```

更多调试方式与错误码见 [总览 · 调试](/plugins/#调试) 与 [错误码](/plugins/#错误码)。
