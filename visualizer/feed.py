"""
Headless feed for the vega-code header visualizer (Windows only).

Reads the current track from Windows' System Media Transport Controls (SMTC),
captures the system's audio output via WASAPI loopback, and prints one JSON
object per line:

  {"bars": [0..1, ...], "palette": [[r,g,b], ...], "title": ..., "artist": ...,
   "playing": bool, "position": s, "duration": s, "art": [[["#top","#bottom"], ...], ...]}
  ("art" = pixelated album cover as half-block cells, sent on the first frame of
   each track only; [] when the track has no artwork.)
  {"idle": true}                       # nothing is playing
  {"error": "..."}                     # a required dependency is missing (then exits)

Commands come in on stdin, one per line: playpause | next | prev.
No terminal control sequences are ever written; stdout is data only.

Dependencies: see requirements.txt (winsdk, Pillow, numpy, soundcard).
"""

import asyncio
import colorsys
import io
import json
import sys
import threading
import time
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass


def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), flush=True)


try:
    import numpy as np
    from PIL import Image
    from winsdk.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionManager as MediaManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    )
    from winsdk.windows.storage.streams import Buffer, DataReader, InputStreamOptions
except Exception as exc:
    emit({"error": f"missing dependency: {exc} (pip install -r visualizer/requirements.txt)"})
    sys.exit(1)

try:
    import soundcard as sc

    HAS_AUDIO = True
except Exception:
    HAS_AUDIO = False

DEFAULT_PALETTE = [(120, 170, 255), (200, 140, 255)]
ART_COLS = 16


# ---------------------------------------------------------------------------
# Now playing (SMTC) + transport commands
# ---------------------------------------------------------------------------


async def get_now_playing() -> dict | None:
    manager = await MediaManager.request_async()
    session = manager.get_current_session()
    if session is None:
        return None

    props = await session.try_get_media_properties_async()
    timeline = session.get_timeline_properties()
    playback_info = session.get_playback_info()

    thumbnail_bytes = None
    if props.thumbnail is not None:
        try:
            stream = await props.thumbnail.open_read_async()
            size = stream.size
            if size > 0:
                buf = Buffer(size)
                await stream.read_async(buf, size, InputStreamOptions.NONE)
                reader = DataReader.from_buffer(buf)
                raw = bytearray(size)
                reader.read_bytes(raw)
                thumbnail_bytes = bytes(raw)
        except OSError:
            thumbnail_bytes = None

    status = playback_info.playback_status if playback_info else None
    return {
        "title": props.title or "",
        "artist": props.artist or "",
        "thumbnail": thumbnail_bytes,
        "position": timeline.position.total_seconds() if timeline else 0.0,
        "duration": timeline.end_time.total_seconds() if timeline else 0.0,
        "playing": status == PlaybackStatus.PLAYING,
    }


async def estimated_position() -> float | None:
    """Playback position extrapolated from the timeline's last-updated stamp.

    SMTC only refreshes `position` every few seconds, so reading it raw makes
    a scrubber jump back and forth; position + (now - last_updated) is the
    documented way to get the live value."""
    try:
        manager = await MediaManager.request_async()
        session = manager.get_current_session()
        if session is None:
            return None
        timeline = session.get_timeline_properties()
        pos = timeline.position.total_seconds()
        playing = session.get_playback_info().playback_status == PlaybackStatus.PLAYING
        if playing:
            pos += max(0.0, (datetime.now(timezone.utc) - timeline.last_updated_time).total_seconds())
        return pos
    except Exception:
        return None


async def send_media_command(action: str) -> None:
    try:
        manager = await MediaManager.request_async()
        session = manager.get_current_session()
        if session is None:
            return
        if action == "playpause":
            await session.try_toggle_play_pause_async()
        elif action == "next":
            await session.try_skip_next_async()
        elif action == "prev":
            await session.try_skip_previous_async()
    except OSError:
        pass


COMMANDS = {"playpause", "next", "prev"}
force_refresh = False  # set after a command so the next frame re-reads the playback state


