/**
 * 插件系统共享类型
 * 用于主进程、预加载、渲染进程、沙箱子进程之间的契约
 */

import type { LyricLine } from "./lyrics";
import type { Track } from "./player";

/**
 * 支持的插件动作
 */
export type PluginAction = "musicUrl" | "menuClick";

/**
 * 音质等级
 * 对齐 src/utils/quality.ts 的 QualityLevel（去掉 null），保持宿主与插件一致
 * - hi-res：高解析度无损（采样率 ≥ 96kHz + 位深 ≥ 24bit）
 * - lossless：无损（flac/ape/wav 等）
 * - hq：有损 ≥ 320kbps
 * - sq：有损 ≥ 192kbps
 * - lq：有损 < 192kbps
 */
export type PluginQuality = "hi-res" | "lossless" | "hq" | "sq" | "lq";

/** 插件类型清单：运行时校验与分类的唯一来源，新增类型只改这里 */
export const PLUGIN_TYPES = ["source", "control"] as const;
/** 插件类型：音源（解析 URL）/ 控制（监听状态 + 反向控制） */
export type PluginType = (typeof PLUGIN_TYPES)[number];

/** 插件可声明的权限清单 */
export const PLUGIN_GRANTS = ["network", "control", "ui", "isolate"] as const;
/** 插件权限：network 联网 / control 控制播放器 / ui 扩展界面 / isolate 开嵌套子沙箱 */
export type PluginGrant = (typeof PLUGIN_GRANTS)[number];

/** 控制类插件可订阅的高层播放事件 */
export type PlaybackEventKind = "trackChange" | "lyricChange" | "lineChange" | "playStateChange";

/** 各高层事件的载荷 */
export interface PlaybackEventData {
  /** 曲目切换 */
  trackChange: { track: Track | null };
  /** 歌词数据 */
  lyricChange: { lines: LyricLine[] };
  /** 当前行索引变化 */
  lineChange: { index: number; position: number };
  /** 播放态变化 */
  playStateChange: { state: "playing" | "paused" | "stopped"; position: number };
}

/** 控制类插件注册的配置项类型（安全子集） */
export type PluginSettingType = "switch" | "number" | "text" | "select";

/** 控制类插件注册的单个配置项 */
export interface PluginSettingItem {
  key: string;
  type: PluginSettingType;
  /** 纯字符串展示名，不做多语言 */
  label: string;
  description?: string;
  default: boolean | number | string;
  /** number 专用 */
  min?: number;
  max?: number;
  /** text 专用 */
  placeholder?: string;
  /** select 专用 */
  options?: { label: string; value: string }[];
}

/**
 * UI 类插件向歌曲菜单贡献的单个菜单项
 */
export interface PluginMenuItem {
  /** 菜单项 id */
  id: string;
  /** 展示名 */
  label: string;
  /** 仅对这些来源（如 local/streaming）的歌曲显示；缺省对所有歌曲显示 */
  sources?: string[];
}

/** 控制/UI 类注册上报的载荷（worker → 主进程的 registered 消息与注册表回调共用） */
export interface PluginRegistration {
  events: PlaybackEventKind[];
  controls: boolean;
  settings: PluginSettingItem[];
  menus: PluginMenuItem[];
}

/** register 入参：音源类用 sources，控制类用 events/controls/settings，UI 类用 menus */
export interface RegisterArgs {
  sources?: Record<string, SourceCapability>;
  events?: PlaybackEventKind[];
  controls?: boolean;
  settings?: PluginSettingItem[];
  menus?: PluginMenuItem[];
}

/** 控制类插件可用的播放面 */
export interface PluginPlayerApi {
  on<K extends PlaybackEventKind>(kind: K, handler: (data: PlaybackEventData[K]) => void): void;
  play(): void;
  pause(): void;
  next(): void;
  prev(): void;
  seek(positionMs: number): void;
  setVolume(volume: number): void;
  getPosition(): Promise<number>;
}

