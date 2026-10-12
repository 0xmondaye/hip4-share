"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { takePrebuiltPack, type PackController } from "./packModel";

// ─────────────────────────────────────────────────────────────────────────────
// PackRip — the pack-tear stage. Web port of nextrare-app's
// components/rippack/RipPackView.tsx (origin/testnet): three.js pack on a
// <canvas>, drag the grip tab left→right to peel, commit → rip → fly-off, then
// onOpened() fires once.
//
// Replaces the old hand-rolled PackTear (raw WebGL, ported from the Kira /rip
// demo). All glow/shake/cascade behaviour now lives in packModel.ts, which
// renders Slabz's own pack GLB + per-pack face art.
//
// Platform swaps vs the RN original:
//   • expo-gl GLView          → <canvas> + THREE.WebGLRenderer
//   • RNGH pan + Reanimated   → pointer events + a rAF spring-back
//   • expo-sensors accel tilt → pointer position over the stage (what
//                               packs-replica, the web original, uses)
// ponytail: no audio (hip4 has no sound layer). The mp3s exist in the iOS repo
//   at assets/rippack/audio — wire them here if/when hip4 grows one.
// ponytail: no DeviceOrientation tilt on mobile web; pointer tilt + the model's
//   idle sway cover it. Add it (with the iOS permission prompt) if a resting
//   phone needs to move the pack.
// ─────────────────────────────────────────────────────────────────────────────

// ── Framing (from RipPackView) ───────────────────────────────────────────────
// Pack art aspect (assets/rippack/pack-carousel.json) + the app's breathing-room
// scale, so the pack lands at the same relative size the native app shows.
const PACK_ASPECT = 1.5794;
const PACK_RENDER_SCALE = 0.9;
// Near-full-bleed pack.
const RIP_PACK_BOOST = 1.4;
// Portrait framing, expressed as the stage's chrome instead of as viewport
// fractions. The old pair (cap 0.48 of the viewport, centre 0.47) was measured
// once at 375x812 and had drifted: the pack came out 497px tall on an 812px
// screen with its centre 43px BELOW the free band, so its bottom third sat
// behind the buy cluster and "See what's inside" landed on the foil. Naming
// the two chrome edges instead makes "centred" mean centred in the gap the
// user can actually see, at any height.
// PORTRAIT_CHROME_BOTTOM is only the fallback for the frames before the buy
// cluster has been measured: the cluster's real height swings ~80px between
// signed-out and signed-in (and again with the card rail), so a single constant
// centres one of them and leaves the other off. page.tsx measures it and passes
// `bottomInset`.
const PORTRAIT_CHROME_TOP = 64; // app header — the stage starts at top-16
const PORTRAIT_CHROME_BOTTOM = 296;
// Share of the free band the pack takes. Well under 1 so the pack reads as an
// object standing on a stage rather than a wall of foil — at 0.86 it still
// filled 57% of an 812px screen and crowded the tier pills — and so the tear
// has somewhere to open into.
const PORTRAIT_BAND_FILL = 0.78;
// Pack world bbox Y = -0.205..0.2124 × group scale 8 (see packModel).
const PACK_WORLD_H = 0.4174 * 8;
const PACK_WORLD_CY = ((0.2124 - 0.205) / 2) * 8;
const TEAR_LINE_WORLD_Y = 0.185 * 8; // glow strip / grip tab row
const TAB_TRACK_WORLD = 0.2 * 8; // the grip tab's world travel
const TEAR_BAND_HALF = 60; // px — vertical grab band around the tear line
const TAB_GRAB_HALF = 44; // px — horizontal grab zone around the tab
const FOV = 45;
const SPRINGBACK_MS = 350;

type Framing = {
  camY: number;
  camZ: number;
  tearY: number;
  tabRestX: number;
  threshold: number;
};

/** Camera distance + the screen-space projections the grab zones need.
 *  ONE framing for both call sites. The idle stage and the rip theater are the
 *  same full-viewport box, so the pack does not move or resize by a pixel when
 *  the tear opens — the theater just adds the grip tab and the glow. */
