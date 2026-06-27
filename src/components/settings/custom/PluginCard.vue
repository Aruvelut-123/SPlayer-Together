<script setup lang="ts">
import type { PluginInfo } from "@shared/types/plugin";
import type { DropdownMenuItem } from "@/components/ui/SDropdownMenu.vue";
import { isExternalUrl, openExternal } from "@/utils/url";
import IconSettings2 from "~icons/lucide/settings-2";
import IconRefreshCw from "~icons/lucide/refresh-cw";
import IconTrash2 from "~icons/lucide/trash-2";

const props = defineProps<{ info: PluginInfo; checking?: boolean }>();

const emit = defineEmits<{
  (event: "toggle", id: string, enabled: boolean): void;
  (event: "uninstall", id: string): void;
  (event: "configure", id: string): void;
  (event: "check", id: string): void;
  (event: "viewUpdate", id: string): void;
}>();

const { t } = useI18n();

type TagType = "default" | "success" | "info" | "warning" | "error";

/** 当前状态 → 徽章颜色 + 文案 key */
const statusTag = computed<{ type: TagType; key: string }>(() => {
  const { enabled, status } = props.info;
  if (!enabled) return { type: "default", key: "disabled" };
  switch (status.state) {
    case "ready":
      return { type: "success", key: "ready" };
    case "loading":
      return { type: "info", key: "loading" };
    case "error":
      return { type: "error", key: "error" };
    case "disabled":
      return { type: "default", key: "disabled" };
    default:
      return { type: "warning", key: "unloaded" };
  }
});

/** ready 时声明的 sources 名（音源类才有） */
const sourceNames = computed<string[]>(() =>
  props.info.status.state === "ready" ? Object.keys(props.info.status.sources) : [],
);

const settings = computed(() =>
  props.info.status.state === "ready" ? (props.info.status.settings ?? []) : [],
);

const menuItems = computed<DropdownMenuItem[]>(() => [
  {
    key: "check",
    label: t("settings.plugins.checkUpdate"),
    icon: markRaw(IconRefreshCw),
    show: !!props.info.manifest.updateUrl,
    disabled: props.checking,
  },
  {
    key: "uninstall",
    label: t("settings.plugins.uninstall"),
    icon: markRaw(IconTrash2),
    separator: !!props.info.manifest.updateUrl,
  },
]);

const onMenuSelect = (key: string): void => {
  const id = props.info.manifest.id;
  if (key === "check") emit("check", id);
  else if (key === "uninstall") emit("uninstall", id);
};
</script>

<template>
  <div
    class="flex flex-col h-full gap-1.5 rounded-xl bg-surface-panel border border-solid border-outline-variant/15 px-3.5 py-3"
  >
    <!-- 标题行 -->
    <div class="flex items-center gap-1.5">
      <div class="flex items-center gap-1 min-w-0 flex-1">
        <span class="truncate text-sm font-medium leading-none text-on-surface">
          {{ info.manifest.name }}
        </span>
        <SButton
          v-if="info.updateInfo"
          class="shrink-0"
          size="tiny"
          variant="secondary"
          type="success"
          round
          @click="emit('viewUpdate', info.manifest.id)"
        >
          <template #icon><IconLucideArrowUpCircle /></template>
          {{ t("settings.plugins.pendingUpdate") }}
        </SButton>
      </div>
      <SButton
        v-if="isExternalUrl(info.manifest.homepage)"
        circle
        size="tiny"
        variant="text"
        :title="info.manifest.homepage"
        @click="openExternal(info.manifest.homepage)"
      >
        <template #icon><IconLucideExternalLink /></template>
      </SButton>
      <STag size="small" round type="default" variant="soft">v{{ info.manifest.version }}</STag>
      <STag size="small" round :type="statusTag.type" variant="soft">
        {{ t(`settings.plugins.status.${statusTag.key}`) }}
      </STag>
    </div>

    <!-- 简介 -->
    <p
      v-if="info.manifest.description"
      class="m-0 text-xs leading-relaxed text-on-surface-variant/70 line-clamp-2"
    >
      {{ info.manifest.description }}
    </p>

    <!-- 作者 + 支持源 -->
    <div
      v-if="info.manifest.author || sourceNames.length"
      class="flex items-center gap-2.5 flex-wrap text-xs text-on-surface-variant/60"
    >
      <span v-if="info.manifest.author" class="flex items-center gap-1 min-w-0">
        <IconLucideUser class="size-3.5 shrink-0 opacity-60" />
        <span class="truncate">{{ info.manifest.author }}</span>
      </span>
      <STag
        v-for="src in sourceNames"
        :key="src"
        size="tiny"
        variant="soft"
        type="primary"
        class="gap-1"
      >
        <IconLucideDatabase class="size-3" />
        {{ src }}
      </STag>
    </div>

    <!-- 错误信息 -->
    <div
      v-if="info.status.state === 'error'"
      class="rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-500 break-all line-clamp-2"
    >
      {{ info.status.error.message }}
    </div>

    <!-- 底部操作 -->
    <div class="mt-auto pt-1.5 flex items-center justify-between gap-2">
      <div class="flex items-center gap-1.5 min-w-0">
        <SButton
          variant="secondary"
          size="small"
          :type="info.enabled ? 'primary' : 'default'"
          @click="emit('toggle', info.manifest.id, info.enabled)"
        >
          <template #icon>
            <IconLucideCircleCheck v-if="info.enabled" class="size-4" />
            <IconLucidePower v-else class="size-4" />
          </template>
          {{ info.enabled ? t("settings.plugins.enabled") : t("settings.plugins.enable") }}
        </SButton>
        <SButton
          v-if="settings.length > 0"
          variant="secondary"
          size="small"
          @click="emit('configure', info.manifest.id)"
        >
          <template #icon><IconSettings2 class="size-4" /></template>
          {{ t("common.configure") }}
        </SButton>
      </div>
      <div class="shrink-0">
        <SDropdownMenu :items="menuItems" align="end" @select="onMenuSelect">
          <template #trigger>
            <SButton variant="secondary" size="small">
              <template #icon><IconLucideMoreHorizontal class="size-4" /></template>
              {{ t("common.more") }}
            </SButton>
          </template>
        </SDropdownMenu>
      </div>
    </div>
  </div>
</template>
