/* The WALAO explainer — a 27-second WebGL sequence that says what the product
   does before anyone has to read a paragraph about it.

   One scene graph serves two surfaces: the fluid hero panel on `/` and the
   locked 1080x1920 frame on `/how` that exists to be screen-recorded. Nothing
   about the composition is aspect-specific — everything is laid out in a
   1000x1560 "core" box that the orthographic camera always contains, so a wide
   panel simply shows more empty ground around the same picture.

   Three.js is vendored (CSP is `script-src 'self'`, so there is no CDN to
   import from). Text is drawn to 2D canvases and mapped onto planes; there is
   no font loader and no external typeface — the stack is whatever the OS
   already has, which is also what the rest of the site uses.

   The sequence is a pure function of time. There is no state machine to fall
   out of sync: every element reads `t` and decides its own opacity, position
   and colour. That is what makes scrubbing, pausing, reduced-motion (freeze at
   one frame) and the 30fps recording lock all one line of code each. */

import * as THREE from "/vendor/three.module.min.js";

const DURATION = 27;

/* Always visible, in stage units. The camera contains this box; anything
   outside it is decorative ground that a wide panel happens to reveal. */
const CORE_W = 1000;
const CORE_H = 1560;

const INK = "#e9e9ed";
const DIM = "#8d93a8";
const ACCENT = "#25d366";

/* One colour per kind of thing moving through the system, and only four of
   them. A fifth would stop reading as a legend and start reading as confetti. */
const CATEGORY = {
  message: new THREE.Color("#5c6a8f"), // the raw traffic — deliberately quiet
  decision: new THREE.Color("#25d366"),
  action: new THREE.Color("#38bdf8"),
  date: new THREE.Color("#f5b642"),
};

const SANS = `system-ui, -apple-system, "Segoe UI", sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", monospace`;

const LAYER = { glow: 1, chrome: 2, type: 3, sweep: 4, film: 9, blackout: 11 };

/* ---------------------------------------------------------------------------
   Time helpers. Every element's visibility is one call to `win`.
   --------------------------------------------------------------------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v) => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};
/* Heavy out-cubic: things arrive with mass and settle, they do not glide in at
   a constant rate. This is the only easing the sequence uses for motion. */
const outCubic = (v) => 1 - Math.pow(1 - clamp01(v), 3);
const outBack = (v) => {
  const x = clamp01(v) - 1;
  return 1 + 2.2 * x * x * x + 1.2 * x * x;
};

/** Opacity envelope: 0 before `a`, 1 between, 0 after `b`, with soft edges. */
function win(t, a, b, fadeIn = 0.45, fadeOut = 0.45) {
  if (t < a || t > b) return 0;
  return Math.min(smooth((t - a) / fadeIn), smooth((b - t) / fadeOut));
}

/** Progress through a segment, clamped and eased. */
function seg(t, a, b, ease = outCubic) {
  return ease((t - a) / (b - a));
}

const lerp = (a, b, k) => a + (b - a) * k;

/* ---------------------------------------------------------------------------
   Builders. Each returns a THREE object carrying a `fade` function on
   userData, so the render loop never has to know what kind of thing it is.
   --------------------------------------------------------------------------- */

function setOpacity(object, alpha) {
  object.visible = alpha > 0.001;
  if (!object.visible) return;
  object.traverse((node) => {
    if (node.material) node.material.opacity = alpha * (node.userData.baseOpacity ?? 1);
  });
}

/** Text as a plane. `px` is the font size in stage units — 1 unit ≈ 1 pixel of
    a 1080-wide render, so the sizes here read like CSS sizes. */
function makeText(text, opts = {}) {
  const {
    px = 28,
    color = INK,
    weight = 500,
    mono = false,
    tracking = 0,
    align = "center",
    opacity = 1,
  } = opts;

  const RES = 3; // texel density; text is never scaled up past this
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = `${weight} ${px * RES}px ${mono ? MONO : SANS}`;
  const spacing = `${tracking * px * RES}px`;

  ctx.font = font;
  if ("letterSpacing" in ctx) ctx.letterSpacing = spacing;
  const metrics = ctx.measureText(text);
  const w = Math.ceil(metrics.width) + 8 * RES;
  const h = Math.ceil(px * RES * 1.4);

  canvas.width = Math.max(2, w);
  canvas.height = Math.max(2, h);
  ctx.font = font;
  if ("letterSpacing" in ctx) ctx.letterSpacing = spacing;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, 4 * RES, h / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const width = canvas.width / RES;
  const height = canvas.height / RES;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false }),
  );
  mesh.userData.baseOpacity = opacity;
  mesh.userData.textWidth = width;
  /* Alignment is a geometry offset rather than a wrapper group, so callers can
     still set position.x to the anchor they mean. */
  if (align === "left") mesh.geometry.translate(width / 2, 0, 0);
  if (align === "right") mesh.geometry.translate(-width / 2, 0, 0);
  /* Everything is on the same plane with depth testing off, so paint order is
     decided explicitly: glow behind, chrome over it, type on top. */
  mesh.renderOrder = LAYER.type;
  return mesh;
}

