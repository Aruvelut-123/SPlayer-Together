import { app, shell } from "electron";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { sendToMain } from "@main/utils/broadcast";
import { store } from "@main/store";
import { isDev, isMac, isPortable, isAppX } from "@main/utils/config";
import { updaterLog } from "@main/utils/logger";
import type { UpdateEvent } from "@shared/types/update";
import type { UpdateChannel } from "@shared/types/settings";

/**
 * 更新检查：与授权 / 中继服务器合并，从 ``GET /api/update`` 获取最新版本信息，
 * 新版本由主进程直接下载安装包（不依赖 GitHub 与 electron-updater）。
 */

/** 更新服务器（与授权 / 中继服务器共用） */
const UPDATE_SERVER = "http://47.122.127.107:8000";
const UPDATE_API = `${UPDATE_SERVER}/api/update`;

/** 是否支持内置下载安装（AppX 由商店管理，Mac/Portable 无自动安装能力） */
const canSelfInstall = !isMac && !isPortable && !isAppX;

/** 定时检查间隔（6 小时） */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 检查请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 10_000;
/** 下载超时（毫秒） */
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/** 服务器返回的更新清单 */
interface UpdateManifest {
  version: string;
  url: string;
  notes: string;
  size: number;
}

/** 进行中的检查 Promise */
let currentCheck: Promise<void> | null = null;
/** 最近一次检测到的可用版本 */
let availableVersion: string | null = null;
/** 可用版本的下载地址 */
let availableUrl: string | null = null;
/** 已下载的安装包路径 */
let installedFile: string | null = null;

let intervalTimer: ReturnType<typeof setInterval> | null = null;

const emit = (event: UpdateEvent): void => sendToMain("update:event", event);

/** 版本号比较：返回 >0 表示 a 比 b 新 */
const compareVersions = (a: string, b: string): number => {
  const pa = a.split(/[.-]/).map((n) => Number(n) || 0);
  const pb = b.split(/[.-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const runCheck = async (manual: boolean): Promise<void> => {
  if (!manual && !store.get("update.autoCheck")) return;
  emit({ type: "checking" });
  try {
    const res = await fetch(UPDATE_API, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const manifest = (await res.json()) as UpdateManifest;
    const current = app.getVersion();
    updaterLog.info(`更新检查：服务器 ${manifest.version} vs 本地 ${current}`);
    if (manifest.version && compareVersions(manifest.version, current) > 0) {
      availableVersion = manifest.version;
      availableUrl = manifest.url;
      emit({
        type: "available",
        meta: {
          version: manifest.version,
          releaseNotes: manifest.notes ?? "",
          releaseDate: "",
          size: manifest.size ?? 0,
        },
        manual,
        canInstall: canSelfInstall,
      });
    } else {
      availableVersion = null;
      availableUrl = null;
      emit({ type: "notAvailable", manual });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updaterLog.error("更新检查失败", error);
    emit({ type: "error", message, manual });
  }
};

/** 获取服务器提供的多版本更新日志（Markdown，按版本分组），失败返回 null */
export const fetchChangelog = async (): Promise<{ version: string; changelog: string } | null> => {
  try {
    const res = await fetch(UPDATE_API, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const manifest = (await res.json()) as UpdateManifest;
    return { version: manifest.version, changelog: manifest.notes ?? "" };
  } catch (error) {
    updaterLog.error("获取更新日志失败", error);
    return null;
  }
};

/**
 * 检查更新：自动检查受设置开关约束，手动检查始终执行
 * @param manual - 是否由用户手动触发
 */
export const checkForUpdates = (manual: boolean): void => {
  if (currentCheck) return;
  currentCheck = runCheck(manual).finally(() => {
    currentCheck = null;
  });
};

/** 下载更新安装包（流式写入并回报进度） */
export const downloadUpdate = (): void => {
  if (!canSelfInstall || !availableUrl || !availableVersion) return;
  const version = availableVersion;
  const url = availableUrl;
  void (async () => {
    try {
      const target = join(app.getPath("temp"), `splayer-together-${version}-setup.exe`);
      const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length") ?? 0);
      const reader = res.body.getReader();
      const writer = createWriteStream(target);
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        writer.write(Buffer.from(value));
        if (total > 0) emit({ type: "progress", percent: Math.round((received / total) * 100) });
      }
      await new Promise<void>((resolve, reject) => {
        writer.end(resolve);
        writer.on("error", reject);
      });
      installedFile = target;
      updaterLog.info(`更新包已下载：${target}（${received} 字节）`);
      emit({
        type: "downloaded",
        meta: { version, releaseNotes: "", releaseDate: "", size: received },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updaterLog.error("下载更新失败", error);
      emit({ type: "error", message, manual: true });
    }
  })();
};

/** 退出并运行已下载的安装器 */
export const quitAndInstall = (): void => {
  if (!installedFile) return;
  void shell.openPath(installedFile);
  app.quit();
};

/** 打开下载页（服务器下载目录） */
export const openDownloadPage = (): void => {
  void shell.openExternal(availableUrl || `${UPDATE_SERVER}/downloads/`);
};

/** 更新通道变更后立即重新检查 */
export const applyChannelChange = (previous: UpdateChannel, channel: UpdateChannel): void => {
  if (previous === channel) return;
  void runCheck(true);
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
