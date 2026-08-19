import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 跨平台读取机器唯一标识：Windows 取 MachineGuid，macOS 取 IOPlatformUUID，
 * Linux 取 /etc/machine-id 或 /var/lib/dbus/machine-id。
 * @returns 机器标识字符串，读取失败时降级为主机名
 */
const readMachineId = async (): Promise<string> => {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("reg", [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ]);
      const m = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.exec(
        stdout,
      );
      if (m) return m[0];
    } catch {
      /* 降级 */
    }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout);
      if (m) return m[1];
    } catch {
      /* 降级 */
    }
  }
  for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const v = readFileSync(p, "utf8").trim();
      if (v) return v;
    } catch {
      /* 继续 */
    }
  }
  return hostname();
};

/**
 * 生成机器授权密钥：对机器标识做 SHA-256，取前 16 个十六进制字符按 4 位分组。
 * 同一台机器生成结果稳定，用于交给服务器加入白名单。
 * @returns 形如 XXXX-XXXX-XXXX-XXXX 的密钥
 */
export const getMachineKey = async (): Promise<string> => {
  const id = await readMachineId();
  const hash = createHash("sha256").update(`splayer-together:${id}`).digest("hex");
  const raw = hash.slice(0, 16).toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
};
