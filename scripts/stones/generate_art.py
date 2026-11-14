"""Draw the stone collection's art with Gemini, resumably and under a hard spend cap.

Run from the repo root (needs GEMINI_API_KEY with billing enabled; the free tier has no
image quota):

    uv run --with requests --with pillow python scripts/stones/generate_art.py --cap-usd 15

Every stone in scripts/stones/catalog.json gets public/stones/<slug>.webp. A stone whose
webp exists is skipped, so a stopped run resumes where it left off, and
src/components/stones/drawn-stones.json is rewritten after each drawing so the wall
switches that stone from its placeholder to the image. Each call's cost, from the token
counts the API reports, is appended to scripts/stones/art-spend.json; the run refuses
to start a call that could push the recorded total past --cap-usd. (The first five
stones were drawn through CellCog; their spend is in the same log, in credits.)

The images come back on a pure white ground. The ground is cut away here (flood fill
from the border) so the wall can show an unowned stone as a silhouette of its own shape.

--out-dir draws into another directory without touching the manifest, for comparing a
prompt change against stones already drawn.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import time
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "scripts/stones/catalog.json"
SPEND_LOG = ROOT / "scripts/stones/art-spend.json"
ART_DIR = ROOT / "public/stones"
MANIFEST = ROOT / "src/components/stones/drawn-stones.json"
SIZE = 512

MODEL = "gemini-nano-banana-2.1"
# Google's published prices for this model (2026-11-12): image output $30 per 1M tokens
# (a 1K image is 1,120 tokens, $0.0336); text input is priced well below a cent per call.
USD_PER_OUTPUT_TOKEN = 30 / 1_000_000
USD_PER_INPUT_TOKEN = 0.5 / 1_000_000
# What one call may cost at most, for the cap check before it starts.
WORST_CALL_USD = 0.05
CELLCOG_CREDITS_PER_USD = 90

STYLE = """Photorealistic studio macro photograph of ONE mineral specimen for a fine collector's catalog.
Composition: the single specimen centered, seen in three-quarter view from slightly above (about 20 degrees),
filling about 70% of a square 1:1 frame, nothing else in the frame.
Background: perfectly flat pure white (#FFFFFF), uniform edge to edge: no gradient, no floor line, no reflection, no cast shadow.
Lighting: one large soft key light from the upper left, gentle fill from the right, a thin cool rim light on the far edge.
Crisp focus over the whole specimen, true-to-life color, rich detail of luster, texture and inclusions.
No text, labels, watermarks, hands, stands, bases, props or second objects."""


def prompt_for(stone: dict) -> str:
    return f"{STYLE}\n\nThe specimen: {stone['name']} - {stone['look']}."


def spend_usd(entry: dict) -> float:
    if "usd" in entry:
        return float(entry["usd"])
    return float(entry.get("credits", 0)) / CELLCOG_CREDITS_PER_USD


def load_spend() -> list[dict]:
    return json.loads(SPEND_LOG.read_text()) if SPEND_LOG.exists() else []


def record_spend(entries: list[dict], entry: dict) -> None:
    entries.append(entry)
    SPEND_LOG.write_text(json.dumps(entries, indent=2) + "\n")


def write_manifest() -> None:
    drawn = sorted(p.stem for p in ART_DIR.glob("*.webp"))
    MANIFEST.write_text(json.dumps(drawn, indent=2) + "\n")


def cut_white_ground(image: Image.Image) -> Image.Image:
    """Make the border-connected near-white ground transparent, with a soft edge."""
    rgb = image.convert("RGB")
    w, h = rgb.size
    mask_src = rgb.copy()
    sentinel = (255, 0, 255)
    # Flood from every border pixel that is near white; the specimen's own whites survive
    # because they are not connected to the border through near-white pixels.
    border = (
        [(x, 0) for x in range(0, w, 8)]
        + [(x, h - 1) for x in range(0, w, 8)]
        + [(0, y) for y in range(0, h, 8)]
        + [(w - 1, y) for y in range(0, h, 8)]
    )
    for x, y in border:
        pixel = mask_src.getpixel((x, y))
        if pixel != sentinel and min(pixel) >= 238:
            ImageDraw.floodfill(mask_src, (x, y), sentinel, thresh=24)
    alpha = Image.new("L", (w, h), 255)
    px, apx = mask_src.load(), alpha.load()
    for yy in range(h):
        for xx in range(w):
            if px[xx, yy] == sentinel:
                apx[xx, yy] = 0
    alpha = alpha.filter(ImageFilter.GaussianBlur(1.2))
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def to_webp(png_bytes: bytes, dest: Path) -> None:
    image = cut_white_ground(Image.open(io.BytesIO(png_bytes)))
    box = image.getbbox()
    if box:
        image = image.crop(box)
    # Fit the specimen into 88% of the square so every stone sits on the wall at one scale.
    scale = (SIZE * 0.88) / max(image.size)
    image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(image, ((SIZE - image.width) // 2, (SIZE - image.height) // 2), image)
    dest.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(dest, "WEBP", quality=82, method=6)


class QuotaError(Exception):
    pass


def draw(key: str, stone: dict) -> tuple[bytes | None, dict]:
    response = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        json={
            "contents": [{"parts": [{"text": prompt_for(stone)}]}],
            "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "1:1"}},
        },
        timeout=180,
    )
    if response.status_code == 429:
        raise QuotaError(response.json().get("error", {}).get("message", "quota exceeded")[:300])
    response.raise_for_status()
    body = response.json()
    usage = body.get("usageMetadata", {})
    image = None
    for part in body.get("candidates", [{}])[0].get("content", {}).get("parts", []):
        if "inlineData" in part:
            image = base64.b64decode(part["inlineData"]["data"])
    return image, usage


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cap-usd", type=float, required=True, help="hard cap on total recorded spend, in dollars")
    parser.add_argument("--slugs", default="", help="comma-separated slugs (default: every stone not yet drawn)")
    parser.add_argument("--out-dir", default="", help="draw here instead of public/stones; the manifest is left alone")
    args = parser.parse_args()

    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        print("GEMINI_API_KEY is not set")
        return 1
    out_dir = Path(args.out_dir) if args.out_dir else ART_DIR
    stones = json.loads(CATALOG.read_text())
    wanted = {s.strip() for s in args.slugs.split(",") if s.strip()}
    todo = [s for s in stones if (not wanted or s["slug"] in wanted) and not (out_dir / f"{s['slug']}.webp").exists()]
    spend = load_spend()
    print(f"{len(todo)} stones to draw; ${sum(map(spend_usd, spend)):.2f} recorded so far", flush=True)

    for stone in todo:
        spent = sum(map(spend_usd, spend))
        if spent + WORST_CALL_USD > args.cap_usd:
            print(f"Stopping: ${spent:.2f} spent, the next call could pass the ${args.cap_usd:.2f} cap", flush=True)
            return 2
        started = time.time()
        try:
            image, usage = draw(key, stone)
        except QuotaError as error:
            print(f"Stopping: Gemini refused for quota ({error})", flush=True)
            return 3
        usd = (
            usage.get("promptTokenCount", 0) * USD_PER_INPUT_TOKEN
            + usage.get("candidatesTokenCount", 0) * USD_PER_OUTPUT_TOKEN
        )
        record_spend(
            spend,
            {
                "provider": "gemini",
                "model": MODEL,
                "slug": stone["slug"],
                "input_tokens": usage.get("promptTokenCount", 0),
                "output_tokens": usage.get("candidatesTokenCount", 0),
                "usd": round(usd, 5),
                "seconds": round(time.time() - started),
                "out_dir": str(out_dir.relative_to(ROOT)) if out_dir.is_relative_to(ROOT) else "elsewhere",
            },
        )
        if image is None:
            print(f"  no image for {stone['slug']} (${usd:.4f})", flush=True)
            continue
        to_webp(image, out_dir / f"{stone['slug']}.webp")
        if out_dir == ART_DIR:
            write_manifest()
        print(f"  drew {stone['slug']} (${usd:.4f}), total ${sum(map(spend_usd, spend)):.2f}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