/** 插件头部 JSDoc 元数据 */
export interface PluginManifest {
  /** 插件唯一 ID：作者声明的 @id 优先，否则按 `平台.名称` 兜底；跨版本/改源码均不变 */
  id: string;
  /** 展示名 */
  name: string;
  /** 版本号 */
  version: string;
  /** 简介 */
  description?: string;
  /** 作者 */
  author?: string;
  /** 主页 */
  homepage?: string;
  /** 声明的权限 */
  grant: PluginGrant[];
  /** 插件类型，来自 @type 头，缺省 "source" */
  type?: PluginType;
  /** 声明兼容的 Host API 级别 */
  apiLevel: number;
  /** 源码 SHA1（内容指纹，用于校验下载完整性） */
  hash: string;
  /** 更新检查地址（来自 @updateUrl，指向 raw .js）；宿主拉取后读其 @version 与本地比对 */
  updateUrl?: string;
  /** 更新说明（来自 @changelog）；检查到新版时取远端这一份展示在卡片上 */
  changelog?: string;
  /** 安装时间戳（ms） */
  installedAt: number;
  /** 末次原地更新时间戳（ms），未更新过则缺省 */
  updatedAt?: number;
  /** 脚本相对 `{userData}/app-data/plugins/scripts/` 的文件名 */
  fileName: string;
}

/** 单个源（如 kw/kg）的能力声明 */
export interface SourceCapability {
  /** 展示名 */
  name: string;
  /** 支持的动作 */
  actions: PluginAction[];
  /** 支持的音质 */
  qualities?: PluginQuality[];
}

/** 插件运行状态 */
export type PluginStatus =
  | { state: "unloaded" }
  | { state: "loading" }
  | {
      state: "ready";
      sources: Record<string, SourceCapability>;
      /** 控制类附加信息 */
      events?: PlaybackEventKind[];
      controls?: boolean;
      settings?: PluginSettingItem[];
      /** UI 类贡献的菜单项 */
      menus?: PluginMenuItem[];
    }
  | { state: "error"; error: { code: string; message: string } }
  | { state: "disabled" };

/** 插件脚本自己上报的更新信息 */
export interface PluginUpdateInfo {
  /** 新版本号（若脚本提供） */
  version?: string;
  /** 人类可读的更新说明 */
  log?: string;
  /** 新版本下载/介绍页链接 */
  updateUrl?: string;
  /** 收到更新提示的时间戳（ms） */
  updatedAt: number;
}

/** 渲染端看到的插件条目（manifest + 状态） */
export interface PluginInfo {
  manifest: PluginManifest;
  enabled: boolean;
  status: PluginStatus;
  /** 脚本上报过"有新版本"时填充，用户更新/卸载后清空 */
  updateInfo?: PluginUpdateInfo | null;
  /** 控制类插件的当前设置值 */
  settingsValues?: Record<string, unknown>;
}

/* ========== 调用请求 / 响应 ========== */

export interface MusicUrlReq {
  source: string;
  quality: PluginQuality;
  musicInfo: {
    songmid: string;
    name?: string;
    singer?: string;
    [key: string]: unknown;
  };
}
export interface MusicUrlRes {
  url: string;
  quality?: PluginQuality;
  expire?: number;
}

export interface MenuClickReq {
  /** 被点击的菜单项 id */
  menuId: string;
  /** 当前歌曲上下文 */
  track: Track;
}
export interface MenuClickRes {
  /** 执行后给用户的提示文案 */
  toast?: string;
  /** 用系统浏览器打开此链接（仅 http/https） */
  openUrl?: string;
  /** 写入剪贴板的文本 */
  copyText?: string;
}

/** Action → 请求/响应映射，用于 HostApi.on 的重载。新增动作时在此追加。 */
export interface ActionIO {
  musicUrl: { req: MusicUrlReq; res: MusicUrlRes };
  menuClick: { req: MenuClickReq; res: MenuClickRes };
}

/* 宿主暴露给插件的 API */
export interface HostRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | Uint8Array;
  /** 毫秒，默认 15000，最大 60000 */
  timeout?: number;
  /** 默认 text；arraybuffer 返回 Uint8Array */
  responseType?: "text" | "json" | "arraybuffer";
}

export interface HostRequestResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface HostLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface HostStorage {
  get: <T = unknown>(key: string) => Promise<T | null>;
  set: (key: string, value: unknown) => Promise<void>;
  remove: (key: string) => Promise<void>;
  keys: () => Promise<string[]>;
}

