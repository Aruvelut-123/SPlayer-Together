# 控制插件

控制插件（`@type control`）不提供音源，而是**监听播放器状态**（曲目 / 歌词 / 播放态）、**反向控制播放**（播放、暂停、切歌、跳转、音量），并可**声明自己的设置项**让用户在插件管理里配置。典型用途如：将播放状态同步到 Discord、智能家居/灯效联动、第三方上报等。

阅读本文前请先了解 [插件总览与架构](/plugins/)，其中的通用 API 对控制插件同样适用。

::: warning 需要 apiLevel 2
控制类能力是 SPlayer-Next 原生特性，无 lx 对应物。脚本头部必须声明 `@type control` 与 `@apiLevel 2`，否则控制能力在运行时受限。
:::

## 快速开始

```js
/**
 * @name        Example Control
 * @version     1.0.0
 * @description 示例控制插件
 * @author      you
 * @type        control
 * @apiLevel    2
 */

splayer.register({
  // 订阅需要的播放事件
  events: ["trackChange", "playStateChange", "lineChange"],
  // 声明会反向控制播放器
  controls: true,
  // 声明用户可配置项
  settings: [{ key: "enabled", type: "switch", label: "启用同步", default: true }],
});

splayer.player.on("trackChange", ({ track }) => {
  if (!track) return;
  splayer.log.info("正在播放：", track.title, "-", track.artists);
});

splayer.player.on("playStateChange", ({ state, position }) => {
  splayer.log.info("播放态：", state, "@", position, "ms");
});
```

保存为 `.js`，在 **设置 → 插件管理 → 本地导入** 即可使用。

## `splayer.register(args)`

控制插件用 `register` 声明三样东西，请在脚本同步执行阶段调用：

```js
splayer.register({
  events: ["trackChange", "lyricChange", "lineChange", "playStateChange"],
  controls: true,
  settings: [
    /* PluginSettingItem[] */
  ],
});
```

| 字段       | 类型                  | 必填 | 说明                                               |
| ---------- | --------------------- | ---- | -------------------------------------------------- |
| `events`   | `PlaybackEventKind[]` |      | 要订阅的播放事件，未声明的事件不会下发             |
| `controls` | `boolean`             |      | 是否使用反向播放控制（`splayer.player.play()` 等） |
| `settings` | `PluginSettingItem[]` |      | 用户可配置项，渲染到插件管理的设置弹窗             |

::: tip 只发订阅的事件
宿主只会向插件下发它在 `events` 里声明过的事件，这是有意的——避免无谓的跨进程开销。插件启用时，宿主会立即补发一次当前状态快照（当前曲目、歌词、播放态、当前行），无需自己拉取初始值。
:::

## 监听播放事件

```js
splayer.player.on(kind, (data) => { ... });
```

支持的事件类型与载荷：

### `trackChange` — 曲目切换

| 字段             | 类型             | 说明                     |
| ---------------- | ---------------- | ------------------------ |
| `track`          | `object \| null` | 当前曲目，`null` 表示无  |
| `track.title`    | `string`         | 标题                     |
| `track.artists`  | `string`         | 艺术家（已用 `, ` 拼接） |
| `track.album`    | `string?`        | 专辑名                   |
| `track.duration` | `number`         | 时长（毫秒）             |
| `track.cover`    | `string?`        | 封面地址                 |

### `lyricChange` — 歌词整体变化

| 字段    | 类型          | 说明                   |
| ------- | ------------- | ---------------------- |
| `lines` | `LyricLine[]` | 当前曲目的完整解析歌词 |

每个 `LyricLine` 的常用字段：

| 字段              | 类型          | 说明                                     |
| ----------------- | ------------- | ---------------------------------------- |
| `words`           | `LyricWord[]` | 该行的逐字内容，`words[i].word` 为字符串 |
| `translatedLyric` | `string`      | 该行翻译（无则空串）                     |
| `startTime`       | `number`      | 行起始时间（毫秒）                       |
| `endTime`         | `number`      | 行结束时间（毫秒）                       |

拼接整行文本：`line.words.map((w) => w.word).join("")`。

### `lineChange` — 当前歌词行变化

仅当**当前行索引**改变时下发，配合 `lyricChange` 缓存的 `lines` 使用。

| 字段       | 类型     | 说明                        |
| ---------- | -------- | --------------------------- |
| `index`    | `number` | 当前行索引，`-1` 表示无匹配 |
| `position` | `number` | 该帧播放进度（毫秒）        |

```js
let lines = [];
splayer.player.on("lyricChange", (data) => (lines = data.lines));
splayer.player.on("lineChange", ({ index }) => {
  const text = index >= 0 ? lines[index].words.map((w) => w.word).join("") : "";
  splayer.log.info("当前歌词：", text);
});
```

### `playStateChange` — 播放态变化

| 字段       | 类型                                 | 说明                 |
| ---------- | ------------------------------------ | -------------------- |
| `state`    | `"playing" \| "paused" \| "stopped"` | 播放态               |
| `position` | `number`                             | 该帧播放进度（毫秒） |