/** A rounded-rectangle outline — the whole interface is made of these. */
function roundedRect(w, h, r, color = INK, opacity = 0.55) {
  const points = [];
  const hw = w / 2 - r;
  const hh = h / 2 - r;
  const corners = [
    [hw, hh, 0],
    [-hw, hh, Math.PI / 2],
    [-hw, -hh, Math.PI],
    [hw, -hh, -Math.PI / 2],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (i / 8) * (Math.PI / 2);
      points.push(new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0));
    }
  }
  const line = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, transparent: true, depthTest: false }),
  );
  line.userData.baseOpacity = opacity;
  line.renderOrder = LAYER.chrome;
  return line;
}

/** Soft radial glow, additive — the only source of "neon" in the picture. */
let glowTexture = null;
function makeGlow(size, color = ACCENT, opacity = 0.5) {
  if (!glowTexture) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d").createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    const ctx = c.getContext("2d");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    glowTexture = new THREE.CanvasTexture(c);
  }
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      map: glowTexture,
      color: new THREE.Color(color),
      transparent: true,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  mesh.userData.baseOpacity = opacity;
  mesh.renderOrder = LAYER.glow;
  return mesh;
}

/** A ring drawn as arcs with gaps, so it reads as an instrument, not a circle. */
function segmentedRing(radius, segments = 12, coverage = 0.62, color = ACCENT, opacity = 0.5) {
  const points = [];
  for (let s = 0; s < segments; s++) {
    const a0 = (s / segments) * Math.PI * 2;
    const a1 = a0 + (coverage / segments) * Math.PI * 2;
    for (let i = 0; i < 6; i++) {
      const a = lerp(a0, a1, i / 5);
      const b = lerp(a0, a1, (i + 1) / 5);
      if (i === 5) break;
      points.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
      points.push(new THREE.Vector3(Math.cos(b) * radius, Math.sin(b) * radius, 0));
    }
  }
  const ring = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, transparent: true, depthTest: false }),
  );
  ring.userData.baseOpacity = opacity;
  ring.renderOrder = LAYER.chrome;
  return ring;
}

/** Four corner brackets — a selection box that never encloses what it selects. */
function selectionBox(w, h, arm = 34, color = ACCENT, opacity = 0.9) {
  const hw = w / 2;
  const hh = h / 2;
  const pts = [];
  const corner = (x, y, sx, sy) => {
    pts.push(new THREE.Vector3(x, y, 0), new THREE.Vector3(x + arm * sx, y, 0));
    pts.push(new THREE.Vector3(x, y, 0), new THREE.Vector3(x, y + arm * sy, 0));
  };
  corner(-hw, hh, 1, -1);
  corner(hw, hh, -1, -1);
  corner(-hw, -hh, 1, 1);
  corner(hw, -hh, -1, 1);
  const box = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: true, depthTest: false }),
  );
  box.userData.baseOpacity = opacity;
  box.renderOrder = LAYER.chrome;
  return box;
}

function filledRect(w, h, color, opacity) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, depthTest: false }),
  );
  mesh.userData.baseOpacity = opacity;
  mesh.renderOrder = LAYER.chrome;
  return mesh;
}

/* ---------------------------------------------------------------------------
   The particle field. One Points object, a custom shader so each particle
   carries its own size and colour, and five keyframed formations it moves
   between. Motion is interpolation between formations, not simulation — a
   simulation would look alive but would never land where the labels say it
   lands.
   --------------------------------------------------------------------------- */

const COUNT = 300;

/* Formation times. A particle reaches formation `k` at KEYS[k], give or take
   its own small stagger, which is what stops the whole field from moving as a
   single rigid object.

   Formations 3 and 4 are the same positions on purpose: interpolating between
   two identical formations is a hold, and without one the field would drift
   straight through the clustered state that scene 4 spends five seconds
   pointing at. */
const KEYS = [0, 4.4, 9.6, 13.0, 17.4, 20.2, 24.6];

