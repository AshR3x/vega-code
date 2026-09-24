"""
Headless feed for the vega-code header visualizer.

Imports the audio capture / spectrum / SMTC / palette code from the
terminal-visualizer project (its directory comes from VEGA_VISUALIZER_DIR,
default F:\\Coding\\Terminal Visualizer) and prints one JSON object per line:

  {"bars": [0..1, ...], "palette": [[r,g,b], ...], "title": ..., "artist": ...,
   "playing": bool, "position": s, "duration": s, "art": [[["#top","#bottom"], ...], ...]}
  ("art" = pixelated album cover as half-block cells, sent on the first frame of
   each track only; [] when the track has no artwork.)
  {"idle": true}                       # nothing is playing

Commands come in on stdin, one per line: playpause | next | prev.

No terminal control sequences are ever written; stdout is data only.
"""

import asyncio
import io
import json
import os
import sys
import threading
import time

VIS_DIR = os.environ.get("VEGA_VISUALIZER_DIR", r"F:\Coding\Terminal Visualizer")
sys.path.insert(0, VIS_DIR)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

try:
    import main as vis  # terminal-visualizer/main.py (guarded by __name__)
    from PIL import Image
except Exception as exc:  # missing dir or deps: tell the parent and exit quietly
    print(json.dumps({"error": f"visualizer unavailable: {exc}"}), flush=True)
    sys.exit(1)


ART_COLS = 16


def art_cells(thumbnail: bytes | None) -> list:
    """Pixelate the cover to ART_COLS wide and pack two pixel rows per text row
    (top pixel = foreground of a half block, bottom pixel = background)."""
    if not thumbnail:
        return []
    try:
        small = vis.pixelate(Image.open(io.BytesIO(thumbnail)), ART_COLS, None)
    except Exception:
        return []
    w, h = small.size
    px = small.load()
    hexc = lambda c: "#%02x%02x%02x" % tuple(c[:3])
    return [[[hexc(px[x, y]), hexc(px[x, y + 1])] for x in range(w)] for y in range(0, h - 1, 2)]


COMMANDS = {"playpause", "next", "prev"}
force_refresh = False  # set after a command so the next frame re-reads the playback state


async def run_command(action: str) -> None:
    global force_refresh
    await vis.send_media_command(action)
    await asyncio.sleep(0.15)  # let the player apply it before we re-read
    force_refresh = True


def read_commands(loop: asyncio.AbstractEventLoop) -> None:
    for line in sys.stdin:
        action = line.strip()
        if action in COMMANDS:
            asyncio.run_coroutine_threadsafe(run_command(action), loop)


def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), flush=True)


async def main() -> None:
    num_bars = int(sys.argv[1]) if len(sys.argv) > 1 else 48
    fps = float(sys.argv[2]) if len(sys.argv) > 2 else 15.0
    meta_interval = 1.0
    frame_dt = 1.0 / fps

    global force_refresh
    threading.Thread(target=read_commands, args=(asyncio.get_running_loop(),), daemon=True).start()

    audio = vis.AudioCapture() if vis.HAS_AUDIO else None
    bar_state: dict = {}
    info = None
    last_meta = -999.0
    position_base = 0.0
    position_time = time.monotonic()
    palette = vis.DEFAULT_PALETTE
    last_key = None
    art: list | None = None  # pending art to attach to the next frame

    while True:
        now = time.monotonic()
        if force_refresh or now - last_meta >= meta_interval:
            force_refresh = False
            try:
                info = await vis.get_now_playing()
            except Exception:
                info = None
            last_meta = now
            if info:
                position_base = info["position"]
                position_time = now

        if info is None:
            emit({"idle": True})
            await asyncio.sleep(0.5)
            continue

        key = (info["title"], info["artist"], info["thumbnail"] is not None)
        if key != last_key:
            palette = vis.DEFAULT_PALETTE
            if info["thumbnail"]:
                try:
                    palette = vis.extract_palette(Image.open(io.BytesIO(info["thumbnail"])))
                except Exception:
                    palette = vis.DEFAULT_PALETTE
            art = art_cells(info["thumbnail"])
            last_key = key

        if audio and audio.available:
            heights = vis.compute_bar_heights(audio.latest(), audio.samplerate, num_bars, 1, bar_state)
        else:
            heights = [0.0] * num_bars

        if info["playing"]:
            pos = min(position_base + (now - position_time), info["duration"] or position_base)
        else:
            pos = position_base

        payload = {
            "bars": [round(float(h), 3) for h in heights],
            "palette": [list(c) for c in palette],
            "title": info["title"],
            "artist": info["artist"],
            "playing": bool(info["playing"]),
            "position": round(pos, 1),
            "duration": round(info["duration"], 1),
        }
        if art is not None:
            payload["art"] = art
            art = None
        emit(payload)
        await asyncio.sleep(frame_dt)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, BrokenPipeError):
        pass
