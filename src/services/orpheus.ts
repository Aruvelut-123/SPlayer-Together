import * as player from "@/core/player";
import { songsByIds } from "@/apis/song/netease";
import { navigateToAlbum, navigateToPlaylist } from "@/utils/navigate";

/** orpheus 解码后的载荷 */
interface OrpheusPayload {
  type: string;
  id: string;
  cmd: string;
}

/**
 * 解析 orpheus:// URL
 * 形如 orpheus://<URL-safe base64(JSON)>，JSON 形如 {"type":"song","id":"123","cmd":"play"}
 * @param url - orpheus:// 链接
 * @returns 解析结果，任一步失败或缺字段返回 null
 */
export const parseOrpheus = (url: string): OrpheusPayload | null => {
  const prefix = "orpheus://";
  if (!url.startsWith(prefix)) return null;
  let path = url.slice(prefix.length);
  if (path.endsWith("/")) path = path.slice(0, -1);
  try {
    path = decodeURIComponent(path);
  } catch {
    // 解码失败则沿用原串继续
  }
  // URL-safe base64 → 标准 base64 并补足 padding
  path = path.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = path.length % 4;
  if (remainder > 0) path += "=".repeat(4 - remainder);
  try {
    const json = JSON.parse(atob(path));
    if (!json?.type || !json?.id) return null;
    return { type: String(json.type), id: String(json.id), cmd: String(json.cmd ?? "") };
  } catch {
    return null;
  }
};

/**
 * 处理一次 orpheus 唤起：单曲立即播放，专辑/歌单跳应用内详情页
 * @param url - orpheus:// 链接
 */
export const handleOrpheus = async (url: string): Promise<void> => {
  const data = parseOrpheus(url);
  if (!data) return;
  switch (data.type) {
    case "song": {
      if (data.cmd !== "play") return;
      const [track] = await songsByIds([data.id]);
      if (track) await player.playNow(track);
      break;
    }
    case "album":
      navigateToAlbum(undefined, { source: "netease", albumId: data.id });
      break;
    case "playlist":
      navigateToPlaylist(data.id, { source: "netease" });
      break;
    default:
      break;
  }
};
