"""SPlayer Together 中继服务器测试：房间全生命周期"""

from __future__ import annotations

import json
from typing import Any

import pytest
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

# 在导入 server 之前重置 rooms 和 admin_tokens 以确保测试隔离
import server as relay

relay.rooms = {}
relay.admin_tokens = set()


class TestRoomLifecycle(AioHTTPTestCase):
    """房间创建、加入、状态推拉、房主转移、解散"""

    async def get_application(self):
        return relay.build_app()

    async def _create_room(self) -> dict[str, Any]:
        resp = await self.client.post("/api/rooms", json={"name": "HostOne"})
        assert resp.status == 200
        data = await resp.json()
        assert "code" in data
        assert "memberId" in data
        assert "token" in data
        return data

    async def _join_room(self, code: str, name: str = "GuestOne") -> dict[str, Any]:
        resp = await self.client.post(f"/api/rooms/{code}/join", json={"name": name})
        assert resp.status == 200
        data = await resp.json()
        assert "memberId" in data
        assert "token" in data
        return data

    def _headers(self, member_id: str, token: str) -> dict[str, str]:
        return {"X-Member-Id": member_id, "X-Token": token}

    @unittest_run_loop
    async def test_create_room(self):
        """创建房间应返回房间码、成员 ID 和令牌"""
        data = await self._create_room()
        assert len(data["code"]) == 6
        assert data["code"].isalnum()
        assert len(data["memberId"]) == 32
        assert len(data["token"]) == 64

    @unittest_run_loop
    async def test_join_room(self):
        """加入房间应返回成员 ID 和令牌"""
        room = await self._create_room()
        guest = await self._join_room(room["code"])
        assert len(guest["memberId"]) == 32
        assert len(guest["token"]) == 64

    @unittest_run_loop
    async def test_join_nonexistent_room_returns_404(self):
        """加入不存在的房间应返回 404"""
        resp = await self.client.post("/api/rooms/ZZZZZZ/join", json={"name": "Ghost"})
        assert resp.status == 404
        data = await resp.json()
        assert "error" in data

    @unittest_run_loop
    async def test_host_push_and_guest_pull_state(self):
        """房主推状态后，成员应能拉取到该状态"""
        room = await self._create_room()
        host_headers = self._headers(room["memberId"], room["token"])

        push_resp = await self.client.post(
            f"/api/rooms/{room['code']}/state",
            json={
                "track": {"id": "123", "title": "Test Song"},
                "state": "playing",
                "positionMs": 5000,
                "playIndex": 0,
                "repeatMode": "list",
                "shuffleMode": "off",
            },
            headers=host_headers,
        )
        assert push_resp.status == 200
        push_data = await push_resp.json()
        assert push_data["seq"] > 0
        assert push_data["state"]["track"]["title"] == "Test Song"

        # 成员加入并拉取
        guest = await self._join_room(room["code"])
        guest_headers = self._headers(guest["memberId"], guest["token"])
        get_resp = await self.client.get(
            f"/api/rooms/{room['code']}/state", headers=guest_headers
        )
        assert get_resp.status == 200
        get_data = await get_resp.json()
        assert get_data["state"]["track"]["title"] == "Test Song"
        assert get_data["state"]["state"] == "playing"

    @unittest_run_loop
    async def test_unauthorized_get_state_returns_401(self):
        """未授权拉取状态应返回 401"""
        resp = await self.client.get(
            "/api/rooms/AAAAAA/state",
            headers={"X-Member-Id": "bad", "X-Token": "bad"},
        )
        assert resp.status == 401

    @unittest_run_loop
    async def test_guest_push_disabled_when_control_disabled(self):
        """获权控制被禁用后，成员推送状态应返回 403"""
        room = await self._create_room()
        host_headers = self._headers(room["memberId"], room["token"])
        guest = await self._join_room(room["code"])
        guest_headers = self._headers(guest["memberId"], guest["token"])

        # 房主禁用该成员的推送权限
        await self.client.post(
            f"/api/rooms/{room['code']}/permissions",
            json={"memberId": guest["memberId"], "allowGuestControl": False},
            headers=host_headers,
        )

        push_resp = await self.client.post(
            f"/api/rooms/{room['code']}/state",
            json={"state": "playing", "positionMs": 0, "playIndex": 0},
            headers=guest_headers,
        )
        assert push_resp.status == 403

    @unittest_run_loop
    async def test_optimistic_lock_conflict(self):
        """乐观锁：baseSeq 落后时返回冲突快照"""
        room = await self._create_room()
        host_headers = self._headers(room["memberId"], room["token"])

        # 两次推送使 seq=2
        await self.client.post(
            f"/api/rooms/{room['code']}/state",
            json={"state": "playing", "positionMs": 1000, "playIndex": 0},
            headers=host_headers,
        )
        await self.client.post(
            f"/api/rooms/{room['code']}/state",
            json={"state": "playing", "positionMs": 1500, "playIndex": 0},
            headers=host_headers,
        )

        # 当前 seq=2，baseSeq=1（落后），且 last_actor 不是自己时触发冲突
        relay.rooms[room["code"]].last_actor = "someone_else"

        push_resp = await self.client.post(
            f"/api/rooms/{room['code']}/state",
            json={
                "state": "paused",
                "positionMs": 2000,
                "playIndex": 0,
                "baseSeq": 1,
            },
            headers=host_headers,
        )
        assert push_resp.status == 200
        push_data = await push_resp.json()
        assert push_data.get("conflict") is True
        assert "snapshot" in push_data

    @unittest_run_loop
    async def test_push_queue(self):
        """房主推送播放列表"""
        room = await self._create_room()
        host_headers = self._headers(room["memberId"], room["token"])
        tracks = [{"id": "1", "title": "Track A"}, {"id": "2", "title": "Track B"}]

        resp = await self.client.post(
            f"/api/rooms/{room['code']}/queue",
            json={"tracks": tracks},
            headers=host_headers,
        )
        assert resp.status == 200
        data = await resp.json()
        assert len(data["queue"]) == 2

    @unittest_run_loop
    async def test_leave_room(self):
        """成员离开房间"""
        room = await self._create_room()
        guest = await self._join_room(room["code"])
        guest_headers = self._headers(guest["memberId"], guest["token"])

        resp = await self.client.post(
            f"/api/rooms/{room['code']}/leave", headers=guest_headers
        )
        assert resp.status == 200
        data = await resp.json()
        assert data["ok"] is True

    @unittest_run_loop
    async def test_transfer_host(self):
        """房主转移"""
        room = await self._create_room()
        guest = await self._join_room(room["code"])
        host_headers = self._headers(room["memberId"], room["token"])

        resp = await self.client.post(
            f"/api/rooms/{room['code']}/transfer",
            json={"targetMemberId": guest["memberId"]},
            headers=host_headers,
        )
        assert resp.status == 200
        data = await resp.json()
        assert data["hostId"] == guest["memberId"]

    @unittest_run_loop
    async def test_admin_rooms_list(self):
        """管理员列出房间"""
        await self._create_room()
        await self._create_room()

        # 模拟登录
        login_resp = await self.client.post(
            "/api/admin/login",
            json={"username": "admin", "password": "change-me"},
        )
        assert login_resp.status == 200
        login_data = await login_resp.json()
        token = login_data["token"]

        rooms_resp = await self.client.get(
            "/api/admin/rooms",
            headers={"X-Admin-Token": token},
        )
        assert rooms_resp.status == 200
        rooms_data = await rooms_resp.json()
        assert len(rooms_data["rooms"]) >= 2

    @unittest_run_loop
    async def test_admin_dissolve_room(self):
        """管理员解散房间"""
        room = await self._create_room()

        login_resp = await self.client.post(
            "/api/admin/login",
            json={"username": "admin", "password": "change-me"},
        )
        login_data = await login_resp.json()
        token = login_data["token"]

        resp = await self.client.post(
            f"/api/admin/rooms/{room['code']}/dissolve",
            headers={"X-Admin-Token": token},
        )
        assert resp.status == 200
        data = await resp.json()
        assert data["ok"] is True

    @unittest_run_loop
    async def test_report_then_clear_on_snapshot(self):
        """成员报告在快照中取出后清空"""
        room = await self._create_room()
        host_headers = self._headers(room["memberId"], room["token"])

        await self.client.post(
            f"/api/rooms/{room['code']}/report",
            json={"kind": "error", "name": "HostOne", "trackTitle": "Test"},
            headers=host_headers,
        )

        # 第一次拉取应有报告
        get1 = await self.client.get(
            f"/api/rooms/{room['code']}/state", headers=host_headers
        )
        data1 = await get1.json()
        assert len(data1["reports"]) == 1

        # 第二次拉取报告应清空
        get2 = await self.client.get(
            f"/api/rooms/{room['code']}/state", headers=host_headers
        )
        data2 = await get2.json()
        assert len(data2["reports"]) == 0