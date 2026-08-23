/**
 * 更新检查：使用 electron-updater + GitHub Releases 发布跟踪
 * 更新包由 GitHub Actions 构建上传到 Releases，electron-updater 自动下载安装
 */

import { shell } from "electron";
import { sendToMain } from "@main/utils/broadcast";
import { store } from "@main/store";
import { isDev, isMac, isPortable, isAppX } from "@main/utils/config";
import { updaterLog } from "@main/utils/logger";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import type { UpdateEvent } from "@shared/types/update";
import type { UpdateChannel } from "@shared/types/settings";

/** 是否支持内置下载安装 */
const canSelfInstall = !isMac && !isPortable && !isAppX;

/** 定时检查间隔（6 小时） */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let intervalTimer: ReturnType<typeof setInterval> | null = null;

const emit = (event: UpdateEvent): void => sendToMain("update:event", event);

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

autoUpdater.on("checking-for-update", () => {
  updaterLog.info("正在检查更新……");
  emit({ type: "checking" });
});

autoUpdater.on("update-available", (info: UpdateInfo) => {
  const version = info.version;
  const releaseNotes = typeof info.releaseNotes === "string" ? info.releaseNotes : "";
  updaterLog.info(`发现新版本：${version}`);
  emit({
    type: "available",
    meta: {
      version,
      releaseNotes,
      releaseDate: info.releaseDate ?? "",
      size: info.files?.[0]?.size ?? 0,
    },
    manual: false,
    canInstall: canSelfInstall,
  });
});

autoUpdater.on("update-not-available", () => {
  updaterLog.info("当前已是最新版本");
  emit({ type: "notAvailable", manual: false });
});

autoUpdater.on("error", (err: Error) => {
  updaterLog.error("更新检查失败", err);
  emit({ type: "error", message: err.message, manual: false });
});

autoUpdater.on("download-progress", (progress) => {
  emit({ type: "progress", percent: Math.round(progress.percent) });
});

autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
  updaterLog.info(`更新包已下载：${info.version}`);
  emit({
    type: "downloaded",
    meta: {
      version: info.version,
      releaseNotes: "",
      releaseDate: info.releaseDate ?? "",
      size: info.files?.[0]?.size ?? 0,
    },
  });
});

/** 检查更新（自动/手动） */
export const checkForUpdates = (manual: boolean): void => {
  if (!manual && !store.get("update.autoCheck")) return;
  if (isDev) {
    updaterLog.info("开发模式跳过更新检查");
    emit({ type: "notAvailable", manual });
    return;
  }
  // 设置更新通道
  const channel = store.get("update.channel") as UpdateChannel;
  if (channel === "stable") autoUpdater.channel = "latest";
  else autoUpdater.channel = channel;
  void autoUpdater.checkForUpdates();
};

/** 下载更新 */
export const downloadUpdate = (): void => {
  if (!canSelfInstall) return;
  void autoUpdater.downloadUpdate();
};

/** 退出并安装 */
export const quitAndInstall = (): void => {
  autoUpdater.quitAndInstall();
};

/** 打开 Releases 下载页 */
export const openDownloadPage = (): void => {
  void shell.openExternal("https://github.com/Aruvelut-123/SPlayer-Together/releases");
};

/** 从 GitHub API 获取 release notes 作为更新日志 */
export const fetchChangelog = async (version: string): Promise<{ version: string; changelog: string } | null> => {
  try {
    const res = await fetch(
      `https://api.github.com/repos/Aruvelut-123/SPlayer-Together/releases/tags/v${version}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { body: string };
    return { version, changelog: data.body ?? "" };
  } catch {
    return null;
  }
};

/** 更新通道变更后立即重新检查 */
export const applyChannelChange = (previous: UpdateChannel, channel: UpdateChannel): void => {
  if (previous === channel) return;
  checkForUpdates(true);
};

/** 初始化更新器 */
export const initUpdater = (): void => {
  if (isDev) {
    updaterLog.info("开发模式，仅支持手动检查更新");
    return;
  }
  intervalTimer = setInterval(() => checkForUpdates(false), CHECK_INTERVAL_MS);
};

/** 清理定时器 */
export const disposeUpdater = (): void => {
  if (intervalTimer) clearInterval(intervalTimer);
  intervalTimer = null;
};