async def run_command(action: str) -> None:
    global force_refresh
    await send_media_command(action)
    await asyncio.sleep(0.15)  # let the player apply it before we re-read
    force_refresh = True


def read_commands(loop: asyncio.AbstractEventLoop) -> None:
    for line in sys.stdin:
        action = line.strip()
        if action in COMMANDS:
            asyncio.run_coroutine_threadsafe(run_command(action), loop)


# ---------------------------------------------------------------------------
# Album art -> pixel art + palette
# ---------------------------------------------------------------------------


def pixelate(img: Image.Image, grid_width: int) -> Image.Image:
    img = img.convert("RGB")
    w, h = img.size
    grid_height = max(2, round(grid_width * h / w))
    if grid_height % 2:
        grid_height += 1
    return img.resize((grid_width, grid_height), Image.Resampling.LANCZOS)


def art_cells(thumbnail: bytes | None) -> list:
    """Pixelate the cover to ART_COLS wide and pack two pixel rows per text row
    (top pixel = foreground of a half block, bottom pixel = background)."""
    if not thumbnail:
        return []
    try:
        small = pixelate(Image.open(io.BytesIO(thumbnail)), ART_COLS)
    except Exception:
        return []
    w, h = small.size
    px = small.load()
    hexc = lambda c: "#%02x%02x%02x" % tuple(c[:3])
    return [[[hexc(px[x, y]), hexc(px[x, y + 1])] for x in range(w)] for y in range(0, h - 1, 2)]


def extract_palette(img: Image.Image, n: int = 4) -> list[tuple[int, int, int]]:
    """The N most prominent, reasonably saturated colors of the cover, so the
    spectrum is tinted to match it instead of using an arbitrary rainbow."""
    small = img.convert("RGB").resize((48, 48))
    quant = small.quantize(colors=16, method=Image.Quantize.FASTOCTREE)
    counts = sorted(quant.getcolors(), reverse=True)
    palette = quant.getpalette()

    vivid, fallback = [], []
    for _count, idx in counts:
        r, g, b = palette[idx * 3 : idx * 3 + 3]
        _h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        (vivid if (0.2 <= v <= 0.95 and s >= 0.25) else fallback).append((r, g, b))

    chosen = (vivid or fallback)[:n] or [(120, 170, 255)]

    # Floor saturation/brightness so bars stay legible on a dark terminal even
    # when the art is dark or near-grayscale; hue is kept.
    def visible(color: tuple[int, int, int]) -> tuple[int, int, int]:
        r, g, b = color
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        r2, g2, b2 = colorsys.hsv_to_rgb(h, max(s, 0.45), max(v, 0.6))
        return (round(r2 * 255), round(g2 * 255), round(b2 * 255))

    chosen = [visible(c) for c in chosen]
    if len(chosen) == 1:
        r, g, b = chosen[0]
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        light = colorsys.hsv_to_rgb(h, s * 0.6, min(1.0, v * 1.3 + 0.15))
        chosen = [chosen[0], tuple(round(c * 255) for c in light)]
    return chosen


# ---------------------------------------------------------------------------
# Live audio capture + spectrum
# ---------------------------------------------------------------------------


class AudioCapture:
    """Records the default output device's WASAPI loopback in a background
    thread so the frame loop can grab the latest chunk without blocking."""

    def __init__(self, samplerate: int = 48000, chunk: int = 2048):
        self.samplerate = samplerate
        self.chunk = chunk
        self._lock = threading.Lock()
        self._latest = np.zeros(chunk, dtype=np.float32)
        self.available = False
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            speaker = sc.default_speaker()
            mic = sc.get_microphone(speaker.id, include_loopback=True)
            with mic.recorder(samplerate=self.samplerate) as rec:
                self.available = True
                while True:
                    data = rec.record(numframes=self.chunk)
                    mono = data.mean(axis=1) if data.ndim > 1 else data
                    with self._lock:
                        self._latest = mono.astype(np.float32)
        except Exception:  # depends on host audio devices
            self.available = False

    def latest(self) -> "np.ndarray":
        with self._lock:
            return self._latest.copy()