function buildParticles() {
  /* A deterministic generator: the composition has to be identical on every
     load, because the labels point at specific clusters. */
  let seed = 20260806;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const forms = [[], [], [], [], [], [], []];
  const colors = new Float32Array(COUNT * 3);
  const sizes = new Float32Array(COUNT);
  const delays = new Float32Array(COUNT);
  const kinds = new Array(COUNT);
  const clusterOf = new Int8Array(COUNT);

  /* Formation 1 is the four group rows inside the input card; the row a
     particle belongs to decides where it goes in every later formation. */
  const rowY = [430, 366, 302, 238];
  const clusterAt = [
    new THREE.Vector2(-235, 150),
    new THREE.Vector2(0, 150),
    new THREE.Vector2(235, 150),
  ];

  for (let i = 0; i < COUNT; i++) {
    const row = i % 4;
    const kind = i % 11 === 0 ? "date" : i % 7 === 0 ? "action" : i % 5 === 0 ? "decision" : "message";
    kinds[i] = kind;
    const cluster = kind === "decision" ? 1 : kind === "action" ? 0 : kind === "date" ? 2 : row % 3;
    clusterOf[i] = cluster;

    const c = CATEGORY[kind];
    colors.set([c.r, c.g, c.b], i * 3);
    sizes[i] = kind === "message" ? 4 + rand() * 3 : 7 + rand() * 4;
    delays[i] = rand() * 0.9;

    // 0 — ambient dust, spread wide behind the title
    forms[0].push(new THREE.Vector3((rand() - 0.5) * 1500, (rand() - 0.5) * 1500, 0));
    // 1 — the input card's rows
    forms[1].push(
      new THREE.Vector3(-300 + rand() * 600, rowY[row] + (rand() - 0.5) * 26, 0),
    );
    // 2 — converged on the processing ring
    {
      const a = (i / COUNT) * Math.PI * 2 + rand() * 0.25;
      const r = 205 + (rand() - 0.5) * 34;
      forms[2].push(new THREE.Vector3(Math.cos(a) * r, 60 + Math.sin(a) * r, 0));
    }
    // 3 and 4 — sorted into three clusters, and held there
    {
      const p = clusterAt[cluster];
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * 80;
      const at = new THREE.Vector3(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 0);
      forms[3].push(at);
      forms[4].push(at.clone());
    }
    // 5 — collapsed into the output card
    forms[5].push(new THREE.Vector3((rand() - 0.5) * 700, 40 + (rand() - 0.5) * 420, 0));
    // 6 — pulled out to the edges as the final card takes over
    forms[6].push(new THREE.Vector3((rand() - 0.5) * 1900, (rand() - 0.5) * 1900, 0));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("alpha", new THREE.BufferAttribute(new Float32Array(COUNT).fill(1), 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uScale: { value: 1 }, // device pixels per stage unit
      uOpacity: { value: 1 },
    },
    vertexShader: `
      attribute float size;
      attribute float alpha;
      varying vec3 vColor;
      varying float vAlpha;
      uniform float uScale;
      void main() {
        vColor = color;
        vAlpha = alpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uScale;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      uniform float uOpacity;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        // A hard-ish core with a wide falloff: reads as a glowing point rather
        // than a blurred blob when hundreds of them overlap.
        float a = smoothstep(0.5, 0.06, d) * 0.55 + smoothstep(0.18, 0.0, d) * 0.75;
        gl_FragColor = vec4(vColor, a * vAlpha * uOpacity);
      }
    `,
    transparent: true,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.userData = { forms, delays, kinds, clusterOf, colors };
  return points;
}

/** Move the field to where time `t` says it should be. */
function updateParticles(points, t) {
  const { forms, delays, clusterOf, colors } = points.userData;
  const position = points.geometry.attributes.position;
  const alpha = points.geometry.attributes.alpha;
  const colorAttr = points.geometry.attributes.color;

  /* The whole field's presence: dust under the title, bright through the
     working scenes, gone by the closing card. */
  points.material.uniforms.uOpacity.value =
    Math.max(win(t, -1, 3.2, 0.6, 0.8) * 0.28, win(t, 3.2, 24.4, 0.7, 1.6));

  for (let i = 0; i < COUNT; i++) {
    const d = delays[i];
    let k = 0;
    while (k < KEYS.length - 2 && t > KEYS[k + 1] + d) k++;
    const from = forms[k][i];
    const to = forms[k + 1][i];
    const p = smooth((t - (KEYS[k] + d)) / (KEYS[k + 1] - KEYS[k]));

    /* A small perpendicular arc so travel curves instead of running along a
       straight line — straight lines between formations look like a chart. */
    const bow = Math.sin(p * Math.PI) * 60 * (i % 2 ? 1 : -1) * (k === 1 || k === 2 ? 1 : 0.25);
    position.setXYZ(
      i,
      lerp(from.x, to.x, p) + bow * 0.4,
      lerp(from.y, to.y, p) + bow,
      0,
    );

    /* Scene 4's verdict: once the answer is selected, its cluster turns the
       brand's success colour and everything else steps back. */
    const picked = clusterOf[i] === 0;
    const win4 = smooth((t - 15.7) / 1.1) * (t < 23 ? 1 : 0);
    if (picked && win4 > 0) {
      colorAttr.setXYZ(
        i,
        lerp(colors[i * 3], CATEGORY.decision.r, win4),
        lerp(colors[i * 3 + 1], CATEGORY.decision.g, win4),
        lerp(colors[i * 3 + 2], CATEGORY.decision.b, win4),
      );
    } else if (t < 15.7) {
      colorAttr.setXYZ(i, colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
    }
    alpha.setX(i, picked ? 1 : 1 - win4 * 0.45);
  }

  position.needsUpdate = true;
  alpha.needsUpdate = true;
  colorAttr.needsUpdate = true;
}

/* ---------------------------------------------------------------------------
   The sequence. Each scene is a group of elements plus one function that says
   what they do at time `t`.
   --------------------------------------------------------------------------- */

function buildSequence() {
  const root = new THREE.Group();
  const steps = [];
  const add = (object, update) => {
    root.add(object);
    steps.push(update);
    return object;
  };

  /* --- Scene 1: hook and title, 0–3s ------------------------------------ */

  const category = makeText("WHATSAPP INTELLIGENCE", { px: 21, mono: true, tracking: 0.34, color: DIM });
  category.position.y = 250;
  add(category, (t) => setOpacity(category, win(t, 0.25, 3.2, 0.6, 0.4)));

  const title = makeText("WALAO", { px: 158, weight: 700, color: "#ffffff", tracking: -0.03 });
  title.position.y = 96;
  add(title, (t) => {
    const a = win(t, 0.5, 3.2, 0.7, 0.4);
    setOpacity(title, a);
    const k = seg(t, 0.5, 1.5);
    title.scale.set(lerp(1.04, 1, k), lerp(1.04, 1, k), 1);
  });

  const titleGlow = makeGlow(540, ACCENT, 0.15);
  titleGlow.position.y = 96;
  add(titleGlow, (t) => setOpacity(titleGlow, win(t, 0.5, 3.2, 1.0, 0.6)));

  /* The scan-line reveal: one bright bar sweeps down through the wordmark
     while it resolves. It is the only element in the sequence that moves
     faster than the eye settles, which is what makes the title feel switched
     on rather than faded in. */
  const scan = filledRect(760, 3, "#ffffff", 0.85);
  scan.renderOrder = LAYER.sweep;
  add(scan, (t) => {
    const k = clamp01((t - 0.35) / 0.85);
    setOpacity(scan, k > 0 && k < 1 ? Math.sin(k * Math.PI) : 0);
    scan.position.y = lerp(200, -10, k);
    scan.scale.x = lerp(0.2, 1, Math.sin(k * Math.PI));
  });

  const hook = makeText("What did your groups decide today?", { px: 31, color: "#b9bdcc" });
  hook.position.y = -30;
  add(hook, (t) => {
    const a = win(t, 1.25, 3.2, 0.6, 0.4);
    setOpacity(hook, a);
    hook.position.y = lerp(-52, -30, seg(t, 1.25, 2.0));
  });

  /* --- Scene 2: what arrives, 3.2–7.4s ---------------------------------- */

  const inputCard = new THREE.Group();
  inputCard.position.y = 330;
  const inputShell = roundedRect(724, 400, 26, "#ffffff", 0.16);
  const inputCore = roundedRect(680, 356, 18, "#ffffff", 0.1);
  const inputLabel = makeText("YOUR GROUPS TODAY", { px: 19, mono: true, tracking: 0.3, color: ACCENT, align: "left" });
  inputLabel.position.set(-300, 145, 0);
  inputCard.add(inputShell, inputCore, inputLabel);

  const rows = [
    "Procurement · 212 messages",
    "Sales MY · 168 messages",
    "Product · 94 messages",
    "Launch · 57 messages",
  ].map((text, i) => {
    const row = makeText(text, { px: 25, mono: true, color: INK, align: "left" });
    row.position.set(-300, 74 - i * 64, 0);
    const dot = filledRect(9, 9, i === 0 ? "#38bdf8" : i === 3 ? "#f5b642" : ACCENT, 0.9);
    dot.position.set(-322, 74 - i * 64, 0);
    inputCard.add(row, dot);
    return { row, dot, i };
  });

  add(inputCard, (t) => {
    const a = win(t, 3.2, 8.4, 0.5, 0.9);
    setOpacity(inputCard, a);
    /* Interface assembly: the shell arrives wide-then-tall, the rows land one
       after another inside it. */
    const k = seg(t, 3.2, 4.1);
    inputShell.scale.set(lerp(0.86, 1, k), lerp(0.55, 1, k), 1);
    inputCore.scale.copy(inputShell.scale);
    for (const { row, dot, i } of rows) {
      const rk = seg(t, 3.7 + i * 0.14, 4.3 + i * 0.14);
      row.material.opacity = a * rk;
      dot.material.opacity = a * rk * 0.9;
      row.position.x = lerp(-324, -300, rk);
    }
    /* Scene 3 pushes it up and away rather than cutting it. */
    const exit = seg(t, 7.2, 8.4);
    inputCard.position.y = lerp(330, 470, exit);
    inputCard.scale.setScalar(lerp(1, 0.92, exit));
  });

  const inputNote = makeText("Only the groups you switch on.", { px: 23, color: DIM });
  inputNote.position.y = 78;
  add(inputNote, (t) => setOpacity(inputNote, win(t, 4.6, 7.3, 0.6, 0.5)));

  /* --- Scene 3 & 4: the processing area, 7.2–17.4s ---------------------- */

  const ringA = segmentedRing(258, 14, 0.55, ACCENT, 0.42);
  const ringB = segmentedRing(300, 5, 0.16, "#ffffff", 0.3);
  const core = new THREE.Group();
  core.position.y = 60;
  core.add(ringA, ringB);
  add(core, (t) => {
    setOpacity(core, win(t, 7.2, 17.6, 0.8, 1.0));
    ringA.rotation.z = t * 0.22;
    ringB.rotation.z = -t * 0.35;
    const k = seg(t, 7.2, 8.6, outBack);
    core.scale.setScalar(lerp(0.8, 1, k));
  });

  /* Scanning pulses — three expanding rings that read as the system looking,
     timed to the scene where it is choosing an answer. */
  const pulses = [0, 1, 2].map(() => segmentedRing(100, 1, 1, ACCENT, 0.4));
  const pulseGroup = new THREE.Group();
  pulseGroup.position.y = 60;
  pulseGroup.add(...pulses);
  add(pulseGroup, (t) => {
    const on = win(t, 12.4, 17.2, 0.6, 0.8);
    setOpacity(pulseGroup, on);
    if (!on) return;
    pulses.forEach((ring, i) => {
      const phase = ((t - 12.4 + i * 0.9) % 2.7) / 2.7;
      ring.scale.setScalar(lerp(0.9, 4.4, phase));
      ring.material.opacity = on * 0.5 * (1 - phase);
    });
  });

  const progressLabel = makeText("ANALYSING", { px: 22, mono: true, tracking: 0.36, color: ACCENT });
  progressLabel.position.y = -300;
  const track = roundedRect(440, 14, 7, "#ffffff", 0.22);
  track.position.y = -340;
  const fill = filledRect(440, 6, ACCENT, 0.95);
  fill.position.y = -340;
  add(progressLabel, (t) => setOpacity(progressLabel, win(t, 7.5, 17.2, 0.6, 0.8)));
  add(track, (t) => setOpacity(track, win(t, 7.5, 17.2, 0.6, 0.8)));
  add(fill, (t) => {
    const a = win(t, 7.7, 17.2, 0.6, 0.8);
    setOpacity(fill, a);
    const k = seg(t, 7.7, 16.6, smooth);
    fill.scale.x = Math.max(0.001, k);
    fill.position.x = -220 + 220 * k; // grow from the left edge of the track
  });

  /* The three system actions. They occupy the same line, one at a time, so
     the eye never has to choose which to read. */
  const stepsCopy = [
    ["READING ONLY ENABLED GROUPS", 8.0, 12.3],
    ["GROUPING DECISIONS AND ACTIONS", 12.5, 14.6],
    ["LINKING EVERY CLAIM TO ITS SOURCE", 14.7, 17.2],
  ];
  for (const [text, a, b] of stepsCopy) {
    const step = makeText(text, { px: 20, mono: true, tracking: 0.22, color: INK });
    step.position.y = -400;
    add(step, (t) => {
      const o = win(t, a, b, 0.4, 0.4);
      setOpacity(step, o);
      step.position.y = lerp(-414, -400, seg(t, a, a + 0.5));
    });
  }

  /* The customer's own question, floating in as the thing being answered. */
  const bubble = new THREE.Group();
  bubble.position.set(0, 470, 0);
  const bubbleShell = roundedRect(660, 92, 30, "#ffffff", 0.2);
  const bubbleText = makeText("What did procurement decide yesterday?", { px: 24, mono: true, color: INK });
  bubble.add(bubbleShell, bubbleText);
  add(bubble, (t) => {
    const a = win(t, 13.0, 17.2, 0.55, 0.7);
    setOpacity(bubble, a);
    bubble.position.y = lerp(500, 470, seg(t, 13.0, 13.9)) + Math.sin(t * 1.1) * 5;
  });

  /* The line from the question to the cluster that answers it. */
  const linkGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 424, 0),
    new THREE.Vector3(-160, 300, 0),
    new THREE.Vector3(-235, 250, 0),
  ]);
  const link = new THREE.Line(
    linkGeometry,
    new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, depthTest: false }),
  );
  link.userData.baseOpacity = 0.55;
  link.renderOrder = LAYER.chrome;
  add(link, (t) => setOpacity(link, win(t, 14.4, 17.2, 0.7, 0.7)));

  const pick = selectionBox(224, 224, 34, ACCENT, 0.95);
  pick.position.set(-235, 150, 0);
  add(pick, (t) => {
    const a = win(t, 15.2, 17.4, 0.4, 0.6);
    setOpacity(pick, a);
    pick.scale.setScalar(lerp(1.25, 1, seg(t, 15.2, 15.9, outBack)));
  });

  const pickGlow = makeGlow(360, ACCENT, 0.13);
  pickGlow.position.set(-235, 150, 0);
  add(pickGlow, (t) => setOpacity(pickGlow, win(t, 15.7, 17.4, 0.9, 0.7)));

  /* --- Scene 5: the result, 17.2–22.4s ---------------------------------- */

  const brief = new THREE.Group();
  brief.position.y = 40;
  const briefShell = roundedRect(804, 580, 34, "#ffffff", 0.18);
  const briefCore = roundedRect(756, 532, 26, ACCENT, 0.24);
  const briefGlow = makeGlow(1000, ACCENT, 0.13);
  const briefLabel = makeText("TODAY BRIEF", { px: 19, mono: true, tracking: 0.34, color: ACCENT });
  briefLabel.position.y = 200;
  const briefResult = makeText("5 things worth your time today", { px: 37, weight: 600, color: INK });
  briefResult.position.y = 120;
  const briefRule = filledRect(672, 1, "#ffffff", 0.18);
  briefRule.position.y = 66;
  brief.add(briefGlow, briefShell, briefCore, briefLabel, briefResult, briefRule);

  const benefits = [
    "Every claim linked to its message",
    "Nothing you did not switch on",
    "One minute, not one hour",
  ].map((text, i) => {
    const line = makeText(text, { px: 25, color: "#cfd3de", align: "left" });
    line.position.set(-300, -10 - i * 62, 0);
    const dot = filledRect(10, 10, ACCENT, 1);
    dot.position.set(-326, -10 - i * 62, 0);
    brief.add(line, dot);
    return { line, dot, i };
  });

  add(brief, (t) => {
    const a = win(t, 17.4, 22.6, 0.6, 0.8);
    setOpacity(brief, a);
    const k = seg(t, 17.4, 18.4, outBack);
    brief.scale.setScalar(lerp(0.92, 1, k));
    briefCore.material.opacity = a * (0.24 + Math.sin(Math.max(0, t - 18.6) * 2.2) * 0.06);
    for (const { line, dot, i } of benefits) {
      const bk = seg(t, 19.0 + i * 0.28, 19.7 + i * 0.28);
      line.material.opacity = a * bk;
      dot.material.opacity = a * bk;
      line.position.x = lerp(-318, -300, bk);
    }
  });

  /* The confirmation sweep: one ring closing on the card, once. */
  const confirm = segmentedRing(420, 1, 1, ACCENT, 0.7);
  confirm.position.y = 40;
  add(confirm, (t) => {
    const k = clamp01((t - 18.3) / 1.0);
    setOpacity(confirm, k > 0 && k < 1 ? Math.sin(k * Math.PI) * 0.7 : 0);
    confirm.scale.setScalar(lerp(2.0, 1.05, outCubic(k)));
  });

  /* --- Scene 6: the offer, 22.4–27s ------------------------------------- */

  const closing = new THREE.Group();
  const closingShell = roundedRect(772, 470, 34, "#ffffff", 0.18);
  const closingCore = roundedRect(724, 422, 26, "#ffffff", 0.08);
  const closingGlow = makeGlow(1100, ACCENT, 0.11);
  const promise = makeText("Understand every group in one minute.", { px: 34, weight: 600, color: INK });
  promise.position.y = 118;
  const trust = makeText("Off by default. You choose the groups.", { px: 24, color: DIM });
  trust.position.y = 56;
  const ctaShell = roundedRect(300, 74, 37, ACCENT, 0.9);
  ctaShell.position.y = -50;
  const ctaGlow = makeGlow(420, ACCENT, 0.28);
  ctaGlow.position.y = -50;
  const cta = makeText("TRY IT FREE", { px: 22, mono: true, tracking: 0.28, color: ACCENT });
  cta.position.y = -50;
  const brand = makeText("walao.app", { px: 26, mono: true, tracking: 0.12, color: INK });
  brand.position.y = -158;
  closing.add(closingGlow, closingShell, closingCore, promise, trust, ctaGlow, ctaShell, cta, brand);

  add(closing, (t) => {
    const a = win(t, 22.4, 26.4, 0.7, 0.9);
    setOpacity(closing, a);
    const k = seg(t, 22.4, 23.4, outBack);
    closing.scale.setScalar(lerp(0.94, 1, k));
    const pulse = 0.9 + Math.sin(Math.max(0, t - 23.4) * 2.6) * 0.1;
    ctaShell.material.opacity = a * pulse;
    ctaGlow.material.opacity = a * 0.28 * pulse;
  });

  /* The fade to black is a plane rather than a renderer clear, so it dims the
     grain and vignette with everything else. */
  const blackout = filledRect(4000, 4000, "#000000", 1);
  blackout.position.z = 6;
  blackout.renderOrder = LAYER.blackout;
  add(blackout, (t) => setOpacity(blackout, Math.max(smooth((t - 26.0) / 0.9), smooth((0.35 - t) / 0.35))));

  return { root, update: (t) => steps.forEach((fn) => fn(t)) };
}

