/** WebDAV 内部运行时配置 */
export interface WebDavRuntimeConfig {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
  rootPath: string;
  scanDepth: number;
}

/** WebDAV 连接错误类型 */
export type WebDavErrorCode = "auth" | "not_found" | "network" | "protocol";

/** WebDAV 连接测试结果 */
export interface WebDavConnectionResult {
  ok: boolean;
  error?: string;
  code?: WebDavErrorCode;
  playbackVerified?: boolean;
  warning?: string;
}
