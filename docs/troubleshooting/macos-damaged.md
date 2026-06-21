# macOS 应用显示已损坏

在 macOS 上打开 SPlayer-Next 时，可能会遇到“应用已损坏，无法打开”的提示。这通常是 macOS 的安全机制导致的，而非应用本身损坏。

## 问题现象

打开应用时出现以下提示：

> “SPlayer-Next” 已损坏，无法打开。您应该将它移到废纸篓。

或

> 无法打开 “SPlayer-Next”，因为 Apple 无法检查其是否包含恶意软件。

## 原因分析

这是 macOS Gatekeeper 安全机制的正常行为。从非 Mac App Store 下载、未经 Apple 签名认证的应用会被系统阻止运行。SPlayer-Next 目前未进行 Apple 开发者签名，因此会触发此保护机制。

## 解决方案

### 方法一：安全移除隔离属性（推荐）

打开 **终端**，执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/SPlayer-Next.app
```

输入管理员密码后，重新打开应用即可。

### 方法二：强制移除所有属性（不推荐）

打开 **终端**，执行：

```bash
sudo xattr -cr /Applications/SPlayer-Next.app
```

### 方法三：右键打开

1. 在 Finder 中找到 `SPlayer-Next.app`；
2. 按住 `Control` 键点击应用图标；
3. 在弹出菜单中选择 **打开**；
4. 在确认对话框中再次点击 **打开**。

此方法可能需要重复 2-3 次。

## M 系列芯片注意事项

如果使用 M1/M2/M3 芯片的 Mac，请尽量下载 **ARM（arm64）** 版本的安装包。若下载了 x64 版本，可能需要 Rosetta 2 转译：

```bash
softwareupdate --install-rosetta --agree-to-license
```

## 仍然无法解决？

1. 完全删除应用及其数据：

   ```bash
   rm -rf /Applications/SPlayer-Next.app
   rm -rf ~/Library/Application\ Support/SPlayer-Next
   ```

2. 重新从 [GitHub Releases](https://github.com/SPlayer-Dev/SPlayer-Next/releases) 下载最新版本；
3. 使用方法一移除隔离属性后再打开。
