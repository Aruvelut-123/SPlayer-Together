import type { Track } from "@shared/types/player";
import { useMediaStore } from "@/stores/media";
import { useStatusStore } from "@/stores/status";
import { useLicenseStore } from "@/stores/license";
import { queue as queueStore, setQueue } from "@/stores/queue";
import * as player from "@/core/player";
import { toast } from "@/composables/useToast";
import i18n from "@/i18n";

/**
 * 一起听（Listen Together）
 *
 * 类似网易云「一起听」：房主创建房间，成员通过房间号加入。全部走纯 HTTP 轮询，
 * 房主周期性推送播放状态与队列，成员周期性拉取并跟随（漂移纠正）。
 * 本地文件与流媒体曲目无法跨设备共享，一起听期间禁止播放这类曲目。
 */

/** 可跨设备共享的在线平台来源；本地路径与流媒体会话无法在其它设备上播放 */
const SHAREABLE_SOURCES = new Set(["netease", "qqmusic", "kugou"]);

/** 房主推送 / 成员拉取的最小间隔（毫秒） */
const SYNC_INTERVAL_MS = 2_000;
/** 成员跟随漂移纠正阈值（毫秒），超过则 seek 对齐 */
const DRIFT_THRESHOLD_MS = 2_000;

export type ListenTogetherRole = "none" | "host" | "guest";
export type ListenTogetherConnection = "idle" | "connecting" | "connected" | "error";

export interface ListenTogetherMember {
  id: string;
  name: string;
  role: "host" | "guest";
}

/** 服务器维护的房间共享状态 */
export interface ListenTogetherSharedState {
  track: Track | null;
  state: "playing" | "paused" | "stopped";
  positionMs: number;
  /** 服务器写入状态时的服务器时间（毫秒） */
  at: number;
  seq: number;
}

interface SharedStatePayload {
  track: Track | null;
  state: "playing" | "paused" | "stopped";
  positionMs: number;
  at: number;
}

interface RoomReport {
  kind: string;
  name: string;
  trackTitle: string;
}

/** 服务器房间快照 */
interface RoomSnapshot {
  seq: number;
  state: SharedStatePayload | null;
  members: ListenTogetherMember[];
  hostId: string;
  queue: Track[] | null;
  reports: RoomReport[];
  serverNow: number;
}