function framingFor(
  w: number,
  h: number,
  chromeBottom = PORTRAIT_CHROME_BOTTOM,
): Framing {
  // Portrait used to sit the pack LOW (0.72) and fill half the screen, so its
  // bottom bled away — right for a full-screen tear with nothing under it,
  // wrong now that the same framing also draws the idle stage, where the rail
  // sits above the pack and the controls below it. Both stages share this, so
  // the pack still doesn't move or resize when the tear opens.
  const portrait = !(w >= 768 && w > h);
  // Portrait fits the pack to the band between the header and the buy cluster
  // and centres it there. Landscape/desktop keeps the near-full-bleed framing —
  // its chrome is a side rail, not a bar above and below the pack.
  const bandTop = PORTRAIT_CHROME_TOP;
  // The floor keeps a very short viewport (landscape phone held portrait-ish,
  // a split-screen pane) from computing a negative or zero band.
  const bandBottom = Math.max(bandTop + 160, h - chromeBottom);
  const heroH = portrait
    ? Math.min(
        w * PACK_ASPECT * PACK_RENDER_SCALE,
        (bandBottom - bandTop) * PORTRAIT_BAND_FILL,
      )
    : Math.min(w * PACK_ASPECT, h * 0.5) * PACK_RENDER_SCALE * RIP_PACK_BOOST;
  const centerY = portrait ? (bandTop + bandBottom) / 2 / h : 0.5;
  // World units spanning the viewport height, then the camera distance that shows exactly that.
  const visibleH = PACK_WORLD_H / (heroH / h);
  // Uniform world→px scale, so the same factor projects x and y offsets.
  const pxPerWorld = heroH / PACK_WORLD_H;
  return {
    camY: PACK_WORLD_CY + (centerY - 0.5) * visibleH,
    camZ: visibleH / (2 * Math.tan((FOV * Math.PI) / 360)),
    tearY: h * centerY - pxPerWorld * (TEAR_LINE_WORLD_Y - PACK_WORLD_CY),
    // Tab rest x = model -0.1 × group scale 8, pack centered.
    tabRestX: w / 2 - pxPerWorld * (0.1 * 8),
    // 1:1 finger↔tab: commit needs exactly the tab's own projected travel.
    threshold: pxPerWorld * TAB_TRACK_WORLD,
  };
}