/* ---------------------------------------------------------------------------
   Grain and vignette. Both are full-screen planes rather than a post-processing
   pass: EffectComposer would mean vendoring another four files for two effects
   that are ten lines of GLSL.
   --------------------------------------------------------------------------- */

function buildFilm() {
  const grain = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying vec2 vUv;
        uniform float uTime;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main() {
          float n = hash(vUv * 900.0 + fract(uTime) * 100.0);
          gl_FragColor = vec4(vec3(n) * 0.055, 1.0);
        }
      `,
      transparent: true,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  grain.position.z = 5;
  grain.renderOrder = 10;

  /* The vignette is a texture rather than a shader because a radial gradient
     is exactly what a 2D canvas is for. */
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(128, 128, 40, 128, 128, 150);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(0.62, "rgba(0,0,0,0.28)");
  g.addColorStop(1, "rgba(0,0,0,0.86)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const vignette = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(c),
      transparent: true,
      depthTest: false,
    }),
  );
  vignette.position.z = 4;
  vignette.renderOrder = 9;

  return { grain, vignette };
}

/* Where the camera looks, per scene: the y it centres on and how tight it sits.
   Between two entries it interpolates, which is the whole of the sequence's
   camera work — there is no path, no dolly rig, just six framings and smoothing
   between them. */
const FOCUS = [
  [0, 90, 1.12], // title
  [3.6, 300, 1.14], // the input card, high in the frame
  [7.8, -30, 1.12], // the processing area, from the ring down to the steps
  [12.6, 40, 1.06], // widest: the question, the clusters and the steps at once
  [17.8, 40, 1.12], // the brief
  [22.6, 0, 1.18], // the closing card
];

function focus(t) {
  let i = 0;
  while (i < FOCUS.length - 1 && t > FOCUS[i + 1][0]) i++;
  const [t0, y0, z0] = FOCUS[i];
  const next = FOCUS[i + 1];
  if (!next) return [y0, z0];
  /* Hold the framing, then move into the next one over the 1.3s that ends
     exactly when the next scene starts — the camera arrives with the content
     rather than leading it out of the previous scene. */
  const move = Math.min(1.3, next[0] - t0);
  const k = smooth((t - (next[0] - move)) / move);
  return [lerp(y0, next[1], k), lerp(z0, next[2], k)];
}

/* ---------------------------------------------------------------------------
   Mount.
   --------------------------------------------------------------------------- */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ fps?: number, fixed?: {width:number,height:number}, at?: number }} [options]
 *   `fps` caps the render rate — /how locks to 30 so a screen recording lands
 *   on whole frames. `fixed` renders at an exact pixel size instead of the
 *   element's, which is how the 1080x1920 export frame stays 1080x1920 on a
 *   laptop that cannot show it at full size. `at` renders one frame at that
 *   second and stops, which is how a scene gets looked at without waiting for
 *   it to come round.
 * @returns {{ destroy: () => void } | null} null when WebGL is unavailable.
 */
export function mountExplainer(canvas, options = {}) {
  const { fps = 0, fixed = null, at = null } = options;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "low-power" });
  } catch {
    return null; // no WebGL — the caller shows the written storyboard instead
  }

  renderer.setClearColor(0x050505, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
  const sequence = buildSequence();
  const particles = buildParticles();
  const film = buildFilm();

  const ambientGlow = makeGlow(1300, ACCENT, 0.02);
  ambientGlow.position.set(-330, 560, -1);
  scene.add(ambientGlow, particles, sequence.root, film.vignette, film.grain);

  let viewW = CORE_W;
  let viewH = CORE_H;

  /* Measure the frame, not the canvas. `setSize` with updateStyle writes an
     inline width/height onto the canvas, which then outranks the stylesheet's
     100% — the canvas stops following its frame and the two drift apart. So the
     buffer is sized here and the box stays entirely CSS's business. */
  const host = canvas.parentElement ?? canvas;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, fixed ? 1 : 2);
    const width = fixed ? fixed.width : Math.max(1, host.clientWidth);
    const height = fixed ? fixed.height : Math.max(1, host.clientHeight);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);

    /* Contain the core box: whichever axis is tight decides the scale, and the
       other simply shows more ground. */
    const aspect = width / height;
    viewH = Math.max(CORE_H, CORE_W / aspect);
    viewW = viewH * aspect;
    camera.left = -viewW / 2;
    camera.right = viewW / 2;
    camera.top = viewH / 2;
    camera.bottom = -viewH / 2;
    camera.updateProjectionMatrix();

    particles.material.uniforms.uScale.value = (height * dpr) / viewH;
    for (const plane of [film.grain, film.vignette]) plane.scale.set(viewW, viewH, 1);
  }

  const observer = new ResizeObserver(resize);
  if (!fixed) observer.observe(host);
  resize();

  function draw(t) {
    sequence.update(t);
    updateParticles(particles, t);
    film.grain.material.uniforms.uTime.value = t;

    /* The camera frames the scene that is currently talking, then drifts. A
       9:16 frame is much taller than any one scene needs, so without this the
       picture sits in the upper third of it with dead space underneath. */
    const [focusY, focusZoom] = focus(t);
    camera.position.x = Math.sin(t * 0.18) * 22;
    camera.position.y = focusY + Math.cos(t * 0.13) * 16;
    camera.zoom = focusZoom + Math.sin(t * 0.21) * 0.012;
    camera.updateProjectionMatrix();
    film.grain.position.set(camera.position.x, camera.position.y, 5);
    film.vignette.position.set(camera.position.x, camera.position.y, 4);

    renderer.render(scene, camera);
  }

  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduced || at !== null) {
    /* One frame, held. Reduced motion gets the result card, the single most
       explanatory moment in the sequence; `at` gets whatever was asked for. */
    draw(at ?? 20.2);
    return {
      destroy() {
        observer.disconnect();
        renderer.dispose();
      },
    };
  }

  let raf = 0;
  let clock = 0; // seconds into the sequence
  let previous = 0;
  let onScreen = true;
  let running = true;
  const interval = fps > 0 ? 1000 / fps : 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!running) {
      previous = now;
      return;
    }
    const delta = now - previous;
    // Under an fps lock, skipped frames keep their time — `previous` only moves
    // when something is actually drawn, so 30fps stays 30fps rather than 30-ish.
    if (interval && delta < interval - 1) return;
    previous = now;
    /* A tab that was backgrounded returns with a huge delta; clamping it means
       the sequence resumes where it paused instead of teleporting mid-scene. */
    clock = (clock + Math.min(delta, 250) / 1000) % DURATION;
    draw(clock);
  }
  previous = performance.now();
  raf = requestAnimationFrame(frame);

  /* Off-screen means no work. A marketing page that keeps a WebGL loop warm
     three sections above the fold is a battery complaint waiting to happen. */
  const visibility = new IntersectionObserver(
    ([entry]) => {
      onScreen = entry.isIntersecting;
      running = onScreen && !document.hidden;
    },
    { threshold: 0.01 },
  );
  visibility.observe(canvas);

  const onVisibility = () => {
    running = onScreen && !document.hidden;
  };
  document.addEventListener("visibilitychange", onVisibility);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      visibility.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      renderer.dispose();
    },
  };
}
