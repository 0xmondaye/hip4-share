// The 3D pack: a crinkled-foil mesh wearing OUR print, plus our rip theater.
//
// Art is ours end to end. Slabz's per-pack webps used to backstop the texture
// chain, so any family without a house file wore a Slabz-branded pack — and
// under that sat the GLB's own embedded print, also theirs. loadArt now ends at
// a house default (see DEFAULT_PRINT), so neither is ever reached and no
// Slabz artwork renders.
//
// The mesh itself is still fetched from their CDN:
//   /packs/glb/skeleton.glb   crinkled mylar mesh, metallic PBR, wrinkle
//                             normal map, specular boost
// through the /pack-mesh rewrite (their CDN sends no CORS headers, so it
// must arrive same-origin). Geometry only — every pixel on it is ours. Replace
// it with our own model to cut the last tie. The shine is the GLB's authored
// materials reacting to the environment map PackRip supplies via setEnvMap —
// nothing here fakes it.
//
// The tear is procedural (the retired pack-wide.glb carried 126 authored tear
// morphs; Slabz's mesh carries none): every pack gets a "tear rig" — each
// primitive is drawn twice from the SAME geometry, a body copy and a strip
// copy, with shaders injected via onBeforeCompile. A jagged tear line crosses
// the pack just under the crimp; a tear FRONT (uniform) sweeps left→right with
// the drag. Fragments above the line and behind the front are discarded from
// the body and kept on the strip, whose vertices curl up and flutter behind
// the front — so the crimp strip visibly peels off the pouch, with a hot foil
// rim glowing along the torn boundary. On commit the front sweeps home and the
// freed strip flies off; the cascade builds a rig per pack so every auto-rip
// tears the same way. Idle float, tilt, flip, the grip tab, the glow sprite
// and the multi-pack conveyor are unchanged from the old model.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";

const BASE = "/rippack";
const MESH = "/pack-mesh"; // → slabz.com/packs/glb, geometry only (next.config rewrite)
// Every pack's print until we have per-family art. ponytail: one constant, not
// a config — when the second house print exists it becomes a <family>_ file and
// this stops being reached.
const DEFAULT_PRINT = "pokemon";
const GLB = `${MESH}/skeleton.glb`;
const GLOW = `${BASE}/opening-small.png`;
const GLOW_MASK = `${BASE}/open-mask.png`;
const TAB = `${BASE}/tab-spade.png`;

// Normalised pack size — PackRip's framing math (PACK_WORLD_H, tear-line y,
// grab zones) was derived from the old model's bbox, so the Slabz mesh is
// scaled/centred to occupy exactly the same world box.
const PACK_H = 0.4174;
const PACK_CY = (0.2124 - 0.205) / 2;

export type TearParams = {
  progress: number; // tear 0..1 (ratcheted — drives the glow wipe)
  drag?: number; // LIVE finger 0..1 (un-ratcheted) — the grip tab follows this
  popping: boolean; // committed -> shake, then the fly-off cascade
  active: boolean; // tear enabled (opening phase)
  pointerX: number; // -1..1 idle tilt
  pointerY: number; // -1..1 idle tilt
  flipYaw?: number; // accrued flip target in radians (+π per toggle) — always turns one way
};

export type PackController = {
  group: THREE.Group;
  update: (delta: number, p: TearParams) => void;
  setCount: (n: number) => void;
  popDone: () => boolean;
  debug: () => string;
  dispose: () => void;
  // Fired as each pack launches in the multi-pack fly-off burst (per-pack SFX).
  onAutoRip?: () => void;
  /** Reflection env for the foil (metal reflects or it's dead gray —
   *  buildPack is GL-agnostic, so the view supplies this once GL exists). */
  setEnvMap: (tex: THREE.Texture) => void;
};

// Prebuild: buildPack() only constructs THREE objects — no GL context needed
// (GPU upload happens on first render). So the whole heavy build (GLB fetch +
// parse + per-pack art) can run from the buy click and hand PackRip a ready
// controller on mount, skipping the spinner.
// The warm is keyed by ccPackType: a pack warmed as pokemon_25 must not be
// handed to a rip wearing another pack's art.
let prebuilt: { key: string; promise: Promise<PackController> } | null = null;

const packKey = (ccPackType?: string | null) => ccPackType ?? "";

export function prebuildPack(ccPackType?: string | null): Promise<PackController> {
  const key = packKey(ccPackType);
  if (!prebuilt || prebuilt.key !== key) {
    const p = buildPack(ccPackType);
    prebuilt = { key, promise: p };
    // A failed build must not poison the rest of the session: page.tsx warms this
    // on every buy click, including pulls that abort before the theater opens (money
    // lock busy, sign error, not allowlisted). `??=` would hand that same rejected
    // promise to every later pull. Attaching the handler here also marks the
    // fire-and-forget `void prebuildPack()` rejection as handled; the promise
    // returned below still rejects, so PackRip can react to it.
    p.catch(() => {
      if (prebuilt?.promise === p) prebuilt = null;
    });
  }
  return prebuilt.promise;
}

