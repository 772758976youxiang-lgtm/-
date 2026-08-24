from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from urllib.request import Request, urlopen

from wechat_channel.agents import DshAgentAdapter, EchoAgentAdapter
from wechat_channel.config import DEFAULT_CONFIG, load_config
from wechat_channel.drivers import SendDriver, SendRouter, WeChatDbReceiveDriver, parse_group_content
from wechat_channel.http_api import ManagementServer
from wechat_channel.models import DriverHealth, SendResult, SendTask, StandardMessage
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
        })
        self.assertIn("会话名称：测试群", prompt)
        self.assertIn("发送者：张三", prompt)
        self.assertIn("发送者备注：三哥", prompt)
        self.assertIn("发送者微信号：zhangsan", prompt)
        self.assertTrue(prompt.endswith("【用户消息】\nhello"))

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

    def test_session_and_send_tasks_persist(self):
        self.store.set_session("wechat:a:c", "session-1", {"a": 1})
        self.assertEqual(self.store.get_session("wechat:a:c"), "session-1")
        task = SendTask("friend", "hello", "m1", "m1:reply")
        self.assertTrue(self.store.create_send_task(task.to_dict()))
        self.assertFalse(self.store.create_send_task(task.to_dict()))
        self.assertEqual(len(self.store.pending_send_tasks()), 1)
        self.store.finish_send_task(task.idempotency_key, True, "hook", 1, None)
        self.assertEqual(self.store.pending_send_tasks(), [])

    def test_configuration_rejects_non_loopback_hook(self):
        path = Path(self.temp.name) / "bad.json"
        path.write_text('{"send":{"hook_endpoint":"http://192.168.1.2:30001"}}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "loopback"):
            load_config(str(path))

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


if __name__ == "__main__":
    unittest.main()
