from __future__ import annotations

import argparse
import ctypes
import json
import os
from ctypes import wintypes
from typing import Any, Dict, List


def list_accounts() -> List[Dict[str, Any]]:
    from wechatauto.db import list_accounts as discover_accounts

    return list(discover_accounts() or [])


def _process_name(pid: int) -> str:
    if not pid:
        return ""
    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return ""
    try:
        value = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if ctypes.windll.kernel32.QueryFullProcessImageNameW(handle, 0, value, ctypes.byref(size)):
            return os.path.basename(value.value).lower()
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)
    return ""


def list_windows(include_hidden: bool = False) -> List[Dict[str, Any]]:
    if os.name != "nt":
        return []
    user32 = ctypes.windll.user32
    result: List[Dict[str, Any]] = []
    callbacks = []

    def visit(hwnd: int, _lparam: int) -> bool:
        if not include_hidden and not user32.IsWindowVisible(hwnd):
            return True
        title_buffer = ctypes.create_unicode_buffer(256)
        class_buffer = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, title_buffer, 256)
        user32.GetClassNameW(hwnd, class_buffer, 256)
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        process = _process_name(int(pid.value))
        title = title_buffer.value.strip()
        class_name = class_buffer.value
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        width, height = rect.right - rect.left, rect.bottom - rect.top
        is_wechat = process in ("weixin.exe", "wechat.exe") or title.strip().lower() in ("微信", "wechat")
        # 微信窗口在 Windows 缩放或贴边状态下宽度可能略低于 300px。
        if is_wechat and width >= 200 and height >= 200:
            result.append({
                "hwnd": int(hwnd), "pid": int(pid.value), "title": title,
                "class_name": class_name, "width": width, "height": height,
            })
        return True

    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    callbacks.append(callback_type(visit))
    user32.EnumWindows(callbacks[0], 0)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe WeChat accounts and windows without controlling them")
    parser.add_argument("kind", choices=("accounts", "windows", "all_windows"))
    args = parser.parse_args()
    value = list_accounts() if args.kind == "accounts" else list_windows(include_hidden=args.kind == "all_windows")
    print(json.dumps(value, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