// Consume the prebuilt pack (or build fresh if none was warmed / the warm wears
// the wrong art), clearing the cache — the controller is owned by the PackRip
// that takes it and disposed on its unmount, so the next pull prebuilds a fresh
// one. Handing out a disposed controller is exactly what this clearing prevents.
export function takePrebuiltPack(ccPackType?: string | null): Promise<PackController> {
  const p = prebuilt?.key === packKey(ccPackType) ? prebuilt.promise : buildPack(ccPackType);
  prebuilt = null;
  return p;
}

const texLoader = new THREE.TextureLoader();
/** Web texture load with the GLTF UV convention (flipY=false) three's loader doesn't default to. */
async function loadTex(url: string): Promise<THREE.Texture> {
  const t = await texLoader.loadAsync(url);
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** House print for this ccPackType, most specific first.
 *
 *  Every source here is ours. The chain used to end at Slabz's CDN art, and
 *  below that at the GLB's own embedded print — both of them Slabz-branded, so
 *  any family without a house file wore their pack. The house default now
 *  backstops the whole catalogue instead: one artwork on every pack until
 *  per-family prints land, which is the point of DEFAULT_PRINT being a
 *  constant rather than a fallback buried in a loop.
 *
 *  Drop public/pack-art/<ccPackType>_front.webp for a per-pack print, or
 *  <family>_front.webp to standardise a whole family. Full-bleed portrait,
 *  1355×2480, sRGB. Backs are uniform: every pack renders all_back.webp, laid
 *  out for the GLB's authored back UV window. */
async function loadArt(ccPackType: string, side: "front" | "back"): Promise<THREE.Texture | null> {
  const family = ccPackType.split("_")[0];
  // Sport families without their own print wear the generic sports art —
  // closer than the house default. Delete an entry when its own file lands.
  const alias = { baseball: "sports", football: "sports", soccer: "sports" }[family];
  // Every pack wears the shared house back; only fronts vary per family.
  const sources = new Set(
    side === "back"
      ? ["/pack-art/all_back.webp"]
      : [
          `/pack-art/${ccPackType}_${side}.webp`,
          `/pack-art/${family}_${side}.webp`,
          ...(alias ? [`/pack-art/${alias}_${side}.webp`] : []),
          `/pack-art/${DEFAULT_PRINT}_${side}.webp`,
        ],
  );
  for (const url of sources) {
    try {
      const t = await loadTex(url);
      t.colorSpace = THREE.SRGBColorSpace;
      // The pack tilts, and at a grazing angle anisotropy 1 mips the art into
      // mush. 8 is the sharpness win; three clamps it to what the GPU has.
      t.anisotropy = 8;
      // The back material's authored KHR_texture_transform pushes UVs past 1.
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      return t;
    } catch {
      // try the next source
    }
  }
  return null;
}

// ── Procedural tear ──────────────────────────────────────────────────────────
// All coordinates are pack space (the baked local space of the normalised
// mesh): x across the pack, y up, tear line just under the crimp at TEAR_Y —
// matching the glow sprite (0.185) and grip tab (0.175) rows.
const TEAR_Y = 0.185;
const JAG_AMP = 0.005; // tear-edge serration amplitude
const RIM_W = 0.0035; // hot-foil rim width along the torn boundary
const CURL_MAX = 1.7; // rad — how far the freed strip curls toward the camera
const PEEL_LEN = 0.1; // pack-space distance behind the front over which curl ramps
const f4 = (v: number) => v.toFixed(4);

const TEAR_COMMON = /* glsl */ `
varying vec3 vPack;
uniform float uFront;
uniform float uTime;
float tearJag(float x) {
  return (sin(x * 231.7) * 0.5 + sin(x * 97.3 + 1.7) * 0.3 + sin(x * 411.0 + 4.2) * 0.2) * ${f4(JAG_AMP)};
}
`;

type TearRig = {
  /** Current tear-front x in pack space (drives the tear light). */
  front: () => number;
  /** Tear progress 0..1 across the pack width (the tear front's x). */
  setFront: (e: number) => void;
  /** Advances the strip flutter clock. */
  tick: (delta: number) => void;
  /** Freed-strip fling: t 0..1 — translate/spin away, fade over the tail. */
  flyStrip: (t: number) => void;
  /** Whole-pack fade for the fly-off (body + strip together). */
  setOpacity: (o: number) => void;
  mats: THREE.MeshStandardMaterial[];
  /** [injected body material, the original it was cloned from] */
  pairs: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial][];
  dispose: () => void;
};

