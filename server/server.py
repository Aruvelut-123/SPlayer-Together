#!/usr/bin/env python3
"""SPlayer Together 中继服务器（纯 HTTP 轮询版）

职责：
1. 应用授权：客户端按机器 ID 生成密钥，携带密钥询问 ``POST /api/auth``，命中白名单才放行。
2. 一起听中继：房主周期性推送播放状态与队列，成员周期性拉取并跟随，全部走纯 HTTP，
   不使用 WebSocket，部署简单且不易断线。
3. WebUI 管理后台：登录后管理密钥白名单与房间。

配置在 ``config.yml``。运行：

    pip install -r requirements.txt
    python server.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import string
import time
from pathlib import Path
from typing import Any

import yaml
from aiohttp import web

from webui import render_admin_page

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("relay")

BASE_DIR = Path(__file__).parent
CONFIG_FILE = BASE_DIR / "config.yml"

CODE_ALPHABET = string.ascii_uppercase + string.digits
ROOM_CODE_LEN = 6

# 成员超过该时长未请求视为离线
MEMBER_TIMEOUT_MS = 60_000
# 房主超过该时长未推送状态视为失联，将房主转移给在线成员
HOST_TIMEOUT_MS = 20_000
# 无在线成员的房间超过该时长后清理（仅清理无人在线的房间）
ROOM_TTL_MS = 2 * 60 * 1000
# 后台清理任务间隔
CLEANUP_INTERVAL_MS = 30_000

DEFAULT_CONFIG: dict[str, Any] = {
    "host": "0.0.0.0",
    "port": 8000,
    "admin": {"username": "admin", "password": "change-me"},
}

# 更新包静态目录（setup/portable exe 放这里供 /downloads 下载）
DOWNLOADS_DIR = BASE_DIR / "downloads"
DOWNLOADS_DIR.mkdir(exist_ok=True)
# 更新日志按版本文件目录（供客户端 /api/changelog 读取，已弃用，保留兼容）
CHANGELOGS_DIR = BASE_DIR / "changelogs"


def now_ms() -> int:
    """服务器毫秒时间戳"""
    return int(time.time() * 1000)


def load_config() -> dict[str, Any]:
    data: dict[str, Any] = {}
    if CONFIG_FILE.exists():
        data = yaml.safe_load(CONFIG_FILE.read_text(encoding="utf-8")) or {}
    config = {**DEFAULT_CONFIG, **data}
    config["admin"] = {**DEFAULT_CONFIG["admin"], **(data.get("admin") or {})}
    return config


CONFIG = load_config()
ADMIN_USERNAME: str = str(CONFIG["admin"]["username"])
ADMIN_PASSWORD: str = str(CONFIG["admin"]["password"])

admin_tokens: set[str] = set()

# code -> Room
rooms: dict[str, "Room"] = {}


class Room:
    """一个一起听房间"""

    def __init__(self, code: str, host_id: str):
        self.code = code
        self.host_id = host_id
        # member_id -> {"name", "token", "last_seen"}
        self.members: dict[str, dict[str, Any]] = {}
        self.state: dict[str, Any] | None = None
        self.queue: list[Any] = []
        self.reports: list[dict[str, Any]] = []
        self.seq = 0
        self.created_at = now_ms()
        self.host_last_push = now_ms()
        # 房主控制的成员权限（含 per-member 覆盖）
        self.permissions: dict[str, Any] = {
            "allowGuestControl": True,
            "allowGuestEditPlaylist": True,
            "members": {},
        }
        # 最后推播放状态的成员 id
        self.last_actor: str | None = None
        # 房间是否已关闭（解散/清理前三秒标记，让客户端 poll 到后优雅退出）
        self.closed = False
        self.closed_at = 0

    def touch(self, member_id: str) -> None:
        self.members[member_id]["last_seen"] = now_ms()

    def member_view(self) -> list[dict[str, Any]]:
        now = now_ms()
        return [
            {
                "id": mid,
                "name": m["name"],
                "role": "host" if mid == self.host_id else "guest",
            }
            for mid, m in self.members.items()
            if now - m["last_seen"] <= MEMBER_TIMEOUT_MS
        ]

    def online_count(self) -> int:
        now = now_ms()
        return sum(1 for m in self.members.values() if now - m["last_seen"] <= MEMBER_TIMEOUT_MS)

    def admin_view(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "hostId": self.host_id,
            "online": self.online_count(),
            "total": len(self.members),
            "state": self.state,
            "seq": self.seq,
        }


def room_snapshot(room: Room) -> dict[str, Any]:
    """生成房间快照：状态 / 成员 / 队列 / 报告（取出后清空报告）"""
    reports = room.reports
    room.reports = []
    return {
        "seq": room.seq,
        "state": room.state,
        "members": room.member_view(),
        "hostId": room.host_id,
        "queue": room.queue,
        "reports": reports,
        "permissions": room.permissions,
        "lastActor": room.last_actor,
        "serverNow": now_ms(),
        "closed": room.closed,
    }


def permission_for(room: Room, member_id: str, key: str) -> bool:
    """查询成员是否有某项权限，per-member 覆盖优先于全局默认"""
    members = room.permissions.get("members", {}) if isinstance(room.permissions, dict) else {}
    member = members.get(member_id, {}) if isinstance(members, dict) else {}
    if key in member:
        return bool(member[key])
    return bool(room.permissions.get(key, True))


def new_code() -> str:
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(ROOM_CODE_LEN))
        if code not in rooms:
            return code


def admin_authed(request: web.Request) -> bool:
    """管理员认证：优先读 X-Admin-Token 请求头，其次读 spt_admin_token Cookie"""
    token = request.headers.get("X-Admin-Token", "") or request.cookies.get("spt_admin_token", "")
    return token in admin_tokens


def room_auth(request: web.Request) -> tuple[Room, str] | None:
    """校验成员凭据，返回 (room, member_id)"""
    code = request.match_info["code"].strip().upper()
    room = rooms.get(code)
    if room is None:
        return None
    member_id = request.headers.get("X-Member-Id", "")
    token = request.headers.get("X-Token", "")
    member = room.members.get(member_id)
    if member is None or member["token"] != token:
        return None
    return room, member_id


# --------------------------------------------------------------------------
# CORS
# --------------------------------------------------------------------------


@web.middleware
async def cors_middleware(request: web.Request, handler: Any) -> web.StreamResponse:
    if request.method == "OPTIONS":
        return web.Response(
            status=204,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token, X-Member-Id, X-Token",
            },
        )
    response = await handler(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response


# --------------------------------------------------------------------------
# 一起听房间（纯 HTTP）
# --------------------------------------------------------------------------


async def handle_create(request: web.Request) -> web.Response:
    body = await request.json()
    name = str(body.get("name", "")).strip() or "我"
    code = new_code()
    member_id = secrets.token_hex(16)
    token = secrets.token_hex(32)
    room = Room(code, member_id)
    room.members[member_id] = {"name": name, "token": token, "last_seen": now_ms()}
    rooms[code] = room
    log.info("创建房间 %s（房主 %s）", code, name)
    return web.json_response({"code": code, "memberId": member_id, "token": token})


async def handle_join(request: web.Request) -> web.Response:
    code = request.match_info["code"].strip().upper()
    room = rooms.get(code)
    if room is None:
        return web.json_response({"error": "room not found"}, status=404)
    body = await request.json()
    name = str(body.get("name", "")).strip() or "我"
    member_id = secrets.token_hex(16)
    token = secrets.token_hex(32)
    room.members[member_id] = {"name": name, "token": token, "last_seen": now_ms()}
    log.info("成员 %s 加入房间 %s（现有 %s 人）", name, code, len(room.members))
    return web.json_response({"memberId": member_id, "token": token})


async def handle_push_state(request: web.Request) -> web.Response:
    """成员推送播放状态（房主总是允许，获权成员也可推；baseSeq 乐观锁防覆盖）"""
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    body = await request.json()
    is_host = member_id == room.host_id
    if not is_host and not permission_for(room, member_id, "allowGuestControl"):
        return web.json_response({"error": "forbidden"}, status=403)
    # 乐观锁：客户端已知 seq 落后于当前（别人已推过）时拒绝覆盖，返回最新快照
    base_seq = int(body.get("baseSeq", 0) or 0)
    if base_seq > 0 and base_seq != room.seq and room.last_actor != member_id:
        return web.json_response({"conflict": True, "snapshot": room_snapshot(room)})
    room.seq += 1
    room.state = {
        "track": body.get("track"),
        "state": body.get("state"),
        "positionMs": int(body.get("positionMs", 0) or 0),
        "at": now_ms(),
        "playIndex": int(body.get("playIndex", -1) or -1),
        "repeatMode": str(body.get("repeatMode", "list")),
        "shuffleMode": str(body.get("shuffleMode", "off")),
    }
    room.last_actor = member_id
    if is_host:
        room.host_last_push = now_ms()
    room.touch(member_id)
    log.debug(
        "成员 %s 推送状态：%s，进度 %sms",
        member_id[:8],
        room.state.get("state"),
        room.state.get("positionMs"),
    )
    return web.json_response(room_snapshot(room))


async def handle_get_state(request: web.Request) -> web.Response:
    """成员拉取房间快照（状态 / 成员 / 队列 / 报告）"""
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    room.touch(member_id)
    return web.json_response(room_snapshot(room))


async def handle_push_queue(request: web.Request) -> web.Response:
    """成员推送播放列表（房主总是允许，获权成员也可推）"""
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    is_host = member_id == room.host_id
    if not is_host and not permission_for(room, member_id, "allowGuestEditPlaylist"):
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    room.queue = body.get("tracks", []) or []
    room.touch(member_id)
    log.debug(
        "成员 %s 推送播放列表（%s 首）到房间 %s",
        member_id[:8],
        len(room.queue),
        room.code,
    )
    return web.json_response(room_snapshot(room))


async def handle_set_permissions(request: web.Request) -> web.Response:
    """房主设置成员权限：不带 memberId 设置全局默认，带 memberId 设置单个成员覆盖"""
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    if member_id != room.host_id:
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    target = str(body.get("memberId", "") or "")
    current = room.permissions
    if target:
        # per-member 覆盖：字段缺省时清空该成员对应限制（恢复全局默认）
        members = current.get("members", {}) if isinstance(current, dict) else {}
        member_cfg = members.get(target, {}) if isinstance(members, dict) else {}
        updated = dict(member_cfg)
        if "allowGuestControl" in body:
            updated["allowGuestControl"] = bool(body.get("allowGuestControl"))
        if "allowGuestEditPlaylist" in body:
            updated["allowGuestEditPlaylist"] = bool(body.get("allowGuestEditPlaylist"))
        if updated:
            members[target] = updated
        else:
            members.pop(target, None)
        room.permissions = {**current, "members": members}
        log.info("房间 %s 成员 %s 权限更新：%s", room.code, target[:8], updated)
    else:
        room.permissions = {
            "allowGuestControl": bool(body.get("allowGuestControl", current.get("allowGuestControl", True))),
            "allowGuestEditPlaylist": bool(
                body.get("allowGuestEditPlaylist", current.get("allowGuestEditPlaylist", True))
            ),
            "members": current.get("members", {}) if isinstance(current, dict) else {},
        }
        log.info("房间 %s 权限更新：%s", room.code, room.permissions)
    room.touch(member_id)
    return web.json_response(room_snapshot(room))


async def handle_transfer_host(request: web.Request) -> web.Response:
    """房主将房主身份转移给其他成员，自己变为成员"""
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    if member_id != room.host_id:
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    target = str(body.get("targetMemberId", ""))
    if target not in room.members or target == member_id:
        return web.json_response({"error": "invalid target"}, status=400)
    room.host_id = target
    room.host_last_push = now_ms()
    room.touch(member_id)
    log.warning("房主 %s 将房主身份转移给 %s（房间 %s）", member_id[:8], target[:8], room.code)
    return web.json_response(room_snapshot(room))


async def handle_report(request: web.Request) -> web.Response:
    """成员上报无法播放，供房主快照时取走"""
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    room.touch(member_id)
    body = await request.json()
    member_name = room.members.get(member_id, {}).get("name", "成员")
    track_title = str(body.get("trackTitle", ""))
    room.reports.append(
        {
            "kind": str(body.get("kind", "")),
            "name": member_name,
            "trackTitle": track_title,
        }
    )
    log.info("成员 %s 上报无法播放《%s》（房间 %s）", member_name, track_title, room.code)
    return web.json_response({"ok": True})


async def handle_leave(request: web.Request) -> web.Response:
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    room.members.pop(member_id, None)
    if member_id == room.host_id:
        now = now_ms()
        for mid, m in room.members.items():
            if now - m["last_seen"] <= MEMBER_TIMEOUT_MS:
                room.host_id = mid
                room.host_last_push = now
                log.warning("房主离开房间 %s，房主转移给 %s", room.code, mid)
                break
        else:
            room.closed = True
            room.closed_at = now_ms()
            log.info("房主离开，房间 %s 即将解散", room.code)
            return web.json_response(room_snapshot(room))
    log.info("成员离开房间 %s（在线 %s 人）", room.code, room.online_count())
    return web.json_response({"ok": True})


# --------------------------------------------------------------------------
# 后台清理：房主失联转移 / 僵尸房间回收
# --------------------------------------------------------------------------


async def cleanup_loop() -> None:
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_MS / 1000)
        now = now_ms()
        for code, room in list(rooms.items()):
            # 已标记关闭的房间，3 秒后删除
            if room.closed and room.closed_at > 0 and now - room.closed_at > 3_000:
                rooms.pop(code, None)
                log.info("清理已关闭房间 %s", code)
                continue
            if now - room.host_last_push > HOST_TIMEOUT_MS:
                for mid, m in room.members.items():
                    if mid != room.host_id and now - m["last_seen"] <= MEMBER_TIMEOUT_MS:
                        room.host_id = mid
                        room.host_last_push = now
                        log.warning(
                            "房主失联（%s 秒未推送），房间 %s 房主转移给 %s",
                            HOST_TIMEOUT_MS // 1000,
                            room.code,
                            mid,
                        )
                        break
            if room.online_count() == 0 and now - room.created_at > ROOM_TTL_MS:
                rooms.pop(code, None)
                log.info("清理空闲房间 %s（创建超过 %s 分钟）", room.code, ROOM_TTL_MS // 60000)


async def start_cleanup(app: web.Application) -> None:
    app["cleanup_task"] = asyncio.create_task(cleanup_loop())
    log.info("后台清理任务已启动（间隔 %s 秒）", CLEANUP_INTERVAL_MS // 1000)


async def stop_cleanup(app: web.Application) -> None:
    task = app.get("cleanup_task")
    if task is not None:
        task.cancel()
        log.info("后台清理任务已停止")


# --------------------------------------------------------------------------
# WebUI 管理后台
# --------------------------------------------------------------------------


async def handle_admin_login(request: web.Request) -> web.Response:
    body = await request.json()
    username = str(body.get("username", ""))
    password = str(body.get("password", ""))
    if username == ADMIN_USERNAME and password == ADMIN_PASSWORD:
        token = secrets.token_hex(32)
        admin_tokens.add(token)
        log.info("管理员登录成功：%s", username)
        resp = web.json_response({"token": token})
        # 设置 cookie（24h 过期），httponly 防止 JS 读取，WebUI 同源请求自动携带
        resp.set_cookie(
            "spt_admin_token", token,
            max_age=86400, httponly=True, samesite="lax", path="/",
        )
        return resp
    log.warning("管理员登录失败：%s", username)
    return web.json_response({"error": "invalid credentials"}, status=401)


async def handle_admin_logout(request: web.Request) -> web.Response:
    token = request.headers.get("X-Admin-Token", "") or request.cookies.get("spt_admin_token", "")
    admin_tokens.discard(token)
    resp = web.json_response({"ok": True})
    resp.del_cookie("spt_admin_token", path="/")
    return resp


async def handle_admin_reload(request: web.Request) -> web.Response:
    """重新加载 config.yml，无需重启服务器"""
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    global CONFIG, ADMIN_USERNAME, ADMIN_PASSWORD
    config = load_config()
    CONFIG = config
    ADMIN_USERNAME = str(config["admin"]["username"])
    ADMIN_PASSWORD = str(config["admin"]["password"])
    log.info("管理员刷新配置")
    return web.json_response({"ok": True})


async def handle_admin_rooms_list(request: web.Request) -> web.Response:
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    # 过滤已关闭的房间，已解散的房间在 WebUI 中立即消失（client 端仍能收到 closed 通知）
    return web.json_response({"rooms": [r.admin_view() for r in rooms.values() if not r.closed]})


async def handle_admin_room_dissolve(request: web.Request) -> web.Response:
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    code = request.match_info["code"].strip().upper()
    if code not in rooms:
        return web.json_response({"error": "room not found"}, status=404)
    room = rooms[code]
    room.closed = True
    room.closed_at = now_ms()
    log.warning("管理员解散房间 %s", code)
    return web.json_response({"ok": True})


async def handle_admin_page(request: web.Request) -> web.StreamResponse:
    return web.Response(text=render_admin_page(), content_type="text/html")


async def index(_request: web.Request) -> web.Response:
    return web.Response(text="SPlayer Together relay server")


def build_app() -> web.Application:
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_get("/", index)
    app.router.add_get("/admin", handle_admin_page)
    app.router.add_static("/downloads", DOWNLOADS_DIR, show_index=True)
    app.router.add_post("/api/rooms", handle_create)
    app.router.add_post("/api/rooms/{code}/join", handle_join)
    app.router.add_post("/api/rooms/{code}/state", handle_push_state)
    app.router.add_get("/api/rooms/{code}/state", handle_get_state)
    app.router.add_post("/api/rooms/{code}/queue", handle_push_queue)
    app.router.add_post("/api/rooms/{code}/permissions", handle_set_permissions)
    app.router.add_post("/api/rooms/{code}/transfer", handle_transfer_host)
    app.router.add_post("/api/rooms/{code}/report", handle_report)
    app.router.add_post("/api/rooms/{code}/leave", handle_leave)
    app.router.add_post("/api/admin/login", handle_admin_login)
    app.router.add_post("/api/admin/logout", handle_admin_logout)
    app.router.add_post("/api/admin/reload", handle_admin_reload)
    app.router.add_get("/api/admin/rooms", handle_admin_rooms_list)
    app.router.add_post("/api/admin/rooms/{code}/dissolve", handle_admin_room_dissolve)
    app.on_startup.append(start_cleanup)
    app.on_cleanup.append(stop_cleanup)
    return app


def main() -> None:
    if ADMIN_PASSWORD == "change-me":
        log.warning("管理后台仍在使用默认密码，请尽快在 config.yml 中修改")
    host = str(CONFIG["host"])
    port = int(CONFIG["port"])
    log.info(
        "SPlayer Together 中继服务器启动：http://%s:%s（管理后台 /admin）",
        host,
        port,
    )
    web.run_app(build_app(), host=host, port=port, access_log=None)


if __name__ == "__main__":
    main()
