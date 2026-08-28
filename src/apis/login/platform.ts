import type { Platform, PlatformProfile } from "@shared/types/platform";
import {
  fetchQQMusicLoginStatus,
  logoutQQMusic,
  openQQMusicLoginWeb,
  setQQMusicCookie,
} from "./qqmusic";

export interface PlatformAccountAdapter {
  displayName: string;
  userIdLabel: string;
  fetchProfile: () => Promise<PlatformProfile | null>;
  logout: () => Promise<void>;
  openWebLogin?: () => Promise<boolean>;
  setCookie?: (cookie: string) => Promise<boolean>;
}

const adapters: Partial<Record<Platform, PlatformAccountAdapter>> = {
  qqmusic: {
    displayName: "QM",
    userIdLabel: "UIN",
    fetchProfile: fetchQQMusicLoginStatus,
    logout: logoutQQMusic,
    openWebLogin: openQQMusicLoginWeb,
    setCookie: setQQMusicCookie,
  },
};

/**
 * 获取平台账号适配器
 * @param platform - 音乐平台
 * @returns 平台账号适配器
 */
export const getPlatformAccountAdapter = (platform: Platform): PlatformAccountAdapter => {
  const adapter = adapters[platform];
  if (!adapter) throw new Error(`平台暂不支持账号连接: ${platform}`);
  return adapter;
};
