import { net, session } from "electron";
import { store } from "@main/store";
import { systemLog } from "@main/utils/logger";

const MAIN_PARTITION = "persist:main";
const PROXY_TEST_URL = "https://www.baidu.com";

/** 当前网络代理规则 */
export const currentProxyRules = (): string => {
  const config = store.get("system.networkProxy");
  if (config.protocol === "off") return "";
  const host = config.host.trim();
  const port = Number(config.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return "";
  return `${config.protocol}://${host}:${port}`;
};

/** 应用网络代理配置到 Electron 会话 */
export const applyNetworkProxy = async (): Promise<void> => {
  const proxyRules = currentProxyRules();
  try {
    await Promise.all([
      session.defaultSession.setProxy({ proxyRules }),
      session.fromPartition(MAIN_PARTITION).setProxy({ proxyRules }),
    ]);
    systemLog.info(proxyRules ? `[proxy] enabled ${proxyRules}` : "[proxy] disabled");
  } catch (err) {
    systemLog.warn("[proxy] apply failed", err);
  }
};

/** 测试当前代理是否可用 */
export const testNetworkProxy = async (): Promise<boolean> => {
  const proxyRules = currentProxyRules();
  if (!proxyRules) return false;
  try {
    await applyNetworkProxy();
    const res = await net.fetch(PROXY_TEST_URL, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch (err) {
    systemLog.warn("[proxy] test failed", err);
    return false;
  }
};
