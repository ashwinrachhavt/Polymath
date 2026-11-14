"""Draw the stone collection's art on Cloudflare Workers AI, free and resumable.

Run from the repo root (needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_KEY in the
environment):

    uv run --with requests --with pillow --with numpy --with scipy python scripts/stones/generate_art.py --limit 50

Every stone in scripts/stones/catalog.json gets public/stones/<slug>.webp; a stone whose
webp exists is skipped, and src/components/stones/drawn-stones.json is rewritten after
each drawing so the wall switches that stone from its placeholder to the image.

Cost: Workers AI includes 10,000 neurons a day (reset 00:00 UTC) and the run must stay at
$0. The API does not report neurons per call, so each call is charged against a
measured estimate, logged per UTC day in
scripts/stones/art-spend.json, and the run stops at --daily-neurons (default 9,000, under
the allowance) and resumes the next day. FLUX.2 klein 4B is listed at about 31
neurons for a 1024x1024 image (5.37 input + 26.05 output) but measured about 3x that; the script charges 90 (measured on 2026-11-13: the allowance ran out after about 115 calls;
on the Workers Free plan a call past the allowance fails with a 429 and nothing bills).

Set STONE_RAW_DIR to keep each raw image (not committed) for re-cutting without a new call.

Order: --limit draws the most-wanted undrawn stones first (PRIORITY, then wall order).
Images come back on a white ground with a detached soft shadow; both are cut away so the wall
can show an unowned stone as a silhouette of its own shape.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "scripts/stones/catalog.json"
SPEND_LOG = ROOT / "scripts/stones/art-spend.json"
ART_DIR = ROOT / "public/stones"
MANIFEST = ROOT / "src/components/stones/drawn-stones.json"
SIZE = 512

MODEL = "@cf/black-forest-labs/flux-2-klein-4b"
NEURONS_PER_IMAGE = 90  # measured: the 10,000 free neurons ran out after ~115 calls (the pricing table suggested ~31)
PRICE_SOURCE = "https://developers.cloudflare.com/workers-ai/platform/pricing/"

# Stones people look for first, after the legendary and precious tiers.
PRIORITY = [
    "clear-quartz", "smoky-quartz", "citrine", "moonstone", "obsidian", "malachite", "tigers-eye",
    "lapis-lazuli", "fluorite", "selenite", "hematite", "carnelian", "amazonite", "sodalite",
    "turquoise", "opal", "aquamarine", "imperial-topaz", "blue-topaz", "peridot", "sunstone",
    "amber", "black-tourmaline", "rhodochrosite", "green-aventurine", "spinel", "iolite", "kunzite",
    "morganite", "onyx", "rhodonite", "celestite", "kyanite", "howlite", "bloodstone",
]

STYLE = (
    "Isolated product cutout photograph of ONE mineral specimen for a fine collector's catalog, on a seamless "
    "pure {ground} background, the specimen floating in mid-air with NO shadow, NO reflection and NO "
    "contact with any surface, so the background is perfectly even all around it. "
    "Centered, three-quarter view from slightly above, filling about 70% of a square frame, nothing else in the frame. "
    "Lighting: one large soft key light from the upper left, gentle fill from the right, thin cool rim light. "
    "Crisp focus, true-to-life color, rich detail of luster and texture. No text, labels, hands, stands or props."
)


# A white stone cannot be told from a white backdrop, so it is shot on black and cut out on dark.
PALE = re.compile(r"^\W*(colou?rless|clear|transparent|white|whitish|milky|creamy?|pearl)", re.IGNORECASE)


def on_black(stone: dict) -> bool:
    return bool(PALE.search(stone["color"]))


def prompt_for(stone: dict) -> str:
    ground = "black (#000000)" if on_black(stone) else "white (#FFFFFF)"
    return f"{STYLE.format(ground=ground)} The specimen: {stone['name']} - {stone['look']}."


def load_spend() -> list[dict]:
    return json.loads(SPEND_LOG.read_text()) if SPEND_LOG.exists() else []


def save_spend(entries: list[dict]) -> None:
    SPEND_LOG.write_text(json.dumps(entries, indent=2) + "\n")


def neurons_today(entries: list[dict]) -> float:
    today = datetime.now(timezone.utc).date().isoformat()
    return sum(e.get("neurons_est", 0) for e in entries if e.get("provider") == "cloudflare" and e.get("utc_date") == today)


def write_manifest() -> None:
    MANIFEST.write_text(json.dumps(sorted(p.stem for p in ART_DIR.glob("*.webp")), indent=2) + "\n")


def cut_ground(image: Image.Image, black: bool) -> Image.Image:
    """Make the studio ground transparent and drop the floating shadow.

    The specimen is shot floating, so its soft shadow is a separate smudge below it. The ground
    is the near-white (or, for white stones, near-black) area connected to the border; of what
    is left, the largest piece is the stone, and a light, smaller piece sitting below it is its
    shadow (tinted by the stone's color, so color is no test). Big pieces stay: a stone in two parts.
    """
    rgb = np.asarray(image.convert("RGB"), dtype=np.int16)
    lowest = rgb.min(axis=2)
    spread = rgb.max(axis=2) - lowest
    highest = rgb.max(axis=2)
    white = (highest <= 30) if black else ((lowest >= 222) & (spread <= 26))
    regions, count = ndimage.label(white)
    border = set(np.unique(np.concatenate([regions[0], regions[-1], regions[:, 0], regions[:, -1]]))) - {0}
    ground = np.isin(regions, list(border))
    solid, pieces = ndimage.label(~ground)
    if pieces > 1:
        areas = ndimage.sum(np.ones_like(solid), solid, index=range(1, pieces + 1))
        biggest = int(np.argmax(areas)) + 1
        for piece in range(1, pieces + 1):
            if piece == biggest:
                continue
            mask = solid == piece
            small = areas[piece - 1] < 0.25 * areas[biggest - 1]
            below = np.nonzero(mask)[0].mean() > np.nonzero(solid == biggest)[0].mean()
            shadowy = (not black) and lowest[mask].mean() >= 140 and small and below
            if shadowy or areas[piece - 1] < 0.02 * areas[biggest - 1]:
                ground |= mask
    alpha = Image.fromarray(np.where(ground, 0, 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(1.2))
    out = image.convert("RGBA")
    out.putalpha(alpha)
    return out


def to_webp(image_bytes: bytes, dest: Path, black: bool) -> None:
    source = Image.open(io.BytesIO(image_bytes)).convert("RGB").resize((768, 768), Image.LANCZOS)
    image = cut_ground(source, black)
    box = image.getbbox()
    if box:
        image = image.crop(box)
    scale = (SIZE * 0.88) / max(image.size)
    image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(image, ((SIZE - image.width) // 2, (SIZE - image.height) // 2), image)
    dest.parent.mkdir(parents=True, exist_ok=True)
    quality = 80
    while True:
        canvas.save(dest, "WEBP", quality=quality, method=6)
        if dest.stat().st_size <= 120 * 1024 or quality <= 50:
            return
        quality -= 10


def draw(account: str, key: str, stone: dict) -> bytes:
    response = requests.post(
        f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{MODEL}",
        headers={"Authorization": f"Bearer {key}"},
        files={"prompt": (None, prompt_for(stone)), "width": (None, "1024"), "height": (None, "1024")},
        timeout=240,
    )
    body = response.json()
    if not body.get("success"):
        messages = "; ".join(str(e.get("message", "")) for e in body.get("errors", []))[:300]
        raise RuntimeError(f"{response.status_code}: {messages}")
    raw = base64.b64decode(body["result"]["image"])
    if os.environ.get("STONE_RAW_DIR"):
        Path(os.environ["STONE_RAW_DIR"], f"{stone['slug']}.jpg").write_bytes(raw)
    return raw


def ordered(stones: list[dict]) -> list[dict]:
    rank = {slug: i for i, slug in enumerate(PRIORITY)}
    tier_rank = {"legendary": 0, "precious": 1}
    position = {s["slug"]: i for i, s in enumerate(stones)}
    return sorted(
        stones,
        key=lambda s: (tier_rank.get(s["tier"], 2), rank.get(s["slug"], len(PRIORITY)), position[s["slug"]]),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="draw at most this many stones this run (0 = all left)")
    parser.add_argument("--daily-neurons", type=float, default=9000, help="stop at this many estimated neurons per UTC day")
    parser.add_argument("--slugs", default="", help="comma-separated slugs (default: the undrawn stones, most wanted first)")
    parser.add_argument("--redraw", action="store_true", help="draw the named --slugs again even when they exist")
    args = parser.parse_args()

    account, key = os.environ.get("CLOUDFLARE_ACCOUNT_ID"), os.environ.get("CLOUDFLARE_API_KEY")
    if not account or not key:
        print("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_KEY are required")
        return 1
    stones = json.loads(CATALOG.read_text())
    wanted = {s.strip() for s in args.slugs.split(",") if s.strip()}
    todo = [
        s for s in ordered(stones)
        if (not wanted or s["slug"] in wanted) and (args.redraw or not (ART_DIR / f"{s['slug']}.webp").exists())
    ]
    if args.limit:
        todo = todo[: args.limit]
    spend = load_spend()
    print(f"{len(todo)} stones to draw; {neurons_today(spend):.0f} neurons used today (UTC)", flush=True)

    for stone in todo:
        if neurons_today(spend) + NEURONS_PER_IMAGE > args.daily_neurons:
            print(f"Stopping: today's {args.daily_neurons:.0f}-neuron budget is spent; run again after 00:00 UTC", flush=True)
            return 2
        started = time.time()
        try:
            image = draw(account, key, stone)
        except RuntimeError as error:
            print(f"  {stone['slug']}: failed ({error}); stopping", flush=True)
            return 3
        spend.append(
            {
                "provider": "cloudflare",
                "model": MODEL,
                "slug": stone["slug"],
                "neurons_est": NEURONS_PER_IMAGE,
                "usd": 0,
                "utc_date": datetime.now(timezone.utc).date().isoformat(),
                "seconds": round(time.time() - started, 1),
            }
        )
        save_spend(spend)
        to_webp(image, ART_DIR / f"{stone['slug']}.webp", on_black(stone))
        write_manifest()
        print(f"  drew {stone['slug']} ({neurons_today(spend):.0f} neurons today)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
