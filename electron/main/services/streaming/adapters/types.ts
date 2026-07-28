import type { Album, Artist, Playlist, Track } from "@shared/types/player";
import type { StreamingListParams, StreamingServerConfig } from "@shared/types/streaming";

/** 主进程流媒体协议适配器 */
export interface StreamingAdapter {
  listSongs(config: StreamingServerConfig, params?: StreamingListParams): Promise<Track[]>;
  listAlbums(config: StreamingServerConfig, params?: StreamingListParams): Promise<Album[]>;
  listArtists(config: StreamingServerConfig): Promise<Artist[]>;
  listPlaylists(config: StreamingServerConfig): Promise<Playlist[]>;
}
