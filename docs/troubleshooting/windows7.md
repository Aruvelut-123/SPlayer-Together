# Windows 7 兼容性问题

SPlayer-Next 基于 Electron 构建，对 Windows 7 的支持存在限制。

::: warning 重要提示
自 Electron 23 起，官方不再支持 Windows 7 / 8 / 8.1。SPlayer-Next 使用的 Electron 版本已不兼容这些系统。**推荐 Windows 10 1903 及以上**。
:::

## 常见问题

### 应用无法启动

- 安装所有可用的 Windows 更新；
- 安装 [Visual C++ Redistributable 2015-2022](https://aka.ms/vs/17/release/vc_redist.x64.exe)。

### 提示缺少 API 函数

> The procedure entry point xxx could not be located

Windows 7 缺少部分现代 API。请确保已安装 SP1，并安装 KB2533623、KB3063858 等更新。

### 媒体控制不可用

Windows 7 不支持 SMTC（System Media Transport Controls），这是 Windows 10 引入的能力，因此系统级媒体控制在 Windows 7 上不可用。

### 网络 / TLS 问题

Windows 7 默认不启用 TLS 1.2，可能导致部分网络请求失败。请安装 KB3140245 更新并启用 TLS 1.2。

## 升级建议

Windows 7 已于 2020 年 1 月结束支持，不再收到安全更新。强烈建议升级到 Windows 10 / 11，以获得安全性、兼容性与 SMTC 等现代能力。

如确需在旧系统使用，可在 [GitHub Releases](https://github.com/SPlayer-Dev/SPlayer-Next/releases) 查找较早的版本，但旧版本可能存在已知安全问题。
