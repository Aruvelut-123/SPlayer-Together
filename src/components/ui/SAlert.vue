<script setup lang="ts">
import type { Component } from "vue";
import IconMaterialSymbolsInfoRounded from "~icons/material-symbols/info-rounded";
import IconMaterialSymbolsCheckCircleRounded from "~icons/material-symbols/check-circle-rounded";
import IconMaterialSymbolsErrorRounded from "~icons/material-symbols/error-rounded";
import IconMaterialSymbolsCancelRounded from "~icons/material-symbols/cancel-rounded";

type AlertType = "default" | "info" | "success" | "warning" | "error";
type AlertVariant = "soft" | "outline";

const props = withDefaults(
  defineProps<{
    /** 主题色 */
    type?: AlertType;
    /** 视觉变体 */
    variant?: AlertVariant;
    /** 标题 */
    title?: string;
    /** 自定义图标 */
    icon?: Component;
    /** 不显示图标 */
    hideIcon?: boolean;
  }>(),
  {
    type: "default",
    variant: "soft",
    hideIcon: false,
  },
);

const defaultIcon = computed<Component>(() => {
  switch (props.type) {
    case "success":
      return IconMaterialSymbolsCheckCircleRounded;
    case "warning":
      return IconMaterialSymbolsErrorRounded;
    case "error":
      return IconMaterialSymbolsCancelRounded;
    default:
      return IconMaterialSymbolsInfoRounded;
  }
});

/** 图标 + 文字配色 */
const textIconClasses = computed(() => {
  switch (props.type) {
    case "info":
      return "text-blue-700 dark:text-blue-400 [&_.alert-icon]:text-blue-600 dark:[&_.alert-icon]:text-blue-400";
    case "success":
      return "text-green-700 dark:text-green-400 [&_.alert-icon]:text-green-600 dark:[&_.alert-icon]:text-green-400";
    case "warning":
      return "text-amber-700 dark:text-amber-400 [&_.alert-icon]:text-amber-600 dark:[&_.alert-icon]:text-amber-400";
    case "error":
      return "text-red-700 dark:text-red-400 [&_.alert-icon]:text-red-600 dark:[&_.alert-icon]:text-red-400";
    default:
      return "text-on-surface [&_.alert-icon]:text-primary";
  }
});

/** 底色 */
const softBgClass = computed(() => {
  switch (props.type) {
    case "info":
      return "bg-blue-500/8";
    case "success":
      return "bg-green-500/8";
    case "warning":
      return "bg-amber-500/10";
    case "error":
      return "bg-red-500/8";
    default:
      return "bg-primary/8";
  }
});

/** 左侧色条颜色 */
const outlineBorderClass = computed(() => {
  switch (props.type) {
    case "info":
      return "border-blue-500";
    case "success":
      return "border-green-500";
    case "warning":
      return "border-amber-500";
    case "error":
      return "border-red-500";
    default:
      return "border-primary";
  }
});

const containerClasses = computed(() =>
  props.variant === "outline"
    ? [
        "border-0 border-l-4 border-solid bg-on-surface/3 rounded-lg",
        outlineBorderClass.value,
        textIconClasses.value,
      ]
    : ["rounded-lg", softBgClass.value, textIconClasses.value],
);
</script>

<template>
  <div class="flex gap-2 p-3 text-xs leading-relaxed" :class="containerClasses">
    <component
      :is="icon ?? defaultIcon"
      v-if="!hideIcon"
      class="alert-icon size-4 shrink-0 mt-0.5"
    />
    <div class="flex-1 min-w-0">
      <div v-if="title" class="text-sm font-semibold mb-1">{{ title }}</div>
      <slot />
    </div>
  </div>
</template>