`stopped` 与 `paused` 区分开：停止（如播放结束）为 `stopped`，暂停为 `paused`。

## 反向控制播放

在 `register` 中声明 `controls: true` 后，可调用 `splayer.player` 控制播放器：

| 方法                       | 说明                                    |
| -------------------------- | --------------------------------------- |
| `player.play()`            | 播放                                    |
| `player.pause()`           | 暂停                                    |
| `player.next()`            | 下一首                                  |
| `player.prev()`            | 上一首                                  |
| `player.seek(positionMs)`  | 跳转到指定毫秒位置                      |
| `player.setVolume(volume)` | 设置音量，`volume ∈ [0, 1]`             |
| `player.getPosition()`     | `Promise<number>`，查询当前进度（毫秒） |

以上控制方法（除 `getPosition`）均为「即发即忘」，不返回结果；非法入参（如负的 `seek`、越界音量）会被宿主忽略。

::: tip getPosition 的正确用法
`getPosition()` 走一次跨进程往返，**仅用于偶发的一次性查询**。需要持续跟踪进度时，请直接读 `lineChange` / `playStateChange` 载荷里已经带上的 `position`，不要高频轮询 `getPosition`。
:::

## 设置项

控制插件可声明设置项，渲染到插件管理的设置弹窗，让用户配置。

### 声明

```js
splayer.register({
  settings: [
    { key: "token", type: "text", label: "访问令牌", placeholder: "粘贴 token" },
    { key: "interval", type: "number", label: "上报间隔(秒)", default: 30, min: 5, max: 600 },
    { key: "enabled", type: "switch", label: "启用上报", default: true },
    {
      key: "mode",
      type: "select",
      label: "模式",
      default: "auto",
      options: [
        { label: "自动", value: "auto" },
        { label: "手动", value: "manual" },
      ],
    },
  ],
});
```

`PluginSettingItem`：

| 字段          | 类型                                         | 适用类型 | 说明               |
| ------------- | -------------------------------------------- | -------- | ------------------ |
| `key`         | `string`                                     | 全部     | 设置键名           |
| `type`        | `"switch" \| "number" \| "text" \| "select"` | 全部     | 控件类型           |
| `label`       | `string`                                     | 全部     | 展示名（纯字符串） |
| `description` | `string?`                                    | 全部     | 副标题说明         |
| `default`     | `boolean \| number \| string`                | 全部     | 默认值             |
| `min` / `max` | `number?`                                    | number   | 数值范围           |
| `placeholder` | `string?`                                    | text     | 占位提示           |
| `options`     | `{ label, value }[]`                         | select   | 可选项             |

### 读取与监听

```js
// 同步读取当前值（用户改动后亦会同步更新缓存）
const token = splayer.getSetting("token");

// 监听某项变化，用户在 UI 改动后实时触发
splayer.onSettingChange("enabled", (value) => {
  splayer.log.info("启用状态变为：", value);
});
```

宿主会按声明的 `type` 对写入值做校验/强转（如 `switch` 转布尔、`number` 按 `min`/`max` 夹取、`select` 校验合法选项），插件读到的始终是规范化后的值。

## 完整示例

把当前播放状态打印出来的最小「状态同步」骨架：

```js
/**
 * @name        Now Playing Logger
 * @version     1.0.0
 * @description 示例：跟踪并打印播放状态
 * @author      you
 * @type        control
 * @apiLevel    2
 */

let lines = [];
let enabled = true;

splayer.register({
  events: ["trackChange", "lyricChange", "lineChange", "playStateChange"],
  controls: false,
  settings: [{ key: "enabled", type: "switch", label: "启用日志", default: true }],
});

enabled = splayer.getSetting("enabled") ?? true;
splayer.onSettingChange("enabled", (v) => (enabled = Boolean(v)));

splayer.player.on("trackChange", ({ track }) => {
  if (!enabled) return;
  splayer.log.info("曲目：", track ? `${track.title} - ${track.artists}` : "(无)");
});

splayer.player.on("lyricChange", ({ lines: next }) => (lines = next));

splayer.player.on("lineChange", ({ index }) => {
  if (!enabled || index < 0) return;
  splayer.log.info("歌词：", lines[index].words.map((w) => w.word).join(""));
});

splayer.player.on("playStateChange", ({ state, position }) => {
  if (!enabled) return;
  splayer.log.info(`状态：${state} @ ${position}ms`);
});
```

## 调试

在应用的 DevTools 控制台改设置、观察插件日志：

```js
// 实时下发一次设置变更（触发 onSettingChange）
await window.api.plugins.setSetting("now-playing-logger-xxxxxxxx", "enabled", false);

// 查看插件状态（含已订阅事件 / 是否声明控制 / 设置项）
await window.api.plugins.list();
```

插件日志汇入应用主日志（`{userData}/app-data/logs/`）。更多调试方式见 [总览 · 调试](/plugins/#调试)。
