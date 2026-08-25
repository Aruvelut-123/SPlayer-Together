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
 * 所有成员周期性拉取快照，房主与获权成员可推送状态。通过 lastActor + baseSeq 乐观锁
 * 解决多写者冲突，强制跟随确保无权限成员始终与房主同步。
 */

/** 可跨设备共享的在线平台来源 */
const SHAREABLE_SOURCES = new Set(["netease", "qqmusic", "kugou"]);

/** 推送 / 拉取间隔（毫秒），更快的间隔让切歌同步更及时 */
const SYNC_INTERVAL_MS = 500;
/** 漂移纠正阈值，超过则 seek 对齐。越大越不频繁 seek，减少卡顿 */
const DRIFT_THRESHOLD_MS = 800;
/** 加载失败冷却期（毫秒），同一首歌在此期间不重复加载 */
const LOAD_FAIL_COOLDOWN_MS = 8_000;

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
  at: number;
  seq: number;
  playIndex: number;
  repeatMode: "list" | "one";
  shuffleMode: "off" | "on";
}

interface SharedStatePayload {
  track: Track | null;
  state: "playing" | "paused" | "stopped";
  positionMs: number;
  at: number;
  playIndex: number;
  repeatMode: "list" | "one";
  shuffleMode: "off" | "on";
}

interface RoomReport {
  kind: string;
  name: string;
  trackTitle: string;
}

interface MemberPermissions {
  allowGuestControl?: boolean;
  allowGuestEditPlaylist?: boolean;
}

/** 服务器快照返回的权限结构 */
interface RoomPermissions {
  allowGuestControl: boolean;
  allowGuestEditPlaylist: boolean;
  members: Record<string, MemberPermissions>;
}

/** 服务器房间快照 */
interface RoomSnapshot {
  seq: number;
  state: SharedStatePayload | null;
  members: ListenTogetherMember[];
  hostId: string;
  queue: Track[] | null;
  reports: RoomReport[];
  permissions: RoomPermissions;
  lastActor: string | null;
  serverNow: number;
  closed?: boolean;
  conflict?: boolean;
  snapshot?: RoomSnapshot;
}

/** 房主控制的成员权限 */
export interface ListenTogetherPermissions {
  allowGuestControl: boolean;
  allowGuestEditPlaylist: boolean;
  members?: Record<string, MemberPermissions>;
}

