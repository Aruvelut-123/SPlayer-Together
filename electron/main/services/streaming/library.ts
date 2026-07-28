import type { StreamingLibrarySnapshot, StreamingSearchResult } from "@shared/types/streaming";
import { getTracks, searchTracks } from "@main/database/remote-media/tracks";
import { getAlbums } from "@main/database/remote-media/albums";
import { getArtists } from "@main/database/remote-media/artists";
import { getPlaylists } from "@main/database/remote-media/playlists";
import { getSyncState } from "@main/database/remote-media/sync";

export { getSyncState as getLibrarySyncState } from "@main/database/remote-media/sync";

/** 读取一个服务器当前已经写入 SQLite 的完整媒体快照 */
export const getLibrarySnapshot = (serverId: string): StreamingLibrarySnapshot => ({
  songs: getTracks(serverId),
  albums: getAlbums(serverId),
  artists: getArtists(serverId),
  playlists: getPlaylists(serverId),
  syncState: getSyncState(serverId),
});

/** 在 SQLite 快照中搜索歌曲、专辑和歌手 */
export const searchLibrary = (serverId: string, query: string): StreamingSearchResult => {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return { songs: [], albums: [], artists: [] };
  return {
    songs: searchTracks(serverId, query),
    albums: getAlbums(serverId).filter(
      (album) =>
        album.name.toLocaleLowerCase().includes(needle) ||
        album.artist?.toLocaleLowerCase().includes(needle),
    ),
    artists: getArtists(serverId).filter((artist) =>
      artist.name.toLocaleLowerCase().includes(needle),
    ),
  };
};