export function PackRip({
  active,
  onOpened,
  count = 1,
  ccPackType,
  bottomInset,
}: {
  active: boolean;
  onOpened?: () => void;
  /** Packs in the pull — >1 plays the staggered rip→fly-off cascade. */
  count?: number;
  /** Slabz pack type ("pokemon_25") — wears that pack's real face art when set;
   *  must match what page.tsx prebuilt. */
  ccPackType?: string | null;
  /** Measured height of the stage's buy cluster, in px. The pack centres in the
   *  band above it. BOTH call sites must pass the same value — the idle stage
   *  and the rip theater are separate instances of this component, and the pack
   *  must not move or resize by a pixel when the tear opens. */
  bottomInset?: number;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [started, setStarted] = useState(false);
  const [frame, setFrame] = useState<Framing | null>(null);

  // Read by the rAF loop; refs so a frame never re-renders React.
  const tear = useRef(0); // ratcheted peel 0..1 → glow wipe
  const drag = useRef(0); // live pointer 0..1 → grip tab
  const popping = useRef(false);
  const committed = useRef(false);
  const dragging = useRef(false);
  const startX = useRef(0);
  const springRaf = useRef(0);
  const tiltX = useRef(0);
  const tiltY = useRef(0);
  const activeRef = useRef(active);
  const framingRef = useRef<Framing | null>(null);
  const openedRef = useRef(false);
  const onOpenedRef = useRef(onOpened);
  const insetRef = useRef(bottomInset);
  // The GL scene mounts once, so the framing lives inside that effect. This is
  // the handle back into it for a re-frame that isn't a resize.
  const reframeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    insetRef.current = bottomInset;
    reframeRef.current?.();
  }, [bottomInset]);
  useEffect(() => {
    onOpenedRef.current = onOpened;
  }, [onOpened]);

  const commitPop = useCallback(() => {
    if (committed.current) return;
    committed.current = true;
    dragging.current = false;
    cancelAnimationFrame(springRaf.current);
    tear.current = 1;
    drag.current = 1;
    popping.current = true;
    setStarted(true);
  }, []);

  // ── GL scene + render loop (mount-once; the pack is disposed on unmount) ───
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    // The canvas is created HERE, not in JSX, and removed on cleanup — so every
    // effect run gets a brand-new element. A React-owned canvas would be reused
    // across runs, and getContext() on a canvas whose context we just
    // force-lost hands the DEAD context straight back: three then reads
    // getShaderPrecisionFormat() === null and throws inside WebGLCapabilities.
    // StrictMode's mount->cleanup->mount made that crash every dev mount.
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 h-full w-full";
    stage.appendChild(canvas);

    // A full-bleed morph-target mesh at DPR 2 WITH MSAA is what makes the tear
    // hitch on mid-range phones — it's pure fill rate, and the peel drives
    // morph targets every frame on top of it. A high-DPR screen already reads
    // smooth without multisampling, so spend the budget on resolution and drop
    // the samples; only DPR-1 displays actually need MSAA to hide the stair-step.
    // ponytail: the idle ground stage (mounted with active=false) caps DPR at
    // 1.5 — 44% less fill for a decorative float; the theater keeps full res
    // for the tear. Separate instances, so no mid-flow buffer realloc.
    const dpr = Math.min(window.devicePixelRatio || 1, activeRef.current ? 2 : 1.5);
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: (window.devicePixelRatio || 1) < 2,
      alpha: true,
    });
    renderer.setPixelRatio(dpr);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 1);

    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const d1 = new THREE.DirectionalLight(0xffffff, 0.6);
    d1.position.set(2, 2, 2);
    scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.5);
    d2.position.set(-1, 0.5, 1);
    scene.add(d2);
    // Face-on key: the HDRI's bright sky sits high, so an UPRIGHT pack reflects
    // the dark horizon and reads dim until tilted back (cursor near the top).
    // A camera-axis light bounces its specular straight back off the flat foil
    // at rest, and naturally fades as the pack tilts and the env takes over.
    const front = new THREE.DirectionalLight(0xffffff, 1.2);
    front.position.set(0, 0.5, 6);
    scene.add(front);
    // Wing keys: a yawed pack mirrors light at ~2× its yaw (max ±30°), so the
    // camera-axis key slides off one side and that half of the foil goes dead.
    // Low lights at ~±55° catch the turned-away half at pack height.
    const wingR = new THREE.DirectionalLight(0xffffff, 0.7);
    wingR.position.set(4, 0.5, 3);
    scene.add(wingR);
    const wingL = new THREE.DirectionalLight(0xffffff, 0.7);
    wingL.position.set(-4, 0.5, 3);
    scene.add(wingL);

    // setSize() reallocates the drawing buffer, which is a visible hitch mid-tear.
    // ResizeObserver fires on things that aren't real size changes (mobile URL-bar
    // chrome settling, a duplicate initial callback), so ignore a box that didn't
    // actually move.
    let lastW = 0;
    let lastH = 0;
    let lastInset: number | undefined = -1;
    const resize = () => {
      const w = stage.clientWidth || window.innerWidth;
      const h = stage.clientHeight || window.innerHeight;
      const inset = insetRef.current;
      if (w === lastW && h === lastH && inset === lastInset) return;
      // The cluster changing height re-frames the camera but must NOT touch the
      // drawing buffer — setSize() reallocates it, the hitch this guard exists
      // to avoid.
      const resized = w !== lastW || h !== lastH;
      lastW = w;
      lastH = h;
      lastInset = inset;
      const f = framingFor(w, h, inset);
      framingRef.current = f;
      setFrame(f);
      if (resized) {
        renderer.setSize(w, h, false);
        cam.aspect = w / h;
      }
      cam.position.set(0, f.camY, f.camZ);
      cam.lookAt(0, f.camY, 0);
      cam.updateProjectionMatrix();
    };
    reframeRef.current = resize;
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(stage);

    let pack: PackController | null = null;
    let raf = 0;
    let disposed = false;
    const clock = new THREE.Timer();

    // ponytail: the idle stage (active=false) is decoration — cap it at 60fps
    // (halves GPU on ProMotion), and 30fps while the window is unfocused (page
    // open beside other work — the case that cooks laptops). Anything lower
    // reads as jank. The live theater keeps full rate for the drag.
    let lastT = 0;
    const render = (t: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(render);
      if (
        !activeRef.current &&
        !popping.current &&
        t - lastT < (document.hasFocus() ? 16 : 33)
      )
        return;
      lastT = t;
      // Timer needs an explicit update; only ticked on rendered frames so the
      // delta spans any throttled ones, like Clock.getDelta() did.
      clock.update(t);
      const delta = Math.min(clock.getDelta(), 0.05);
      if (pack) {
        pack.update(delta, {
          progress: tear.current,
          drag: drag.current,
          popping: popping.current,
          active: activeRef.current,
          // Tilt is released once the rip commits — the tear plays face-on.
          pointerX: committed.current ? 0 : tiltX.current,
          pointerY: committed.current ? 0 : tiltY.current,
        });
        if (pack.popDone() && !openedRef.current) {
          openedRef.current = true;
          onOpenedRef.current?.();
        }
      }
      renderer.render(scene, cam);
    };

    // Reflections for the metallic foil — metal shows nothing without an
    // environment. Poly Haven "resting_place" (CC0), vendored in public/hdri;
    // if the HDR fails to load, fall back to the studio RoomEnvironment.
    // Note: PMREM hands back a render target's texture, and .dispose() on one
    // of those is a no-op — the cleanup's forceContextLoss() is what actually
    // reclaims it, so don't rely on the pack's own dispose here.
    const envPromise = new HDRLoader()
      .loadAsync("/hdri/resting_place_1k.hdr")
      .catch(() => null);

    Promise.all([takePrebuiltPack(ccPackType), envPromise])
      .then(([p, hdr]) => {
        if (disposed) {
          p.dispose();
          hdr?.dispose();
          return;
        }
        pack = p;
        p.setCount(count);
        const pmrem = new THREE.PMREMGenerator(renderer);
        if (hdr) {
          hdr.mapping = THREE.EquirectangularReflectionMapping;
          p.setEnvMap(pmrem.fromEquirectangular(hdr).texture);
          hdr.dispose(); // PMREM'd — the equirect source is scaffolding
        } else {
          const room = new RoomEnvironment();
          p.setEnvMap(pmrem.fromScene(room, 0.04).texture);
          // scaffolding for the one-off bake — the room's own geometries/
          // materials leak unless disposed (three's own instruction)
          room.dispose();
        }
        pmrem.dispose();
        scene.add(p.group);
      })
      .catch((e: unknown) => {
        console.warn("[packrip] pack load failed:", e);
        if (disposed) return;
        setFailed(true);
        // The rip is decoration; the card behind it is what the user paid for.
        // onOpened only ever fires from the render loop's `if (pack)` branch, and
        // the theater is a fixed inset-0 overlay with no close affordance — so
        // without this a failed asset load strands a PAID pull until a reload.
        // Advance the flow instead of holding the card hostage to an animation.
        if (!openedRef.current) {
          openedRef.current = true;
          onOpenedRef.current?.();
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    raf = requestAnimationFrame(render);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(springRaf.current);
      ro.disconnect();
      pack?.dispose();
      renderer.dispose();
      // dispose() only drops three's caches + canvas listeners — the GPU context
      // itself stays alive, and browsers cap concurrent contexts (~16, oldest
      // evicted first). One context leaked per pull silently killed UrFlare's
      // context over in the Reveal (its createShader started returning null).
      // Same call the old PackTear made on unmount. Must follow dispose(), which
      // removes three's own webglcontextlost handler.
      renderer.forceContextLoss();
      // Drop the element too: its context is now dead, and nothing may reuse it.
      canvas.remove();
    };
    // Mount-once: re-running this would rebuild the whole GL scene mid-rip.
    // `count` and `ccPackType` are read when the pack resolves — the pull size and the
    // pack's category are both known before the theater mounts, so neither
    // changes under a live rip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Peel gesture: rightward drag from the grip tab ────────────────────────
  // The grab zone is only the tab (~88px) but the peel travels ~217px, so the
  // pointer leaves it almost immediately. Track on the window for the duration
  // of the drag — the web equivalent of RNGH's "once the pan activates, it keeps
  // tracking outside the view". Pointer capture alone is too fragile here.
  const onDown = (e: React.PointerEvent) => {
    if (!activeRef.current || committed.current) return;
    cancelAnimationFrame(springRaf.current);
    dragging.current = true;
    startX.current = e.clientX;
    setStarted(true);

    const move = (ev: PointerEvent) => {
      if (!dragging.current) return;
      const threshold = framingRef.current?.threshold ?? 1;
      // Rightward only (no abs — the tab pulls left→right). Tear and tab BOTH
      // track the live pointer, so backing up rewinds the peel.
      const p = Math.min(1, Math.max(0, (ev.clientX - startX.current) / threshold));
      drag.current = p;
      tear.current = p;
      if (p >= 1) {
        end();
        commitPop();
      }
    };
    const up = () => {
      end();
      if (committed.current || !dragging.current) return;
      dragging.current = false;
      setStarted(false);
      // Spring back to 0 over 350ms (outQuad).
      const from = drag.current;
      const t0 = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / SPRINGBACK_MS);
        const eased = k * (2 - k);
        drag.current = from * (1 - eased);
        tear.current = drag.current;
        if (k < 1) springRaf.current = requestAnimationFrame(step);
      };
      springRaf.current = requestAnimationFrame(step);
    };
    function end() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // Pointer position over the stage → pack tilt (-1..1), r3f `state.pointer`
  // equivalent. Touch only reports while a finger is down; the model's idle
  // sway carries the resting pack.
  const onStageMove = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    tiltX.current = ((e.clientX - r.left) / r.width) * 2 - 1;
    tiltY.current = -(((e.clientY - r.top) / r.height) * 2 - 1);
  };
  const onStageLeave = () => {
    tiltX.current = 0;
    tiltY.current = 0;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    commitPop();
  };

  return (
    <div
      ref={stageRef}
      className="relative h-full w-full overflow-hidden"
      onPointerMove={onStageMove}
      onPointerLeave={onStageLeave}
    >
      {/* the <canvas> is appended here by the effect — see the note there */}

      {loading && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          role="status"
          aria-label="Loading pack"
        >
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/25 border-t-white" />
        </div>
      )}

      {failed && (
        <p className="absolute inset-x-0 top-1/2 text-center text-sm text-white/60">
          Couldn&apos;t load the pack.
        </p>
      )}

      {/* Grab zone — a band around the tear line, narrowed to the grip tab, so
          the peel can only be STARTED from the tab itself. Owns pointer +
          keyboard. */}
      {active && !loading && frame && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Drag right or press Enter to tear open the pack"
          className="absolute outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          style={{
            top: frame.tearY - TEAR_BAND_HALF,
            height: TEAR_BAND_HALF * 2,
            left: frame.tabRestX - TAB_GRAB_HALF,
            width: TAB_GRAB_HALF * 2,
            touchAction: "none",
            cursor: "grab",
            WebkitTapHighlightColor: "transparent",
          }}
          onPointerDown={onDown}
          onKeyDown={onKeyDown}
        />
      )}

      {/* Swipe affordance — cursor hand riding the grip tab; hides once engaged. */}
      {active && !started && !loading && frame && (
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={{ top: frame.tearY, left: frame.tabRestX }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/gacha/cursor-hand.svg"
            alt=""
            draggable={false}
            className="w-12 drop-shadow-[0_4px_12px_rgba(0,0,0,0.6)]"
            style={{ animation: "packRipHintSlide 1.6s ease-in-out infinite" }}
          />
          <style>{`@keyframes packRipHintSlide { 0%, 100% { transform: translateX(-6px); opacity: 0.65 } 50% { transform: translateX(22px); opacity: 1 } }
@media (prefers-reduced-motion: reduce){ [style*="packRipHintSlide"]{ animation: none } }`}</style>
        </div>
      )}

      {/* Accessible tap-to-open fallback. */}
      {active && !started && !loading && (
        <button
          type="button"
          onClick={commitPop}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 text-xs text-white/45 underline-offset-2 hover:text-white/80 hover:underline"
        >
          or tap to open
        </button>
      )}
    </div>
  );
}

export default PackRip;
