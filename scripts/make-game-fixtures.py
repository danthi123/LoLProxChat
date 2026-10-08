#!/usr/bin/env python3
"""
Build the real-game icon test set for tests/cv/real-games.test.ts from Debug
zips (games/<lobby>_<date>_<time>.zip in a tester's log folder).

For every own-team icon on every minimap snapshot in each zip, this cuts a
patch around it and labels it with the teammate whose minimap icon it
correlates with best — the same method src/services/skin-matcher.ts uses, in
an independent implementation — keeping only clear matches (score >= 0.6,
margin >= 0.2, as the app). It also writes contact sheets of the labelled
patches: LOOK AT THEM before trusting a new batch. A label the sheet shows to
be wrong goes in overrides.json ({"<patch file>": "<champion alias>" or null
to drop it}) and the script is rerun.

The roster comes from each zip's log (the local champion and the ALLY peers).
Which skin each player had on is in the log from v0.5.20 ("[Skins] Teammate
icons: ..."); for older zips every skin of the champion is a candidate, which
makes the test set harder, not easier.

Riot's art is not committed: icons are downloaded from Community Dragon into
the output folder, tests/cv/fixtures-games/, which is gitignored like
fixtures-real/. The test skips itself when the folder is missing.

Usage: python3 scripts/make-game-fixtures.py <zip> [<zip> ...]
"""
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from collections import deque

import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..')
OUT = os.path.join(ROOT, 'tests', 'cv', 'fixtures-games')
CD = 'https://raw.communitydragon.org/latest/game/assets/characters'
S = 32
MIN_SCORE, MIN_MARGIN = 0.6, 0.2