/** 嵌套隔离上下文句柄（插件套插件：在更深的 vm 子沙箱里跑子代码） */
export interface IsolateHandle {
  /** 在隔离上下文里执行一段代码，返回其求值结果（同步，5s 超时） */
  run: (code: string) => unknown;
  /** 向隔离上下文发消息，触发其 onmessage */
  sendMessage: (data: unknown) => void;
  /** 注册接收隔离上下文 postMessage 的回调 */
  onMessage: (handler: (data: unknown) => void) => void;
  /** 销毁隔离上下文（清其定时器） */
  destroy: () => void;
}

/** 注入沙箱的全局对象形状 */
export interface HostApi {
  readonly pluginId: string;
  readonly apiLevel: number;
  readonly locale: string;
  readonly appVersion: string;

  /** 发起网络请求 */
  request: (url: string, opts?: HostRequestOptions) => Promise<HostRequestResult>;

  /** 声明能力 */
  register: (args: RegisterArgs) => void;

  /** 注册动作处理器 */
  on: <A extends PluginAction>(
    action: A,
    handler: (req: ActionIO[A]["req"]) => Promise<ActionIO[A]["res"]>,
  ) => void;

  /** 日志 */
  log: HostLogger;

  /** 每插件隔离 KV */
  storage: HostStorage;

  /** 用户在设置里为此插件配置的值 */
  getSetting: <T = unknown>(key: string) => T | undefined;

  /** 控制类播放面：监听高层事件 + 反向控制 */
  player: PluginPlayerApi;

  /** 控制类设置变更回调：用户改设置后触发 */
  onSettingChange: (key: string, handler: (value: unknown) => void) => void;

  /** 创建嵌套子沙箱（需 isolate 权限，每插件上限 ISOLATE_MAX_PER_PLUGIN）；未授权则缺省 */
  createIsolate?: () => IsolateHandle;
}

/* ========== 沙箱 ↔ 主进程消息协议 ========== */

export interface PluginErrorPayload {
  code: string;
  message: string;
}

/**
 * 主 ↔ 插件 host 的消息协议
 * 一个 host 进程托管多个插件 vm 上下文：按插件的消息带 pluginId 路由，
 * loadPlugin/unloadPlugin/ping 为 host 级控制消息。
 */
export type SandboxIn =
  | {
      kind: "loadPlugin";
      pluginId: string;
      apiLevel: number;
      /** 插件已授予的权限（worker 内 createIsolate 等按此门控） */
      grant: PluginGrant[];
      locale: string;
      appVersion: string;
      userSettings: Record<string, unknown>;
      source: string;
      scriptInfo: {
        name: string;
        description: string;
        version: string;
        author: string;
        homepage: string;
      };
    }
  | { kind: "unloadPlugin"; pluginId: string }
  | { kind: "call"; pluginId: string; requestId: string; action: PluginAction; params: unknown }
  | { kind: "cancel"; pluginId: string; requestId: string }
  | {
      kind: "hostResult";
      pluginId: string;
      callId: string;
      ok: boolean;
      data?: unknown;
      error?: PluginErrorPayload;
    }
  | { kind: "ping" }
  | { kind: "event"; pluginId: string; event: PlaybackEventKind; data: unknown }
  | { kind: "settingsUpdate"; pluginId: string; settings: Record<string, unknown> };

/** 插件 host → 主 */
export type SandboxOut =
  /** host 进程 fork 后就绪一次（无 pluginId） */
  | { kind: "hostReady" }
  | { kind: "ready"; pluginId: string; sources: Record<string, SourceCapability> }
  | {
      kind: "result";
      pluginId: string;
      requestId: string;
      ok: boolean;
      data?: unknown;
      error?: PluginErrorPayload;
    }
  | { kind: "hostCall"; pluginId: string; callId: string; method: HostCallMethod; args: unknown[] }
  | { kind: "updateAvailable"; pluginId: string; info: PluginUpdateInfo }
  | {
      kind: "log";
      /** 缺省表示 host 级日志（如无法归因的 unhandledRejection） */
      pluginId?: string;
      level: "debug" | "info" | "warn" | "error";
      args: unknown[];
    }
  | { kind: "fatal"; pluginId: string; error: PluginErrorPayload }
  | { kind: "pong" }
  /** sources 增量上报 */
  | { kind: "sourcesUpdate"; pluginId: string; sources: Record<string, SourceCapability> }
  /** 控制/UI 类注册上报 */
  | ({ kind: "registered"; pluginId: string } & PluginRegistration);

