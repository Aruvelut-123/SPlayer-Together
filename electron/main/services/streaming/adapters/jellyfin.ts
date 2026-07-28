import type { Album, Artist, Playlist, Track } from "@shared/types/player";
import type { StreamingAuthResult, StreamingServerConfig } from "@shared/types/streaming";
import type { StreamingAdapter } from "./types";

const CLIENT_NAME = "SPlayer-Next";
const CLIENT_VERSION = "1.0.0";
const DEVICE_NAME = "SPlayer Desktop";
const REQUEST_TIMEOUT_MS = 15_000;

interface JellyItem {
  Id: string;
  Name?: string;
  Album?: string;
  AlbumId?: string;
  AlbumArtist?: string;
  Artists?: string[];
  ArtistItems?: { Id: string; Name: string }[];
  RunTimeTicks?: number;
  ProductionYear?: number;
  ChildCount?: number;
  ImageTags?: { Primary?: string };
  MediaSources?: {
    Container?: string;
    Bitrate?: number;
    Size?: number;
    MediaStreams?: {
      Type?: string;
      SampleRate?: number;
      BitDepth?: number;
      Channels?: number;
      Codec?: string;
    }[];
  }[];
}

const deviceId = (config: StreamingServerConfig): string => `splayer-next-shadow-${config.id}`;

const headers = (config: StreamingServerConfig): Record<string, string> => {
  const parts = [
    `Client="${CLIENT_NAME}"`,
    `Device="${DEVICE_NAME}"`,
    `DeviceId="${deviceId(config)}"`,
    `Version="${CLIENT_VERSION}"`,
  ];
  if (config.accessToken) parts.push(`Token="${config.accessToken}"`);
  const name = config.type === "emby" ? "X-Emby-Authorization" : "Authorization";
  return { "Content-Type": "application/json", [name]: `MediaBrowser ${parts.join(", ")}` };
};

const callApi = async <T>(
  config: StreamingServerConfig,
  apiPath: string,
  init?: RequestInit,
): Promise<T> => {
  const response = await fetch(`${config.url.replace(/\/+$/, "")}/${apiPath.replace(/^\//, "")}`, {
    ...init,
    headers: { ...headers(config), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
};

const requireUserId = (config: StreamingServerConfig): string => {
  if (!config.accessToken || !config.userId) throw new Error("缺少 accessToken / userId");
  return config.userId;
};

const fetchUserItems = async (
  config: StreamingServerConfig,
  query: Record<string, string | number>,
): Promise<JellyItem[]> => {
  const userId = requireUserId(config);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, String(value));
  const result = await callApi<{ Items?: JellyItem[] }>(
    config,
    `Users/${userId}/Items?${params.toString()}`,
  );
  return result.Items ?? [];
};

const imageUrl = (
  config: StreamingServerConfig,
  itemId: string,
  tag: string | undefined,
  maxHeight: number,
): string | undefined => {
  if (!config.accessToken) return undefined;
  const params = new URLSearchParams({ api_key: config.accessToken, maxHeight: String(maxHeight) });
  if (tag) params.set("tag", tag);
  return `${config.url.replace(/\/+$/, "")}/Items/${itemId}/Images/Primary?${params.toString()}`;
};

const toTrack = (config: StreamingServerConfig, item: JellyItem): Track => {
  const mediaSource = item.MediaSources?.[0];
  const audioStream = mediaSource?.MediaStreams?.find((stream) => stream.Type === "Audio");
  const imageTag = item.ImageTags?.Primary;
  return {
    id: `${config.id}:${item.Id}`,
    source: "streaming",
    serverId: config.id,
    originalId: item.Id,
    title: item.Name ?? "",
    artists:
      item.ArtistItems?.map((artist) => ({ id: artist.Id, name: artist.Name })) ??
      item.Artists?.map((name) => ({ name })) ??
      [],
    album: item.Album ? { id: item.AlbumId, name: item.Album } : undefined,
    duration: item.RunTimeTicks ? Math.floor(item.RunTimeTicks / 10_000) : 0,
    cover: imageTag ? imageUrl(config, item.Id, imageTag, 500) : undefined,
    coverOriginal: imageTag ? imageUrl(config, item.Id, imageTag, 1500) : undefined,
    fileSize: mediaSource?.Size,
    quality: {
      sampleRate: audioStream?.SampleRate ?? 0,
      channels: audioStream?.Channels ?? 2,
      bitsPerSample: audioStream?.BitDepth ?? 0,
      bitRate: mediaSource?.Bitrate ?? 0,
      codec: audioStream?.Codec ?? mediaSource?.Container ?? "",
    },
  };
};

const toAlbum = (config: StreamingServerConfig, item: JellyItem): Album => ({
  id: item.Id,
  name: item.Name ?? "",
  artist: item.AlbumArtist,
  cover: imageUrl(config, item.Id, item.ImageTags?.Primary, 300),
  trackCount: item.ChildCount,
  year: item.ProductionYear,
});

const toArtist = (config: StreamingServerConfig, item: JellyItem): Artist => ({
  id: item.Id,
  name: item.Name ?? "",
  avatar: imageUrl(config, item.Id, item.ImageTags?.Primary, 300),
  albumCount: item.ChildCount,
});

const toPlaylist = (config: StreamingServerConfig, item: JellyItem): Playlist => ({
  id: item.Id,
  name: item.Name ?? "",
  cover: imageUrl(config, item.Id, item.ImageTags?.Primary, 300),
  trackCount: item.ChildCount,
});

/** 使用账号密码创建仅供主进程旁路同步使用的会话 */
export const authenticate = async (config: StreamingServerConfig): Promise<StreamingAuthResult> => {
  const result = await callApi<{ AccessToken?: string; User?: { Id?: string } }>(
    { ...config, accessToken: undefined, userId: undefined },
    "Users/AuthenticateByName",
    {
      method: "POST",
      body: JSON.stringify({ Username: config.username, Pw: config.password }),
    },
  );
  if (!result.AccessToken || !result.User?.Id) {
    throw new Error("登录响应缺少 AccessToken/UserId");
  }
  return { accessToken: result.AccessToken, userId: result.User.Id };
};

export const jellyfinAdapter: StreamingAdapter = {
  async listSongs(config, params) {
    const items = await fetchUserItems(config, {
      IncludeItemTypes: "Audio",
      Recursive: "true",
      SortBy: "DateCreated,SortName",
      SortOrder: "Descending",
      Fields: "MediaSources",
      Limit: params?.limit ?? 100,
      StartIndex: params?.offset ?? 0,
    });
    return items.map((item) => toTrack(config, item));
  },

  async listAlbums(config, params) {
    const items = await fetchUserItems(config, {
      IncludeItemTypes: "MusicAlbum",
      Recursive: "true",
      SortBy: "SortName",
      SortOrder: "Ascending",
      Limit: params?.limit ?? 500,
      StartIndex: params?.offset ?? 0,
    });
    return items.map((item) => toAlbum(config, item));
  },

  async listArtists(config) {
    const userId = requireUserId(config);
    const result = await callApi<{ Items?: JellyItem[] }>(
      config,
      `Artists?userId=${userId}&Recursive=true&SortBy=Name&SortOrder=Ascending`,
    );
    return (result.Items ?? []).map((item) => toArtist(config, item));
  },

  async listPlaylists(config) {
    const items = await fetchUserItems(config, {
      IncludeItemTypes: "Playlist",
      Recursive: "true",
      SortBy: "SortName",
    });
    return items.map((item) => toPlaylist(config, item));
  },
};
