import type { StreamingServerConfig, StreamingServerType } from "@shared/types/streaming";
import { authenticate, jellyfinAdapter } from "./jellyfin";
import { subsonicAdapter } from "./subsonic";
import type { StreamingAdapter } from "./types";

const SUBSONIC_TYPES = new Set<StreamingServerType>([
  "subsonic",
  "navidrome",
  "opensubsonic",
  "airsonic",
  "gonic",
  "lms",
]);

export interface ResolvedStreamingAdapter {
  config: StreamingServerConfig;
  adapter: StreamingAdapter;
}

/**
 * 解析协议适配器，并为 Jellyfin/Emby 建立主进程会话
 * @param config - 带明文凭据的主进程配置
 * @returns 可直接发起请求的配置和适配器
 */
export const resolveStreamingAdapter = async (
  config: StreamingServerConfig,
): Promise<ResolvedStreamingAdapter> => {
  if (SUBSONIC_TYPES.has(config.type)) return { config, adapter: subsonicAdapter };
  if (config.type === "jellyfin" || config.type === "emby") {
    const session = await authenticate(config);
    return { config: { ...config, ...session }, adapter: jellyfinAdapter };
  }
  throw new Error(`不支持的服务器类型: ${config.type}`);
};
