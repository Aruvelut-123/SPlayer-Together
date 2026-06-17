# Linux Wayland 兼容性

在 Wayland 会话下，部分**窗口相关功能**可能受限，个别环境甚至会出现画面闪烁、花屏乃至系统卡死。这是 Electron / Chromium 在 Wayland 下的通用情况，并非应用本身的缺陷。

## 首选方案：切回 XWayland

遇到花屏、闪烁、卡死或悬浮窗异常时，最稳妥的办法是让应用以 **X11（XWayland）** 模式运行——在启动参数中加入 `--ozone-platform=x11`。

开发环境：

```bash
pnpm dev -- --ozone-platform=x11
```

为安装版长期生效，可修改桌面项，避免每次手动加参数：

**KDE Plasma**

1. 右击 SPlayer-Next 的桌面项 → **编辑应用程序…**；
2. 在 **命令行参数** 中，把 `%U` 改为 `--ozone-platform=x11 %U`；
3. 保存退出。

**其他桌面环境**

1. 找到 SPlayer-Next 的 `.desktop` 文件（通常在 `/usr/share/applications/` 下）；
2. 复制到 `~/.local/share/applications/`；
3. 用文本编辑器打开，找到 `Exec=` 开头的行，在可执行文件后追加 `--ozone-platform=x11`，例如：
   ```
   Exec=/opt/SPlayer-Next/splayer-next --ozone-platform=x11 %U
   ```
4. 保存退出。

## 已知的窗口限制

Wayland 出于安全考虑，不允许应用读取 / 设置全局屏幕坐标，并对置顶、穿透、透明无边框窗口有更多约束。这会影响 SPlayer-Next 的以下功能：

| 功能                                     | 在 Wayland 下的表现                               |
| ---------------------------------------- | ------------------------------------------------- |
| 桌面歌词 / 灵动岛（无边框 + 透明悬浮窗） | 可能渲染异常、出现不透明背景，或定位错位          |
| 窗口绝对定位（拖拽、吸附、记忆位置）     | Wayland 不允许应用设置绝对坐标，可能失效或错位    |
| 窗口置顶（always-on-top）                | 支持有限，悬浮窗可能无法保持置顶                  |
| 鼠标穿透（click-through）                | 可能不生效                                        |
| 悬停判定（全局光标位置）                 | Wayland 限制读取全局光标，悬停隐藏 / 交互可能不准 |
| 全局快捷键                               | Wayland 下通常无法注册全局快捷键                  |

> 具体表现因发行版与合成器（GNOME Mutter、KDE KWin、wlroots 等）而异。

## 桌面歌词的 KWin 窗口规则

桌面歌词窗口使用固定的窗口标题 **`SPlayer-Next - Desktop Lyric`**。在 KDE（KWin）下可通过**窗口规则**按标题匹配，手动补齐 Wayland 下缺失的行为（如保持置顶等）：

1. 打开 **系统设置 → 窗口管理 → 窗口规则**，新建一条规则；
2. 在 **窗口匹配** 中，将 **窗口标题** 设为 `SPlayer-Next - Desktop Lyric`（精确或包含匹配）；
3. 添加需要的属性，例如：
   - **保持在其他窗口之上**：设为「强制 / 是」；
   - 可选 **无标题栏与边框**、固定 **位置** 与 **大小**；
4. 应用并保存。

## 第三方 / 外部 API 替代

如果在 Wayland 下内置悬浮窗体验不佳，可改用桌面环境原生的**面板 / 挂件类**第三方歌词组件：它们通过 SPlayer-Next 的 [外部 API（HTTP）](/api) 或 [WebSocket API](/socket) 获取当前播放与歌词，再由桌面环境自身负责显示，从而绕开 Electron 悬浮窗在 Wayland 下的限制。

## 报障信息

如遇问题，请在 Issue 中附上：发行版、桌面环境与合成器、是否启用了原生 Wayland，以及具体的窗口异常现象。
