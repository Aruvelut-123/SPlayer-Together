<script setup lang="ts">
import type { Component } from "vue";
import type { PlayStatsSummary, SourcePlayStats } from "@shared/types/stats";
import { PLATFORM_SHORT_NAME, isPlatform } from "@shared/types/platform";
import IconLucidePlay from "~icons/lucide/play";
import IconLucideClock from "~icons/lucide/clock";
import IconLucideMusic2 from "~icons/lucide/music-2";
import IconLucideCalendarCheck from "~icons/lucide/calendar-check";
import IconLucideFlame from "~icons/lucide/flame";

const props = defineProps<{
  /** 播放统计汇总（本地与在线来源全部计入） */
  summary: PlayStatsSummary | null;
  /** 各来源播放量 */
  sources: SourcePlayStats[];
  /** 加载中 */
  loading: boolean;
}>();

const { t } = useI18n();

/** 概览卡片 */
interface SummaryCard {
  key: string;
  icon: Component;
  /** 主数字 */
  value: string;
  /** 主数字单位（h / m / 次） */
  unit?: string;
  /** 第二段数字 */
  value2?: string;
  /** 第二段数字单位 */
  unit2?: string;
}

/**
 * 收听时长拆分为小时和分钟
 * @param ms - 时长（毫秒）
 * @returns 小时与分钟
 */
const splitDuration = (ms: number): { hours: number; minutes: number } => {
  const totalMin = Math.floor(ms / 60000);
  return { hours: Math.floor(totalMin / 60), minutes: totalMin % 60 };
};

const cards = computed<SummaryCard[]>(() => {
  const summary = props.summary;
  const listened = summary ? splitDuration(summary.totalListenedMs) : null;
  return [
    {
      key: "playTimes",
      icon: IconLucidePlay,
      value: summary ? String(summary.totalPlayCount) : "--",
      unit: summary ? t("stats.playUnit") : undefined,
    },
    listened
      ? {
          key: "listenedDuration",
          icon: IconLucideClock,
          value: String(listened.hours),
          unit: "h",
          value2: String(listened.minutes),
          unit2: "m",
        }
      : { key: "listenedDuration", icon: IconLucideClock, value: "--" },
    {
      key: "playedSongs",
      icon: IconLucideMusic2,
      value: summary ? String(summary.totalPlayedTracks) : "--",
      unit: summary ? t("stats.trackUnit") : undefined,
    },
    {
      key: "weekPlays",
      icon: IconLucideCalendarCheck,
      value: summary ? String(summary.weekPlayCount) : "--",
      unit: summary ? t("stats.playUnit") : undefined,
    },
    {
      key: "listenStreak",
      icon: IconLucideFlame,
      value: summary ? String(summary.streakDays) : "--",
      unit: summary ? t("stats.dayUnit") : undefined,
    },
  ];
});

/** 来源播放量按播放次数占比排序 */
const sourceRows = computed(() => {
  const total = props.sources.reduce((sum, item) => sum + item.playCount, 0);
  return props.sources.map((item) => ({
    source: item.source,
    playCount: item.playCount,
    hours: splitDuration(item.listenedMs).hours,
    percent: total > 0 ? Math.round((item.playCount / total) * 100) : 0,
  }));
});

/**
 * 来源显示名：在线平台用简写，本地与流媒体走 i18n
 * @param source - 曲目来源
 * @returns 显示名
 */
const sourceLabel = (source: string): string => {
  if (isPlatform(source)) return PLATFORM_SHORT_NAME[source];
  return t(`stats.source.${source}`);
};
</script>

<template>
  <SCard radius="xl" class="flex flex-col gap-4">
    <div class="flex items-baseline justify-between gap-3">
      <h3 class="text-base font-semibold text-on-surface">{{ t("stats.playOverview") }}</h3>
      <span class="text-xs text-on-surface-variant/50">{{ t("stats.playOverviewHint") }}</span>
    </div>

    <div class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
      <div
        v-for="card in cards"
        :key="card.key"
        class="relative overflow-hidden rounded-xl bg-surface-alt/60 px-4 py-3"
      >
        <component
          :is="card.icon"
          class="pointer-events-none absolute -right-2 -bottom-3 size-16 -rotate-14 text-primary/15"
        />
        <div class="relative flex flex-col justify-between gap-1">
          <div class="flex items-baseline gap-0.5">
            <span class="text-2xl font-bold leading-none text-on-surface tabular-nums">
              {{ card.value }}
            </span>
            <span v-if="card.unit" class="text-xs font-medium text-on-surface-variant/70">
              {{ card.unit }}
            </span>
            <template v-if="card.value2 !== undefined">
              <span class="text-2xl font-bold leading-none text-on-surface tabular-nums">
                {{ card.value2 }}
              </span>
              <span v-if="card.unit2" class="text-xs font-medium text-on-surface-variant/70">
                {{ card.unit2 }}
              </span>
            </template>
          </div>
          <div class="truncate text-xs text-on-surface-variant/50">
            {{ t(`stats.${card.key}`) }}
          </div>
        </div>
      </div>
    </div>

    <!-- 各来源播放占比：本地与在线（含流媒体）分别统计 -->
    <div v-if="!loading && sourceRows.length > 0" class="flex flex-col gap-2">
      <div v-for="row in sourceRows" :key="row.source" class="flex items-center gap-3">
        <span class="w-14 shrink-0 text-xs font-medium text-on-surface-variant/70">
          {{ sourceLabel(row.source) }}
        </span>
        <div class="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-on-surface/8">
          <div
            class="h-full rounded-full bg-primary/70 transition-[width] duration-500"
            :style="{ width: `${Math.max(row.percent, 2)}%` }"
          />
        </div>
        <span class="w-28 shrink-0 text-right text-xs text-on-surface-variant/55 tabular-nums">
          {{ row.playCount }} {{ t("stats.playUnit") }} · {{ row.hours }} h
        </span>
      </div>
    </div>
    <div v-else-if="!loading" class="py-2 text-center text-sm text-on-surface-variant/40">
      {{ t("stats.noDataHint") }}
    </div>
  </SCard>
</template>
