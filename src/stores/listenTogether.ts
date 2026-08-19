import type { Track } from "@shared/types/player";
import { useMediaStore } from "@/stores/media";
import { useStatusStore } from "@/stores/status";
import { useLicenseStore } from "@/stores/license";
import * as player from "@/core/player";
import { toast } from "@/composables/useToast";
import i18n from "@/i18n";

/**
 * 一起听（Listen Together）
 *
 * 类似网易云「一起听」：房主创建房间，成员通过 WebSocket 连到中继服务器，
 * 房主播放状态（曲目 / 播放态 / 进度）实时推给房间，成员自动跟随播放并做漂移纠正。
 * 本地文件与流媒体曲目无法跨设备共享，房主播放这类曲目时房间状态置空，成员暂停。
 */

/** 可跨设备共享的在线平台来源；本地路径与流媒体会话无法在其它设备上播放 */
const SHAREABLE_SOURCES = new Set(["netease", "qqmusic", "kugou"]);

/** 房主推送进度的最小间隔（毫秒） */
const PUSH_INTERVAL_MS = 2_000;
/** 房间内成员 WebSocket 心跳间隔（毫秒） */
const PING_INTERVAL_MS = 25_000;
/** 断线重连退避上限（毫秒） */
const RECONNECT_MAX_DELAY_MS = 15_000;
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

/** 服务器 → 客户端消息 */
type ServerMessage =
  | {
      type: "welcome";
      code: string;
      role: "host" | "guest";
      members: ListenTogetherMember[];
      hostId: string;
      state: ListenTogetherSharedState | null;
      serverNow: number;
    }
  | {
      type: "state";
      seq: number;
      state: {
        track: Track | null;
        state: "playing" | "paused" | "stopped";
        positionMs: number;
        at: number;
      };
      serverNow: number;
    }
  | { type: "members"; members: ListenTogetherMember[]; hostId: string }
  | { type: "event"; kind: "loadFailed"; name: string; trackTitle: string }
  | { type: "role"; role: "host" | "guest" }
  | { type: "error"; message: string }
  | { type: "pong" };

/** 客户端 → 服务器消息 */
type ClientMessage =
  | { type: "hello"; memberId: string; token: string }
  | {
      type: "state";
      track: Track | null;
      state: "playing" | "paused" | "stopped";
      positionMs: number;
    }
  | { type: "report"; kind: "loadFailed"; trackId: string; trackTitle: string }
  | { type: "ping" }
  | { type: "leave" };