def compute_bar_heights(samples: "np.ndarray", samplerate: int, num_bars: int, state: dict) -> list[float]:
    """FFT the latest chunk into log-spaced bars, each 0..1.

    Raw spectra are bass-heavy, so each band is boosted by its distance from
    the lowest frequency and blended a little with its neighbors, on top of
    auto-gain and attack/decay smoothing."""
    magnitudes = np.zeros(num_bars, dtype=np.float64)
    if samples.size and num_bars:
        windowed = samples * np.hanning(len(samples))
        spectrum = np.abs(np.fft.rfft(windowed))
        freqs = np.fft.rfftfreq(len(samples), d=1.0 / samplerate)
        low, high = 40.0, min(16000.0, samplerate / 2 - 1)
        edges = np.logspace(np.log10(low), np.log10(high), num_bars + 1)
        centers = np.sqrt(edges[:-1] * edges[1:])
        boost = (centers / low) ** 0.55
        for i in range(num_bars):
            mask = (freqs >= edges[i]) & (freqs < edges[i + 1])
            if mask.any():
                magnitudes[i] = spectrum[mask].mean() * boost[i]
        magnitudes = np.log1p(magnitudes)
        if num_bars >= 3:
            padded = np.pad(magnitudes, 1, mode="edge")
            magnitudes = 0.25 * padded[:-2] + 0.5 * magnitudes + 0.25 * padded[2:]

    peak = state.get("peak", 1e-6)
    peak = max(peak * 0.985, float(magnitudes.max()) if magnitudes.size else 0.0, 1e-6)
    state["peak"] = peak

    normalized = np.clip(magnitudes / peak, 0.0, 1.0)
    prev = state.get("heights", np.zeros(num_bars))
    if len(prev) != num_bars:
        prev = np.zeros(num_bars)
    heights = np.maximum(normalized, prev * 0.70)
    state["heights"] = heights
    return heights.tolist()


# ---------------------------------------------------------------------------
# Frame loop
# ---------------------------------------------------------------------------


async def main() -> None:
    global force_refresh
    num_bars = int(sys.argv[1]) if len(sys.argv) > 1 else 48
    fps = float(sys.argv[2]) if len(sys.argv) > 2 else 15.0
    meta_interval = 1.0
    frame_dt = 1.0 / fps

    threading.Thread(target=read_commands, args=(asyncio.get_running_loop(),), daemon=True).start()

    audio = AudioCapture() if HAS_AUDIO else None
    bar_state: dict = {}
    info = None
    last_meta = -999.0
    position_base = 0.0
    position_time = time.monotonic()
    palette = DEFAULT_PALETTE
    last_key = None
    art: list | None = None  # pending art to attach to the next frame
    last_track: tuple | None = None
    was_playing = False
    forced = False

    while True:
        now = time.monotonic()
        forced = force_refresh
        if force_refresh or now - last_meta >= meta_interval:
            force_refresh = False
            try:
                info = await get_now_playing()
            except Exception:
                info = None
            last_meta = now
            if info:
                est = await estimated_position()
                if est is None:
                    est = info["position"]
                local = position_base + (now - position_time) if info["playing"] else position_base
                new_track = (info["title"], info["artist"]) != last_track
                # Resync only on a real change (seek, track change, pause/resume);
                # otherwise keep the smooth local clock and nudge it toward the estimate.
                if new_track or forced or was_playing != info["playing"] or abs(est - local) > 1.5:
                    position_base = est
                else:
                    position_base = local + (est - local) * 0.25
                position_time = now
                last_track = (info["title"], info["artist"])
                was_playing = info["playing"]

        if info is None:
            emit({"idle": True})
            await asyncio.sleep(0.5)
            continue

        key = (info["title"], info["artist"], info["thumbnail"] is not None)
        if key != last_key:
            palette = DEFAULT_PALETTE
            if info["thumbnail"]:
                try:
                    palette = extract_palette(Image.open(io.BytesIO(info["thumbnail"])))
                except Exception:
                    palette = DEFAULT_PALETTE
            art = art_cells(info["thumbnail"])
            last_key = key

        if audio and audio.available:
            heights = compute_bar_heights(audio.latest(), audio.samplerate, num_bars, bar_state)
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
