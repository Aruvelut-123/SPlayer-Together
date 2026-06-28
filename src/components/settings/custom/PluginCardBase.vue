<script setup lang="ts">
defineProps<{ name: string; description?: string; author?: string }>();
</script>

<template>
  <div
    class="flex flex-col h-full gap-1.5 rounded-xl bg-surface-panel border border-solid border-outline-variant/15 px-3.5 py-3"
  >
    <div class="flex items-center gap-1.5">
      <div class="flex items-center gap-1 min-w-0 flex-1">
        <span class="truncate text-sm font-medium text-on-surface">{{ name }}</span>
        <slot name="name-suffix" />
      </div>
      <slot name="title-end" />
    </div>

    <!-- 简介 -->
    <p
      v-if="description"
      class="m-0 text-xs leading-relaxed text-on-surface-variant/70 line-clamp-2"
    >
      {{ description }}
    </p>

    <!-- 作者 + 附加标签 -->
    <div
      v-if="author || $slots.tags"
      class="flex items-center gap-2.5 flex-wrap text-xs text-on-surface-variant/60"
    >
      <span v-if="author" class="flex items-center gap-1 min-w-0">
        <IconLucideUser class="size-3.5 shrink-0 opacity-60" />
        <span class="truncate">{{ author }}</span>
      </span>
      <slot name="tags" />
    </div>

    <!-- 额外内容 -->
    <slot name="extra" />

    <!-- 底部操作 -->
    <div class="mt-auto pt-1.5"><slot name="actions" /></div>
  </div>
</template>
