export interface DeviceChangeDecision {
  defaultChanged: boolean;
  shouldReinit: boolean;
}

const RECOVERY_RETRY_DELAYS_MS = [100, 300, 1000] as const;

/** 返回指定恢复尝试前的等待时间；超过最大次数时不再重试。 */
export const recoveryRetryDelay = (attempt: number): number | null =>
  RECOVERY_RETRY_DELAYS_MS[attempt] ?? null;

/** 根据默认设备和用户选择决定是否重建音频输出 */
export const evaluateDeviceChange = (
  previousDefault: string | null,
  currentDefault: string | null,
  selectedDevice: string | null,
): DeviceChangeDecision => {
  const defaultChanged = previousDefault !== currentDefault;
  return {
    defaultChanged,
    shouldReinit: defaultChanged && currentDefault !== null && selectedDevice === null,
  };
};