/** Arm a pack root for tearing: swap each mesh onto an injected body material
 *  and add a strip twin over the same geometry. Cheap enough to build lazily
 *  per cascade pack; shader programs are shared via the custom cache key. */
function makeTearRig(
  root: THREE.Object3D,
  resolveBright: (m: THREE.Material) => THREE.MeshStandardMaterial,
  x0: number,
  x1: number,
): TearRig {
  // margin keeps the idle front (and its rim glow) fully off the mesh
  const M = 0.05;
  const uniforms = { uFront: { value: x0 - M }, uTime: { value: 0 } };

  const inject = (mat: THREE.MeshStandardMaterial, strip: boolean) => {
    if (strip) mat.defines = { ...(mat.defines ?? {}), TEAR_STRIP: "" };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${TEAR_COMMON}`)
        .replace(
          "#include <begin_vertex>",
          /* glsl */ `#include <begin_vertex>
          vPack = position;
          #ifdef TEAR_STRIP
          {
            // peel: torn vertices curl about the tear line, ramping up behind
            // the front; a light flutter sells foil that has lost its tension
            float grab = smoothstep(0.0, ${f4(PEEL_LEN)}, uFront - position.x)
                       * smoothstep(${f4(TEAR_Y - JAG_AMP - 0.004)}, ${f4(TEAR_Y + JAG_AMP)}, position.y);
            float a = (${f4(CURL_MAX)} + sin(uTime * 26.0 + position.x * 70.0) * 0.08) * grab;
            float cy = transformed.y - ${f4(TEAR_Y)};
            float cz = transformed.z;
            transformed.y = ${f4(TEAR_Y)} + cy * cos(a) - cz * sin(a);
            transformed.z = cy * sin(a) + cz * cos(a) + 0.008 * grab;
          }
          #endif`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${TEAR_COMMON}`)
        .replace(
          "#include <clipping_planes_fragment>",
          /* glsl */ `
          float tearEdgeY = ${f4(TEAR_Y)} + tearJag(vPack.x);
          bool tearTorn = vPack.x < uFront && vPack.y > tearEdgeY;
          #ifdef TEAR_STRIP
          if (!tearTorn) discard;
          #else
          if (tearTorn) discard;
          #endif
          #include <clipping_planes_fragment>`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          /* glsl */ `#include <emissivemap_fragment>
          {
            // hot torn-foil rim along the two live edges: the horizontal tear
            // line (already-torn span only) and the advancing vertical front
            float dLine = (vPack.x < uFront) ? abs(vPack.y - tearEdgeY) : 1e3;
            float dFront = (vPack.y > tearEdgeY - ${f4(RIM_W)}) ? abs(vPack.x - uFront) : 1e3;
            float rim = 1.0 - smoothstep(0.0, ${f4(RIM_W)}, min(dLine, dFront));
            totalEmissiveRadiance += vec3(1.0, 0.85, 0.6) * rim * 1.6;
          }`,
        );
    };
    // onBeforeCompile output isn't part of three's program cache key — without
    // this, an injected material could be handed an uninjected twin's program
    mat.customProgramCacheKey = () => (strip ? "tear-strip" : "tear-body");
    return mat;
  };

  const mats: THREE.MeshStandardMaterial[] = [];
  const stripMats: THREE.MeshStandardMaterial[] = [];
  const pairs: TearRig["pairs"] = [];
  const stripGroup = new THREE.Group();
  stripGroup.name = "tearStrip";
  const targets: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) targets.push(m);
  });
  for (const m of targets) {
    const bright = resolveBright(m.material as THREE.Material);
    const body = inject(bright.clone(), false);
    const strip = inject(bright.clone(), true);
    strip.transparent = true; // the freed strip fades as it flings away
    m.material = body;
    const sm = new THREE.Mesh(m.geometry, strip);
    sm.frustumCulled = false;
    stripGroup.add(sm);
    mats.push(body, strip);
    stripMats.push(strip);
    pairs.push([body, bright]);
  }
  root.add(stripGroup);

  // ponytail: the strip twin re-rasterises the whole pack only to discard
  // every fragment while nothing is torn — draw it only once the front is on
  // the mesh. Two warm frames keep the first-idle-frame shader compile.
  let warm = 2;

  const span = x1 - x0 + 2 * M;
  return {
    front: () => uniforms.uFront.value,
    setFront: (e) => {
      uniforms.uFront.value = x0 - M + THREE.MathUtils.clamp(e, 0, 1) * span;
    },
    tick: (d) => {
      uniforms.uTime.value += d;
      if (warm > 0) warm--;
      else stripGroup.visible = uniforms.uFront.value > x0 - M + 1e-4;
    },
    flyStrip: (t) => {
      const k = THREE.MathUtils.clamp(t, 0, 1);
      const ei = k * k;
      stripGroup.position.set(0.2 * ei, 0.1 * ei, 0.22 * ei);
      stripGroup.rotation.set(1.3 * ei, 0, -0.8 * ei);
      const op = 1 - THREE.MathUtils.smoothstep(k, 0.55, 1);
      for (const s of stripMats) s.opacity = op;
    },
    setOpacity: (o) => {
      for (const m of mats) {
        m.transparent = true;
        m.opacity = o;
      }
    },
    mats,
    pairs,
    dispose: () => {
      for (const m of mats) m.dispose();
    },
  };
}

