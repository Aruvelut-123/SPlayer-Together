import type { StreamingServerConfig } from "@shared/types/streaming";

/** 仅存在于主进程内存中的完整服务器配置 */
export interface StreamingRuntimeConfig extends StreamingServerConfig {
  password: string;
  accessToken?: string;
  userId?: string;
}

/** Jellyfin/Emby 主进程登录会话 */
export interface StreamingAuthSession {
  accessToken: string;
  userId: string;
}
