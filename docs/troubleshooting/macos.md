# macOS 常见问题

本文汇总 macOS 上使用 SPlayer-Next 时可能遇到的常见问题及解决方案。

## 应用签名问题

### 无法打开应用

**症状**：双击应用后提示“无法打开，因为无法验证开发者”。

**解决方案**：

1. 打开 **系统设置** → **隐私与安全性**，找到被拦截的应用并点击 **仍要打开**；
2. 或在终端执行：

   ```bash
   sudo xattr -rd com.apple.quarantine /Applications/SPlayer-Next.app
   ```

若提示“应用已损坏”，请参考 [Mac 应用显示已损坏](/troubleshooting/macos-damaged)。

### Gatekeeper 持续阻止

```bash
# 强制移除所有属性
sudo xattr -cr /Applications/SPlayer-Next.app
```

## 系统集成

### 控制中心“正在播放”

SPlayer-Next 在 macOS 上**支持系统级媒体集成**：通过 `media-ctrl` 原生模块对接 macOS Now Playing，可在控制中心、锁屏界面查看并控制当前播放。

若未正常显示，可尝试重启应用；并确认未被其他播放器（如音乐 App、Spotify）抢占媒体会话。

### 媒体控制键无响应

**可能原因**：其他应用占用了媒体键，或系统将媒体键分配给了其他功能。

**解决方案**：

1. 关闭其他可能占用媒体键的应用；
2. 检查 **系统设置** → **键盘** → **键盘快捷键** 中的媒体键设置。

## 更新问题

### 自动更新失败

1. 手动从 [GitHub Releases](https://github.com/SPlayer-Dev/SPlayer-Next/releases) 下载最新版本；
2. 删除旧版本后重新安装；
3. 检查网络连接是否正常。
