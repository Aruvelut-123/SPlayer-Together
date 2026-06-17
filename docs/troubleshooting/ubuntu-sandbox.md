# Ubuntu 沙箱启动失败

在 Ubuntu 及其他 Linux 发行版上，Electron 应用可能因 Chromium 沙箱限制而无法启动。

## 问题现象

```
The SUID sandbox helper binary was found, but is not configured correctly.
```

或

```
Running as root without --no-sandbox is not supported.
```

## 原因

Chromium 使用沙箱增强安全性，在部分配置下可能无法工作：未启用用户命名空间、`chrome-sandbox` 权限不正确，或在容器 / WSL 环境中运行。

## 解决方案

### 方案一：启用用户命名空间（推荐）

```bash
# 临时启用
echo 1 | sudo tee /proc/sys/kernel/unprivileged_userns_clone

# 永久启用（重启后生效）
echo 'kernel.unprivileged_userns_clone=1' | sudo tee /etc/sysctl.d/00-local-userns.conf
sudo sysctl --system
```

### 方案二：修正 chrome-sandbox 权限

```bash
# 找到 chrome-sandbox（deb / rpm 安装通常在 /opt 下）
find /opt /usr -name "chrome-sandbox" 2>/dev/null

sudo chown root:root /path/to/chrome-sandbox
sudo chmod 4755 /path/to/chrome-sandbox
```

### 方案三：禁用沙箱（不推荐）

::: danger 安全警告
禁用沙箱会降低安全性，仅在其他方法无效时使用。
:::

```bash
# 运行 AppImage 时追加参数
./SPlayer-Next-*.AppImage --no-sandbox
```

## 缺少系统库

部分发行版需要补齐依赖库，例如 Ubuntu / Debian：

```bash
sudo apt update
sudo apt install libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2
```

Fedora 使用 `dnf`、Arch 使用 `pacman` 安装对应的 nss / alsa / libXScrnSaver 等依赖。

## WSL 环境

在 WSL 中运行需使用 WSL2 + WSLg（Windows 11 或 Windows 10 21H2+），且沙箱通常需禁用：

```bash
./SPlayer-Next-*.AppImage --no-sandbox
```

## 仍有问题？

请提交 Issue 并附上：发行版与版本、完整错误信息、`uname -a` 与 `cat /proc/sys/kernel/unprivileged_userns_clone` 的输出。
