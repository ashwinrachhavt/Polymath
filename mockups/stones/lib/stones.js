/*
 * Polymath stones: the exploration engine shared by every board in this folder.
 * One stone = cut (kind of knowledge) x material (subject) x finish (evidence),
 * plus a seed from the concept id for small, stable variation.
 * Plain script, no build step. Exposes window.Stones.
 */
(function (root) {
  "use strict";
  const TAU = Math.PI * 2;
  const C = [100, 100];

  /* ---------- deterministic helpers ---------- */
  function fnv(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const f1 = (n) => (Math.round(n * 10) / 10).toString();
  const pt = (p) => f1(p[0]) + "," + f1(p[1]);
  const pts = (a) => a.map(pt).join(" ");

  /* ---------- colour ---------- */
  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(c) {
    return "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  }
  function mix(a, b, t) {
    const A = hexToRgb(a), B = hexToRgb(b);
    return rgbToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
  }
  function rotateHue(hex, deg) {
    // rotate around the grey axis; cheap and good enough for +-10 degrees
    const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
    const a = (deg * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a), k = 1 / 3, q = Math.sqrt(k);
    const m = [
      cs + (1 - cs) * k, k * (1 - cs) - q * sn, k * (1 - cs) + q * sn,
      k * (1 - cs) + q * sn, cs + k * (1 - cs), k * (1 - cs) - q * sn,
      k * (1 - cs) - q * sn, k * (1 - cs) + q * sn, cs + k * (1 - cs),
    ];
    return rgbToHex([
      (r * m[0] + g * m[1] + b * m[2]) * 255,
      (r * m[3] + g * m[4] + b * m[5]) * 255,
      (r * m[6] + g * m[7] + b * m[8]) * 255,
    ]);
  }
  function ramp(pal, t) {
    t = Math.max(0, Math.min(1, t)) * (pal.length - 1);
    const i = Math.min(pal.length - 2, Math.floor(t));
    return mix(pal[i], pal[i + 1], t - i);
  }

  /* ---------- the inventory ---------- */
  // Cut = what kind of knowledge it is.
  const CUTS = [
    { key: "pebble", name: "Pebble", kind: "Fact", plural: "Facts", why: "One smooth thing you simply know." },
    { key: "prism", name: "Prism", kind: "Principle", plural: "Principles", why: "Holds true from every side." },
    { key: "terrace", name: "Terrace", kind: "Mechanism", plural: "Mechanisms", why: "Works in levels, one inside the next." },
    { key: "delta", name: "Delta", kind: "Pattern", plural: "Patterns", why: "The same shape, repeating." },
    { key: "point", name: "Point", kind: "Tool", plural: "Tools", why: "Has a working end." },
    { key: "baton", name: "Baton", kind: "Method", plural: "Methods", why: "Runs in order, start to finish." },
  ];
  // Material = the subject it belongs to. Palettes run darkest first.
  const MATERIALS = [
    { key: "obsidian", name: "Obsidian", subject: "Code and languages", look: "glass", pal: ["#07080c", "#161a24", "#2a3140", "#5d6c88", "#b6cfe0"], accent: "#7a5cff", accent2: "#2fd6c0", why: "Dark, sharp glass." },
    { key: "hematite", name: "Hematite", subject: "Systems and infrastructure", look: "metal", pal: ["#16181d", "#343a44", "#6b7380", "#aab2bd", "#f1f4f8"], accent: "#8fa3c2", why: "Iron, the stuff of machines." },
    { key: "azurite", name: "Azurite", subject: "Data and AI", look: "clear", pal: ["#071a5e", "#1436a6", "#2a5be0", "#74a0ff", "#d6e4ff"], accent: "#59e0ff", why: "Deep water." },
    { key: "fluorite", name: "Fluorite", subject: "Maths and logic", look: "clear", pal: ["#083f45", "#107874", "#2fb3a3", "#8de3cf", "#e6fff6"], accent: "#8a6cf0", why: "Grows in perfect cubes." },
    { key: "malachite", name: "Malachite", subject: "Science and nature", look: "banded", pal: ["#042a1b", "#0a5236", "#168457", "#52c08e", "#c6f2d6"], accent: "#0a3f2a", why: "Growth rings in green." },
    { key: "peridot", name: "Peridot", subject: "Arts and music", look: "clear", pal: ["#33420a", "#637f10", "#9cbf22", "#cfe566", "#f8ffcc"], accent: "#ffd84a", why: "A bright, high note." },
    { key: "amber", name: "Amber", subject: "Writing and language", look: "clear", pal: ["#552503", "#9a5205", "#dc8c0c", "#f7bf45", "#fff1bd"], accent: "#ff6a1f", why: "Keeps what it holds." },
    { key: "copper", name: "Copper", subject: "Business and strategy", look: "metal", pal: ["#3d160a", "#823415", "#c26536", "#eda67b", "#ffe6d3"], accent: "#3fa796", why: "The metal of trade." },
    { key: "jasper", name: "Jasper", subject: "History and society", look: "banded", pal: ["#350d08", "#742213", "#ad4229", "#d98a5a", "#f4d6ad"], accent: "#d9a441", why: "Old earth, laid down in layers." },
    { key: "coral", name: "Coral", subject: "Design and craft", look: "milky", pal: ["#77192b", "#bf3d57", "#ee7187", "#ffaab4", "#ffe6e7"], accent: "#ffd0a8", why: "Built by many small hands." },
    { key: "amethyst", name: "Amethyst", subject: "Philosophy and ideas", look: "clear", pal: ["#260d4f", "#51229c", "#8649d9", "#bc90f6", "#f0e3ff"], accent: "#ff8ad8", why: "Long prized for a clear head." },
    { key: "moonstone", name: "Moonstone", subject: "People and mind", look: "milky", pal: ["#56688a", "#8fa3c2", "#c7d5ea", "#edf3fb", "#ffffff"], accent: "#6fb0ff", why: "Lit from the inside." },
  ];
  // Finish = how well the idea has held up. It only ever goes up.
  const FINISHES = [
    { key: "cut", name: "", label: "Fresh-cut", evidence: "Proven once", detail: "Formed from its shards. Matte, like stone straight off the wheel." },
    { key: "polished", name: "Polished", label: "Polished", evidence: "Held through a review", detail: "Came back right after time away. Gains a gloss." },
    { key: "brilliant", name: "Brilliant", label: "Brilliant", evidence: "Held through three reviews", detail: "Keeps coming back right. Gains fire and glints." },
    { key: "star", name: "Star", label: "Star", evidence: "Held for six months", detail: "Long-term memory. A six-ray star sits in the stone." },
  ];
  const byKey = (list) => Object.fromEntries(list.map((x, i) => [x.key, Object.assign({ index: i }, x)]));
  const CUT = byKey(CUTS), MAT = byKey(MATERIALS), FIN = byKey(FINISHES);

  /** [Finish] Material Cut. The first finish is silent: "Amber Prism", then "Polished Amber Prism". */
  function stoneName(s) {
    const fin = FIN[s.finish || "cut"].name;
    return (fin ? fin + " " : "") + MAT[s.material].name + " " + CUT[s.cut].name;
  }
  /** One plain sentence saying what the stone means. */
  function stoneMeaning(s) {
    const c = CUT[s.cut], m = MAT[s.material], f = FIN[s.finish || "cut"];
    const an = /^[aeiou]/i.test(c.kind) ? "An" : "A";
    return an + " " + c.kind.toLowerCase() + " in " + m.subject.toLowerCase() + ". " + f.evidence + ".";
  }
  /**
   * The deterministic mapping. kind and subject are labels stored on the concept
   * when it is first extracted; the seed comes from the concept id; the finish is
   * read from review history. Nothing here is random and nothing is re-derived.
   */
  function stoneForConcept(concept) {
    return {
      cut: concept.kind, material: concept.subject,
      finish: concept.finish || "cut", seed: fnv(String(concept.id)),
    };
  }

  /* ---------- geometry ---------- */
  function rot(p, a, c) {
    c = c || C;
    const cs = Math.cos(a), sn = Math.sin(a), x = p[0] - c[0], y = p[1] - c[1];
    return [c[0] + x * cs - y * sn, c[1] + x * sn + y * cs];
  }
  const scale = (list, s, c) => list.map((p) => [(c || C)[0] + (p[0] - (c || C)[0]) * s, (c || C)[1] + (p[1] - (c || C)[1]) * s]);
  const mid = (a, b, t) => [a[0] + (b[0] - a[0]) * (t == null ? 0.5 : t), a[1] + (b[1] - a[1]) * (t == null ? 0.5 : t)];
  function centroid(list) {
    let x = 0, y = 0;
    for (const p of list) { x += p[0]; y += p[1]; }
    return [x / list.length, y / list.length];
  }
  function outward(a, b, c) {
    let nx = b[1] - a[1], ny = -(b[0] - a[0]);
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    const m = mid(a, b);
    if (nx * (m[0] - c[0]) + ny * (m[1] - c[1]) < 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  }
  function ring(A, B, tilt, c, out) {
    const n = A.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      out.push({ pts: [A[i], A[j], B[j], B[i]], n: outward(A[i], A[j], c), tilt });
    }
  }

  /** Each cut returns its outline, its facets and its flat top (the table), on a 200 x 200 canvas. */
  function buildCut(key, r) {
    const facets = [], inner = [];
    let outline, table, c = C, smooth = false;
    if (key === "prism") {
      const hex = (R) => Array.from({ length: 6 }, (_, i) => [100 + R * Math.cos(-TAU / 4 + (i * TAU) / 6), 100 + R * Math.sin(-TAU / 4 + (i * TAU) / 6)]);
      const a = hex(84), b = hex(63), t = hex(42);
      ring(a, b, 1, c, facets); ring(b, t, 0.6, c, facets);
      outline = a; table = t;
      for (let i = 0; i < 6; i++) inner.push({ pts: [t[i], mid(t[i], t[(i + 1) % 6]), C], d: i % 2 ? 0.16 : -0.1 }, { pts: [mid(t[i], t[(i + 1) % 6]), t[(i + 1) % 6], C], d: i % 2 ? -0.16 : 0.12 });
    } else if (key === "terrace") {
      const oct = (w, h, k) => [[100 - w + k, 100 - h], [100 + w - k, 100 - h], [100 + w, 100 - h + k], [100 + w, 100 + h - k], [100 + w - k, 100 + h], [100 - w + k, 100 + h], [100 - w, 100 + h - k], [100 - w, 100 - h + k]];
      const a = oct(88, 62, 24), b = oct(72, 47, 18), d = oct(57, 33, 13), t = oct(42, 20, 8);
      ring(a, b, 1, c, facets); ring(b, d, 0.72, c, facets); ring(d, t, 0.45, c, facets);
      outline = a; table = t;
      inner.push({ pts: [t[7], t[0], mid(t[0], t[1], 0.42), mid(t[5], t[4], 0.12), t[5], t[6]], d: 0.12 });
      inner.push({ pts: [mid(t[0], t[1], 0.7), t[1], t[2], t[3], t[4], mid(t[5], t[4], 0.5)], d: -0.12 });
    } else if (key === "delta") {
      c = [100, 108];
      const tri = (R) => [0, 1, 2].map((i) => [c[0] + R * Math.cos(-TAU / 4 + (i * TAU) / 3), c[1] + R * Math.sin(-TAU / 4 + (i * TAU) / 3)]);
      const T = tri(98), a = [];
      for (let i = 0; i < 3; i++) { a.push(mid(T[i], T[(i + 2) % 3], 0.13), mid(T[i], T[(i + 1) % 3], 0.13)); }
      const t = tri(46);
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3;
        facets.push({ pts: [a[2 * i + 1], a[2 * j], t[j], t[i]], n: outward(a[2 * i + 1], a[2 * j], c), tilt: 0.95 });
        facets.push({ pts: [a[2 * i], a[2 * i + 1], t[i]], n: outward(a[2 * i], a[2 * i + 1], c), tilt: 0.7 });
      }
      outline = a; table = t;
      const m = [mid(t[0], t[1]), mid(t[1], t[2]), mid(t[2], t[0])];
      inner.push({ pts: m, d: 0.2 }, { pts: [t[0], m[0], m[2]], d: -0.06 }, { pts: [t[1], m[1], m[0]], d: -0.2 }, { pts: [t[2], m[2], m[1]], d: 0.06 });
    } else if (key === "point") {
      c = [100, 108];
      const k = [[100, 8], [156, 116], [100, 192], [44, 116]];
      const t = scale(k, 0.46, c);
      ring(k, t, 1, c, facets);
      outline = k; table = t;
      inner.push({ pts: [t[0], t[1], t[2]], d: -0.2 }, { pts: [t[0], t[2], t[3]], d: 0.16 });
      inner.push({ pts: [t[0], mid(t[0], t[1], 0.55), mid(t[0], t[2], 0.3)], d: 0.05 });
    } else if (key === "baton") {
      const a0 = [[100, 8], [130, 38], [130, 162], [100, 192], [70, 162], [70, 38]];
      const t0 = [[100, 38], [114, 52], [114, 148], [100, 162], [86, 148], [86, 52]];
      const A = -0.52;
      const a = a0.map((p) => rot(p, A)), t = t0.map((p) => rot(p, A));
      ring(a, t, 1, c, facets);
      outline = a; table = t;
      inner.push({ pts: [t[0], t[1], t[2], mid(t[2], t[5])], d: -0.14 }, { pts: [t[5], t[0], mid(t[2], t[5]), t[4]], d: 0.14 });
    } else {
      // pebble: a soft superellipse with a seeded wobble, no facets
      smooth = true;
      const ph = r() * TAU, n = 2.5, a = -0.2 + (r() - 0.5) * 0.2;
      outline = Array.from({ length: 44 }, (_, i) => {
        const th = (i / 44) * TAU, cs = Math.cos(th), sn = Math.sin(th), w = 1 + 0.035 * Math.sin(3 * th + ph) + 0.02 * Math.sin(5 * th + ph * 2);
        return rot([100 + 86 * w * Math.sign(cs) * Math.pow(Math.abs(cs), 2 / n), 100 + 62 * w * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n)], a);
      });
      table = scale(outline, 0.4);
    }
    return { outline, facets, table, inner, c, smooth };
  }

  /* ---------- drawing ---------- */
  const L = (() => { const l = Math.hypot(-0.55, -0.83); return [-0.55 / l, -0.83 / l]; })();
  const LOOK = {
    clear: { base: 0.5, amp: 0.36, jit: 0.1, star: 0.85, edge: 0.34 },
    milky: { base: 0.6, amp: 0.2, jit: 0.04, star: 0.25, edge: 0.3 },
    banded: { base: 0.48, amp: 0.26, jit: 0.05, star: 0.4, edge: 0.22 },
    metal: { base: 0.5, amp: 0.5, jit: 0.12, star: 0.5, edge: 0.5 },
    glass: { base: 0.2, amp: 0.34, jit: 0.07, star: 0.6, edge: 0.4 },
  };

  function sparkle(x, y, s, o) {
    const k = s * 0.14;
    return `<path d="M${f1(x)},${f1(y - s)}Q${f1(x + k)},${f1(y - k)} ${f1(x + s)},${f1(y)}Q${f1(x + k)},${f1(y + k)} ${f1(x)},${f1(y + s)}Q${f1(x - k)},${f1(y + k)} ${f1(x - s)},${f1(y)}Q${f1(x - k)},${f1(y - k)} ${f1(x)},${f1(y - s)}Z" fill="#fff" opacity="${o}"/>`;
  }

  /**
   * Draw a stone. Returns the parts so callers can compose them:
   * { svg, body, defs, outlinePath, ... }. `id` namespaces gradient ids when the
   * svg is inlined more than once on a page; as an <img> data URL it is not needed.
   */
  function drawStone(spec, opts) {
    opts = opts || {};
    const id = opts.id || "s";
    const mat = MAT[spec.material], fin = FIN[spec.finish || "cut"].index, look = LOOK[mat.look];
    const r = rng((spec.seed >>> 0) || 1);
    const hue = (r() - 0.5) * 14;
    const pal = mat.pal.map((h) => rotateHue(h, hue));
    const turn = spec.cut === "pebble" ? 0 : (r() - 0.5) * 0.14;
    const g = buildCut(spec.cut, r);
    const R = (p) => rot(p, turn, g.c);
    const outline = g.outline.map(R);
    const contrast = fin === 0 ? 0.62 : 1;
    const tone = (b) => {
      b = Math.max(0, Math.min(1, b));
      if (mat.look === "metal") { b = b < 0.5 ? 0.5 * Math.pow(b * 2, 1.5) : 1 - 0.5 * Math.pow((1 - b) * 2, 1.5); }
      return ramp(pal, 0.5 + (b - 0.5) * contrast);
    };
    const edge = ramp(pal, 0.92);
    let body = "";
    const outlineD = "M" + outline.map(pt).join("L") + "Z";

    if (g.smooth) {
      body += `<rect width="200" height="200" fill="url(#${id}b)"/>`;
    } else {
      const n = [Math.cos(turn), Math.sin(turn)];
      for (const f of g.facets) {
        const nx = f.n[0] * n[0] - f.n[1] * n[1], ny = f.n[0] * n[1] + f.n[1] * n[0];
        const b = look.base + look.amp * f.tilt * (nx * L[0] + ny * L[1]) + (r() - 0.5) * look.jit * 2;
        body += `<polygon points="${pts(f.pts.map(R))}" fill="${tone(b)}"/>`;
      }
      const tb = look.base + 0.1;
      body += `<polygon points="${pts(g.table.map(R))}" fill="${tone(tb)}"/>`;
      if (look.star) {
        const so = look.star * (fin === 0 ? 0.55 : 1);
        for (const t of g.inner) body += `<polygon points="${pts(t.pts.map(R))}" fill="${tone(tb + t.d * 1.5)}" opacity="${f1(so)}"/>`;
      }
      // facet lines: the crisp edges that make it read as cut stone
      let lines = "";
      for (const f of g.facets) lines += "M" + f.pts.map(R).map(pt).join("L") + "Z";
      lines += "M" + g.table.map(R).map(pt).join("L") + "Z";
      body += `<path d="${lines}" fill="none" stroke="${edge}" stroke-width=".7" stroke-linejoin="round" opacity="${f1(look.edge * (fin === 0 ? 0.6 : 1))}"/>`;
    }

    // material character
    if (mat.look === "banded") {
      const bx = 60 + r() * 80, by = 50 + r() * 100, sq = 0.5 + r() * 0.35, ba = r() * 180;
      let bands = "";
      for (let i = 1; i <= 7; i++) {
        const rr = 14 + i * 21 + r() * 6;
        bands += `<ellipse cx="${f1(bx)}" cy="${f1(by)}" rx="${f1(rr)}" ry="${f1(rr * sq)}" fill="none" stroke="${i % 2 ? mat.accent : pal[3]}" stroke-width="${f1(3 + r() * 6)}" opacity="${i % 2 ? 0.5 : 0.3}"/>`;
      }
      body += `<g transform="rotate(${f1(ba)} ${f1(bx)} ${f1(by)})">${bands}</g>`;
    }
    if (mat.look === "milky") {
      body += `<circle cx="${f1(86 + r() * 40)}" cy="${f1(96 + r() * 36)}" r="62" fill="url(#${id}m)"/>`;
    }
    if (mat.look === "glass") {
      const a = 20 + r() * 50;
      body += `<rect x="-40" y="${f1(50 + r() * 40)}" width="280" height="90" fill="url(#${id}m)" transform="rotate(${f1(-a)} 100 100)"/>`;
    }
    if (mat.key === "amber" || mat.key === "fluorite") {
      // inclusions and colour zoning, the small flaws that make a specimen its own
      for (let i = 0; i < 3; i++) body += `<circle cx="${f1(60 + r() * 80)}" cy="${f1(60 + r() * 90)}" r="${f1(5 + r() * 14)}" fill="${mat.accent}" opacity="${f1(0.1 + r() * 0.16)}"/>`;
    }

    // light: inner glow always, gloss and rim once polished
    body += `<rect width="200" height="200" fill="url(#${id}g)"/>`;
    if (fin === 0) body += `<rect width="200" height="200" fill="${pal[4]}" opacity=".13"/>`;
    if (fin >= 1) {
      body += g.smooth
        ? `<ellipse cx="72" cy="66" rx="40" ry="17" fill="#fff" opacity=".5" transform="rotate(-24 72 66)" filter="url(#${id}f)"/><ellipse cx="62" cy="62" rx="12" ry="5" fill="#fff" opacity=".85" transform="rotate(-24 62 62)"/>`
        : `<polygon points="${pts([g.table[0], mid(g.table[0], g.table[1], 0.62), mid(g.table[g.table.length - 1], g.table[g.table.length - 2], 0.3), g.table[g.table.length - 1]].map(R))}" fill="#fff" opacity=".2"/><path d="M-20,90L90,-20L128,-20L-20,128Z" fill="url(#${id}s)"/>`;
    }
    if (fin >= 2 && !g.smooth) {
      g.inner.forEach((t, i) => {
        if (i % 2 === 0) body += `<polygon points="${pts(t.pts.map(R))}" fill="${i % 4 === 0 ? mat.accent : rotateHue(pal[4], 55)}" opacity=".3"/>`;
      });
    }
    if (fin >= 3) {
      const tc = centroid(g.table.map(R));
      let rays = "";
      for (let i = 0; i < 3; i++) {
        const a = turn + 0.3 + (i * Math.PI) / 3, dx = Math.cos(a), dy = Math.sin(a), w = 1.7;
        rays += `<polygon points="${pts([[tc[0] + dx * 96, tc[1] + dy * 96], [tc[0] - dy * w, tc[1] + dx * w], [tc[0] - dx * 96, tc[1] - dy * 96], [tc[0] + dy * w, tc[1] - dx * w]])}"/>`;
      }
      body += `<g fill="#fff" opacity=".5">${rays}</g><circle cx="${f1(tc[0])}" cy="${f1(tc[1])}" r="20" fill="url(#${id}a)"/>`;
    }

    const defs =
      `<radialGradient id="${id}g" cx=".66" cy=".74" r=".7"><stop offset="0" stop-color="${pal[4]}" stop-opacity="${mat.look === "glass" ? 0.1 : mat.look === "metal" ? 0.14 : 0.42}"/><stop offset=".55" stop-color="${pal[3]}" stop-opacity="0"/><stop offset="1" stop-color="${pal[0]}" stop-opacity=".38"/></radialGradient>` +
      (fin >= 1 && !g.smooth ? `<linearGradient id="${id}s" x1="0" y1="0" x2="1" y2="1"><stop offset=".2" stop-color="#fff" stop-opacity="0"/><stop offset=".34" stop-color="#fff" stop-opacity=".46"/><stop offset=".42" stop-color="#fff" stop-opacity=".08"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>` : "") +
      (g.smooth ? `<radialGradient id="${id}b" cx=".36" cy=".3" r=".85"><stop offset="0" stop-color="${ramp(pal, mat.look === "glass" ? 0.6 : 0.86)}"/><stop offset=".42" stop-color="${ramp(pal, mat.look === "glass" ? 0.3 : 0.55)}"/><stop offset=".8" stop-color="${ramp(pal, mat.look === "glass" ? 0.12 : 0.3)}"/><stop offset="1" stop-color="${pal[0]}"/></radialGradient>` : "") +
      (g.smooth && fin >= 1 ? `<filter id="${id}f" x="-.3" y="-.6" width="1.6" height="2.2"><feGaussianBlur stdDeviation="5"/></filter>` : "") +
      (mat.look === "milky" ? `<radialGradient id="${id}m"><stop offset="0" stop-color="${mat.accent}" stop-opacity=".62"/><stop offset="1" stop-color="${mat.accent}" stop-opacity="0"/></radialGradient>` : "") +
      (mat.look === "glass" ? `<linearGradient id="${id}m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mat.accent}" stop-opacity="0"/><stop offset=".4" stop-color="${mat.accent}" stop-opacity=".42"/><stop offset=".62" stop-color="${mat.accent2}" stop-opacity=".4"/><stop offset="1" stop-color="${mat.accent2}" stop-opacity="0"/></linearGradient>` : "") +
      (fin >= 3 ? `<radialGradient id="${id}a"><stop offset="0" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>` : "") +
      `<clipPath id="${id}c"><path d="${outlineD}"/></clipPath>`;

    // rim and glints sit outside the clip so the silhouette stays crisp
    let top = `<path d="${outlineD}" fill="none" stroke="${pal[0]}" stroke-width="1.6" stroke-linejoin="round" opacity=".55"/>`;
    if (mat.look === "glass") top += `<path d="${outlineD}" fill="none" stroke="${pal[3]}" stroke-width="1.2" stroke-linejoin="round" opacity=".7"/>`;
    if (fin >= 1) top += `<path d="${outlineD}" fill="none" stroke="#fff" stroke-width="1.1" stroke-linejoin="round" opacity=".5" stroke-dasharray="${g.smooth ? "90 400" : "120 500"}" stroke-dashoffset="${g.smooth ? 250 : 60}"/>`;
    if (fin >= 2) {
      const hi = outline.slice().sort((a, b) => a[0] * 0.55 + a[1] * 0.83 - (b[0] * 0.55 + b[1] * 0.83));
      top += sparkle(hi[0][0] + 3, hi[0][1] + 4, 13, 0.95) + sparkle(hi[Math.min(2, hi.length - 1)][0] + 6, hi[Math.min(2, hi.length - 1)][1] + 8, 7, 0.8);
      if (fin >= 3) top += sparkle(hi[hi.length - 1][0] - 8, hi[hi.length - 1][1] - 10, 8, 0.7);
    }
    const shadow = opts.shadow === false ? "" : `<ellipse cx="104" cy="${g.smooth ? 172 : 190}" rx="${g.smooth ? 66 : 54}" ry="7" fill="#000" opacity=".2"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs>${defs}</defs>${shadow}<g clip-path="url(#${id}c)">${body}</g>${top}</svg>`;
    return { svg, defs, body, top, shadow, outlineD, outline, center: g.c, pal, id };
  }

  const dataUrl = (svg) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  function stoneImg(spec, size, alt) {
    const d = drawStone(spec);
    return `<img class="stone" src="${dataUrl(d.svg)}" width="${size}" height="${size}" alt="${alt == null ? stoneName(spec) : alt}" loading="lazy" decoding="async">`;
  }

  /**
   * A stone that is still forming: the outline is there, and each shard earned
   * fills one fragment of it, held slightly apart until the last one lands.
   */
  function drawForming(spec, have, need, opts) {
    opts = opts || {};
    const id = opts.id || "f";
    const d = drawStone(Object.assign({}, spec, { finish: "cut" }), { id, shadow: false });
    const r = rng(((spec.seed >>> 0) ^ 0x9e3779b9) >>> 0);
    const c = [d.center[0] + (r() - 0.5) * 24, d.center[1] + (r() - 0.5) * 24];
    const a0 = r() * TAU, cuts = [];
    for (let i = 0; i < need; i++) cuts.push(a0 + (i * TAU) / need + (r() - 0.5) * 0.5);
    let clips = "", groups = "";
    for (let i = 0; i < need; i++) {
      const a = cuts[i], b = cuts[(i + 1) % need] + (i === need - 1 ? TAU : 0), m = (a + b) / 2;
      const w = [c, [c[0] + 260 * Math.cos(a), c[1] + 260 * Math.sin(a)], [c[0] + 260 * Math.cos(m), c[1] + 260 * Math.sin(m)], [c[0] + 260 * Math.cos(b), c[1] + 260 * Math.sin(b)]];
      clips += `<clipPath id="${id}k${i}"><polygon points="${pts(w)}"/></clipPath>`;
      const off = [Math.cos(m) * 5, Math.sin(m) * 5];
      groups += `<g class="frag${i < have ? " on" : ""}" data-i="${i}" style="--dx:${f1(off[0])}px;--dy:${f1(off[1])}px" clip-path="url(#${id}k${i})"><g clip-path="url(#${id}c)">${d.body}</g></g>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" class="forming"><defs>${d.defs}${clips}</defs><path class="ghost" d="${d.outlineD}"/>${groups}<g class="rim">${d.top}</g></svg>`;
    return { svg, cuts, center: c, pal: d.pal };
  }

  /** The small reward for one win: a chip of the concept's own material. */
  function drawShard(material, seed) {
    const pal = MAT[material].pal, r = rng(seed || 7);
    const p = [[22 + r() * 6, 6 + r() * 4], [40 - r() * 4, 20 + r() * 6], [26 + r() * 6, 42 - r() * 4], [8 + r() * 4, 26 + r() * 6]];
    const m = [22 + r() * 6, 22 + r() * 4];
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><polygon points="${pts([p[0], p[1], m])}" fill="${pal[3]}"/><polygon points="${pts([p[1], p[2], m])}" fill="${pal[2]}"/><polygon points="${pts([p[2], p[3], m])}" fill="${pal[1]}"/><polygon points="${pts([p[3], p[0], m])}" fill="${pal[4]}"/><polygon points="${pts(p)}" fill="none" stroke="#fff" stroke-width="1" opacity=".6"/></svg>`;
  }

  /**
   * The specimen for a finished mission: a geode. Each band is one stone from
   * the mission, in that stone's material, so the geode is a record of the work.
   */
  function drawGeode(stones, seed, opts) {
    opts = opts || {};
    const id = opts.id || "g", r = rng(seed || 3), K = 48;
    const shape = (R, sq, cx, cy, amp) => {
      const p = [r() * TAU, r() * TAU, r() * TAU];
      return Array.from({ length: K }, (_, i) => {
        const th = (i / K) * TAU, w = 1 + amp * (0.5 * Math.sin(2 * th + p[0]) + 0.34 * Math.sin(3 * th + p[1]) + 0.16 * Math.sin(5 * th + p[2]));
        return [cx + R * w * Math.cos(th), cy + R * w * sq * Math.sin(th)];
      });
    };
    const d = (P) => "M" + P.map(pt).join("L") + "Z";
    const lerp = (A, B, t) => A.map((a, i) => [a[0] + (B[i][0] - a[0]) * t, a[1] + (B[i][1] - a[1]) * t]);
    const rind = shape(90, 0.8, 100, 100, 0.2), face = scale(rind, 0.9, [100, 100]);
    const cav = shape(24 + r() * 6, 0.62, 100 + (r() - 0.5) * 34, 102 + (r() - 0.5) * 20, 0.5);
    // band widths are uneven, the way agate lays down
    const n = stones.length, w = stones.map(() => 0.6 + r() * 0.9), tot = w.reduce((a, b) => a + b, 0);
    let s = `<path d="${d(rind)}" fill="url(#${id}r)"/><path d="${d(rind)}" fill="#000" filter="url(#${id}n)" opacity=".55"/>`, t = 0;
    for (let i = 0; i < n; i++) {
      const pal = MAT[stones[i].material].pal, P = lerp(face, cav, t), look = MAT[stones[i].material].look;
      s += `<path d="${d(P)}" fill="${look === "glass" ? pal[2] : look === "milky" ? pal[3] : pal[i % 2 ? 2 : 1]}"/><path d="${d(lerp(face, cav, t + (w[i] / tot) * 0.45))}" fill="none" stroke="${pal[4]}" stroke-width=".9" opacity=".4"/>`;
      t += w[i] / tot;
    }
    // the hollow: a bed of small crystals in the mission's most common material
    const count = {}; stones.forEach((x) => (count[x.material] = (count[x.material] || 0) + 1));
    const main = MAT[Object.keys(count).sort((a, b) => count[b] - count[a])[0]].pal, cc = centroid(cav);
    let dr = "";
    for (let i = 0; i < 46; i++) {
      const a = r() * TAU, q = Math.sqrt(r()) * 34, x = cc[0] + Math.cos(a) * q, y = cc[1] + Math.sin(a) * q * 0.7, sz = 5 + r() * 8, a2 = r() * TAU;
      dr += `<polygon points="${pts([[x + Math.cos(a2) * sz, y + Math.sin(a2) * sz], [x + Math.cos(a2 + 2.1) * sz, y + Math.sin(a2 + 2.1) * sz], [x + Math.cos(a2 + 4.2) * sz, y + Math.sin(a2 + 4.2) * sz]])}" fill="${[main[1], main[2], main[3], main[4], "#ffffff"][Math.floor(r() * 5)]}" opacity="${f1(0.7 + r() * 0.3)}"/>`;
    }
    s += `<path d="${d(cav)}" fill="${main[0]}"/><g clip-path="url(#${id}c)">${dr}</g><path d="${d(cav)}" fill="none" stroke="${main[0]}" stroke-width="2.5" opacity=".7"/>`;
    s += `<path d="${d(face)}" fill="url(#${id}l)"/>` + sparkle(cc[0] - 6, cc[1] - 4, 9, 0.95) + sparkle(cc[0] + 13, cc[1] + 7, 5, 0.85) + sparkle(face[30][0] + 16, face[30][1] + 10, 6, 0.6);
    const defs = `<radialGradient id="${id}r" cx=".4" cy=".3" r=".8"><stop offset="0" stop-color="#93877a"/><stop offset="1" stop-color="#3a322c"/></radialGradient><linearGradient id="${id}l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".34"/><stop offset=".38" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".26"/></linearGradient><clipPath id="${id}c"><path d="${d(cav)}"/></clipPath><filter id="${id}n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="${(seed || 3) % 97}"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.4 1"/><feComposite in2="SourceGraphic" operator="in"/></filter>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs>${defs}</defs><ellipse cx="104" cy="176" rx="66" ry="7" fill="#000" opacity=".2"/>${s}</svg>`;
  }

  root.Stones = {
    CUTS, MATERIALS, FINISHES, CUT, MAT, FIN,
    fnv, rng, ramp, mix, rotateHue, hexToRgb,
    stoneName, stoneMeaning, stoneForConcept,
    buildCut, drawStone, drawForming, drawShard, drawGeode, dataUrl, stoneImg,
  };
})(typeof window !== "undefined" ? window : globalThis);
