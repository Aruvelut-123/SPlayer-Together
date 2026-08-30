/**
 * QM 用户基础资料模块
 *
 * 通过登录 Cookie 中的 uin 及 Web 官方 CGI 接口获取用户信息；
 * key 失效时先尝试刷新 musickey 再重试一次
 */

import { getQQMusicCookies, getQQMusicUin, refreshQQMusicCredential } from "../core/request";
import { coreLog } from "@main/utils/logger";
import type { QMModule } from "../core/types";

interface ProfileCreator {
  nick?: string;
  headpic?: string;
  icon?: string;
  vip?: number;
  vip_level?: number;
  is_vip?: number;
  is_super_vip?: number;
}

interface ProfileHomepageResp {
  code?: number;
  subcode?: number;
  data?: {
    creator?: ProfileCreator;
  };
}

const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** QQ 系 CSRF token 算法（与网页端 g_tk 一致） */
const hash33 = (str: string, seed = 0): number => {
  let h = seed;
  for (const ch of str) h = (((h << 5) + h + ch.codePointAt(0)!) & 0xffffffff) >>> 0;
  return h & 2147483647;
};

/** 请求一次 profile 接口；成功返回 creator，失败抛错 */
const fetchProfile = async (uin: string): Promise<ProfileCreator | null> => {
  const cookies = getQQMusicCookies();
  const musickey = cookies.qm_keyst || cookies.qqmusic_key || "";
  const cookieEntries = Object.entries(cookies).filter(([_, v]) => !!v);
  const cookieStr = cookieEntries.map(([k, v]) => `${k}=${v}`).join("; ");

  const url = `https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg?g_tk=${hash33(
    musickey,
    5381,
  )}&cid=205360838&userid=${encodeURIComponent(uin)}&loginUin=${encodeURIComponent(
    uin,
  )}&hostUin=0&reqfrom=1&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Referer: "https://y.qq.com/",
      Origin: "https://y.qq.com",
      "User-Agent": WEB_UA,
      ...(cookieStr ? { Cookie: cookieStr } : {}),
    },
    signal: AbortSignal.timeout(8000),
  });

  const json = (await res.json()) as ProfileHomepageResp;
  if (json.code !== 0) {
    throw new Error(`Web 接口返回异常: code=${json.code}, subcode=${json.subcode}`);
  }
  return json.data?.creator ?? null;
};

const userDetail: QMModule = async (_params) => {
  const uin = getQQMusicUin();
  const cookies = getQQMusicCookies();

  const hasKey = !!(
    cookies.qm_keyst ||
    cookies.qqmusic_key ||
    cookies.pskey ||
    cookies.p_skey ||
    cookies.skey
  );

  if (!uin || uin === "0" || !hasKey) {
    return {
      code: 301,
      loggedIn: false,
      message: "未登录 QM 账号",
    };
  }

  let creator: ProfileCreator | null = null;
  try {
    creator = await fetchProfile(uin);
  } catch (err) {
    coreLog.warn("[qm-user-detail] 获取用户资料失败，尝试刷新 musickey:", err);
    if (!(await refreshQQMusicCredential())) {
      return {
        code: 301,
        loggedIn: false,
        message: "登录已过期，请重新登录",
      };
    }
    try {
      creator = await fetchProfile(uin);
    } catch (err) {
      coreLog.warn("[qm-user-detail] 刷新后仍获取失败:", err);
      return {
        code: 301,
        loggedIn: false,
        message: "登录已过期，请重新登录",
      };
    }
  }

  const defaultAvatar = `https://q.qlogo.cn/headimg_dl?dst_uin=${uin}&spec=100`;
  return {
    code: 200,
    loggedIn: true,
    profile: {
      userId: uin,
      nickname: creator?.nick || `QQ用户_${uin.slice(-4)}`,
      avatarUrl: creator?.headpic || defaultAvatar,
      isVip: !!(creator?.is_vip || creator?.is_super_vip || (creator?.vip && creator.vip > 0)),
      vipLevel: creator?.vip_level ?? 0,
    },
  };
};

export default userDetail;
