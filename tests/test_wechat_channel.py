from __future__ import annotations

import copy
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from urllib.request import Request, urlopen

from wechat_channel.agents import DshAgentAdapter, EchoAgentAdapter
from wechat_channel.config import DEFAULT_CONFIG, load_config
from wechat_channel.drivers import HookSendDriver, SendDriver, SendRouter, UiaOcrSendDriver, WeChatDbReceiveDriver, parse_group_content
from wechat_channel.http_api import ManagementServer
from wechat_channel.media import image_part_from_media
from wechat_channel.models import AgentReply, DriverHealth, RawMessage, SendResult, SendTask, StandardMessage
from wechat_channel.service import Policy, WeChatChannelService
from wechat_channel.storage import StateStore


class FakeDb:
    wxid = "wxid_test"

    def __init__(self):
        self.messages = {
            "friend": [{"local_id": 10, "sender_id": 1, "type": "text", "content": "old", "create_time": 1, "sort_seq": 10}]
        }
        self.unread = {"friend": 0}

    def get_self_info(self):
        return {"username": self.wxid, "nick_name": "Tester"}

    def get_sessions(self, limit=15):
        return [{"username": name, "last_time": rows[-1]["create_time"], "unread": self.unread.get(name, 0)} for name, rows in self.messages.items()][:limit]

    def get_messages(self, user, limit=3):
        return list(reversed(self.messages.get(user, [])))[:limit]

    def get_new_messages(self, user, since_seq=0, limit=3):
        return [row for row in self.messages.get(user, []) if row["sort_seq"] > since_seq][:limit]

    def get_nickname(self, user):
        return "Friend" if user == "friend" else user

    def search_contact(self, keyword):
        return [{"username": "friend", "nick_name": "Friend Nick", "remark": "Friend Remark"}] if keyword == "friend" else []


class FakeSendDriver(SendDriver):
    def __init__(self, name, outcomes):
        self.name = name
        self.outcomes = list(outcomes)
        self.calls = 0

    def health(self):
        return DriverHealth(True, self.name)

    def send(self, task):
        self.calls += 1
        ok = self.outcomes.pop(0) if self.outcomes else False
        return SendResult(ok, self.name, task.target_id, task.idempotency_key, None if ok else "failed")


class CapturingAgent(EchoAgentAdapter):
    def __init__(self):
        self.metadata = None

    def respond(self, session_id, message, metadata):
        self.metadata = metadata
        return AgentReply("received", session_id)


class WeChatChannelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = StateStore(str(Path(self.temp.name) / "state.sqlite3"))

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_group_parser_and_normalized_conversation_key(self):
        sender, content = parse_group_content("wxid_member:\nhello", 17)
        self.assertEqual(sender, "wxid_member")
        self.assertEqual(content, "hello")
        db = FakeDb()
        receive = WeChatDbReceiveDriver(self.store, db_factory=lambda **_: db)
        raw = receive.poll()
        self.assertEqual(raw.baseline_conversations, ["friend"])

    def test_default_policy_allows_groups_and_contact_profile_keeps_identity_fields(self):
        db = FakeDb()
        receive = WeChatDbReceiveDriver(self.store, db_factory=lambda **_: db)
        profile = receive.contact_profile("friend")
        self.assertEqual(profile["nickname"], "Friend Nick")
        self.assertEqual(profile["remark"], "Friend Remark")
        message = StandardMessage("m", "wechat", "a", "group@chatroom", "group", "member", "text", "hello", 1)
        allowed, reason = Policy(copy.deepcopy(DEFAULT_CONFIG)["policy"]).allow(message)
        self.assertTrue(allowed, reason)

    def test_dsh_prompt_includes_group_and_sender_identity(self):
        message = StandardMessage("m", "wechat", "a", "group@chatroom", "group", "member", "text", "hello", 1)
        prompt = DshAgentAdapter._contextual_prompt(message, {
            "conversation_name": "测试群", "sender_name": "张三", "sender_remark": "三哥", "sender_wechat_id": "zhangsan",
            "mentioned": True, "mention_display_masked": True,
        })
        self.assertIn("会话名称：测试群", prompt)
        self.assertIn("发送者：张三", prompt)
        self.assertIn("发送者备注：三哥", prompt)
        self.assertIn("发送者微信号：zhangsan", prompt)
        self.assertIn("机器人被 @：是（微信已将提及名称脱敏显示为 @***）", prompt)
        self.assertTrue(prompt.endswith("【用户消息】\nhello"))

    def test_masked_group_mention_is_recognized_as_self_mention(self):
        db = FakeDb()
        receive = WeChatDbReceiveDriver(self.store, db_factory=lambda **_: db)
        self.assertTrue(receive.mentions_self("member:\n@*** 你好"))
        self.assertTrue(receive.mentions_self("member:\n@＊＊＊ 你好"))

    def test_first_poll_establishes_baseline_and_does_not_reply_history(self):
        db = FakeDb()
        receive = WeChatDbReceiveDriver(self.store, db_factory=lambda **_: db)
        sender = FakeSendDriver("send", [True])
        config = copy.deepcopy(DEFAULT_CONFIG)
        config["policy"]["direct_message"] = "allow"
        service = WeChatChannelService(config, self.store, receive, SendRouter([sender], 0), EchoAgentAdapter())
        service.poll_once()
        self.assertEqual(self.store.get_cursor("friend"), 10)
        self.assertEqual(service._send_queue.qsize(), 0)
        db.messages["friend"].append({"local_id": 11, "sender_id": 1, "type": "文本", "content": "new", "create_time": 2, "sort_seq": 11})
        service.poll_once()
        self.assertEqual(service._send_queue.qsize(), 1)
        task = service._send_queue.get_nowait()
        self.assertEqual(task.text, "[ECHO] new")
        self.assertEqual(task.target_id, "friend")
        self.assertEqual(self.store.get_cursor("friend"), 11)

    def test_self_message_is_filtered_and_cursor_advances(self):
        db = FakeDb()
        receive = WeChatDbReceiveDriver(self.store, db_factory=lambda **_: db)
        service = WeChatChannelService(copy.deepcopy(DEFAULT_CONFIG), self.store, receive,
                                       SendRouter([FakeSendDriver("send", [True])], 0), EchoAgentAdapter())
        service.poll_once()
        db.messages["friend"].append({"local_id": 12, "sender_id": 2, "type": "text", "content": "mine", "create_time": 3, "sort_seq": 12})
        service.poll_once()
        self.assertEqual(service._send_queue.qsize(), 0)
        self.assertEqual(self.store.get_cursor("friend"), 12)

    def test_new_unseen_conversation_processes_its_first_unread_message(self):
        db = FakeDb()
        receive = WeChatDbReceiveDriver(self.store, db_factory=lambda **_: db)
        service = WeChatChannelService(copy.deepcopy(DEFAULT_CONFIG), self.store, receive,
                                       SendRouter([FakeSendDriver("send", [True])], 0), EchoAgentAdapter())
        service.poll_once()
        db.messages["new_friend"] = [
            {"local_id": 20, "sender_id": 1, "type": "text", "content": "first message", "create_time": 4, "sort_seq": 20}
        ]
        db.unread["new_friend"] = 1
        service.poll_once()
        self.assertEqual(service._send_queue.qsize(), 1)
        self.assertEqual(service._send_queue.get_nowait().text, "[ECHO] first message")
        self.assertEqual(self.store.get_cursor("new_friend"), 20)

    def test_send_router_falls_back_and_is_bounded(self):
        hook = FakeSendDriver("hook", [False])
        gui = FakeSendDriver("uia_ocr", [True])
        result = SendRouter([hook, gui], max_retries=2, retry_delay=0).send(SendTask("friend", "hello", "m1", "m1:reply"))
        self.assertTrue(result.ok)
        self.assertEqual(result.driver, "uia_ocr")
        self.assertEqual(result.attempts, 2)
        self.assertEqual(hook.calls, 1)
        self.assertEqual(gui.calls, 1)

    def test_group_reply_mentions_original_sender_through_native_hook(self):
        db = FakeDb()
        receive = WeChatDbReceiveDriver(self.store, db_factory=lambda **_: db)
        service = WeChatChannelService(copy.deepcopy(DEFAULT_CONFIG), self.store, receive,
                                       SendRouter([FakeSendDriver("aixed_hook", [True])], 0), EchoAgentAdapter())
        service._handle_raw(RawMessage("account", "group@chatroom", "42", 1, "text", "member:\nhello", 1, 42))
        task = service._send_queue.get_nowait()
        self.assertEqual(task.mention_ids, ["member"])
        self.assertEqual(task.mention_names, ["member"])

    def test_mention_task_falls_back_to_bound_uia_native_mention(self):
        hook = FakeSendDriver("aixed_hook", [False])
        gui = FakeSendDriver("wechatauto_uia_ocr", [True])
        result = SendRouter([hook, gui], max_retries=0, retry_delay=0).send(
            SendTask("group@chatroom", "hello", "m1", "m1:reply", mention_ids=["member"])
        )
        self.assertTrue(result.ok)
        self.assertEqual(hook.calls, 1)
        self.assertEqual(gui.calls, 1)

    def test_uia_driver_uses_at_member_for_group_mentions(self):
        calls = []

        class Gui:
            def at_member(self, member, text, who=None, verify=False):
                calls.append((member, text, who, verify))
                return type("Response", (), {"ok": True, "is_success": True})()

        driver = UiaOcrSendDriver(lambda _target: "测试群", gui_factory=Gui, verify=True, hwnd=88)
        result = driver.send(SendTask("group@chatroom", "你好", "m", "m:r", mention_ids=["wxid_member"], mention_names=["张三"]))
        self.assertTrue(result.ok)
        self.assertEqual(calls, [("张三", "你好", "测试群", True)])

    def test_hook_driver_posts_group_mention_endpoint_with_visible_prefix(self):
        requests = []

        def fake_request(url, payload, timeout, method="POST"):
            requests.append((url, payload, timeout, method))
            return {"ret": 0}

        import wechat_channel.drivers as drivers
        original = drivers._json_request
        drivers._json_request = fake_request
        try:
            result = HookSendDriver("http://127.0.0.1:30001").send(
                SendTask("group@chatroom", "你好", "m1", "m1:reply", mention_ids=["wxid_member"], mention_names=["张三"])
            )
        finally:
            drivers._json_request = original
        self.assertTrue(result.ok)
        self.assertEqual(requests[0][0], "http://127.0.0.1:30001/SendAtText")
        self.assertEqual(requests[0][1], {"wxidorgid": "group@chatroom", "msg": "@张三 你好", "wxids": ["wxid_member"]})

    def test_session_and_send_tasks_persist(self):
        self.store.set_session("wechat:a:c", "session-1", {"a": 1})
        self.assertEqual(self.store.get_session("wechat:a:c"), "session-1")
        self.assertEqual(self.store.get_session_metadata("wechat:a:c"), {"a": 1})
        task = SendTask("friend", "hello", "m1", "m1:reply", mention_ids=["wxid_member"], mention_names=["张三"])
        self.assertTrue(self.store.create_send_task(task.to_dict()))
        self.assertFalse(self.store.create_send_task(task.to_dict()))
        pending = self.store.pending_send_tasks()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["mention_ids"], ["wxid_member"])
        self.assertEqual(pending[0]["mention_names"], ["张三"])
        self.store.finish_send_task(task.idempotency_key, True, "hook", 1, None)
        self.assertEqual(self.store.pending_send_tasks(), [])

    def test_configuration_rejects_non_loopback_hook(self):
        path = Path(self.temp.name) / "bad.json"
        path.write_text('{"send":{"hook_endpoint":"http://192.168.1.2:30001"}}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "loopback"):
            load_config(str(path))

    def test_configuration_allows_hook_to_be_disabled_for_isolated_bots(self):
        path = Path(self.temp.name) / "isolated.json"
        path.write_text('{"send":{"hook_endpoint":""},"runtime":{"wechatHwnd":12345}}', encoding="utf-8")
        config = load_config(str(path))
        self.assertEqual(config["send"]["hook_endpoint"], "")
        self.assertEqual(config["runtime"]["wechatHwnd"], 12345)
        driver = UiaOcrSendDriver(lambda _target: "target", hwnd=12345)
        self.assertEqual(driver.hwnd, 12345)

    def test_management_api_status_and_echo(self):
        db = FakeDb()
        receive = WeChatDbReceiveDriver(self.store, db_factory=lambda **_: db)
        service = WeChatChannelService(copy.deepcopy(DEFAULT_CONFIG), self.store, receive,
                                       SendRouter([FakeSendDriver("send", [True])], 0), EchoAgentAdapter())
        api = ManagementServer("127.0.0.1", 0, service)
        api.start()
        port = api.httpd.server_address[1]
        try:
            with urlopen("http://127.0.0.1:%d/api/status" % port, timeout=3) as response:
                status = json.loads(response.read().decode("utf-8"))
            self.assertTrue(status["receive"]["ok"])
            request = Request("http://127.0.0.1:%d/api/echo" % port, data=b'{"enabled":true}',
                              method="POST", headers={"Content-Type": "application/json"})
            with urlopen(request, timeout=3) as response:
                echo = json.loads(response.read().decode("utf-8"))
            self.assertTrue(echo["enabled"])
        finally:
            api.stop()

    def test_sensitive_word_policy_blocks_before_agent(self):
        policy = Policy({"enabled": True, "direct_message": "allow", "sensitive_words": ["blocked"], "rate_limit_per_minute": 10})
        message = StandardMessage("m", "wechat", "a", "c", "direct", "c", "text", "contains blocked text", 1)
        allowed, reason = policy.allow(message)
        self.assertFalse(allowed)
        self.assertIn("sensitive-word", reason)

    def test_blacklists_override_allow_modes(self):
        policy = Policy({
            "enabled": True, "direct_message": "allow", "group_message": "allow",
            "direct_blacklist": ["blocked-friend"], "group_blacklist": ["blocked-group"],
        })
        direct = StandardMessage("d", "wechat", "a", "blocked-friend", "direct", "blocked-friend", "text", "hello", 1)
        group = StandardMessage("g", "wechat", "a", "blocked-group", "group", "member", "text", "hello", 1)
        self.assertFalse(policy.allow(direct)[0])
        self.assertFalse(policy.allow(group)[0])

    def test_quote_context_is_added_to_agent_prompt(self):
        quote = WeChatChannelService._quote_context("收到\n引用 张三 的消息：原始内容")
        self.assertEqual(quote, {"quoted_message": "原始内容", "quoted_sender": "张三"})
        message = StandardMessage("m", "wechat", "a", "friend", "direct", "friend", "text", "收到", 1)
        prompt = DshAgentAdapter._contextual_prompt(message, quote)
        self.assertIn("引用消息发送者：张三", prompt)
        self.assertIn("引用的消息：原始内容", prompt)

    def test_only_selected_group_requires_mention_but_keeps_context(self):
        db = FakeDb()
        receive = WeChatDbReceiveDriver(self.store, db_factory=lambda **_: db)
        receive.mentions_self = lambda _content: False
        config = copy.deepcopy(DEFAULT_CONFIG)
        config["policy"]["group_reply_only_when_mentioned_groups"] = ["group@chatroom"]
        service = WeChatChannelService(config, self.store, receive,
                                       SendRouter([FakeSendDriver("send", [True])], 0), EchoAgentAdapter())
        raw = RawMessage("account", "group@chatroom", "1", 1, "text", "member:\\nhello", 1, 1)
        service._handle_raw(raw)
        latest = self.store.recent_messages(1)[0]["message"]
        self.assertFalse(latest["reply_allowed"])
        self.assertEqual(latest["policy_reason"], "group message does not mention account")
        self.assertEqual(service._send_queue.qsize(), 0)

    def test_context_storage_retains_latest_two_hundred_records(self):
        for index in range(205):
            self.store.mark_processed("m-%d" % index, "group", {"index": index})
        self.store.prune_recent_messages(200)
        records = self.store.recent_messages(500)
        self.assertEqual(len(records), 200)

    def test_deleted_workspace_is_recreated_even_when_id_was_cached(self):
        workspace_dir = str(Path(self.temp.name) / "wechat-workspace")
        adapter = DshAgentAdapter("http://127.0.0.1:3080", self.store, workspace_dir=workspace_dir)
        adapter._workspace_id = "deleted-workspace"
        calls = []

        def rpc(method, payload):
            calls.append((method, payload))
            if method == "workspace.list":
                return {"items": []}
            if method == "workspace.create":
                return {"workspace": {"workspaceId": "new-workspace"}}
            if method == "workspace.rename":
                return {}
            raise AssertionError(method)

        adapter._rpc = rpc
        ready = adapter.ensure_ready()
        self.assertEqual(ready["workspace_id"], "new-workspace")
        self.assertIn(("workspace.create", {"path": workspace_dir}), calls)

    def test_profile_write_permission_maps_only_the_authorized_direct_session(self):
        preset = "channel-test-permission-%d" % os.getpid()
        preset_dir = Path.home() / ".dsh" / ".agent-presets" / preset
        try:
            self.store.set_session("wechat:a:owner", "session-owner", {
                "conversation_id": "owner", "conversation_type": "direct",
            })
            self.store.set_session("wechat:a:owner@chatroom", "session-group", {
                "conversation_id": "owner", "conversation_type": "group",
            })
            adapter = DshAgentAdapter("http://127.0.0.1:3080", self.store, preset=preset,
                                      authorized_contact_id="owner")
            adapter._sync_profile_permissions()
            permissions = json.loads((preset_dir / "self-profile-permissions.json").read_text(encoding="utf-8"))
            self.assertEqual(permissions["authorizedContactId"], "owner")
            self.assertEqual(permissions["authorizedSessionIds"], ["session-owner"])
        finally:
            if preset_dir.exists():
                shutil.rmtree(preset_dir)

    def test_service_marks_only_selected_direct_contact_as_profile_writer(self):
        db = FakeDb()
        receive = WeChatDbReceiveDriver(self.store, db_factory=lambda **_: db)
        agent = CapturingAgent()
        config = copy.deepcopy(DEFAULT_CONFIG)
        config["policy"]["profile_write_authorized_contact"] = "friend"
        service = WeChatChannelService(config, self.store, receive,
                                       SendRouter([FakeSendDriver("send", [True])], 0), agent)
        service._handle_raw(RawMessage("account", "friend", "41", 1, "text", "remember this", 1, 41))
        self.assertTrue(agent.metadata["profile_write_authorized"])

    def test_image_message_reaches_agent_and_persists_safe_media_metadata(self):
        db = FakeDb()
        receive = WeChatDbReceiveDriver(self.store, db_factory=lambda **_: db)
        receive.materialize_media = lambda _raw, _directory: [{
            "kind": "image", "source_type": "图片", "available": False, "attachable": False,
            "path": "C:/private/cache/image.dat", "name": "", "media_type": "",
            "error": "图片事件已收到，但微信本地图片密钥或缓存尚不可用",
        }]
        agent = CapturingAgent()
        service = WeChatChannelService(copy.deepcopy(DEFAULT_CONFIG), self.store, receive,
                                       SendRouter([FakeSendDriver("send", [True])], 0), agent)
        raw = RawMessage("account", "friend", "31", 1, "图片", "[图片]", 1, 31)
        service._handle_raw(raw)
        self.assertEqual(agent.metadata["media"][0]["kind"], "image")
        self.assertEqual(service._send_queue.get_nowait().text, "received")
        stored = self.store.recent_messages(1)[0]["message"]
        self.assertNotIn("path", stored["context"]["media"][0])

    def test_materialized_image_becomes_harness_image_content_part(self):
        image_path = Path(self.temp.name) / "pixel.png"
        image_path.write_bytes(
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        )
        part = image_part_from_media({"attachable": True, "path": str(image_path), "name": "pixel.png"})
        self.assertEqual(part["type"], "image")
        self.assertEqual(part["mediaType"], "image/png")
        self.assertTrue(part["data"].startswith("iVBOR"))


if __name__ == "__main__":
    unittest.main()