export const useListenTogetherStore = defineStore("listenTogether", () => {
  const media = useMediaStore();
  const status = useStatusStore();
  const license = useLicenseStore();
  const user = useUserStore();

  /** 昵称固定为网易云账号名，不提供编辑（一起听要求登录后才可进入） */
  const nickname = computed(() => user.profile?.nickname || i18n.global.t("listenTogether.me"));

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
    members: {},
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
  /** 本机无法播放的曲目 id + 时间戳，冷却期内不重试 */
  let lastFailedAt = 0;
  let lastFailedTrackId = "";
  /** 本机是否正在跟随远端状态（跟随时不触发 watch 回推） */
  let isFollowing = false;
  /** 已知的服务器 seq，用于乐观锁 push */
  let knownSeq = 0;

  let syncTimer: number | undefined;

  /** 服务器地址去尾斜杠 */
  const baseUrl = computed(() => license.serverUrl.replace(/\/+$/, ""));

  /** 房间成员请求头 */
  const memberHeaders = (): Record<string, string> => ({
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
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(String(body.error ?? `HTTP ${res.status}`));
    }
    return body as T;
  };

  const stopTimers = (): void => {
    if (syncTimer !== undefined) window.clearInterval(syncTimer);
    syncTimer = undefined;
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

  /** 检查当前 member 是否有某项权限（per-member 覆盖全局） */
  const permFor = (key: "allowGuestControl" | "allowGuestEditPlaylist"): boolean => {
    const p = permissions.value;
    const memberOverride = p.members?.[memberId.value];
    if (memberOverride && key in memberOverride) return memberOverride[key]!;
    return p[key];
  };

  /** 应用房主队列（内容不一致才替换，避免无谓刷新） */
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
    // 权限合并：保留 old members 覆盖，新快照 members 替换
    if (snap.permissions) {
      permissions.value = {
        allowGuestControl: snap.permissions.allowGuestControl,
        allowGuestEditPlaylist: snap.permissions.allowGuestEditPlaylist,
        members: snap.permissions.members ?? {},
      };
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
    // 所有成员共享同一播放列表
    if (snap.queue) {
      applyQueue(snap.queue);
    }
    roomQueue.value = snap.queue ?? [];
    if (snap.state) {
      sharedState.value = { ...snap.state, seq: snap.seq };
    }
    // 房主身份变化
    if (snap.hostId === memberId.value && role.value !== "host") {
      role.value = "host";
      toast.success(i18n.global.t("listenTogether.promotedToHost"));
      // 转移后立即推送自己的状态
      void pushState(true);
      void pushQueue();
    } else if (snap.hostId !== memberId.value && role.value === "host") {
      role.value = "guest";
      toast.info(i18n.global.t("listenTogether.demotedToGuest"));
    }
  };

  /** 推送播放状态（房主或获权 guest 可推；支持乐观锁防覆盖） */
  const pushState = async (force = false): Promise<void> => {
    if (!roomActive.value) return;
    if (role.value !== "host" && !permFor("allowGuestControl")) return;
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
    const heartbeatDue = Date.now() - lastHeartbeatAt > 5_000;
    if (!changed && !heartbeatDue) return;
    lastHeartbeatAt = Date.now();
    lastPushed = { trackId, state, positionMs };
    try {
      const snap = await api<RoomSnapshot>(`/api/rooms/${code.value}/state`, {
        method: "POST",
        body: JSON.stringify({
          track: shareable ? track : null,
          state,
          positionMs,
          playIndex: shareable ? status.playIndex : -1,
          repeatMode: status.repeatMode,
          shuffleMode: status.shuffleMode,
          baseSeq: knownSeq,
        }),
      });
      // 乐观锁冲突：别人先更新了状态，本机跟随
      if (snap.conflict) {
        knownSeq = snap.snapshot!.seq;
        applyRoomView(snap.snapshot!);
        if (snap.snapshot!.state && snap.snapshot!.lastActor !== memberId.value) {
          await applyState({
            ...snap.snapshot!.state,
            seq: snap.snapshot!.seq,
          } as ListenTogetherSharedState);
        }
        return;
      }
      knownSeq = snap.seq;
      connection.value = "connected";
      applyRoomView(snap);
    } catch (err) {
      if (handleRoomGone(err)) return;
      connection.value = "error";
    }
  };

  /** 推送播放列表（房主或获权编辑的 guest） */
  const pushQueue = async (): Promise<void> => {
    if (!roomActive.value) return;
    if (role.value !== "host" && !permFor("allowGuestEditPlaylist")) return;
    const tracks = queueStore.value;
    const key = tracks.map((t) => t.id).join("\u0000");
    if (key === lastPushedQueueKey) return;
    lastPushedQueueKey = key;
    try {
      const snap = await api<RoomSnapshot>(`/api/rooms/${code.value}/queue`, {
        method: "POST",
        body: JSON.stringify({ tracks }),
      });
      knownSeq = snap.seq;
      applyRoomView(snap);
    } catch (err) {
      if (handleRoomGone(err)) return;
    }
  };

  /** 拉取房间快照并跟随，所有成员（含 host）都参与，确保 lastActor 一致性 */
  const syncState = async (): Promise<void> => {
    if (!roomActive.value) return;
    try {
      const snap = await api<RoomSnapshot>(`/api/rooms/${code.value}/state`);
      // 房间已关闭（房主离开 / 管理员解散 / 清理）→ 优雅退出
      if (snap.closed) {
        if (role.value !== "none") {
          toast.warning(i18n.global.t("listenTogether.roomClosed"), { duration: 4_000 });
        }
        void leaveRoom();
        return;
      }
      connection.value = "connected";
      knownSeq = snap.seq;
      applyRoomView(snap);
      // 跟随 lastActor：自己推的不跟随，其他情况都跟随（含 host 跟随 guest）
      if (snap.state && snap.lastActor !== memberId.value) {
        await applyState({ ...snap.state, seq: snap.seq } as ListenTogetherSharedState);
      }
    } catch (err) {
      if (handleRoomGone(err)) return;
      connection.value = "error";
    }
  };

  /** 跟随远端状态：切歌 / 漂移纠正 / 播放态对齐 / 模式同步 */
  const applyState = async (s: ListenTogetherSharedState): Promise<void> => {
    if (!roomActive.value) return;
    const sharedTrack = s.track;
    // 不可共享的曲目（如本地文件）→ 暂停
    if (!sharedTrack || !SHAREABLE_SOURCES.has(sharedTrack.source)) {
      if (status.isPlaying) await player.pause();
      return;
    }
    // 同步播放模式（不洗队列不弹 toast）
    player.applyRemotePlayMode(s.repeatMode, s.shuffleMode);

    const myTrack = media.track;
    // 同一首歌：仅做漂移纠正与播放态对齐
    if (myTrack?.id === sharedTrack.id) {
      if (s.state === "playing") {
        const target = expectedPosition(s);
        if (Math.abs(status.position - target) > DRIFT_THRESHOLD_MS) await player.seek(target, true);
        if (!status.isPlaying) await player.play();
      } else if (status.isPlaying) {
        await player.pause();
      }
      return;
    }

    // 不同歌：跟随切歌
    // 同一目标仍在加载则不重复触发
    if (pendingFollow?.trackId === sharedTrack.id) {
      pendingFollow.expected = expectedPosition(s);
      pendingFollow.playing = s.state === "playing";
      return;
    }

    // 加载失败冷却期内跳过（但不阻止播放其他歌——如果 host 切到新歌，冷却期应重置）
    if (lastFailedTrackId === sharedTrack.id && Date.now() - lastFailedAt < LOAD_FAIL_COOLDOWN_MS) {
      // 冷却期内 guest 不能播别的歌：如果正在播别的歌，暂停强制等待
      if (myTrack && myTrack.id !== sharedTrack.id && role.value !== "host" && !permFor("allowGuestControl")) {
        await player.pause();
      }
      return;
    }

    // 开始跟随：递增 trackToken 取消在途旧加载
    isFollowing = true;
    const myToken = player.advanceTrackToken();
    pendingFollow = {
      trackId: sharedTrack.id,
      expected: expectedPosition(s),
      playing: s.state === "playing",
      trackToken: myToken,
    };

    // 从本地队列取同 id 的 Track（避免 host 特有字段导致解析失败）
    const localTrack = queueStore.value.find((t) => t.id === sharedTrack.id) ?? sharedTrack;
    const prevSource = status.currentSource;

    try {
      // 使用 loadTrack 直接加载，不修改队列顺序（不插队）
      // suppressSkip=true 防止加载失败自动跳到其他歌
      await player.loadTrack(localTrack, status.currentPlaybackContext, true);
    } catch {
      pendingFollow = null;
      isFollowing = false;
      lastFailedTrackId = sharedTrack.id;
      lastFailedAt = Date.now();
      reportLoadFailed(sharedTrack);
      return;
    }

    // 加载期间被更新的切歌接管
    if (pendingFollow.trackToken !== myToken) {
      isFollowing = false;
      return;
    }

    // 验证加载结果
    const loadedOk =
      media.track?.id === sharedTrack.id &&
      !!status.currentSource &&
      status.currentSource !== prevSource;
    if (!loadedOk) {
      pendingFollow = null;
      isFollowing = false;
      lastFailedTrackId = sharedTrack.id;
      lastFailedAt = Date.now();
      reportLoadFailed(sharedTrack);
      return;
    }

    // 成功跟随
    isFollowing = false;
    lastFailedTrackId = "";
    lastFailedAt = 0;
    pendingFollow = null;

    // 对齐队列高亮
    const queueIndex = queueStore.value.findIndex((t) => t.id === sharedTrack.id);
    if (queueIndex >= 0) status.playIndex = queueIndex;

    // 进度对齐
    const target = expectedPosition(s);
    if (target > 500) await player.seek(target, true);
    if (s.state === "playing") {
      if (!status.isPlaying) await player.play();
    } else if (status.isPlaying) {
      await player.pause();
    }
  };

  /** 上报本机无法播放 */
  const reportLoadFailed = (track: Track): void => {
    void api<{ ok: boolean }>(`/api/rooms/${code.value}/report`, {
      method: "POST",
      body: JSON.stringify({ kind: "loadFailed", trackId: track.id, trackTitle: track.title }),
    }).catch(() => {});
    toast.warning(i18n.global.t("listenTogether.cannotPlay", { title: track.title }), {
      duration: 5_000,
    });
  };

  /** 启动同步定时器 */
  const startTimers = (): void => {
    stopTimers();
    // 周期任务：拉取快照 + host 主动推心跳与位置
    syncTimer = window.setInterval(() => {
      void syncState();
      if (role.value === "host") {
        void pushState(); // host 周期性推位置（心跳 + 位置同步），服务器据此刷新 host_last_push
      }
    }, SYNC_INTERVAL_MS);
    // 首次同步
    void syncState();
    // 首次推送（host 立即推，guest 不主动推，跟随后等主动操作推）
    if (role.value === "host") {
      void pushState(true);
      void pushQueue();
    }
  };

  /** 创建房间 */
  const createRoom = async (): Promise<void> => {
    await leaveRoom();
    try {
      const res = await api<{ code: string; memberId: string; token: string }>("/api/rooms", {
        method: "POST",
        body: JSON.stringify({ name: nickname.value }),
      });
      code.value = res.code;
      memberId.value = res.memberId;
      token.value = res.token;
      role.value = "host";
      roomActive.value = true;
      connection.value = "connecting";
      knownSeq = 0;
      startTimers();
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      toast.error(i18n.global.t("listenTogether.createFailed"));
      connection.value = "error";
    }
  };

  /** 加入房间 */
  const joinRoom = async (roomCode: string): Promise<void> => {
    await leaveRoom();
    const trimmed = roomCode.trim();
    if (!trimmed) return;
    try {
      const res = await api<{ memberId: string; token: string }>(
        `/api/rooms/${encodeURIComponent(trimmed)}/join`,
        {
          method: "POST",
          body: JSON.stringify({ name: nickname.value }),
        },
      );
      code.value = trimmed;
      memberId.value = res.memberId;
      token.value = res.token;
      role.value = "guest";
      roomActive.value = true;
      connection.value = "connecting";
      knownSeq = 0;
      startTimers();
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : String(err);
      toast.error(i18n.global.t("listenTogether.joinFailed"));
      connection.value = "error";
    }
  };

  /** 离开房间 */
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
    lastFailedTrackId = "";
    lastFailedAt = 0;
    pendingFollow = null;
    lastPushed = null;
    lastPushedQueueKey = "";
    prevMemberIds = [];
    isFollowing = false;
    knownSeq = 0;
    permissions.value = { allowGuestControl: true, allowGuestEditPlaylist: true, members: {} };
  };

  /** 设置权限（支持 per-member） */
  const setPermissions = async (next: Partial<ListenTogetherPermissions> & { memberId?: string }): Promise<void> => {
    if (role.value !== "host" || !roomActive.value) return;
    try {
      const snap = await api<RoomSnapshot>(`/api/rooms/${code.value}/permissions`, {
        method: "POST",
        body: JSON.stringify({
          allowGuestControl: next.allowGuestControl ?? permissions.value.allowGuestControl,
          allowGuestEditPlaylist:
            next.allowGuestEditPlaylist ?? permissions.value.allowGuestEditPlaylist,
          memberId: next.memberId,
        }),
      });
      knownSeq = snap.seq;
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
      knownSeq = snap.seq;
      applyRoomView(snap);
    } catch (err) {
      if (handleRoomGone(err)) return;
    }
  };

  // 本地操作变化时主动推送（跟随时 isFollowing 为 true，不触发回推）
  watch(
    () => media.track?.id,
    () => {
      if (roomActive.value && !isFollowing && (role.value === "host" || permFor("allowGuestControl"))) {
        void pushState(true);
      }
    },
  );
  watch(
    () => status.state,
    () => {
      if (roomActive.value && !isFollowing && (role.value === "host" || permFor("allowGuestControl"))) {
        void pushState(true);
      }
    },
  );

  // 队列变化推送（host 或获权编辑的 guest）
  watch(
    () => queueStore.value.map((t) => t.id).join("\u0000"),
    () => {
      if (roomActive.value && (role.value === "host" || permFor("allowGuestEditPlaylist"))) {
        void pushQueue();
      }
    },
  );

  // 一起听期间禁止本地音乐
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

  // 监听用户主动 seek：有控制权时立即推位置抢权威
  const onPlayerSeek = (): void => {
    if (!roomActive.value) return;
    if (role.value !== "host" && !permFor("allowGuestControl")) return;
    void pushState(true);
  };
  window.addEventListener("player:seek", onPlayerSeek);

  onScopeDispose(() => {
    window.removeEventListener("player:seek", onPlayerSeek);
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