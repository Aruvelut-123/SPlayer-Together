# 插件更新

SPlayer-Next 的插件更新走「**脚本自报 + 用户一键应用**」：插件在运行时自己判断有没有新版，主动告知宿主；宿主据此在插件卡片上提示用户，用户点「更新」后宿主拉取新版脚本**原地覆盖**。

宿主**不会**主动轮询远端、也**不做**版本比较——是否有新版完全由脚本自行决定后上报。

## 工作流程

```
插件运行 → 脚本自检有新版 → 自报(version/log/updateUrl)
        → 宿主在卡片显示「有更新」+ 更新说明
        → 用户点「更新」 → 宿主拉取 updateUrl(raw .js) → 原地覆盖 → 重启
```

- **检测是被动的**：只有插件已启用并运行时，脚本才有机会自报。插件禁用时不会有更新提示。
- **应用是手动的**：宿主只提示，不会自动替换脚本，由用户决定何时更新。

## 自报更新

### splayer 原生：`splayer.notifyUpdate(info)`

在脚本里自检出有新版后调用，**每次运行只取首次**调用：

```js
// 自己拉远端版本号，比当前新就提示
const remote = await splayer.request("https://example.com/my-plugin.meta.json", {
  responseType: "json",
});
if (remote.body?.version && remote.body.version !== "1.0.0") {
  splayer.notifyUpdate({
    version: remote.body.version,
    log: remote.body.changelog,
    updateUrl: "https://example.com/my-plugin.js",
  });
}
```

`info` 字段：

| 字段        | 类型      | 必填 | 说明                                                        |
| ----------- | --------- | ---- | ----------------------------------------------------------- |
| `version`   | `string?` |      | 新版本号，仅用于在卡片上展示                                |
| `log`       | `string?` |      | 更新说明 / changelog，展示在卡片更新提示里                  |
| `updateUrl` | `string?` |      | 新版地址。指向 **raw .js** 才能一键更新；指向页面则回退手动 |

::: tip 是否有新版由你判断
宿主不替你比较版本号。请在脚本里自行获取远端版本并与当前 `@version` 比较，确认更新后再调用 `notifyUpdate`，避免反复误报。
:::

### lx 脚本：`updateAlert`（兼容）

lx 脚本沿用其原生事件即可，宿主会识别为同一套更新提示：

```js
lx.send(lx.EVENT_NAMES.updateAlert, {
  log: "修复了若干问题",
  updateUrl: "https://example.com/lx-source.js",
});
```

lx 的 `updateAlert` 只有 `log`（必填）与 `updateUrl`（选填），没有版本号字段，因此卡片上只显示「有更新」而不带具体版本。lx 脚本的 `updateUrl` 多指向介绍页而非 raw .js，这种情况下一键更新会**回退为打开该地址**，需用户手动下载并重新导入。

## 一键更新

用户在 **设置 → 插件管理** 看到「有更新」提示后点「更新」，宿主会：

1. 拉取脚本自报的 `updateUrl`（要求是可访问的 **raw .js**，仅允许 `https://`）；
2. 解析校验后**原地覆盖**该插件，并**保留**启用状态、用户设置、插件私有存储（`splayer.storage`）与优先级；
3. 重启插件进程，清除更新提示。

::: warning 名称或类型不可变
插件身份由 `slugify(@name) + @platform` 决定。一键更新要求新版的**名称与类型（`@type`）保持不变**——若新版改了名字或从 `source` 变成 `control`，更新会被拒绝，需用户手动重新导入。发布新版时请只改 `@version` 与脚本内容，不要改 `@name`。
:::

若一键更新失败（网络问题、`updateUrl` 不是合法脚本、名称/类型变更等），插件保持旧版可用；卡片上的「查看更新」外链按钮仍可用于手动打开 `updateUrl`。

## 与「重新导入」的关系

因为插件 ID 只取决于 `@name + @platform`、与源码内容无关，所以**手动重新导入同名脚本也会原地替换旧版**，不会再产生重复条目。`notifyUpdate` / `updateAlert` 只是把「有新版」这件事提示给用户，省去用户自己去对版本的麻烦。
