import type { Album, Artist, Playlist, Track } from "@shared/types/player";
import type { StreamingListParams, StreamingServerConfig } from "@shared/types/streaming";

/** 主进程流媒体协议适配器 */
export interface StreamingAdapter {
  /**
   * 分页读取歌曲列表
   * @param config - 主进程服务器配置
   * @param params - 分页参数
   * @returns 统一歌曲列表
   */
  listSongs(config: StreamingServerConfig, params?: StreamingListParams): Promise<Track[]>;
  /**
   * 分页读取专辑列表
   * @param config - 主进程服务器配置
   * @param params - 分页参数
   * @returns 统一专辑列表
   */
  listAlbums(config: StreamingServerConfig, params?: StreamingListParams): Promise<Album[]>;
  /**
   * 读取歌手列表
   * @param config - 主进程服务器配置
   * @returns 统一歌手列表
   */
  listArtists(config: StreamingServerConfig): Promise<Artist[]>;
  /**
   * 读取歌单列表
   * @param config - 主进程服务器配置
   * @returns 统一歌单列表
   */
  listPlaylists(config: StreamingServerConfig): Promise<Playlist[]>;
  /**
   * 读取专辑歌曲
   * @param config - 主进程服务器配置
   * @param albumId - 服务端专辑 ID
   * @returns 按服务端顺序排列的歌曲
   */
  getAlbumSongs(config: StreamingServerConfig, albumId: string): Promise<Track[]>;
  /**
   * 读取歌单歌曲
   * @param config - 主进程服务器配置
   * @param playlistId - 服务端歌单 ID
   * @returns 按歌单顺序排列的歌曲
   */
  getPlaylistSongs(config: StreamingServerConfig, playlistId: string): Promise<Track[]>;
  /**
   * 读取歌手专辑
   * @param config - 主进程服务器配置
   * @param artistId - 服务端歌手 ID
   * @returns 歌手的专辑列表
   */
  getArtistAlbums(config: StreamingServerConfig, artistId: string): Promise<Album[]>;
  /**
   * 读取歌手歌曲
   * @param config - 主进程服务器配置
   * @param artistId - 服务端歌手 ID
   * @returns 歌手的歌曲列表
   */
  getArtistSongs(config: StreamingServerConfig, artistId: string): Promise<Track[]>;
}
