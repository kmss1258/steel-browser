#!/usr/bin/env python3
"""Minimal Steel Browser client.

Install:
  pip install requests websockets
"""

from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path
from typing import cast
from urllib.parse import quote, urlsplit, urlunsplit

import requests
from websockets.sync.client import connect
from websockets.sync.connection import Connection


BASE_HTTP_URL = os.getenv("STEEL_HTTP_URL", "http://127.0.0.1:12200")
FRAMES_DIR = Path(os.getenv("STEEL_FRAMES_DIR", "./frames"))
DEFAULT_DIMENSIONS = {"width": 1356, "height": 763}
JsonDict = dict[str, object]


def http_url(path: str) -> str:
    return f"{BASE_HTTP_URL.rstrip('/')}{path}"


def ws_url(path: str) -> str:
    parts = urlsplit(BASE_HTTP_URL)
    scheme = "wss" if parts.scheme == "https" else "ws"
    return urlunsplit((scheme, parts.netloc, path, "", ""))


def create_session() -> JsonDict:
    response = requests.post(
        http_url("/v1/sessions"),
        json={"dimensions": DEFAULT_DIMENSIONS},
        timeout=30,
    )
    response.raise_for_status()
    return cast(JsonDict, response.json())


def get_live_details(session_id: str) -> JsonDict:
    response = requests.get(http_url(f"/v1/sessions/{session_id}/live-details"), timeout=30)
    response.raise_for_status()
    return cast(JsonDict, response.json())


def release_session(session_id: str) -> JsonDict:
    response = requests.post(http_url(f"/v1/sessions/{session_id}/release"), timeout=30)
    response.raise_for_status()
    return cast(JsonDict, response.json())


def pick_page_id(live_details: JsonDict) -> str:
    pages = cast(list[JsonDict], live_details.get("pages") or [])
    if not pages:
        raise RuntimeError("No pages were returned by /live-details")
    return cast(str, pages[0]["id"])


def send_event(ws: Connection, payload: JsonDict) -> None:
    ws.send(json.dumps(payload))


def send_navigation(ws: Connection, page_id: str, url: str) -> None:
    send_event(
        ws,
        {
            "type": "navigation",
            "pageId": page_id,
            "event": {"url": url},
        },
    )


def send_click(ws: Connection, page_id: str, x: int, y: int) -> None:
    send_event(
        ws,
        {
            "type": "mouseEvent",
            "pageId": page_id,
            "event": {
                "type": "mousePressed",
                "x": x,
                "y": y,
                "button": "left",
                "modifiers": 0,
                "clickCount": 1,
            },
        },
    )


def save_frame(frame_data: str, index: int) -> Path:
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    file_path = FRAMES_DIR / f"frame-{index:04d}.jpg"
    _ = file_path.write_bytes(base64.b64decode(frame_data))
    return file_path


def stream_page(page_id: str, demo_url: str | None = None, max_frames: int = 10) -> None:
    url = ws_url(f"/v1/sessions/cast?pageId={quote(page_id)}")
    with connect(url, open_timeout=30) as ws:
        if demo_url:
            send_navigation(ws, page_id, demo_url)

        frame_count = 0
        while frame_count < max_frames:
            raw = ws.recv()
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8")

            message = cast(JsonDict, json.loads(raw))

            if message.get("type") == "castError":
                raise RuntimeError(str(message.get("error", "cast error")))

            if message.get("type") == "castTimeout":
                raise RuntimeError(str(message.get("error", "cast timeout")))

            if "data" in message:
                frame_count += 1
                path = save_frame(cast(str, message["data"]), frame_count)
                print(f"saved {path}  |  {message.get('title')}  |  {message.get('url')}")

                if frame_count == 2 and demo_url:
                    send_click(ws, page_id, 120, 80)
                    time.sleep(0.25)


def main() -> None:
    session = create_session()
    session_id = cast(str, session["id"])
    print(f"session: {session_id}")

    try:
        live_details = get_live_details(session_id)
        page_id = pick_page_id(live_details)
        print(f"pageId: {page_id}")
        pages = cast(list[JsonDict], live_details.get("pages") or [])
        print(f"pages: {len(pages)}")

        stream_page(page_id, demo_url=os.getenv("STEEL_DEMO_URL"), max_frames=10)
    finally:
        _ = release_session(session_id)


if __name__ == "__main__":
    main()