export const useListenTogetherStore = defineStore("listenTogether", () => {
  const media = useMediaStore();
  const status = useStatusStore();
  const license = useLicenseStore();

  /** 中继服务器地址（复用授权服务器） */
  const serverUrl = computed(() => license.serverUrl);
  /** 房间内昵称 */
  const nickname = ref("");

  /** WebSocket 连接状态 */
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
  /** 最近一次错误提示 */
  const lastError = ref("");

  /** 本机成员凭据（不参与渲染） */
  const memberId = ref("");
  const token = ref("");
  const ws = shallowRef<WebSocket | null>(null);
  /** 是否处于房间中（驱动 watcher / 定时器 / 重连） */
  const roomActive = ref(false);
  /** 用户主动断开标记：置位后不重连 */
  let manualClose = false;
  /** 重连退避当前值 */
  let reconnectDelayMs = 1_000;
  /** 上次推送内容，用于变化检测 */
  let lastPushed: { trackId: string | null; state: string; positionMs: number } | null = null;
  /** 成员跟随中的曲目（等待加载完成确认） */
  let pendingFollow: { trackId: string; expected: number; playing: boolean } | null = null;
  /** 本机无法播放的曲目 id（房主切歌前不再重试） */
  const lastFailedTrackId = ref("");
  /** 服务器时钟相对本机时钟的偏移（毫秒），每条消息刷新 */
  let serverOffsetMs = 0;
  /** 上次成员 id 快照，用于进出房间提示 */
  let prevMemberIds: string[] = [];

  let pushTimer: number | undefined;
  let pingTimer: number | undefined;
  let reconnectTimer: number | undefined;

  /** 服务器地址去尾斜杠 */
  const baseUrl = computed(() => serverUrl.value.replace(/\/+$/, ""));
  /** WebSocket 地址（http→ws，https→wss） */
  const wsUrl = computed(() => {
    const base = baseUrl.value.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    return `${base}/api/rooms/${code.value}/ws?memberId=${encodeURIComponent(memberId.value)}&token=${encodeURIComponent(token.value)}&key=${encodeURIComponent(license.machineKey)}`;
  });

  const stopTimers = (): void => {
    if (pushTimer !== undefined) window.clearInterval(pushTimer);
    if (pingTimer !== undefined) window.clearInterval(pingTimer);
    pushTimer = undefined;
    pingTimer = undefined;
  };

  const clearReconnect = (): void => {
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };

  /** 封装 REST 请求；非 2xx 抛带服务端文案的错误 */
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${baseUrl.value}${path}`, {
      headers: { "Content-Type": "application/json", "X-Auth-Key": license.machineKey },
      ...init,
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? body.detail ?? `HTTP ${res.status}`);
    }
    return body as T;
  };

  /** 发送 JSON 消息（连接未就绪时静默丢弃） */
  const send = (msg: ClientMessage): void => {
    if (ws.value?.readyState === WebSocket.OPEN) ws.value.send(JSON.stringify(msg));
  };

  const connect = (): void => {
    if (!code.value || !memberId.value || !token.value) return;
    roomActive.value = true;
    manualClose = false;
    connection.value = "connecting";
    const socket = new WebSocket(wsUrl.value);
    ws.value = socket;
    socket.onopen = () => {
      send({ type: "hello", memberId: memberId.value, token: token.value });
    };
    socket.onmessage = (event) => {
      try {
        handleMessage(JSON.parse(event.data as string) as ServerMessage);
      } catch {
        /* 忽略坏消息 */
      }
    };
    socket.onerror = () => {
      connection.value = "error";
    };
    socket.onclose = () => {
      ws.value = null;
      if (roomActive.value && !manualClose) {
        // 断线退避重连；重连成功后 welcome 会带最新状态，成员自动重新对齐
        clearReconnect();
        reconnectTimer = window.setTimeout(connect, reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
        connection.value = "error";
      } else if (!roomActive.value) {
        connection.value = "idle";
      }
    };
  };

  const handleMessage = (msg: ServerMessage): void => {
    // 刷新服务器时钟偏移（用于把状态里的服务器时间换算成本机时间）
    if ("serverNow" in msg) serverOffsetMs = msg.serverNow - Date.now();
    switch (msg.type) {
      case "welcome": {
        connection.value = "connected";
        reconnectDelayMs = 1_000;
        clearReconnect();
        role.value = msg.role;
        hostId.value = msg.hostId;
        members.value = msg.members;
        prevMemberIds = msg.members.map((m) => m.id);
        sharedState.value = msg.state;
        stopTimers();
        pushTimer = window.setInterval(() => pushState(), PUSH_INTERVAL_MS);
        pingTimer = window.setInterval(() => send({ type: "ping" }), PING_INTERVAL_MS);
        if (msg.role === "host") {
          // 房主重连后立即把自己当前状态推上去
          pushState(true);
        } else if (msg.state) {
          void applyState(msg.state);
        }
        break;
      }
      case "state": {
        // 房主不处理自己推送的广播（服务器也不会回灌给发送者，这里兜底）
        if (role.value === "host") break;
        sharedState.value = { ...msg.state, seq: msg.seq };
        void applyState(sharedState.value);
        break;
      }
      case "members": {
        const prev = new Set(prevMemberIds);
        for (const m of msg.members) {
          if (!prev.has(m.id)) {
            toast.info(i18n.global.t("listenTogether.memberJoined", { name: m.name }));
          }
        }
        for (const id of prevMemberIds) {
          if (!msg.members.some((m) => m.id === id)) {
            const gone = members.value.find((m) => m.id === id);
            if (gone) {
              toast.info(i18n.global.t("listenTogether.memberLeft", { name: gone.name }));
            }
          }
        }
        prevMemberIds = msg.members.map((m) => m.id);
        members.value = msg.members;
        hostId.value = msg.hostId;
        break;
      }
      case "event": {
        if (msg.kind === "loadFailed" && role.value === "host") {
          toast.warning(
            i18n.global.t("listenTogether.memberCannotPlay", {
              name: msg.name,
              title: msg.trackTitle,
            }),
            { duration: 5_000 },
          );
        }
        break;
      }
      case "role": {
        role.value = msg.role;
        if (msg.role === "host") {
          toast.success(i18n.global.t("listenTogether.promotedToHost"));
          pushState(true);
        }
        break;
      }
      case "error":
        lastError.value = msg.message;
        toast.error(msg.message);
        break;
      case "pong":
        break;
    }
  };

  /** 房主推送当前播放状态；非房主 / 未连接时忽略 */
  const pushState = (force = false): void => {
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
      Math.abs(lastPushed.positionMs - positionMs) >= PUSH_INTERVAL_MS;
    if (!changed) return;
    lastPushed = { trackId, state, positionMs };
    send({ type: "state", track: shareable ? track : null, state, positionMs });
  };

  /** 按服务器时间换算的目标进度（毫秒） */
  const expectedPosition = (s: ListenTogetherSharedState): number =>
    s.state === "playing" ? s.positionMs + (Date.now() + serverOffsetMs - s.at) : s.positionMs;

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
      // 切歌：走一次完整播放流程，加载成功后 seek 对齐并设置播放态
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
    send({ type: "report", kind: "loadFailed", trackId: track.id, trackTitle: track.title });
    toast.warning(
      i18n.global.t("listenTogether.cannotPlay", { title: track.title }),
      { duration: 5_000 },
    );
  };

  /** 创建房间并连接 */
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
      connect();
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      toast.error(i18n.global.t("listenTogether.createFailed"));
    }
  };

  /** 加入房间并连接 */
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
      connect();
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      toast.error(i18n.global.t("listenTogether.joinFailed"));
    }
  };

  /** 离开房间并断开连接 */
  const leaveRoom = async (): Promise<void> => {
    manualClose = true;
    roomActive.value = false;
    stopTimers();
    clearReconnect();
    if (ws.value) {
      try {
        ws.value.send(JSON.stringify({ type: "leave" }));
      } catch {
        /* 连接已断则忽略 */
      }
      ws.value.close();
    }
    ws.value = null;
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
    prevMemberIds = [];
  };

  // 房主侧：曲目 / 播放态变化时立即推送
  watch(
    () => media.track?.id,
    () => {
      if (roomActive.value && role.value === "host") pushState(true);
    },
  );
  watch(
    () => status.state,
    () => {
      if (roomActive.value && role.value === "host") pushState(true);
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
    lastError,
    createRoom,
    joinRoom,
    leaveRoom,
  };
});
