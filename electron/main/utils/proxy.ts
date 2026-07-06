import { net, session } from "electron";
import type { ProxyConfig } from "electron";
import { store } from "@main/store";
import { systemLog } from "@main/utils/logger";

const MAIN_PARTITION = "persist:main";
const PROXY_TEST_URL = "https://www.baidu.com";

/**
 * 将网络代理配置转换为 Electron ProxyConfig。
 * system 模式使用 { mode: "system" } 跟随系统代理；off 直连。
 */
const buildProxyConfig = (): ProxyConfig => {
  const config = store.get("system.networkProxy");
  if (config.protocol === "system") return { mode: "system" };
  if (config.protocol === "off") return { mode: "direct" };
  const host = config.host.trim();
  const port = Number(config.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { mode: "direct" };
  return { proxyRules: `${config.protocol}://${host}:${port}` };
};

/** 应用网络代理配置到 Electron 会话 */
export const applyNetworkProxy = async (): Promise<void> => {
  const proxyConfig = buildProxyConfig();
  try {
    await Promise.all([
      session.defaultSession.setProxy(proxyConfig),
      session.fromPartition(MAIN_PARTITION).setProxy(proxyConfig),
    ]);
    systemLog.info(
      `[proxy] mode=${proxyConfig.mode ?? "fixed_servers"}${proxyConfig.proxyRules ? ` rules=${proxyConfig.proxyRules}` : ""}`,
    );
  } catch (err) {
    systemLog.warn("[proxy] apply failed", err);
  }
};

/** 测试当前代理是否可用 */
export const testNetworkProxy = async (): Promise<boolean> => {
  const proxyConfig = buildProxyConfig();
  if (proxyConfig.mode === "system") return true;
  if (proxyConfig.mode === "direct") return false;
  try {
    await applyNetworkProxy();
    const res = await net.fetch(PROXY_TEST_URL, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch (err) {
    systemLog.warn("[proxy] test failed", err);
    return false;
  }
};
