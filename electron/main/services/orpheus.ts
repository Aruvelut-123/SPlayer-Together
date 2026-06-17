import { app } from "electron";
import { store } from "@main/store";
import { getMainWindow } from "@main/window";
import { coreLog } from "@main/utils/logger";

/** orpheus 协议 scheme 名 */
const ORPHEUS_SCHEME = "orpheus";

/** 冷启动捕获到、但渲染层尚未就绪时暂存的唤起 URL */
let pendingOrpheusUrl: string | null = null;
/** 渲染层是否已就绪（首次拉取 pending 即视为就绪，之后改走实时下发） */
let rendererReady = false;

/**
 * 注册 / 取消注册 orpheus 协议处理程序
 * @param on - true 注册抢占，false 取消
 */
export const setOrpheusProtocolRegistered = (on: boolean): void => {
  if (on) {
    app.setAsDefaultProtocolClient(ORPHEUS_SCHEME);
    coreLog.info("[orpheus] 已注册 orpheus 协议处理程序");
  } else {
    app.removeAsDefaultProtocolClient(ORPHEUS_SCHEME);
    coreLog.info("[orpheus] 已取消 orpheus 协议处理程序");
  }
};

/**
 * 从命令行参数中提取首个 orpheus:// URL
 * @param argv - 命令行参数（含 argv[0] 程序名，从下标 1 起扫）
 * @returns 唤起 URL，未找到返回 null
 */
export const extractOrpheusUrl = (argv: readonly string[]): string | null => {
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith(`${ORPHEUS_SCHEME}://`)) return arg;
  }
  return null;
};

/**
 * 捕获一个唤起 URL：渲染层就绪则实时下发，否则暂存待拉取
 * @param url - orpheus:// URL
 */
export const captureOrpheusUrl = (url: string): void => {
  const win = getMainWindow();
  if (rendererReady && win) {
    win.webContents.send("protocol:orpheus", url);
  } else {
    pendingOrpheusUrl = url;
  }
  coreLog.info("[orpheus] 捕获唤起 URL", url);
};

/**
 * 渲染层拉取冷启动暂存的唤起 URL，并标记渲染层已就绪
 * @returns 暂存的 URL（取走即清空），无则 null
 */
export const consumePendingOrpheusUrl = (): string | null => {
  rendererReady = true;
  const url = pendingOrpheusUrl;
  pendingOrpheusUrl = null;
  return url;
};

/** 按当前配置决定启动时是否注册协议 */
export const initOrpheusRegistration = (): void => {
  if (store.get("system.registerOrpheusProtocol")) {
    setOrpheusProtocolRegistered(true);
  }
};