export const useListenTogetherStore = defineStore("listenTogether", () => {
  const media = useMediaStore();
  const status = useStatusStore();
  const license = useLicenseStore();

  /** 房间内昵称 */
  const nickname = ref("");
  /** 轮询连接状态 */
  const connection = ref<ListenTogetherConnection>("idle");
  /** 当前身份 */
  const role = ref<ListenTogetherRole>("none");
  /** 房间号 */
  const code = ref("");
  /** 房间成员 */
  const members = ref<ListenTogetherMember[]>([]);
  /** 房主成员 id */
  const hostId = ref("");
  /** 服务器上的共享播放状态 */
  const sharedState = ref<ListenTogetherSharedState | null>(null);
  /** 服务器上的共享播放列表 */
  const roomQueue = ref<Track[]>([]);
  /** 最近一次错误提示 */
  const lastError = ref("");

  /** 本机成员凭据（不参与渲染） */
  const memberId = ref("");
  const token = ref("");
  /** 是否处于房间中（驱动定时器 / watcher） */
  const roomActive = ref(false);
  /** 服务器时钟相对本机时钟的偏移（毫秒），每条快照刷新 */
  let serverOffsetMs = 0;
  /** 上次成员 id 快照，用于进出房间提示 */
  let prevMemberIds: string[] = [];
  /** 上次推送内容，用于变化检测 */
  let lastPushed: { trackId: string | null; state: string; positionMs: number } | null = null;
  /** 上次推送队列的指纹 */
  let lastPushedQueueKey = "";
  /** 成员跟随中的曲目（等待加载完成确认） */
  let pendingFollow: { trackId: string; expected: number; playing: boolean } | null = null;
  /** 本机无法播放的曲目 id（房主切歌前不再重试） */
  const lastFailedTrackId = ref("");

  let pushTimer: number | undefined;
  let pollTimer: number | undefined;

  /** 服务器地址去尾斜杠（复用授权服务器） */
  const baseUrl = computed(() => license.serverUrl.replace(/\/+$/, ""));

  /** 房间成员请求头 */
  const memberHeaders = (): Record<string, string> => ({
    "X-Auth-Key": license.machineKey,
    "X-Member-Id": memberId.value,
    "X-Token": token.value,
  });

  /** 封装 REST 请求；非 2xx 抛带服务端文案的错误 */
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...memberHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    };
    const res = await fetch(`${baseUrl.value}${path}`, { ...init, headers });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return body as T;
  };

  const stopTimers = (): void => {
    if (pushTimer !== undefined) window.clearInterval(pushTimer);
    if (pollTimer !== undefined) window.clearInterval(pollTimer);
    pushTimer = undefined;
    pollTimer = undefined;
  };

  /** 按服务器时间换算的目标进度（毫秒） */
  const expectedPosition = (s: ListenTogetherSharedState): number =>
    s.state === "playing" ? s.positionMs + (Date.now() + serverOffsetMs - s.at) : s.positionMs;

  /** 成员应用房主队列（内容不一致才替换，避免无谓刷新） */
  const applyQueue = (tracks: Track[]): void => {
    const key = tracks.map((t) => t.id).join("\u0000");
    if (key !== queueStore.value.map((t) => t.id).join("\u0000")) {
      setQueue(tracks);
    }
  };

  /** 应用房间快照：成员进出提示 / 房主 / 队列 / 报告 / 共享状态 */
  const applyRoomView = (snap: RoomSnapshot): void => {
    serverOffsetMs = snap.serverNow - Date.now();
    const prev = new Set(prevMemberIds);
    for (const m of snap.members) {
      if (!prev.has(m.id)) {
        toast.info(i18n.global.t("listenTogether.memberJoined", { name: m.name }));
      }
    }
    for (const id of prevMemberIds) {
      if (!snap.members.some((m) => m.id === id)) {
        const gone = members.value.find((m) => m.id === id);
        if (gone) {
          toast.info(i18n.global.t("listenTogether.memberLeft", { name: gone.name }));
        }
      }
    }
    prevMemberIds = snap.members.map((m) => m.id);
    members.value = snap.members;
    hostId.value = snap.hostId;
    if (snap.reports.length > 0 && role.value === "host") {
      for (const r of snap.reports) {
        if (r.kind === "loadFailed") {
          toast.warning(
            i18n.global.t("listenTogether.memberCannotPlay", {
              name: r.name,
              title: r.trackTitle,
            }),
            { duration: 5_000 },
          );
        }
      }
    }
    if (snap.queue && role.value === "guest") {
      applyQueue(snap.queue);
    }
    roomQueue.value = snap.queue ?? [];
    if (snap.state) {
      sharedState.value = { ...snap.state, seq: snap.seq };
    }
  };

  /** 房主推送当前播放状态；非房主 / 未连接时忽略 */
  const pushState = async (force = false): Promise<void> => {
    if (role.value !== "host" || !roomActive.value) return;
    const track = media.track;
    const shareable = !!track && SHAREABLE_SOURCES.has(track.source);
    const state = !shareable
      ? "paused"
      : status.state === "playing"
        ? "playing"
        : status.state === "paused"
          ? "paused"
          : "stopped";
    const positionMs = shareable ? Math.round(status.position) : 0;
    const trackId = shareable && track ? track.id : null;
    const changed =
      force ||
      !lastPushed ||
      lastPushed.trackId !== trackId ||
      lastPushed.state !== state ||
      Math.abs(lastPushed.positionMs - positionMs) >= SYNC_INTERVAL_MS;
    if (!changed) return;
    lastPushed = { trackId, state, positionMs };
    try {
      const snap = await api<RoomSnapshot>(`/api/rooms/${code.value}/state`, {
        method: "POST",
        body: JSON.stringify({ track: shareable ? track : null, state, positionMs }),
      });
      connection.value = "connected";
      applyRoomView(snap);
    } catch {
      connection.value = "error";
    }
  };

  /** 房主推送播放列表（仅内容变化时） */
  const pushQueue = async (): Promise<void> => {
    if (role.value !== "host" || !roomActive.value) return;
    const tracks = queueStore.value;
    const key = tracks.map((t) => t.id).join("\u0000");
    if (key === lastPushedQueueKey) return;
    lastPushedQueueKey = key;
    try {
      const snap = await api<RoomSnapshot>(`/api/rooms/${code.value}/queue`, {
        method: "POST",
        body: JSON.stringify({ tracks }),
      });
      applyRoomView(snap);
    } catch {
      /* 队列推送失败，下次轮询重试 */
    }
  };

  /** 成员拉取房间状态 */
  const pollState = async (): Promise<void> => {
    if (role.value !== "guest" || !roomActive.value) return;
    try {
      const snap = await api<RoomSnapshot>(`/api/rooms/${code.value}/state`);
      connection.value = "connected";
      applyRoomView(snap);
      // 房主离开后自动升级
      if (snap.hostId === memberId.value && role.value === "guest") {
        role.value = "host";
        toast.success(i18n.global.t("listenTogether.promotedToHost"));
        stopTimers();
        pushTimer = window.setInterval(() => void pushState(), SYNC_INTERVAL_MS);
        void pushState(true);
        void pushQueue();
        return;
      }
      if (snap.state) {
        await applyState(sharedState.value as ListenTogetherSharedState);
      }
    } catch {
      connection.value = "error";
    }
  };

  /** 成员应用房间状态：切歌跟随 / 播放态对齐 / 漂移纠正 */
  const applyState = async (s: ListenTogetherSharedState): Promise<void> => {
    if (role.value !== "guest") return;
    if (!s.track || !SHAREABLE_SOURCES.has(s.track.source)) {
      if (status.isPlaying) await player.pause();
      return;
    }
    if (s.track.id === lastFailedTrackId.value) return;
    const myTrack = media.track;
    if (myTrack?.id !== s.track.id) {
      if (pendingFollow) return;
      pendingFollow = {
        trackId: s.track.id,
        expected: expectedPosition(s),
        playing: s.state === "playing",
      };
      const prevSource = status.currentSource;
      await player.playNow(s.track);
      const loadedOk =
        media.track?.id === s.track.id &&
        !!status.currentSource &&
        status.currentSource !== prevSource;
      if (!loadedOk) {
        pendingFollow = null;
        lastFailedTrackId.value = s.track.id;
        reportLoadFailed(s.track);
        return;
      }
      const target = pendingFollow.expected;
      if (target > 500) await player.seek(target);
      if (pendingFollow.playing) {
        if (!status.isPlaying) await player.play();
      } else if (status.isPlaying) {
        await player.pause();
      }
      pendingFollow = null;
      return;
    }
    // 同一首歌：仅做漂移纠正与播放态对齐
    if (s.state === "playing") {
      const target = expectedPosition(s);
      if (Math.abs(status.position - target) > DRIFT_THRESHOLD_MS) await player.seek(target);
      if (!status.isPlaying) await player.play();
    } else if (status.isPlaying) {
      await player.pause();
    }
  };

  /** 上报本机无法播放，并提示用户 */
  const reportLoadFailed = (track: Track): void => {
    void api<{ ok: boolean }>(`/api/rooms/${code.value}/report`, {
      method: "POST",
      body: JSON.stringify({ kind: "loadFailed", trackId: track.id, trackTitle: track.title }),
    }).catch(() => {});
    toast.warning(i18n.global.t("listenTogether.cannotPlay", { title: track.title }), {
      duration: 5_000,
    });
  };

  /** 启动轮询定时器并立即同步一次 */
  const startTimers = (): void => {
    stopTimers();
    if (role.value === "host") {
      pushTimer = window.setInterval(() => void pushState(), SYNC_INTERVAL_MS);
      void pushState(true);
      void pushQueue();
    } else {
      pollTimer = window.setInterval(() => void pollState(), SYNC_INTERVAL_MS);
      void pollState();
    }
  };

  /** 创建房间并开始轮询 */
  const createRoom = async (): Promise<void> => {
    await leaveRoom();
    try {
      const res = await api<{ code: string; memberId: string; token: string }>("/api/rooms", {
        method: "POST",
        body: JSON.stringify({ name: nickname.value.trim() || i18n.global.t("listenTogether.me") }),
      });
      code.value = res.code;
      memberId.value = res.memberId;
      token.value = res.token;
      role.value = "host";
      roomActive.value = true;
      connection.value = "connecting";
      startTimers();
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      toast.error(i18n.global.t("listenTogether.createFailed"));
      connection.value = "error";
    }
  };

  /** 加入房间并开始轮询 */
  const joinRoom = async (roomCode: string): Promise<void> => {
    await leaveRoom();
    const trimmed = roomCode.trim();
    if (!trimmed) return;
    try {
      const res = await api<{ memberId: string; token: string }>(
        `/api/rooms/${encodeURIComponent(trimmed)}/join`,
        {
          method: "POST",
          body: JSON.stringify({
            name: nickname.value.trim() || i18n.global.t("listenTogether.me"),
          }),
        },
      );
      code.value = trimmed;
      memberId.value = res.memberId;
      token.value = res.token;
      role.value = "guest";
      roomActive.value = true;
      connection.value = "connecting";
      startTimers();
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      toast.error(i18n.global.t("listenTogether.joinFailed"));
      connection.value = "error";
    }
  };

  /** 离开房间并停止轮询 */
  const leaveRoom = async (): Promise<void> => {
    roomActive.value = false;
    stopTimers();
    if (code.value && memberId.value && token.value) {
      await api<{ ok: boolean }>(`/api/rooms/${encodeURIComponent(code.value)}/leave`, {
        method: "POST",
      }).catch(() => {});
    }
    code.value = "";
    memberId.value = "";
    token.value = "";
    role.value = "none";
    connection.value = "idle";
    members.value = [];
    hostId.value = "";
    sharedState.value = null;
    lastError.value = "";
    lastFailedTrackId.value = "";
    pendingFollow = null;
    lastPushed = null;
    lastPushedQueueKey = "";
    prevMemberIds = [];
  };

  // 房主侧：曲目 / 播放态变化时立即推送
  watch(
    () => media.track?.id,
    () => {
      if (roomActive.value && role.value === "host") void pushState(true);
    },
  );
  watch(
    () => status.state,
    () => {
      if (roomActive.value && role.value === "host") void pushState(true);
    },
  );

  // 房主侧：队列变化推送
  watch(
    () => queueStore.value.map((t) => t.id).join("\u0000"),
    () => {
      if (roomActive.value && role.value === "host") void pushQueue();
    },
  );

  // 一起听期间禁止本地音乐：房主播放不可共享曲目时暂停并提示
  watch(
    () => media.track,
    (track) => {
      if (!roomActive.value || role.value !== "host") return;
      if (track && !SHAREABLE_SOURCES.has(track.source)) {
        void player.pause();
        toast.warning(i18n.global.t("listenTogether.localNotShareable"), { duration: 4_000 });
      }
    },
  );

  onScopeDispose(() => {
    void leaveRoom();
  });

  return {
    nickname,
    connection,
    role,
    code,
    members,
    hostId,
    sharedState,
    roomQueue,
    lastError,
    createRoom,
    joinRoom,
    leaveRoom,
  };
});