/** worker 调用回宿主的方法名 */
export type HostCallMethod =
  | "request"
  | "storage.get"
  | "storage.set"
  | "storage.remove"
  | "storage.keys"
  | "player.play"
  | "player.pause"
  | "player.next"
  | "player.prev"
  | "player.seek"
  | "player.setVolume"
  | "player.getPosition";

/* ========== 渲染端 ↔ 主进程的 IPC 请求参数 ========== */

export interface PluginResolveUrlArgs {
  pluginId: string;
  source: string;
  quality?: PluginQuality;
  musicInfo: { songmid: string; [key: string]: unknown };
}

export interface PluginInvokeMenuArgs {
  pluginId: string;
  menuId: string;
  track: Track;
}
export interface PluginInvokeMenuResult {
  ok: boolean;
  /** 插件返回的轻提示文案（成功时） */
  toast?: string;
  /** 插件请求打开的外链（成功时） */
  openUrl?: string;
  /** 插件请求复制的文本（成功时） */
  copyText?: string;
  error?: string;
}

/** 插件市场条目 */
export interface MarketPlugin {
  id: string;
  name: string;
  author: string;
  type: PluginType;
  version: string;
  description: string;
  homepage: string;
  updateUrl: string;
}

/** 渲染端插件 API */
export interface PluginsApi {
  /** 列出所有已安装插件 */
  list: () => Promise<PluginInfo[]>;
  /** 从指定路径导入插件（进阶：一般由 pickAndInstall 触发） */
  install: (filePath: string) => Promise<{ ok: boolean; id?: string; error?: string }>;
  /** 弹出原生文件选择框导入插件 */
  pickAndInstall: () => Promise<{
    ok: boolean;
    id?: string;
    error?: string;
    cancelled?: boolean;
  }>;
  /** 从远端 URL 下载并导入 */
  installFromUrl: (url: string) => Promise<{ ok: boolean; id?: string; error?: string }>;
  /** 卸载（同时删除 scripts/{id}.js） */
  uninstall: (id: string) => Promise<{ ok: boolean; error?: string }>;
  /** 启用/禁用 */
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /**
   * 写入控制类插件的单个配置项
   * @param id - 插件 ID
   * @param key - 配置项 key（须在插件 settings schema 中声明）
   * @param value - 新值，由主进程按 schema 类型校验后写入并推送到沙箱
   */
  setSetting: (id: string, key: string, value: unknown) => Promise<void>;
  /**
   * 手动检查更新：拉 @updateUrl 读远端 @version 与本地比对，有新版则置 updateInfo
   * @param id - 插件 ID
   * @returns ok 是否成功联网比对；hasUpdate 是否发现新版；plugin 最新信息
   */
  checkUpdate: (
    id: string,
  ) => Promise<{ ok: boolean; hasUpdate: boolean; plugin?: PluginInfo; error?: string }>;
  /**
   * 一键更新：拉取 updateUrl(raw .js) 原地覆盖，保留启用态/设置/数据
   * @param id - 插件 ID
   * @returns ok 成功;失败时 fallbackUrl 为可手动打开的更新地址(若有)
   */
  applyUpdate: (
    id: string,
  ) => Promise<{ ok: boolean; plugin?: PluginInfo; error?: string; fallbackUrl?: string }>;
  /** 获取播放 URL */
  resolveUrl: (args: PluginResolveUrlArgs) => Promise<MusicUrlRes>;
  /** 触发某插件的自定义菜单项 */
  invokeMenu: (args: PluginInvokeMenuArgs) => Promise<PluginInvokeMenuResult>;
  /** 拉取插件市场列表 */
  market: () => Promise<{ ok: boolean; plugins: MarketPlugin[]; error?: string }>;
  /** 订阅插件状态变化 */
  onStatus: (cb: (info: PluginInfo) => void) => () => void;
}

/* ========== 配置 ========== */

export interface PluginsConfig {
  /** 插件启用开关，key = pluginId */
  enabled: Record<string, boolean>;
  /** 各动作的插件优先级列表 */
  priority: {
    musicUrl: string[];
  };
  /** 每插件的用户设置 */
  perPlugin: Record<string, Record<string, unknown>>;
}
