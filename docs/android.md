# Android 支持

SPlayer Together 提供基于 Capacitor 的 Android 构建工程，Android 原生层参考 `SPlayer-for-Android` 的 Media3 播放服务、缓存、下载、本地歌词和分享插件实现。

## 构建环境

- JDK 17 或 21
- Android SDK Platform 36、Build Tools 36.0.0、Platform Tools
- Node.js 22+、pnpm 10+

在 Windows 上设置 SDK 路径后执行：

```powershell
$env:ANDROID_HOME = "D:\\Android\\Sdk"
$env:JAVA_HOME = "D:\\Program Files\\Microsoft\\jdk-21.0.12.8-hotspot"
pnpm install
pnpm build:android
```

APK 位于 `android/app/build/outputs/apk/debug/`，会按 ABI 生成 arm64-v8a、armeabi-v7a、x86 和 x86_64 变体。

## 当前 Android 原生能力

Android 工程包含 Media3 后台播放、MediaSession 通知控制、播放队列、缓存、下载、歌词文件访问、分享和悬浮歌词服务。桌面端继续使用 Electron、Rust audio-engine 和 SQLite，不共用 Android 原生实现。

当前 Web UI 仍在逐步接入 Android 平台适配层；Android 真机验证必须在实体设备上完成。本项目不使用模拟器作为功能验收依据。

## 真机验证清单

安装 debug APK 后，请验证：启动、平台登录、在线播放、锁屏控制、后台播放、一起听、流媒体、下载、本地歌词、统计和悬浮歌词权限。若某项失败，请附设备型号、Android 版本和日志反馈。

## 许可与来源

Android 原生桥接参考 AGPL-3.0 项目 [SPlayer for Android](https://github.com/SPlayer-Dev/SPlayer-for-Android)，相关上游版权和许可证声明保留。SPlayer Together 是独立维护的非官方分支，详见仓库根目录 `NOTICE.md`。