def fetch(url):
    # Cloudflare refuses urllib's default user agent.
    req = urllib.request.Request(url, headers={'User-Agent': 'lolproxchat-fixtures/1.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def alias_of(name):
    return re.sub(r'[^a-z0-9]', '', name.lower())


def icon_files(alias):
    html = fetch(f'{CD}/{alias}/hud/').decode('utf8', 'replace')
    return sorted(set(m.lower() for m in re.findall(alias + r'(?:_[a-z0-9]+)?_circle(?:_\d+)?\.png', html, re.I)))


def files_for_skin(files, skin):
    """Each form's icon for `skin`: its own, else the highest below it (a
    chroma wears its parent's), as iconFilesForSkin in skin-matcher.ts."""
    forms = {}
    for f in files:
        m = re.match(r'(.+?)_circle(?:_(\d+))?\.png$', f)
        n = int(m.group(2)) if m.group(2) else 0
        if n not in forms.setdefault(m.group(1), {}) or not m.group(2):
            forms[m.group(1)][n] = f
    out = []
    for by_num in forms.values():
        below = [n for n in by_num if n <= skin]
        if below:
            out.append(by_num[max(below)])
    return sorted(out)


# --- the matcher, independently of the TypeScript one ---
yy, xx = np.mgrid[0:S, 0:S]
INNER = np.hypot(xx - (S - 1) / 2, yy - (S - 1) / 2) <= S * 0.36


def norm(rgb):
    v = rgb[INNER].reshape(-1).astype(np.float64)
    v -= v.mean()
    return v / (np.linalg.norm(v) or 1)


def templates(png):
    im = Image.open(io.BytesIO(png)).convert('RGBA')
    bg = Image.new('RGBA', im.size, (30, 30, 30, 255))
    bg.paste(im, (0, 0), im)
    w, h = bg.size
    out = []
    for z in (0.8, 0.9, 1.0):
        c = min(w, h) * z
        crop = bg.crop(((w - c) / 2, (h - c) / 2, (w + c) / 2, (h + c) / 2))
        out.append(norm(np.asarray(crop.convert('RGB').resize((S, S), Image.LANCZOS), dtype=np.float64)))
    return out


def match(img, cx, cy, diam, sets):
    best = {}
    for k in (0.95, 1.05, 1.15):
        for dy in (-2, -1, 0, 1, 2):
            for dx in (-2, -1, 0, 1, 2):
                h = diam * k / 2
                crop = img.crop((cx + dx - h, cy + dy - h, cx + dx + h, cy + dy + h)).resize((S, S), Image.BILINEAR)
                v = norm(np.asarray(crop, dtype=np.float64))
                for who, vecs in sets.items():
                    s = max(float(v @ t) for t in vecs)
                    best[who] = max(best.get(who, -9), s)
    return sorted(best.items(), key=lambda kv: -kv[1])


# --- own-team icons, as tracking.ts finds them (teal ring, dilated, sized) ---
def teal_icons(img, diam):
    a = np.asarray(img, dtype=np.int32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    m = (r < 100) & (g > 120) & (b > 120) & (g + b > 280)
    d = m.copy()
    d[1:] |= m[:-1]; d[:-1] |= m[1:]; d[:, 1:] |= m[:, :-1]; d[:, :-1] |= m[:, 1:]
    seen = np.zeros_like(d)
    H, W = d.shape
    out = []
    for y in range(H):
        for x in range(W):
            if not d[y, x] or seen[y, x]:
                continue
            q = deque([(y, x)]); seen[y, x] = True; pts = []
            while q:
                cy, cx = q.popleft(); pts.append((cy, cx))
                for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                    if 0 <= ny < H and 0 <= nx < W and d[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True; q.append((ny, nx))
            ys = [p[0] for p in pts]; xs = [p[1] for p in pts]
            bw, bh = max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
            fill = len(pts) / (bw * bh)
            if 0.6 * diam <= bw <= 1.6 * diam and 0.6 * diam <= bh <= 1.6 * diam and fill <= 0.4:
                out.append(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2))
    return out


def roster(log):
    local = re.search(r'Local champion: (.+?) →', log)
    allies = re.findall(r'Peer joined: .+? \(ALLY, (.+?)\)', log)
    skins = {}
    for m in re.finditer(r'\[Skins\] Teammate icons: (.*)', log):
        for part in m.group(1).split('; '):
            sm = re.match(r'(.+?) skin (\d+) \(', part)
            if sm:
                skins[sm.group(1)] = int(sm.group(2))
    names = ([local.group(1)] if local else []) + sorted(set(allies))
    return names, skins


def main(zips):
    os.makedirs(os.path.join(OUT, 'patches'), exist_ok=True)
    os.makedirs(os.path.join(OUT, 'icons'), exist_ok=True)
    overrides_path = os.path.join(OUT, 'overrides.json')
    overrides = json.load(open(overrides_path)) if os.path.exists(overrides_path) else {}
    index = {'size': S, 'games': []}
    for zp in zips:
        z = zipfile.ZipFile(zp)
        log = z.read('lolproxchat.log').decode('utf8', 'replace')
        names, skins = roster(log)
        if len(names) < 2:
            print(f'{zp}: fewer than two own-team champions in the log, skipped')
            continue
        game = {'zip': os.path.basename(zp), 'roster': [], 'patches': []}
        sets = {}
        for n in names:
            alias = alias_of(n)
            files = icon_files(alias)
            if n in skins:
                files = files_for_skin(files, skins[n])
            game['roster'].append({'champion': n, 'alias': alias, 'icons': files})
            sets[alias] = []
            for f in files:
                path = os.path.join(OUT, 'icons', f)
                if not os.path.exists(path):
                    open(path, 'wb').write(fetch(f'{CD}/{alias}/hud/{f}'))
                sets[alias] += templates(open(path, 'rb').read())
                # Raw RGBA as well: the Jest test has no PNG decoder.
                im = Image.open(path).convert('RGBA')
                open(path[:-4] + '.rgba', 'wb').write(im.tobytes())
                game.setdefault('icons', {})[f] = [im.width, im.height]
        stem = os.path.splitext(os.path.basename(zp))[0]
        for name in sorted(n for n in z.namelist() if n.startswith('minimap/') and n.endswith('.png')):
            img = Image.open(io.BytesIO(z.read(name))).convert('RGB')
            diam = round(img.width * 0.087)
            for (cx, cy) in teal_icons(img, diam):
                ranked = match(img, cx, cy, diam, sets)
                label = ranked[0][0] if ranked[0][1] >= MIN_SCORE and ranked[0][1] - ranked[1][1] >= MIN_MARGIN else None
                side = diam * 2
                patch_file = f'{stem}_{os.path.basename(name)[:-4]}_{int(cx)}x{int(cy)}.rgba'
                if patch_file in overrides:
                    label = overrides[patch_file]
                if label is None:
                    continue
                patch = img.crop((round(cx - side / 2), round(cy - side / 2), round(cx - side / 2) + side, round(cy - side / 2) + side))
                open(os.path.join(OUT, 'patches', patch_file), 'wb').write(patch.convert('RGBA').tobytes())
                game['patches'].append({'file': patch_file, 'side': side, 'diam': diam, 'label': label})
        print(f"{zp}: {len(game['patches'])} labelled icons, roster {', '.join(names)}")
        index['games'].append(game)
    json.dump(index, open(os.path.join(OUT, 'index.json'), 'w'), indent=1)
    sheet(index)


def sheet(index):
    """Contact sheet per label, for checking by eye."""
    for game in index['games']:
        for alias in {p['label'] for p in game['patches']}:
            ps = [p for p in game['patches'] if p['label'] == alias][:96]
            cell = 48
            cols = 12
            sh = Image.new('RGB', (cols * cell, ((len(ps) + cols - 1) // cols) * cell), 'white')
            for i, p in enumerate(ps):
                raw = open(os.path.join(OUT, 'patches', p['file']), 'rb').read()
                im = Image.frombytes('RGBA', (p['side'], p['side']), raw).convert('RGB').resize((cell, cell))
                sh.paste(im, ((i % cols) * cell, (i // cols) * cell))
            sh.save(os.path.join(OUT, f"sheet_{os.path.splitext(game['zip'])[0]}_{alias}.png"))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1:])
