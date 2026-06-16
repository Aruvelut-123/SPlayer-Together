/** 是否为开发环境 */
export const isDev = import.meta.env.MODE === "development" || import.meta.env.DEV;

/** 系统判断 */
export const userAgent = window.navigator.userAgent;

/** 是否为 Windows 系统 */
export const isWin = userAgent.includes("Windows");
/** 是否为 macOS 系统 */
export const isMac = userAgent.includes("Macintosh");
/** 是否为 Linux 系统 */
export const isLinux = userAgent.includes("Linux");
/** 是否为 Electron 环境 */
export const isElectron = userAgent.includes("Electron") || typeof window?.electron !== "undefined";

/** 应用版本号 */
export const APP_VERSION = __APP_VERSION__;
/** 仓库地址 */
export const REPO_URL = __APP_REPO_URL__;
/** 项目名称 */
export const REPO_NAME = __APP_REPO_NAME__;
/** 版权署名 */
export const COPYRIGHT_HOLDER = __APP_AUTHOR__;
/** 官网地址 */
export const HOMEPAGE_URL = __APP_HOMEPAGE__;
/** 作者主页 */
export const AUTHOR_URL = __APP_AUTHOR_URL__;
