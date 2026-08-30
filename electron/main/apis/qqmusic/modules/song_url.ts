/**
 * QM 单曲播放链接解析模块
 *
 * CDN 节点走 audioCdnDispatch，播放地址走 vkey.GetVkey（UrlGetVkey），
 * 登录态注入 comm 的 qq/authst/tmeLoginType；无 media_mid 时 filename 用 mid 拼两次
 */

import { randomUUID } from "node:crypto";
import { getQQMusicCookies, getQQMusicUin, qmRequest } from "../core/request";
import { coreLog } from "@main/utils/logger";
import type { QMModule } from "../core/types";

interface QualityCandidate {
  prefix: string;
  ext: string;
  level: string;
  label: string;
}

const QQ_QUALITY_CANDIDATE_TEMPLATES: QualityCandidate[] = [
  { prefix: "AI00", ext: ".flac", level: "hi-res", label: "Hi-Res FLAC" },
  { prefix: "F000", ext: ".flac", level: "lossless", label: "无损 FLAC" },
  { prefix: "M800", ext: ".mp3", level: "hq", label: "320k MP3" },
  { prefix: "M500", ext: ".mp3", level: "sq", label: "128k MP3" },
  { prefix: "C400", ext: ".m4a", level: "lq", label: "标准 AAC" },
];

/**
 * 根据用户的首选音质生成顺位候选列表
 */
const getQualityCandidates = (preferredLevel: string): QualityCandidate[] => {
  const target = String(preferredLevel || "hq").toLowerCase();
  const targetIndex = QQ_QUALITY_CANDIDATE_TEMPLATES.findIndex((t) => t.level === target);
  if (targetIndex >= 0) {
    return QQ_QUALITY_CANDIDATE_TEMPLATES.slice(targetIndex);
  }
  return QQ_QUALITY_CANDIDATE_TEMPLATES;
};

interface MidUrlInfo {
  songmid: string;
  filename: string;
  purl?: string;
  result?: number;
}

/** 0=成功；104003=无权限(未登录/等级不够)；104004=VKey 获取失败；104013=播放设备受限 */
const RESULT_MESSAGES: Record<number, string> = {
  104003: "无播放权限（需要 VIP 或登录）",
  104004: "VKey 获取失败",
  104013: "播放设备受限",
};

interface CdnDispatchData {
  sip?: string[];
}

/** CDN 调度缓存；失败时短暂缓存空列表避免每次播放都重试 */
let cdnCache: { sips: string[]; expireAt: number } | null = null;
const CDN_FALLBACK = "https://isure.stream.qqmusic.qq.com/";

const getCdnSip = async (): Promise<string> => {
  if (cdnCache && cdnCache.expireAt > Date.now()) return cdnCache.sips[0] ?? CDN_FALLBACK;
  try {
    const data = await qmRequest<CdnDispatchData>(
      "music.audioCdnDispatch.cdnDispatch",
      "GetCdnDispatch",
      { guid: randomUUID().replace(/-/g, ""), uid: "0", use_new_domain: 1, use_ipv6: 1 },
      { session: false },
    );
    const sips = (data?.sip ?? []).filter((sip) => sip.startsWith("https://"));
    cdnCache = { sips, expireAt: Date.now() + 60 * 60 * 1000 };
  } catch (err) {
    coreLog.warn("[qm-song-url] CDN 调度失败，使用兜底节点:", err);
    cdnCache = { sips: [], expireAt: Date.now() + 60 * 1000 };
  }
  return cdnCache.sips[0] ?? CDN_FALLBACK;
};

const songUrl: QMModule = async (params) => {
  const mid = String(params.mid || params.id || "").trim();
  if (!mid) return { code: 400, message: "missing mid" };
  // 无 media_mid 时上游规则是 mid 拼两次
  const fileBase = String(params.mediaMid || "").trim() || `${mid}${mid}`;

  const targetLevel = String(params.level || "hq");
  const candidates = getQualityCandidates(targetLevel);
  const filenames = candidates.map((c) => `${c.prefix}${fileBase}${c.ext}`);

  const cookies = getQQMusicCookies();
  const uin = getQQMusicUin();
  const musickey = cookies.qm_keyst || cookies.qqmusic_key || "";
  const loginComm = musickey
    ? { qq: uin, authst: musickey, tmeLoginType: Number(cookies.tmeLoginType) || 2 }
    : {};

  coreLog.debug("[qm-song-url] 发起直链解析:", mid, targetLevel, {
    uin,
    loggedIn: !!musickey,
  });

  try {
    const data = await qmRequest<{ midurlinfo?: MidUrlInfo[] }>(
      "music.vkey.GetVkey",
      "UrlGetVkey",
      {
        uin: uin !== "0" ? uin : "",
        filename: filenames,
        guid: randomUUID().replace(/-/g, ""),
        songmid: filenames.map(() => mid),
        songtype: filenames.map(() => 0),
        ctx: 0,
      },
      { comm: loginComm },
    );

    const infos = data?.midurlinfo ?? [];
    // 服务器已按权限过滤：purl 非空即授权，按音质顺位取第一个实现自动降级
    const sip = await getCdnSip();
    const matched = candidates
      .map((cand) => {
        const matchFilename = `${cand.prefix}${fileBase}${cand.ext}`;
        const found = infos.find((item) => item.filename === matchFilename && !!item.purl);
        return found ? { cand, url: `${sip}${found.purl}` } : undefined;
      })
      .find((item): item is NonNullable<typeof item> => !!item);

    if (matched) {
      coreLog.info(
        `[qm-song-url] 成功命中直链: ${mid} -> ${matched.cand.label} (${matched.cand.level})`,
      );

      return {
        code: 200,
        data: [
          {
            id: mid,
            url: matched.url,
            level: matched.cand.level,
            format: matched.cand.ext.replace(".", ""),
            isFallback: matched.cand.level !== targetLevel,
          },
        ],
      };
    }

    const firstResult = infos.find((item) => item.filename === filenames[0])?.result;
    const reason = RESULT_MESSAGES[firstResult ?? 0];
    coreLog.warn("[qm-song-url] 未获取到可用音质:", {
      mid,
      firstResult,
      reason,
    });

    return {
      code: 403,
      message: reason || "无法获取播放链接，可能需要 VIP 或无版权",
      data: [{ id: mid, url: "" }],
    };
  } catch (err) {
    coreLog.error("[qm-song-url] 解析发生网络或系统异常:", err);
    return {
      code: 500,
      message: err instanceof Error ? err.message : String(err),
      data: [{ id: mid, url: "" }],
    };
  }
};

export default songUrl;
