import { createHash, randomBytes } from "node:crypto";
import type { Album, Artist, Playlist, Track } from "@shared/types/player";
import type { StreamingServerConfig } from "@shared/types/streaming";
import type { StreamingAdapter } from "./types";

const API_VERSION = "1.16.1";
const CLIENT_NAME = "SPlayer-Next";
const REQUEST_TIMEOUT_MS = 15_000;

interface SubsonicSong {
  id: string;
  title: string;
  artist?: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  duration?: number;
  bitRate?: number;
  samplingRate?: number;
  bitDepth?: number;
  channelCount?: number;
  suffix?: string;
  size?: number;
  coverArt?: string;
  artists?: { id?: string; name: string }[];
  displayArtist?: string;
}

interface SubsonicAlbum {
  id: string;
  name: string;
  artist?: string;
  coverArt?: string;
  songCount?: number;
  year?: number;
  displayArtist?: string;
}

interface SubsonicArtist {
  id: string;
  name: string;
  albumCount?: number;
  coverArt?: string;
}

interface SubsonicPlaylist {
  id: string;
  name: string;
  comment?: string;
  songCount?: number;
  coverArt?: string;
  owner?: string;
}

const md5 = (value: string): string => createHash("md5").update(value).digest("hex");

const buildAuth = (config: StreamingServerConfig): URLSearchParams => {
  const salt = randomBytes(6).toString("hex");
  return new URLSearchParams({
    u: config.username,
    t: md5(config.password + salt),
    s: salt,
    v: API_VERSION,
    c: CLIENT_NAME,
    f: "json",
  });
};

const buildUrl = (
  config: StreamingServerConfig,
  endpoint: string,
  extra: Record<string, string | number> = {},
): string => {
  const params = buildAuth(config);
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  return `${config.url.replace(/\/+$/, "")}/rest/${endpoint}?${params.toString()}`;
};

const callApi = async <T>(
  config: StreamingServerConfig,
  endpoint: string,
  extra?: Record<string, string | number>,
): Promise<T> => {
  const response = await fetch(buildUrl(config, endpoint, extra), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { "subsonic-response"?: Record<string, unknown> };
  const result = body["subsonic-response"];
  if (!result) throw new Error("响应缺少 subsonic-response 包装");
  if (result.status !== "ok") {
    const error = result.error as { code?: number; message?: string } | undefined;
    throw new Error(error?.message ?? `Subsonic error code ${error?.code}`);
  }
  return result as T;
};

const coverUrl = (
  config: StreamingServerConfig,
  coverId: string | undefined,
  size: number,
  auth: URLSearchParams,
): string | undefined => {
  if (!coverId) return undefined;
  const params = new URLSearchParams(auth);
  params.set("id", coverId);
  params.set("size", String(size));
  return `${config.url.replace(/\/+$/, "")}/rest/getCoverArt?${params.toString()}`;
};

const toTrack = (
  config: StreamingServerConfig,
  song: SubsonicSong,
  auth: URLSearchParams,
): Track => {
  const artists = song.artists?.length
    ? song.artists.map((artist) => ({ id: artist.id, name: artist.name }))
    : (song.displayArtist ?? song.artist ?? "").trim()
      ? [{ id: song.artistId, name: (song.displayArtist ?? song.artist ?? "").trim() }]
      : [];
  return {
    id: `${config.id}:${song.id}`,
    source: "streaming",
    serverId: config.id,
    originalId: song.id,
    title: song.title || "",
    artists,
    album: song.album ? { id: song.albumId, name: song.album } : undefined,
    duration: Math.round((song.duration ?? 0) * 1000),
    cover: coverUrl(config, song.coverArt, 500, auth),
    coverOriginal: coverUrl(config, song.coverArt, 1500, auth),
    fileSize: song.size,
    quality: {
      sampleRate: song.samplingRate ?? 0,
      channels: song.channelCount ?? 2,
      bitsPerSample: song.bitDepth ?? 0,
      bitRate: song.bitRate ? song.bitRate * 1000 : 0,
      codec: song.suffix ?? "",
    },
  };
};

const toAlbum = (
  config: StreamingServerConfig,
  album: SubsonicAlbum,
  auth: URLSearchParams,
): Album => ({
  id: album.id,
  name: album.name,
  artist: album.displayArtist ?? album.artist,
  cover: coverUrl(config, album.coverArt, 300, auth),
  trackCount: album.songCount,
  year: album.year,
});

const toArtist = (
  config: StreamingServerConfig,
  artist: SubsonicArtist,
  auth: URLSearchParams,
): Artist => ({
  id: artist.id,
  name: artist.name,
  avatar: coverUrl(config, artist.coverArt, 300, auth),
  albumCount: artist.albumCount,
});

const toPlaylist = (
  config: StreamingServerConfig,
  playlist: SubsonicPlaylist,
  auth: URLSearchParams,
): Playlist => ({
  id: playlist.id,
  name: playlist.name,
  description: playlist.comment,
  cover: coverUrl(config, playlist.coverArt, 300, auth),
  trackCount: playlist.songCount,
  owner: playlist.owner,
});

export const subsonicAdapter: StreamingAdapter = {
  async listSongs(config, params) {
    const result = await callApi<{ searchResult3?: { song?: SubsonicSong[] } }>(config, "search3", {
      query: "",
      songCount: params?.limit ?? 100,
      songOffset: params?.offset ?? 0,
      artistCount: 0,
      albumCount: 0,
    });
    const viewAuth = buildAuth(config);
    return (result.searchResult3?.song ?? []).map((song) => toTrack(config, song, viewAuth));
  },

  async listAlbums(config, params) {
    const result = await callApi<{ albumList2?: { album?: SubsonicAlbum[] } }>(
      config,
      "getAlbumList2",
      {
        type: "alphabeticalByName",
        size: params?.limit ?? 500,
        offset: params?.offset ?? 0,
      },
    );
    const viewAuth = buildAuth(config);
    return (result.albumList2?.album ?? []).map((album) => toAlbum(config, album, viewAuth));
  },

  async listArtists(config) {
    const result = await callApi<{
      artists?: { index?: { artist?: SubsonicArtist[] }[] };
    }>(config, "getArtists");
    const viewAuth = buildAuth(config);
    return (result.artists?.index ?? []).flatMap((index) =>
      (index.artist ?? []).map((artist) => toArtist(config, artist, viewAuth)),
    );
  },

  async listPlaylists(config) {
    const result = await callApi<{ playlists?: { playlist?: SubsonicPlaylist[] } }>(
      config,
      "getPlaylists",
    );
    const viewAuth = buildAuth(config);
    return (result.playlists?.playlist ?? []).map((playlist) =>
      toPlaylist(config, playlist, viewAuth),
    );
  },
};
