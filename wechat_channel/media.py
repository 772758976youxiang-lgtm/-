from __future__ import annotations

import base64
import json
import struct
import threading
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.request import Request, urlopen


_ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
_MAX_IMAGE_BYTES = 12 * 1024 * 1024


def decode_wechat_blob(value: Any) -> bytes:
    if value is None:
        return b""
    raw = value if isinstance(value, bytes) else str(value).encode("utf-8", "replace")
    if not raw.startswith(_ZSTD_MAGIC):
        return raw
    try:
        from compression import zstd

        return zstd.decompress(raw)
    except ImportError:
        import zstandard

        return zstandard.ZstdDecompressor().decompress(raw)


def raster_type(data: bytes) -> Optional[Tuple[str, str]]:
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif", "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp", "image/webp"
    return None


class WeChatMediaReceiver:
    """Materialize media without bringing the WeChat desktop window forward."""

    _KINDS = {
        "3": "image", "image": "image", "图片": "image",
        "47": "emoji", "emoji": "emoji", "动画表情": "emoji", "表情": "emoji",
        "34": "voice", "voice": "voice", "语音": "voice",
        "43": "video", "video": "video", "视频": "video",
        "49": "file", "file": "file", "文件": "file", "文件/链接/卡片": "file",
    }

    def __init__(self, db: Any, save_dir: str, max_image_bytes: int = _MAX_IMAGE_BYTES):
        self.db = db
        self.save_dir = Path(save_dir).expanduser()
        self.save_dir.mkdir(parents=True, exist_ok=True)
        self.max_image_bytes = int(max_image_bytes)
        self._key_scan_lock = threading.Lock()
        self._key_scan_started = False

    def materialize(self, conversation_id: str, local_id: str, message_type: str) -> Dict[str, Any]:
        source_type = str(message_type or "unknown")
        kind = self._KINDS.get(source_type.lower(), self._KINDS.get(source_type, "unknown"))
        item: Dict[str, Any] = {
            "kind": kind,
            "source_type": source_type,
            "available": False,
            "attachable": False,
            "path": "",
            "name": "",
            "media_type": "",
            "error": "",
        }
        try:
            path = self._download(conversation_id, int(local_id), kind)
            if path:
                source = Path(path)
                item.update({"available": True, "path": str(source), "name": source.name})
                detected = raster_type(source.read_bytes()[:16])
                if detected:
                    item.update({"attachable": True, "media_type": detected[1]})
            if not item["available"]:
                item["error"] = self._unavailable_message(kind)
        except Exception as exc:
            item["error"] = "%s 接收失败：%s" % (self._label(kind), exc)
        self._prune()
        return item

    def _download(self, conversation_id: str, local_id: int, kind: str) -> Optional[str]:
        if kind == "emoji":
            return self._download_emoji(conversation_id, local_id)
        from wechatauto.media import MediaDownloader

        downloader = MediaDownloader(self.db, save_dir=str(self.save_dir))
        if kind == "image":
            return self._download_image(downloader, conversation_id, local_id)
        method = {
            "voice": downloader.download_voice,
            "video": downloader.download_video,
            "file": downloader.download_file,
        }.get(kind)
        return method(conversation_id, local_id, save_dir=str(self.save_dir)) if method else None

    def _download_image(self, downloader: Any, conversation_id: str, local_id: int) -> Optional[str]:
        row = self.db.get_message_row(conversation_id, local_id) or {}
        if int(row.get("local_type") or 0) != 3:
            return None
        md5 = downloader._img_md5(row)
        if not md5:
            return None
        dat_path = downloader._find_dat(conversation_id, md5, int(row.get("create_time") or 0))
        thumb = False
        if not dat_path:
            dat_path = downloader._find_dat(conversation_id, md5, int(row.get("create_time") or 0), thumbnail=True)
            thumb = bool(dat_path)
        if not dat_path:
            self._start_key_scan()
            return None
        encrypted = Path(dat_path).read_bytes()
        aes_key = None
        xor_key = None
        cfg_dword = getattr(self.db, "cfg_dword", None)
        if cfg_dword:
            aes_key, xor_key = downloader.derive_image_keys(int(cfg_dword), str(self.db.wxid))
        else:
            try:
                saved = json.loads(Path(downloader._key_store()).read_text(encoding="utf-8"))
                aes_key = saved.get(self.db.account)
            except (OSError, ValueError, json.JSONDecodeError):
                pass
        if encrypted.startswith(b"\x07\x08V2\x08\x07"):
            if len(encrypted) >= 15 and xor_key is None:
                _, xor_size = struct.unpack_from("<LL", encrypted, 6)
                if xor_size >= 2:
                    candidate = encrypted[-2] ^ 0xFF
                    if encrypted[-1] ^ 0xD9 == candidate:
                        xor_key = candidate
            if not aes_key or xor_key is None:
                self._start_key_scan()
                return None
        elif encrypted.startswith(b"\x07\x08\x05V\x02\x05") and xor_key is None and len(encrypted) > 22:
            body = encrypted[22:]
            for magic in (b"\xff\xd8\xff", b"\x89PNG", b"GIF8"):
                candidate = body[0] ^ magic[0]
                if bytes(value ^ candidate for value in body[:len(magic)]) == magic:
                    xor_key = candidate
                    break
            if xor_key is None:
                return None
        data = downloader.decrypt_image(dat_path, aes_key=aes_key, xor_key=xor_key)
        detected = raster_type(data)
        if not detected and data.startswith(b"wxgf"):
            converted = downloader._wxgf_to_jpg(data)
            if converted:
                data = converted
                detected = ("jpg", "image/jpeg")
        extension = detected[0] if detected else "img"
        suffix = "_thumb" if thumb else ""
        target = self.save_dir / ("%s_%d%s.%s" % (conversation_id.replace("/", "_"), local_id, suffix, extension))
        target.write_bytes(data)
        return str(target)

    def _start_key_scan(self) -> None:
        """Discover the WeChat 4.x image key off the polling thread, without UIA."""
        with self._key_scan_lock:
            if self._key_scan_started:
                return
            self._key_scan_started = True

        def scan() -> None:
            try:
                from wechatauto.media import MediaDownloader

                downloader = MediaDownloader(self.db, save_dir=str(self.save_dir))
                key = downloader._scan_aes_key(monitor=True, monitor_timeout=120)
                if key:
                    downloader._persist_key(key)
            except Exception:
                pass

        threading.Thread(target=scan, name="wechat-image-key", daemon=True).start()

    def _download_emoji(self, conversation_id: str, local_id: int) -> Optional[str]:
        row = self.db.get_message_row(conversation_id, local_id) or {}
        raw = row.get("message_content") or row.get("content") or b""
        decoded = decode_wechat_blob(raw)
        xml_start = decoded.find(b"<msg")
        if xml_start > 0:
            decoded = decoded[xml_start:]
        root = ET.fromstring(decoded.decode("utf-8", "replace"))
        emoji = root.find(".//emoji")
        if emoji is None:
            return None
        for key in ("cdnurl", "thumburl", "tpurl", "externurl"):
            url = str(emoji.attrib.get(key) or "").replace("&amp;", "&")
            if not url.startswith(("https://", "http://")):
                continue
            request = Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://weixin.qq.com/"})
            with urlopen(request, timeout=15) as response:
                data = response.read(self.max_image_bytes + 1)
            if len(data) > self.max_image_bytes:
                raise ValueError("表情图片超过大小限制")
            detected = raster_type(data)
            if not detected:
                continue
            target = self.save_dir / ("emoji-%d.%s" % (local_id, detected[0]))
            target.write_bytes(data)
            return str(target)
        return None

    @staticmethod
    def _label(kind: str) -> str:
        return {"image": "图片", "emoji": "表情", "voice": "语音", "video": "视频", "file": "文件"}.get(kind, "媒体")

    @classmethod
    def _unavailable_message(cls, kind: str) -> str:
        if kind == "image":
            return "图片事件已收到，但微信本地图片密钥或缓存尚不可用"
        if kind == "emoji":
            return "表情事件已收到，但本地或 CDN 图片暂不可用"
        return "%s事件已收到，但本地文件尚未落盘" % cls._label(kind)

    def _prune(self, keep: int = 200) -> None:
        files = sorted((item for item in self.save_dir.iterdir() if item.is_file()), key=lambda item: item.stat().st_mtime,
                       reverse=True)
        for item in files[keep:]:
            try:
                item.unlink()
            except OSError:
                pass


def image_part_from_media(item: Dict[str, Any]) -> Optional[Dict[str, str]]:
    if not item.get("attachable") or not item.get("path"):
        return None
    path = Path(str(item["path"]))
    detected = raster_type(path.read_bytes()[:16])
    if not detected:
        return None
    return {
        "type": "image",
        "mediaType": detected[1],
        "data": base64.b64encode(path.read_bytes()).decode("ascii"),
        "name": str(item.get("name") or path.name),
    }
