<script setup lang="ts">
import type { PluginSettingItem } from "@shared/types/plugin";

const props = defineProps<{
  /** 插件注册的设置 schema */
  schema: PluginSettingItem[];
  /** 当前值（来自 perPlugin，缺省取 default） */
  values: Record<string, unknown>;
}>();

const emit = defineEmits<{
  (event: "change", key: string, value: unknown): void;
}>();

/** 取某项当前值，缺省回退 default */
const valueOf = (item: PluginSettingItem): unknown => props.values[item.key] ?? item.default;
</script>

<template>
  <div class="flex flex-col gap-2 mt-2 pt-2 border-t border-solid border-outline-variant/15">
    <div
      v-for="item in schema"
      :key="item.key"
      class="flex items-center justify-between gap-4 py-1"
    >
      <div class="flex flex-col min-w-0 flex-1">
        <span class="text-xs text-on-surface">{{ item.label }}</span>
        <span v-if="item.description" class="text-xs text-on-surface-variant/60 mt-0.5">
          {{ item.description }}
        </span>
      </div>
      <div class="shrink-0">
        <SSwitch
          v-if="item.type === 'switch'"
          :model-value="Boolean(valueOf(item))"
          @update:model-value="(val) => emit('change', item.key, val)"
        />
        <SNumberInput
          v-else-if="item.type === 'number'"
          :model-value="valueOf(item) != null ? Number(valueOf(item)) : null"
          :min="item.min"
          :max="item.max"
          size="small"
          @update:model-value="(val) => emit('change', item.key, val)"
        />
        <SInput
          v-else-if="item.type === 'text'"
          :model-value="String(valueOf(item) ?? '')"
          :placeholder="item.placeholder"
          size="small"
          @update:model-value="(val) => emit('change', item.key, val)"
        />
        <SSelect
          v-else-if="item.type === 'select'"
          :model-value="(valueOf(item) ?? '') as string"
          :options="item.options ?? []"
          @update:model-value="(val) => emit('change', item.key, val)"
        />
      </div>
    </div>
  </div>
</template>
