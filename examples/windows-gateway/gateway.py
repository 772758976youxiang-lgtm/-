# -*- coding: utf-8 -*-
"""
微信(小号) 网关 —— 基于 aixed/WeChat-Hook（微信 4.1.10.27 · version.dll · 本机 HTTP 30001）
角色：Windows 侧常驻。
  1) 轮询微信消息库(QueryDB) 取新消息
  2) 转发给 Mac 上的 harness/演示台 (/api/incoming)，取得回复
  3) 用 /SendTextMsg 把回复发回（群/单聊）
配置: config.json（首跑请开 debug_discover 拿库表结构并在 SCHEMA 固定字段）
"""
import json
import os
import time
import threading
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CFG_FILE = os.path.join(BASE_DIR, "config.json")
DEFAULTS = {
    "hook_host": "http://127.0.0.1:30001",   # WeChat-Hook 本机服务
    "mac_url": "http://192.168.1.100:8789",  # Mac 演示台/harness 地址（改你的局域网 IP）
    "poll_interval": 2.0,
    "room_policy": "at",
    "owner": "",           # 只允许该发送人命令（绑定 大号 wxid/昵称；留空=不限）
    "workHours": "",        # 工作时间段 "08:00-24:00"；留空=不限                      # at/all/off
    "cursor_ms": 0,                           # 已处理的最大消息时间戳(ms)
    "debug_discover": True,                   # 首跑：列出库/表/样例，用于固定 SCHEMA
    "SCHEMA": {                                # 首次联调后固定（字段名以实际库为准）
        "db": "",                              # 消息库名 如 "msg"
        "table": "",                           # 消息表名 如 "MSG"
        "time_field": "CreateTime",
        "sender_field": "StrTalker",
        "content_field": "StrContent",
        "type_field": "Type",
        "self_field": "IsSender",
        "is_group_marker": "",                 # 若 sender 行是群号则填该字段(如 roomid)
    },
    "AT_TEXT": "@本群管理员",
}
CFG = {**DEFAULTS}
if os.path.exists(CFG_FILE):
    CFG = {**DEFAULTS, **json.load(open(CFG_FILE, encoding="utf-8"))}

def now_s():
    return time.strftime("%Y-%m-%d %H:%M:%S")

def post(url, payload, timeout=15):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))

def get(url, timeout=15):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))

def db_names():
    try:
        return get(f"{CFG['hook_host']}/QueryDB/GetAllDBName") or []
    except Exception as e:
        print(f"[{now_s()}] GetAllDBName 失败: {e}")
        return []

def table_list(db_name):
    try:
        r = post(f"{CFG['hook_host']}/QueryDB/execute",
                 {"optDbName": db_name, "SQL": "SELECT name FROM sqlite_master WHERE type='table'"})
        return r.get("data") or r.get("rows") or r
    except Exception as e:
        return [f"<err {e}>"]

def query(db, sql):
    return post(f"{CFG['hook_host']}/QueryDB/execute", {"optDbName": db, "SQL": sql})

def discover():
    print(f"[{now_s()}] === 库表发现 (debug_discover) ===")
    for db in db_names():
        print(f"  库: {db}")
        try:
            for t in table_list(db):
                print(f"    表: {t}")
        except Exception as e:
            print(f"    (读取表失败: {e})")
    print("    请把消息库/表名填入 config.json 的 SCHEMA，并把 debug_discover 设为 false")

def find_self():
    try:
        p = post(f"{CFG['hook_host']}/GetSelfProfile", {})
        print(f"[{now_s()}] 当前登录: {p}")
        return p.get("wxid", "") if isinstance(p, dict) else ""
    except Exception as e:
        print(f"[{now_s()}] 未检测到微信/Hook（请确认微信已启动、version.dll 已放置、30001 在监听）: {e}")
        return ""

def send_text(target, content):
    try:
        r = post(f"{CFG['hook_host']}/SendTextMsg", {"wxidorgid": target, "msg": content})
        print(f"[{now_s()}] 已发送 -> {target[:20]}: {content[:40]!r} ({r})")
    except Exception as e:
        print(f"[{now_s()}] 发送失败: {e}")

def in_work():
    wh = CFG["workHours"]
    if not wh: return True
    try:
        st, en = wh.split("-")
        sh, sm = map(int, st.split(":")); eh, em = map(int, en.split(":"))
        c = time.localtime(); cur = c.tm_hour*60 + c.tm_min
        return cur >= sh*60+sm and cur < eh*60+em
    except Exception:
        return True

def poll_once(self_wxid):
    S = CFG["SCHEMA"]
    if not S.get("db") or not S.get("table"):
        return None
    sql = (f"SELECT * FROM {S['table']} WHERE {S['time_field']} > {int(CFG['cursor_ms'] // 1000)} "
           f"ORDER BY {S['time_field']} ASC LIMIT 50")
    try:
        r = query(S["db"], sql)
    except Exception as e:
        print(f"[{now_s()}] 查询失败: {e}")
        return None
    rows = r.get("data") or r.get("rows") or []
    if not rows:
        return None
    # rows 可能是 [{...}] 或 [[...]] —— 联调时以实际结构为准，先尝试 dict
    new_cursor = CFG["cursor_ms"]
    for row in rows:
        d = row if isinstance(row, dict) else {}
        if not d:
            print(f"[{now_s()}] [调试] 行结构: {row}")
            continue
        ts = d.get(S["time_field"])
        if ts:
            new_cursor = max(new_cursor, int(ts) * 1000)
        if d.get(S["self_field"]) in (1, "1", True):
            continue
        sender = d.get(S["sender_field"], "")
        if not in_work(): continue
        if CFG["owner"] and sender not in (CFG["owner"],): continue
        content = d.get(S["content_field"], "") or ""
        is_group = bool(S.get("is_group_marker")) and bool(d.get(S["is_group_marker"]))
        if not content or sender in (self_wxid, ""):
            continue
        if is_group and CFG["room_policy"] == "off":
            continue
        payload = {"room_id": sender if is_group else "", "room_name": "", "talker": sender,
                   "content": content, "msg_id": str(new_cursor) + sender, "ts": int(time.time() * 1000)}
        try:
            reply = post(CFG["mac_url"] + "/api/incoming", payload, timeout=60)
        except Exception as e:
            print(f"[{now_s()}] 转发 Mac 失败: {e}")
            continue
        text = (reply or {}).get("reply")
        if text:
            send_text(sender, text)
    CFG["cursor_ms"] = new_cursor
    return True

def main():
    print(f"[{now_s()}] 网关启动 (Mac: {CFG['mac_url']})")
    if CFG["debug_discover"]:
        discover()
        if not CFG["SCHEMA"].get("db"):
            print("    请在 config.json 固定 SCHEMA 后重启")
    self_wxid = find_self()
    while True:
        try:
            poll_once(self_wxid)
        except Exception as e:
            print(f"[{now_s()}] 轮询异常: {e}")
        time.sleep(CFG["poll_interval"])

if __name__ == "__main__":
    main()
