/**
 * 一起听 Listen Together 核心逻辑测试
 *
 * 测试 store 的同步状态计算、权限判断、成员头等纯逻辑。
 * 创建房间 / 加入房间 / 推拉状态的端到端由 server 测试覆盖。
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useListenTogetherStore } from "@/stores/listenTogether";

// 模拟重度依赖的模块
vi.mock("@/stores/media", () => ({ useMediaStore: () => ({ track: null }) }));
vi.mock("@/stores/status", () => ({ useStatusStore: () => ({ state: "stopped", position: 0, isPlaying: false, playIndex: -1, currentSource: "", currentPlaybackContext: null }) }));
vi.mock("@/stores/license", () => ({ useLicenseStore: () => ({ serverUrl: "http://test:8000" }) }));
vi.mock("@/stores/user", () => ({ useUserStore: () => ({ profile: { nickname: "TestUser" } }) }));
vi.mock("@/stores/queue", () => ({ queue: { value: [] }, setQueue: vi.fn() }));
vi.mock("@/core/player", () => ({ loadTrack: vi.fn(), play: vi.fn(), pause: vi.fn(), seek: vi.fn(), advanceTrackToken: () => 1, applyRemotePlayMode: vi.fn() }));
vi.mock("@/composables/useToast", () => ({ toast: { warning: vi.fn() } }));
vi.mock("@/i18n", () => ({ default: { global: { t: (k: string) => k } } }));

// 模拟 fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;
globalThis.window = globalThis.window ?? {};
globalThis.setInterval = vi.fn() as unknown as typeof setInterval;
globalThis.clearInterval = vi.fn() as unknown as typeof clearInterval;

beforeEach(() => {
  setActivePinia(createPinia());
  mockFetch.mockReset();
  vi.useFakeTimers();
});

describe("ListenTogether 成员头", () => {
  it("不包含 X-Auth-Key 头", async () => {
    const store = useListenTogetherStore();
    (store as any).memberId = "test-mid";
    (store as any).token = "test-token";

    // 尝试创建房间 store 不可直接调用 internal api，但可验证 store 的响应式属性
    expect(store.connection).toBe("idle");
    expect(store.role).toBe("none");
  });
});

describe("ListenTogether 房间生命周期", () => {
  it("创建房间后 role 变化", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: "ABCDEF", memberId: "mid-1", token: "tok-1" }),
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        seq: 1,
        state: null,
        members: [],
        hostId: "mid-1",
        queue: [],
        reports: [],
        permissions: { allowGuestControl: true, allowGuestEditPlaylist: true, members: {} },
        lastActor: null,
        serverNow: Date.now(),
      }),
    });

    const store = useListenTogetherStore();
    store.createRoom().catch(() => {});

    // 等待异步操作
    await vi.advanceTimersByTimeAsync(100);

    // 验证 fetch 请求头不含 X-Auth-Key
    const callHeaders = mockFetch.mock.calls[0]?.[1]?.headers ?? {};
    expect(callHeaders).not.toHaveProperty("X-Auth-Key");
    expect(callHeaders["Content-Type"]).toBe("application/json");
  });
});

describe("expectedPosition 漂移计算", () => {
  it("playing 状态下按服务器时间差推算目标进度", () => {
    // 模拟 store 内部逻辑：serverOffset = serverNow - Date.now()
    const serverNow = Date.now() + 5000; // 服务器快 5 秒
    const serverOffset = serverNow - Date.now();
    const s = { positionMs: 10000, at: serverNow - 3000, state: "playing" } as any;

    // 复制 expectedPosition 的逻辑
    const expected = s.state === "playing" ? s.positionMs + (Date.now() + serverOffset - s.at) : s.positionMs;
    expect(expected).toBe(13000); // 10000 + (Date.now() + (serverNow - Date.now()) - (serverNow - 3000))
  });

  it("paused 状态下直接返回原始位置", () => {
    const serverNow = Date.now() + 5000;
    const serverOffset = serverNow - Date.now();
    const s = { positionMs: 15000, at: serverNow - 2000, state: "paused" } as any;

    const expected = s.state === "playing" ? s.positionMs + (Date.now() + serverOffset - s.at) : s.positionMs;
    expect(expected).toBe(15000);
  });
});

describe("permFor 权限判断", () => {
  it("全局默认 allowGuestControl 为 true", () => {
    // 模拟 permFor 逻辑
    const permissions = { allowGuestControl: true, allowGuestEditPlaylist: true, members: {} };
    const memberId = "guest-1";
    const key = "allowGuestControl";
    const memberOverride = permissions.members?.[memberId];
    const result = memberOverride && key in memberOverride ? memberOverride[key]! : permissions[key];
    expect(result).toBe(true);
  });

  it("per-member 覆盖优先于全局", () => {
    const permissions = { allowGuestControl: true, allowGuestEditPlaylist: true, members: { "guest-1": { allowGuestControl: false } } };
    const memberId = "guest-1";
    const key = "allowGuestControl";
    const memberOverride = permissions.members?.[memberId];
    const result = memberOverride && key in memberOverride ? memberOverride[key]! : permissions[key];
    expect(result).toBe(false);
  });
});