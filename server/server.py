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
# 无在线成员的房间超过该时长后清理
ROOM_TTL_MS = 10 * 60 * 1000
# 后台清理任务间隔
CLEANUP_INTERVAL_MS = 30_000

DEFAULT_CONFIG: dict[str, Any] = {
    "host": "0.0.0.0",
    "port": 8000,
    "admin": {"username": "admin", "password": "change-me"},
    "keys": [],
}


def now_ms() -> int:
    """服务器毫秒时间戳"""
    return int(time.time() * 1000)


def load_config() -> dict[str, Any]:
    data: dict[str, Any] = {}
    if CONFIG_FILE.exists():
        data = yaml.safe_load(CONFIG_FILE.read_text(encoding="utf-8")) or {}
    config = {**DEFAULT_CONFIG, **data}
    config["admin"] = {**DEFAULT_CONFIG["admin"], **(data.get("admin") or {})}
    config["keys"] = [str(k).strip() for k in (config.get("keys") or []) if str(k).strip()]
    return config


def save_config(config: dict[str, Any]) -> None:
    CONFIG_FILE.write_text(
        yaml.safe_dump(config, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )


CONFIG = load_config()
AUTH_KEYS: list[str] = CONFIG["keys"]
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
        "serverNow": now_ms(),
    }


def new_code() -> str:
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(ROOM_CODE_LEN))
        if code not in rooms:
            return code


def valid_machine_key(key: str) -> bool:
    return bool(AUTH_KEYS) and key in AUTH_KEYS


def admin_authed(request: web.Request) -> bool:
    return request.headers.get("X-Admin-Token", "") in admin_tokens


def room_auth(request: web.Request) -> tuple[Room, str] | None:
    """校验机器密钥与成员凭据，返回 (room, member_id)"""
    if not valid_machine_key(request.headers.get("X-Auth-Key", "")):
        return None
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
                "Access-Control-Allow-Headers": "Content-Type, X-Auth-Key, X-Admin-Token, X-Member-Id, X-Token",
            },
        )
    response = await handler(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response


# --------------------------------------------------------------------------
# 授权
# --------------------------------------------------------------------------


async def handle_auth(request: web.Request) -> web.Response:
    body = await request.json()
    key = str(body.get("key", "")).strip()
    if valid_machine_key(key):
        return web.json_response({"valid": True})
    return web.json_response({"error": "invalid key"}, status=401)


# --------------------------------------------------------------------------
# 一起听房间（纯 HTTP）
# --------------------------------------------------------------------------


async def handle_create(request: web.Request) -> web.Response:
    if not valid_machine_key(request.headers.get("X-Auth-Key", "")):
        return web.json_response({"error": "unauthorized"}, status=401)
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
    if not valid_machine_key(request.headers.get("X-Auth-Key", "")):
        return web.json_response({"error": "unauthorized"}, status=401)
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
    """房主推送播放状态；任意成员都会刷新活跃时间。返回房间快照。"""
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    body = await request.json()
    if member_id == room.host_id:
        room.seq += 1
        room.state = {
            "track": body.get("track"),
            "state": body.get("state"),
            "positionMs": int(body.get("positionMs", 0) or 0),
            "at": now_ms(),
        }
        room.host_last_push = now_ms()
        log.debug(
            "房主 %s 推送状态：%s，进度 %sms",
            member_id[:8],
            room.state.get("state"),
            room.state.get("positionMs"),
        )
    room.touch(member_id)
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
    """房主推送播放列表"""
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    if member_id != room.host_id:
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    room.queue = body.get("tracks", []) or []
    room.touch(member_id)
    log.debug("房主 %s 推送播放列表（%s 首）到房间 %s", member_id[:8], len(room.queue), room.code)
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
            rooms.pop(room.code, None)
            log.info("房主离开，房间 %s 解散", room.code)
            return web.json_response({"ok": True})
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
        return web.json_response({"token": token})
    log.warning("管理员登录失败：%s", username)
    return web.json_response({"error": "invalid credentials"}, status=401)


async def handle_admin_logout(request: web.Request) -> web.Response:
    admin_tokens.discard(request.headers.get("X-Admin-Token", ""))
    return web.json_response({"ok": True})


async def handle_admin_keys_list(request: web.Request) -> web.Response:
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    return web.json_response({"keys": list(AUTH_KEYS)})


async def handle_admin_keys_add(request: web.Request) -> web.Response:
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    body = await request.json()
    key = str(body.get("key", "")).strip()
    if not key:
        return web.json_response({"error": "empty key"}, status=400)
    if key not in AUTH_KEYS:
        AUTH_KEYS.append(key)
        save_config(CONFIG)
        log.info("添加授权密钥：%s", key)
    return web.json_response({"keys": list(AUTH_KEYS)})


async def handle_admin_keys_remove(request: web.Request) -> web.Response:
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    key = request.match_info["key"]
    if key in AUTH_KEYS:
        AUTH_KEYS.remove(key)
        save_config(CONFIG)
        log.info("删除授权密钥：%s", key)
    return web.json_response({"keys": list(AUTH_KEYS)})


async def handle_admin_rooms_list(request: web.Request) -> web.Response:
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    return web.json_response({"rooms": [r.admin_view() for r in rooms.values()]})


async def handle_admin_room_dissolve(request: web.Request) -> web.Response:
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    code = request.match_info["code"].strip().upper()
    if code not in rooms:
        return web.json_response({"error": "room not found"}, status=404)
    rooms.pop(code, None)
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
    app.router.add_post("/api/auth", handle_auth)
    app.router.add_post("/api/rooms", handle_create)
    app.router.add_post("/api/rooms/{code}/join", handle_join)
    app.router.add_post("/api/rooms/{code}/state", handle_push_state)
    app.router.add_get("/api/rooms/{code}/state", handle_get_state)
    app.router.add_post("/api/rooms/{code}/queue", handle_push_queue)
    app.router.add_post("/api/rooms/{code}/report", handle_report)
    app.router.add_post("/api/rooms/{code}/leave", handle_leave)
    app.router.add_post("/api/admin/login", handle_admin_login)
    app.router.add_post("/api/admin/logout", handle_admin_logout)
    app.router.add_get("/api/admin/keys", handle_admin_keys_list)
    app.router.add_post("/api/admin/keys", handle_admin_keys_add)
    app.router.add_delete("/api/admin/keys/{key}", handle_admin_keys_remove)
    app.router.add_get("/api/admin/rooms", handle_admin_rooms_list)
    app.router.add_post("/api/admin/rooms/{code}/dissolve", handle_admin_room_dissolve)
    app.on_startup.append(start_cleanup)
    app.on_cleanup.append(stop_cleanup)
    return app


def main() -> None:
    if not AUTH_KEYS:
        log.warning("密钥白名单为空：请在 config.yml 或 WebUI 中配置，未授权客户端将被拒绝")
    if ADMIN_PASSWORD == "change-me":
        log.warning("管理后台仍在使用默认密码，请尽快在 config.yml 中修改")
    host = str(CONFIG["host"])
    port = int(CONFIG["port"])
    log.info(
        "SPlayer Together 中继服务器启动：http://%s:%s（密钥 %s 个，管理后台 /admin）",
        host,
        port,
        len(AUTH_KEYS),
    )
    web.run_app(build_app(), host=host, port=port, access_log=None)


if __name__ == "__main__":
    main()
