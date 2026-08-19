import type { Track } from "@shared/types/player";
import { useMediaStore } from "@/stores/media";
import { useStatusStore } from "@/stores/status";
import { useLicenseStore } from "@/stores/license";
import { useUserStore } from "@/stores/user";
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
const SYNC_INTERVAL_MS = 1_000;
/** 成员跟随漂移纠正阈值（毫秒），超过则 seek 对齐，越小同步越紧 */
const DRIFT_THRESHOLD_MS = 800;

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
  permissions: { allowGuestControl: boolean; allowGuestEditPlaylist: boolean };
  lastActor: string | null;
  serverNow: number;
}

/** 房主控制的成员权限 */
export interface ListenTogetherPermissions {
  allowGuestControl: boolean;
  allowGuestEditPlaylist: boolean;
}

export const useListenTogetherStore = defineStore("listenTogether", () => {
  const media = useMediaStore();
  const status = useStatusStore();
  const license = useLicenseStore();
  const user = useUserStore();

  /** 房间内昵称：默认使用网易云账号名 */
  const nickname = ref(user.profile?.nickname || "");
  // 网易云登录后自动填充昵称（仅当用户尚未手动输入时）
  watch(
    () => user.profile?.nickname,
    (name) => {
      if (name && !nickname.value) nickname.value = name;
    },
  );
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
  /** 房主设置的成员权限 */
  const permissions = ref<ListenTogetherPermissions>({
    allowGuestControl: true,
    allowGuestEditPlaylist: true,
  });
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
  /** 上次请求心跳时间戳（状态无变化时也定期刷新活跃） */
  let lastHeartbeatAt = 0;
  /** 成员跟随中的曲目（等待加载完成确认） */
  let pendingFollow:
    | { trackId: string; expected: number; playing: boolean; trackToken: number }
    | null = null;
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

  /** 判断错误是否为房间已关闭（404），如是则提示并退出房间 */
  const handleRoomGone = (err: unknown): boolean => {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not found") || message.includes("404")) {
      toast.warning(i18n.global.t("listenTogether.roomClosed"), { duration: 4_000 });
      void leaveRoom();
      return true;
    }
    return false;
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
    if (snap.permissions) {
      permissions.value = snap.permissions;
    }
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
    // 所有成员共享同一播放列表：任何成员推送的队列都会被其他成员应用
    if (snap.queue) {
      applyQueue(snap.queue);
    }
    roomQueue.value = snap.queue ?? [];
    if (snap.state) {
      sharedState.value = { ...snap.state, seq: snap.seq };
    }
    // 房主身份变化：被转移 / 自动升级
    if (snap.hostId === memberId.value && role.value !== "host") {
      role.value = "host";
      toast.success(i18n.global.t("listenTogether.promotedToHost"));
      stopTimers();
      pushTimer = window.setInterval(() => void pushState(), SYNC_INTERVAL_MS);
      void pushState(true);
      void pushQueue();
    } else if (snap.hostId !== memberId.value && role.value === "host") {
      role.value = "guest";
      toast.info(i18n.global.t("listenTogether.demotedToGuest"));
      stopTimers();
      pollTimer = window.setInterval(() => void pollState(), SYNC_INTERVAL_MS);
      void pollState();
    }
  };

  /** 成员推送当前播放状态（房主总是允许，成员需 allowGuestControl 权限） */
  const pushState = async (force = false): Promise<void> => {
    if (!roomActive.value) return;
    if (role.value !== "host" && !permissions.value.allowGuestControl) return;
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
    // 状态无变化时也定期心跳，避免被服务器判定离线
    const heartbeatDue = Date.now() - lastHeartbeatAt > 15_000;
    if (!changed && !heartbeatDue) return;
    lastHeartbeatAt = Date.now();
    lastPushed = { trackId, state, positionMs };
    try {
      const snap = await api<RoomSnapshot>(`/api/rooms/${code.value}/state`, {
        method: "POST",
        body: JSON.stringify({ track: shareable ? track : null, state, positionMs }),
      });
      connection.value = "connected";
      applyRoomView(snap);
    } catch (err) {
      if (handleRoomGone(err)) return;
      connection.value = "error";
    }
  };

  /** 成员推送播放列表（房主总是允许，成员需 allowGuestEditPlaylist 权限） */
  const pushQueue = async (): Promise<void> => {
    if (!roomActive.value) return;
    if (role.value !== "host" && !permissions.value.allowGuestEditPlaylist) return;
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
    } catch (err) {
      if (handleRoomGone(err)) return;
      /* 队列推送失败，下次重试 */
    }
  };

  /** 成员拉取房间状态（含房主失联自动升级 / 被转移降级） */
  const pollState = async (): Promise<void> => {
    if (role.value !== "guest" || !roomActive.value) return;
    try {
      const snap = await api<RoomSnapshot>(`/api/rooms/${code.value}/state`);
      connection.value = "connected";
      applyRoomView(snap);
      // 不跟随自己推送的状态
      if (snap.state && snap.lastActor !== memberId.value) {
        await applyState(sharedState.value as ListenTogetherSharedState);
      }
    } catch (err) {
      if (handleRoomGone(err)) return;
      connection.value = "error";
    }
  };

  /** 成员应用房间状态：切歌跟随 / 播放态对齐 / 漂移纠正（所有成员跟随同一进度） */
  const applyState = async (s: ListenTogetherSharedState): Promise<void> => {
    if (!roomActive.value) return;
    const sharedTrack = s.track;
    if (!sharedTrack || !SHAREABLE_SOURCES.has(sharedTrack.source)) {
      if (status.isPlaying) await player.pause();
      return;
    }
    if (sharedTrack.id === lastFailedTrackId.value) return;
    const myTrack = media.track;
    if (myTrack?.id !== sharedTrack.id) {
      // 同一目标仍在加载：仅刷新目标进度，避免重复 playNow
      if (pendingFollow?.trackId === sharedTrack.id) {
        pendingFollow.expected = expectedPosition(s);
        pendingFollow.playing = s.state === "playing";
        return;
      }
      // 目标已变：递增 trackToken 取消在途旧加载，并记录本次跟随
      const myToken = player.advanceTrackToken();
      pendingFollow = {
        trackId: sharedTrack.id,
        expected: expectedPosition(s),
        playing: s.state === "playing",
        trackToken: myToken,
      };
      // 从本地队列中找同 id 的 Track（队列已通过 applyQueue 同步）
      // 使用本地队列的 Track 对象而非 host 推送的，避免因 host 端特有字段
      //（如 pluginId、URL 等）导致 guest 端解析音源失败
      const localTrack = queueStore.value.find((t) => t.id === sharedTrack.id) ?? sharedTrack;
      const prevSource = status.currentSource;
      try {
        await player.playNow(localTrack, status.currentPlaybackContext);
      } catch {
        // 加载异常：清空跟随状态并上报，避免 pendingFollow 残留导致后续切歌全部被跳过
        pendingFollow = null;
        lastFailedTrackId.value = sharedTrack.id;
        reportLoadFailed(sharedTrack);
        return;
      }
      // 加载期间被更新的切歌接管：本次结果作废，由新目标处理
      if (pendingFollow.trackToken !== myToken) return;
      const loadedOk =
        media.track?.id === sharedTrack.id &&
        !!status.currentSource &&
        status.currentSource !== prevSource;
      if (!loadedOk) {
        pendingFollow = null;
        lastFailedTrackId.value = sharedTrack.id;
        reportLoadFailed(sharedTrack);
        return;
      }
      // 成功跟随：清除历史失败标记，允许之后重试曾被跳过的歌曲
      lastFailedTrackId.value = "";
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
    permissions.value = { allowGuestControl: true, allowGuestEditPlaylist: true };
  };

  /** 房主设置成员权限 */
  const setPermissions = async (next: Partial<ListenTogetherPermissions>): Promise<void> => {
    if (role.value !== "host" || !roomActive.value) return;
    try {
      const snap = await api<RoomSnapshot>(`/api/rooms/${code.value}/permissions`, {
        method: "POST",
        body: JSON.stringify({
          allowGuestControl: next.allowGuestControl ?? permissions.value.allowGuestControl,
          allowGuestEditPlaylist:
            next.allowGuestEditPlaylist ?? permissions.value.allowGuestEditPlaylist,
        }),
      });
      applyRoomView(snap);
    } catch (err) {
      if (handleRoomGone(err)) return;
    }
  };

  /** 房主将房主身份转移给其他成员 */
  const transferHost = async (targetMemberId: string): Promise<void> => {
    if (role.value !== "host" || !roomActive.value) return;
    try {
      const snap = await api<RoomSnapshot>(`/api/rooms/${code.value}/transfer`, {
        method: "POST",
        body: JSON.stringify({ targetMemberId }),
      });
      applyRoomView(snap);
    } catch (err) {
      if (handleRoomGone(err)) return;
    }
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
    permissions,
    lastError,
    createRoom,
    joinRoom,
    leaveRoom,
    setPermissions,
    transferHost,
  };
});