export async function buildPack(ccPackType?: string | null): Promise<PackController> {
  const group = new THREE.Group();
  group.scale.setScalar(8);

  // The Slabz GLB is Draco-compressed; decoder wasm is vendored from
  // node_modules/three/examples/jsm/libs/draco into public/draco.
  const draco = new DRACOLoader().setDecoderPath("/draco/");
  const loader = new GLTFLoader().setDRACOLoader(draco);

  const wantArt = !!ccPackType && /^[\w-]+$/.test(ccPackType);
  const [gltf, glowMap, glowMask, tabMap, frontArt, backArt] = await Promise.all([
    loader.loadAsync(GLB).finally(() => draco.dispose()),
    loadTex(GLOW),
    loadTex(GLOW_MASK),
    loadTex(TAB),
    wantArt ? loadArt(ccPackType!, "front") : null,
    wantArt ? loadArt(ccPackType!, "back") : null,
  ]);

  glowMap.colorSpace = THREE.SRGBColorSpace;
  glowMap.wrapS = glowMap.wrapT = THREE.ClampToEdgeWrapping;
  glowMap.repeat.set(0.5, 1 / 24);
  glowMap.offset.set(0, 1 - 1 / 24);
  glowMask.colorSpace = THREE.NoColorSpace;
  glowMask.wrapS = glowMask.wrapT = THREE.ClampToEdgeWrapping;
  tabMap.colorSpace = THREE.SRGBColorSpace;
  // The tab rides a PlaneGeometry, not GLTF geometry, so the flipY=false loadTex
  // applies is wrong here — it lands image row 0 at v=0 and renders the art
  // upside down.
  tabMap.flipY = true;

  // Normalise the Slabz mesh into the old model's world box so PackRip's
  // framing (camera distance, tear-line y, grab zones) holds unchanged — then
  // BAKE that transform into the geometry, so mesh-local coordinates ARE pack
  // space (the tear shaders cut and curl in these coordinates). `packRoot`
  // stays at origin, because the cascade positions packs by SETTING root
  // positions.
  const inner = gltf.scene;
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  inner.scale.multiplyScalar(PACK_H / size.y);
  box.setFromObject(inner);
  const c = box.getCenter(new THREE.Vector3());
  inner.position.set(-c.x, PACK_CY - c.y, -c.z);
  inner.updateMatrixWorld(true);
  const packRoot = new THREE.Group();
  const packMeshes: THREE.Mesh[] = [];
  inner.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) packMeshes.push(m);
  });
  for (const m of packMeshes) {
    m.geometry.applyMatrix4(m.matrixWorld);
    m.position.set(0, 0, 0);
    m.quaternion.identity();
    m.scale.set(1, 1, 1);
    packRoot.add(m); // reparent flat — the GLB's node hierarchy is done with
  }
  box.setFromObject(packRoot);
  const packX0 = box.min.x;
  const packX1 = box.max.x;

  // Slabz's authored materials ARE the look — metallic crinkle + wrinkle
  // normal map + specular boost. Only the face art gets swapped in.
  const packMats = new Set<THREE.MeshStandardMaterial>();
  for (const m of packMeshes) {
    m.frustumCulled = false;
    const mat = m.material as THREE.MeshStandardMaterial;
    packMats.add(mat);
    const art = mat.name.includes("back") ? backArt : frontArt;
    if (art && mat.map && mat.name.startsWith("pack_texture")) {
      // the GLB's back material carries a KHR_texture_transform — the swapped
      // art must ride the same UV window
      art.offset.copy(mat.map.offset);
      art.repeat.copy(mat.map.repeat);
      mat.map = art;
      mat.needsUpdate = true;
    }
  }
  group.add(packRoot);

  // Dim variants for the stacked-behind packs (+ the reverse map, so a pack
  // brightens back to the real material the moment its own rip begins).
  const dimByMat = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  const brightByDim = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  for (const mat of packMats) {
    const dim = mat.clone();
    dim.color.multiplyScalar(0.22);
    dimByMat.set(mat, dim);
    brightByDim.set(dim, mat);
  }

  // The front pack is armed for tearing from the start (its strip renders
  // fully discarded until the drag moves the front, so the shader compiles on
  // the first idle frame, not mid-rip). Cascade packs get their rigs lazily
  // as their turn comes. All rigs are tracked for env + dispose.
  const rigs: TearRig[] = [];
  const armPack = (root: THREE.Object3D): TearRig => {
    const rig = makeTearRig(
      root,
      (m) => brightByDim.get(m) ?? (m as THREE.MeshStandardMaterial),
      packX0,
      packX1,
    );
    rigs.push(rig);
    return rig;
  };
  const frontRig = armPack(packRoot);
  // setCount clones the front pack's meshes — they wear the rig's body
  // materials now, so the dim lookup must know those too
  for (const [body, orig] of frontRig.pairs) dimByMat.set(body, dimByMat.get(orig)!);

  // Additive tear-line glow plane.
  const glowGroup = new THREE.Group();
  glowGroup.position.set(0.007, 0.185, 0);
  // Slimmer + dimmer than the old theater's blaze — the procedural tear is
  // the star now; the sprite is just sizzle hugging the tear line.
  glowGroup.scale.set(0.23, -0.13, 0.23);
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowMap,
    alphaMap: glowMask,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    opacity: 0,
    toneMapped: false,
  });
  const glowMesh = new THREE.Mesh(new THREE.PlaneGeometry(809 / 278, 1), glowMat);
  glowMesh.renderOrder = 999;
  glowGroup.add(glowMesh);
  group.add(glowGroup);

  // Tear light: a warm point light hovering just off the foil at the tear
  // front, so the metal around the rip actually catches light while tearing
  // (the emissive rim glows but illuminates nothing). Lives in the scene from
  // frame one at intensity 0 — adding it mid-tear would recompile every
  // injected material and hitch the peel.
  // 0xa3e635 = the app's lime accent (globals.css) — the tear burns theme-green.
  const tearLight = new THREE.PointLight(0xa3e635, 0, 0, 2);
  group.add(tearLight);

  // Peel-grip tab (always drawn on top).
  const tabMat = new THREE.MeshBasicMaterial({
    map: tabMap,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const tabMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.017), tabMat);
  tabMesh.position.set(-0.1, 0.175, 0.015);
  tabMesh.renderOrder = 1000;
  group.add(tabMesh);

  // Stacked-behind packs (count > 1): static clones, dim material, stacked
  // vertically — each pack behind peeks up and sits deeper, so the camera's
  // perspective shrinks it naturally.
  const STACK_UP = 0.014; // world y per pack — fat peek, stack reads at a glance
  const STACK_BACK = 0.028; // world z per pack (> pack thickness, no z-fight)
  const slotPos = (v: THREE.Vector3, k: number) => v.set(0, STACK_UP * k, -STACK_BACK * k);
  let extras: THREE.Object3D[] = [];
  const setCount = (n: number) => {
    for (const ex of extras) group.remove(ex);
    extras = [];
    for (let k = 1; k < n; k++) {
      const ex = packRoot.clone(true);
      // the clone copied the front pack's strip twins — a stacked pack is
      // sealed, and its own rig adds fresh ones when its rip begins
      ex.getObjectByName("tearStrip")?.removeFromParent();
      ex.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.material = dimByMat.get(m.material as THREE.Material) ?? m.material;
          m.frustumCulled = false;
        }
      });
      slotPos(ex.position, k);
      // Behind the front pack.
      group.add(ex);
      extras.push(ex);
    }
  };

  const glowTime = { v: 0 };
  const tabOpacity = { v: 0 };
  const fadeElapsed = { v: 0 };
  const wasPopping = { v: false };
  const popDoneRef = { v: false };

  // Multi-pack chain (count > 1): overlapping per-pack timelines, not a serial
  // one-by-one. When the user's rip commits, the front pack finishes its tear
  // and flies off while extras[0] is ALREADY tearing in its slot; each next
  // pack's rip starts before the previous finishes (STAGGER < rip length) — a
  // seamless cascade of tear → fly-toward-the-bottom. popDoneRef (the
  // peel→reveal gate) only flips after the LAST pack has flown past.
  const TEAR_SWEEP = 0.45; // s — the committed front pack's tear plays out slow
  const STRIP_FLY = 0.35; // s — the freed crimp strip flings away
  const RIP_LEN = 0.3; // s — cascade packs tear faster
  const STAGGER = RIP_LEN * 0.6; // next rip starts at 60% of the previous one
  const JITTER_AMP = 0.03; // rad — roll jitter while a tear is running
  const JITTER_HZ = 46; // rad/s
  // Fly-out per design spec: a short ease-OUT settle drop, then a strong
  // ease-IN whoosh (most of the travel lands in the final ~100ms), ±5° roll,
  // opacity fading only over the last 30%.
  const FLY_DROP_IN = 0.12; // s — pack drops into motion, ease-out
  const FLY_OUT = 0.26; // s — flies down + past the camera, cubic ease-in
  const FLY_DUR = FLY_DROP_IN + FLY_OUT;
  const DROP_IN_Y = 0.12; // group-space settle drop
  const FLY_Z = 1.7; // group-space z travel (camera sits ≈1.1 — overshoot past it)
  const FLY_DROP = 0.6; // group-space y drop → exits the bottom, not the center
  const FLY_ROLL = 0.087; // ±5° roll during the whoosh
  let chain = false;
  const chainT = { v: 0 };
  type Flyer = {
    obj: THREE.Object3D;
    rig: TearRig | null; // armed once its rip begins (front pack: from birth)
    flyFrom: THREE.Vector3 | null; // position captured at fly start
  };
  let flyers: Flyer[] = [];
  const TMP = new THREE.Vector3();
  // Which pack the tear glow rides + its tear progress (newest ripper wins).
  let glowPack: THREE.Object3D = packRoot;
  let glowRig: TearRig = frontRig; // the ripper's rig — its front() places the tear light
  const glowE = { v: 0 };
  // Front-pack commit timeline + where its drag-scrubbed tear front stood.
  const sweepT = { v: 0 };
  const sweepFrom = { v: 0 };
  const lastS = { v: 0 };

  const dbg = { v: "pack:init" };
  const idleT = { v: 0 }; // idle-float clock (seconds); drives bob + auto-sway
  const ep = Math.PI / 6; // max tilt rotation (~30°)
  const TWO_PI = Math.PI * 2;

  const update = (delta: number, p: TearParams) => {
    const e = THREE.MathUtils.clamp(p.progress, 0, 1);
    const driving = p.active || p.popping;
    // Exact model mapping (async/396) — n drives the glow wipe, s the tear
    // front (same 0.1 baseline the old morph scrub used: an armed pack shows
    // a starting nick at the left edge).
    const n = p.popping ? 1 : driving ? 0.4 + 0.6 * e : 0;
    const nn = n <= 0.4 ? 0 : (n - 0.4) / 0.6;
    const s = driving ? 0.1 + nn * 0.9 : 0;

    frontRig.tick(delta);

    if (p.popping && !popDoneRef.v) {
      if (!chain) {
        // --- front pack rip (user drag committed) ---
        // Phase A: the tear front sweeps home from wherever the drag left it
        // (ease-in — the tear accelerates as the strip loses purchase).
        // Phase B: the freed crimp strip flings away. Then the cascade owns it.
        if (!wasPopping.v) {
          wasPopping.v = true;
          sweepT.v = 0;
          sweepFrom.v = lastS.v;
        }
        sweepT.v += delta;
        if (sweepT.v < TEAR_SWEEP) {
          const k = sweepT.v / TEAR_SWEEP;
          frontRig.setFront(THREE.MathUtils.lerp(sweepFrom.v, 1, k * k));
          const decay = 1 - k;
          packRoot.rotation.z = Math.sin(sweepT.v * JITTER_HZ) * JITTER_AMP * decay;
        } else if (sweepT.v < TEAR_SWEEP + STRIP_FLY) {
          frontRig.setFront(1);
          packRoot.rotation.z = 0;
          frontRig.flyStrip((sweepT.v - TEAR_SWEEP) / STRIP_FLY);
        } else {
          frontRig.flyStrip(1);
          // single pack or stack: hand it to the SAME cascade machinery, so
          // quantity 1 and quantity N fly out identically. popDone flips when
          // the cascade reports allGone.
          chain = true;
          chainT.v = 0;
          flyers = [
            { obj: packRoot, rig: frontRig, flyFrom: null },
            ...extras.map((ex) => ({ obj: ex, rig: null as TearRig | null, flyFrom: null })),
          ];
        }
      } else {
        // --- overlapping cascade: every pack runs its own tear→fly timeline ---
        chainT.v += delta;
        // Conveyor: each pack that has left the stack (flying or gone) frees a
        // slot, and everything still waiting/tearing lerps one slot forward.
        let advance = 0;
        flyers.forEach((f, i) => {
          const ripLen = i === 0 ? 0 : RIP_LEN;
          const start = i === 0 ? 0 : (i - 1) * STAGGER;
          if (chainT.v - start >= ripLen) advance++;
        });
        let allGone = true;
        flyers.forEach((f, i) => {
          // front pack (i=0) was ripped by hand → flies immediately; extras
          // start their rips staggered, overlapping the previous pack's tail
          const ripLen = i === 0 ? 0 : RIP_LEN;
          const start = i === 0 ? 0 : (i - 1) * STAGGER;
          const local = chainT.v - start;
          if (local < ripLen) {
            // waiting (local < 0) or tearing — either way, step forward into
            // the freed slots while the rip plays
            allGone = false;
            f.obj.position.lerp(slotPos(TMP, Math.max(0, i - advance)), 0.2);
            if (local >= 0) {
              if (!f.rig) {
                // this pack's turn — arm its own tear rig (also swaps the
                // stacked-behind dim materials for the injected bright ones)
                f.rig = armPack(f.obj);
                controller.onAutoRip?.();
              }
              const k = local / ripLen;
              f.rig.setFront(k * k); // same accelerating tear as the hand rip
              f.rig.tick(delta);
              f.obj.rotation.z = Math.sin(local * JITTER_HZ) * JITTER_AMP * (1 - k);
              glowPack = f.obj; // newest ripper carries the tear glow
              glowRig = f.rig;
              glowE.v = THREE.MathUtils.clamp(k, 0, 1);
            }
            return;
          }
          // flying off — from wherever the conveyor left it when the rip
          // finished: ease-out settle drop, then the cubic ease-in whoosh
          const flyT = local - ripLen;
          if (flyT >= FLY_DUR) {
            f.obj.visible = false;
            return;
          }
          allGone = false;
          if (!f.flyFrom) {
            f.flyFrom = f.obj.position.clone();
            f.obj.rotation.z = 0; // tear's over — the fly roll owns z now
            f.rig?.setFront(1);
          }
          // cascade packs fling their freed strip as the pack starts to drop
          // (the front pack's already flew during its own commit beat)
          if (i > 0) f.rig?.flyStrip(flyT / 0.15);
          const dir = i % 2 ? 1 : -1;
          if (flyT < FLY_DROP_IN) {
            // pack drops into motion (ease-out)
            const k = flyT / FLY_DROP_IN;
            const eo = 1 - (1 - k) * (1 - k);
            f.obj.position.set(f.flyFrom.x, f.flyFrom.y - DROP_IN_Y * eo, f.flyFrom.z);
          } else {
            // whoosh: cubic ease-in — most travel lands in the final ~100ms
            const k = Math.min(1, (flyT - FLY_DROP_IN) / FLY_OUT);
            const ei = k * k * k;
            f.obj.position.set(
              f.flyFrom.x,
              f.flyFrom.y - DROP_IN_Y - FLY_DROP * ei,
              f.flyFrom.z + FLY_Z * ei,
            );
            f.obj.rotation.z = dir * FLY_ROLL * k;
            // stay fully visible through ~70%, fade over the last 30%
            // (rig materials are per-pack, so this can't dim the others)
            f.rig?.setOpacity(k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3);
          }
        });
        if (allGone) popDoneRef.v = true; // last pack flew — reveal may switch
      }
    } else if (!p.popping) {
      popDoneRef.v = false;
      wasPopping.v = false;
      fadeElapsed.v = 0;
      packRoot.rotation.z = 0;
      // drag scrubs the tear front directly — the strip peels under the finger
      frontRig.setFront(s);
      lastS.v = s;
    }

    // Tear-line glow rides the pack it belongs to: glowGroup is a SIBLING of
    // the pack meshes (fixed at the front slot), so when the ripped pack flies
    // off in the multi-pack chain the glow would hang mid-air — re-pin it to
    // the current ripper every frame (no-op pre-chain).
    glowGroup.position.set(
      0.007 + glowPack.position.x,
      0.185 + glowPack.position.y,
      glowPack.position.z,
    );

    // Tear-line glow: mask wipe + 48-frame sprite + fade. `n` is pinned to 1
    // by p.popping, which would freeze the wipe at its end state for the whole
    // chain — during the cascade, drive it from the newest ripper's own tear
    // progress (glowE, same 0.4+0.6·e mapping as a manual drag).
    const glowN = chain ? 0.4 + 0.6 * glowE.v : n;
    const gp = glowN <= 0 ? 0 : 0.775 * Math.max(0.52, Math.min(1, glowN));
    glowMask.offset.x = 1 - gp;
    glowTime.v = (glowTime.v + delta) % 0.8;
    const frame = Math.floor(glowTime.v / (1 / 60)) % 48;
    glowMap.offset.set((frame % 2) / 2, 1 - (Math.floor(frame / 2) + 1) / 24);
    glowMap.repeat.set(0.5, 1 / 24);
    if (popDoneRef.v) {
      fadeElapsed.v += delta;
      glowMat.opacity = Math.max(0, 1 - fadeElapsed.v / 0.1);
    } else {
      glowMat.opacity = driving ? 0.4 : 0;
    }

    // Tear light rides the ripper's live front, just off the foil. Intensity
    // follows the glow sprite (same fade), scaled by how far the tear has
    // opened so an armed-but-untouched pack shows no hot spot.
    const tearHeat = glowN <= 0.4 ? 0 : (glowN - 0.4) / 0.6;
    tearLight.intensity = glowMat.opacity * tearHeat * 30;
    tearLight.position.set(
      glowRig.front() + glowPack.position.x,
      0.185 + glowPack.position.y,
      glowPack.position.z + 0.09,
    );

    // Peel-grip tab: visible when active & not opened; slides x = -0.1 + 0.2·drag.
    // Follows the LIVE finger (p.drag, un-ratcheted) — the tear itself ratchets,
    // but the grip must track the pointer, including backing up.
    // Hidden once the fly-off burst owns the stage — no finger to grip there.
    const dragE = THREE.MathUtils.clamp(p.drag ?? p.progress, 0, 1);
    const wantVisible = p.active && !popDoneRef.v && !chain;
    const rate = popDoneRef.v ? delta / 0.2 : delta / 0.3;
    tabOpacity.v = THREE.MathUtils.clamp(
      tabOpacity.v + Math.sign((wantVisible ? 1 : 0) - tabOpacity.v) * rate,
      0,
      1,
    );
    tabMat.opacity = tabOpacity.v;
    tabMesh.position.x = p.active && !popDoneRef.v ? -0.1 + 0.2 * dragE : -0.1;

    dbg.v = `pop=${p.popping ? 1 : 0} done=${popDoneRef.v ? 1 : 0} s=${s.toFixed(2)} sweep=${sweepT.v.toFixed(2)} chain=${chain ? 1 : 0}`;

    // Idle float: gentle bob + slow auto-sway so a resting pack feels alive/weightless. Fades to 0
    // as you peel (1 - e) and off entirely while popping, so the rip stays steady. Incommensurate
    // frequencies (1.3 / 0.55 / 0.42) → non-repeating drift instead of an obvious loop.
    idleT.v += delta;
    const idle = p.popping || popDoneRef.v ? 0 : 1 - e;
    const bob = Math.sin(idleT.v * 1.3) * 0.06 * idle; // vertical float
    const swayY = Math.sin(idleT.v * 0.55) * 0.09 * idle; // yaw drift ~±5°
    const swayX = Math.cos(idleT.v * 0.42) * 0.05 * idle; // pitch drift ~±3°

    // Rotation: sensor/pointer tilt + idle sway (superposed; a real tilt dominates the sway).
    // Flip yaw accrues +π per toggle so the pack always turns the SAME way (no rock-back); the 0.08
    // lerp animates the turn. While popping, ease to the nearest front-facing 2π multiple so the
    // rip plays face-on without unwinding every accrued turn.
    // ponytail: flipYaw grows unbounded across toggles; fine (sin/cos wrap, pack resets per session).
    const flipYaw = p.flipYaw ?? 0;
    const flip = p.popping || popDoneRef.v ? Math.round(flipYaw / TWO_PI) * TWO_PI : flipYaw;
    group.position.y = bob;
    // no tear lean — packs stay upright through the rip
    group.rotation.z = THREE.MathUtils.lerp(group.rotation.z, 0, 0.2);
    group.rotation.y = THREE.MathUtils.lerp(group.rotation.y, p.pointerX * ep + swayY + flip, 0.08);
    group.rotation.x = THREE.MathUtils.lerp(group.rotation.x, -p.pointerY * ep + swayX, 0.08);
  };

  const dispose = () => {
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry?.dispose(); // strip twins share geometry — re-dispose is a no-op
    });
    for (const rig of rigs) rig.dispose();
    for (const mat of packMats) {
      // env texture is shared across pack mats — repeated dispose is a no-op
      mat.envMap?.dispose();
      mat.map?.dispose();
      mat.normalMap?.dispose();
      mat.dispose();
    }
    for (const dim of dimByMat.values()) dim.dispose();
    [glowMat, tabMat].forEach((m) => m.dispose());
    [glowMap, glowMask, tabMap].forEach((t) => t.dispose());
  };

  const controller: PackController = {
    group,
    update,
    setCount,
    popDone: () => popDoneRef.v,
    debug: () => dbg.v,
    dispose,
    setEnvMap: (tex) => {
      // The Slabz foil is metal — without an environment it renders dead gray.
      // Materials keep their authored metalness/roughness/normals; only the
      // reflection source is supplied here.
      // intensity 1 — the env IS Slabz's own HDRI, boosting it drifts the shine
      // rigs created after this call clone already-env'd materials; the front
      // rig exists before it, so its mats are in the loop
      for (const mat of [...packMats, ...dimByMat.values(), ...rigs.flatMap((r) => r.mats)]) {
        mat.envMap = tex;
        mat.envMapIntensity = 1;
        mat.needsUpdate = true;
      }
    },
  };
  return controller;
}
