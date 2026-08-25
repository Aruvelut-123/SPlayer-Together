/**
 * 一起听：主进程轻量 HTTP 客户端
 * MCP 工具通过它操作中继服务器的房间（创建 / 加入 / 查询 / 离开），
 * 与渲染进程的 listenTogether store 共用同一套 REST 协议。
 */

import { store } from "@main/store";

/** 默认中继服务器地址（与 shared/defaults/settings.ts 保持一致） */
const DEFAULT_RELAY_SERVER = "http://47.122.127.107:8000";

/** 当前房间会话（member 凭据，供后续请求携带） */
interface RoomSession {
  code: string;
  memberId: string;
  token: string;
}

let session: RoomSession | null = null;

/** 读取配置的中继服务器地址，去尾斜杠 */
const relayBaseUrl = (): string => {
  const custom = store.get("system.relayServerUrl");
  return (custom?.trim() || DEFAULT_RELAY_SERVER).replace(/\/+$/, "");
};

/** 封装 REST 请求；非 2xx 抛带服务端文案的错误 */
const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(session ? { "X-Member-Id": session.memberId, "X-Token": session.token } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${relayBaseUrl()}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(String(body.error ?? `HTTP ${res.status}`));
  }
  return body as T;
};

/** 房间快照中的共享状态 */
export interface ListenTogetherSharedState {
  track: Record<string, unknown> | null;
  state: "playing" | "paused" | "stopped";
  positionMs: number;
  at: number;
  seq: number;
  playIndex: number;
  repeatMode: "list" | "one";
  shuffleMode: "off" | "on";
}

/** 房间成员 */
export interface ListenTogetherMember {
  id: string;
  name: string;
  role: "host" | "guest";
}

/** 服务器房间快照 */
export interface ListenTogetherSnapshot {
  seq: number;
  state: ListenTogetherSharedState | null;
  members: ListenTogetherMember[];
  hostId: string;
  queue: Record<string, unknown>[] | null;
  reports: { kind: string; name: string; trackTitle: string }[];
  lastActor: string | null;
  serverNow: number;
  closed?: boolean;
  conflict?: boolean;
  snapshot?: ListenTogetherSnapshot;
}

/** 当前是否已加入房间 */
export const isInRoom = (): boolean => session !== null;

/** 当前所加入的房间码 */
export const currentRoomCode = (): string | null => session?.code ?? null;

/** 当前房间成员名 */
export const currentMemberName = (): string => {
  if (!session) return "";
  return `成员-${session.memberId.slice(0, 4)}`;
};

/**
 * 创建房间并成为房主
 * @param name - 房主昵称
 * @returns 房间码与成员凭据
 */
export const createRoom = async (
  name = "我",
): Promise<{ code: string; memberId: string; token: string }> => {
  const res = await api<{ code: string; memberId: string; token: string }>("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name: name.trim() || "我" }),
  });
  session = { code: res.code, memberId: res.memberId, token: res.token };
  return res;
};

/**
 * 加入指定房间
 * @param roomCode - 房间码
 * @param name - 成员昵称
 * @returns 成员凭据
 */
export const joinRoom = async (
  roomCode: string,
  name = "我",
): Promise<{ memberId: string; token: string }> => {
  const code = roomCode.trim().toUpperCase();
  if (!code) throw new Error("房间码不能为空");
  const res = await api<{ memberId: string; token: string }>(
    `/api/rooms/${encodeURIComponent(code)}/join`,
    {
      method: "POST",
      body: JSON.stringify({ name: name.trim() || "我" }),
    },
  );
  session = { code, memberId: res.memberId, token: res.token };
  return res;
};

/** 拉取当前房间快照（含状态、成员、队列、报告） */
export const getRoomSnapshot = async (): Promise<ListenTogetherSnapshot> => {
  if (!session) throw new Error("尚未加入任何一起听房间");
  const snap = await api<ListenTogetherSnapshot>(`/api/rooms/${session.code}/state`);
  if (snap.closed) {
    session = null;
    throw new Error("房间已关闭");
  }
  return snap;
};

/** 离开当前房间 */
export const leaveRoom = async (): Promise<void> => {
  if (!session) return;
  try {
    await api<{ ok: boolean }>(`/api/rooms/${session.code}/leave`, { method: "POST" });
  } finally {
    session = null;
  }
};

/** 重置本模块的房间会话（本地状态，不通知服务器） */
export const resetRoomSession = (): void => {
  session = null;
};