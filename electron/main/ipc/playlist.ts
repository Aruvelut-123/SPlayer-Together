import { ipcMain } from "electron";
import type {
  LegacyPlaylistRecord,
  PlaylistCreateInput,
  PlaylistUpdateInput,
} from "@shared/types/playlist";
import {
  addPlaylistTracks,
  clearPlaylists,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylists,
  importLegacyPlaylists,
  removePlaylistTracks,
  updatePlaylist,
} from "@main/database/playlists";
import {
  addWebDavPlaylistConfig,
  clearRemoteMediaConfig,
  removeWebDavPlaylistConfig,
} from "@main/services/remoteMedia/config";

/** 创建歌单并保存对应的远程配置 */
const create = (input: PlaylistCreateInput) => {
  if (input.type === "webdav" && !input.webdav) throw new Error("请填写 WebDAV 配置");
  const playlist = createPlaylist(input);
  if (input.type !== "webdav") return playlist;
  try {
    addWebDavPlaylistConfig(playlist.id, input.webdav!);
    return playlist;
  } catch (error) {
    deletePlaylist(playlist.id);
    throw error;
  }
};

/** 删除歌单及其远程配置 */
const remove = (id: string): void => {
  removeWebDavPlaylistConfig(id);
  deletePlaylist(id);
};

/** 清空全部歌单和远程配置 */
const clear = (): void => {
  clearRemoteMediaConfig();
  clearPlaylists();
};

/** 注册统一歌单 IPC */
export const registerPlaylistIpc = (): void => {
  ipcMain.handle("playlist:list", getPlaylists);
  ipcMain.handle("playlist:get", (_event, id: string) => getPlaylist(id));
  ipcMain.handle("playlist:create", (_event, input: PlaylistCreateInput) => create(input));
  ipcMain.handle("playlist:update", (_event, id: string, input: PlaylistUpdateInput) =>
    updatePlaylist(id, input),
  );
  ipcMain.handle("playlist:remove", (_event, id: string) => remove(id));
  ipcMain.handle("playlist:addTracks", (_event, id: string, trackIds: string[]) =>
    addPlaylistTracks(id, trackIds),
  );
  ipcMain.handle("playlist:removeTracks", (_event, id: string, trackIds: string[]) =>
    removePlaylistTracks(id, trackIds),
  );
  ipcMain.handle("playlist:importLegacy", (_event, records: LegacyPlaylistRecord[]) =>
    importLegacyPlaylists(records),
  );
  ipcMain.handle("playlist:clear", clear);
};
