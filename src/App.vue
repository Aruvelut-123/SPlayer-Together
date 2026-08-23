<script setup lang="ts">
import { useSettingsStore } from "@/stores/settings";
import { initPlayer } from "@/core/player";
import { installHotkeyManager } from "@/core/hotkey/manager";
import { useHotkeyStore } from "@/stores/hotkey";

watchEffect(() => {
  const v = useSettingsStore().appearance.fontFamily;
  const root = document.documentElement.style;
  if (v) root.setProperty("--user-font", `${v}, var(--app-font)`);
  else root.removeProperty("--user-font");
});

let booted = false;

onMounted(() => {
  if (!booted) {
    booted = true;
    initPlayer().catch(console.error);
    useHotkeyStore()
      .init()
      .then(installHotkeyManager)
      .catch((err) => console.error("[hotkey] init failed", err));
  }
});
</script>

<template>
  <AppBackground />
  <RouterView />
</template>