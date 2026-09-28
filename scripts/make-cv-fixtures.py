#!/usr/bin/env python3
"""
Build the real-art fixtures for tests/cv/real-art.test.ts.

The CV simulation suite draws flat coloured rings on a flat background, which
proves the state machine but not that any of it survives League's actual
minimap: terrain whose river and jungle colours can fall inside the teal box,
and champion portraits whose art can merge with or break up the border ring.
This writes the real Summoner's Rift minimap (assets/minimap-blank-sr.png) and
a handful of real champion circle portraits, scaled to the harness's geometry,
as raw RGBA the Jest harness can read without a PNG decoder.

Riot's art is not committed: the portraits come from the icon scrape
(npm run update-icons -- --limit 8, or the full scrape) and the output goes to
tests/cv/fixtures-real/, which is gitignored. real-art.test.ts skips itself,
saying so, when the fixtures are missing.

Usage: python3 scripts/make-cv-fixtures.py
"""
import json
import os
import sys
from PIL import Image, ImageChops, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), '..')
ICONS = os.path.join(ROOT, 'assets', 'champion-circles')
OUT = os.path.join(ROOT, 'tests', 'cv', 'fixtures-real')
# Must match tests/cv/harness/scenes.ts (REGION.width, ICON_DIAM).
REGION = 273
ICON_DIAM = 24
PORTRAIT_DIAM = ICON_DIAM - 2  # the border ring is drawn around the art

# The testers' matchup first (v0.5.9 logs), then whatever the scrape has.
WANTED = ['Briar', 'Katarina', 'Aatrox', 'Ahri', 'Akali', 'Akshan', 'Alistar', 'Amumu']


def pick_icon(champ_dir):
    for name in ('0.png', 'base.png'):
        p = os.path.join(champ_dir, name)
        if os.path.exists(p):
            return p
    pngs = sorted(f for f in os.listdir(champ_dir) if f.endswith('.png'))
    return os.path.join(champ_dir, pngs[0]) if pngs else None


def circle_portrait(path):
    im = Image.open(path).convert('RGBA')
    # Base tiles are square with a thin dark frame; trim it before the crop.
    w, h = im.size
    inset = round(w * 0.06)
    im = im.crop((inset, inset, w - inset, h - inset)).resize(
        (PORTRAIT_DIAM, PORTRAIT_DIAM), Image.LANCZOS)
    mask = Image.new('L', im.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, PORTRAIT_DIAM - 1, PORTRAIT_DIAM - 1), fill=255)
    im.putalpha(ImageChops.multiply(im.getchannel('A'), mask))
    return im


def main():
    os.makedirs(OUT, exist_ok=True)
    bg = Image.open(os.path.join(ROOT, 'assets', 'minimap-blank-sr.png')).convert('RGBA')
    flat = Image.new('RGBA', bg.size, (0, 0, 0, 255))
    flat.alpha_composite(bg)
    flat = flat.resize((REGION, REGION), Image.LANCZOS)
    with open(os.path.join(OUT, 'background-sr.rgba'), 'wb') as f:
        f.write(flat.tobytes())

    champions = []
    if os.path.isdir(ICONS):
        for name in WANTED:
            d = os.path.join(ICONS, name)
            if not os.path.isdir(d):
                continue
            p = pick_icon(d)
            if not p:
                continue
            with open(os.path.join(OUT, name + '.rgba'), 'wb') as f:
                f.write(circle_portrait(p).tobytes())
            champions.append(name)

    with open(os.path.join(OUT, 'index.json'), 'w') as f:
        json.dump({'region': REGION, 'portraitDiam': PORTRAIT_DIAM, 'champions': champions}, f, indent=2)
    print('wrote background + %d portraits to %s: %s' % (len(champions), OUT, ', '.join(champions)))
    if len(champions) < 4:
        print('need at least 4 portraits — run: npm run update-icons -- --limit 8', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
