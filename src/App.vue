<script setup lang="ts">
import { useSettingsStore } from "@/stores/settings";
import { useLicenseStore, LICENSE_CHECK_INTERVAL_MS } from "@/stores/license";
import { useHotkeyStore } from "@/stores/hotkey";
import { initPlayer } from "@/core/player";
import { installHotkeyManager } from "@/core/hotkey/manager";

const license = useLicenseStore();

watchEffect(() => {
  const v = useSettingsStore().appearance.fontFamily;
  const root = document.documentElement.style;
  if (v) root.setProperty("--user-font", `${v}, var(--app-font)`);
  else root.removeProperty("--user-font");
});

let checkTimer: number | undefined;
let booted = false;

watch(
  () => license.authorized,
  (authorized) => {
    if (authorized && !booted) {
      booted = true;
      initPlayer().catch(console.error);
      useHotkeyStore()
        .init()
        .then(installHotkeyManager)
        .catch((err) => console.error("[hotkey] init failed", err));
    }
    if (authorized) {
      if (checkTimer === undefined) {
        checkTimer = window.setInterval(() => void license.verify(), LICENSE_CHECK_INTERVAL_MS);
      }
    } else if (checkTimer !== undefined) {
      window.clearInterval(checkTimer);
      checkTimer = undefined;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (checkTimer !== undefined) window.clearInterval(checkTimer);
});
</script>

<template>
  <template v-if="license.authorized">
    <AppBackground />
    <RouterView />
  </template>
  <LicenseGate v-else />
</template>
