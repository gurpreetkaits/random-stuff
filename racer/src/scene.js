import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import carGlb from '../models/car.glb';
import propsGlb from '../models/props.glb';
import { ROAD_HALF, KERB, CORRIDOR } from './track.js';

const WHEEL_X = 0.84, WHEEL_Z = 1.35, WHEEL_R = 0.34;
const C = h => new THREE.Color(h);

function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function noise2(x, z) {
  return 0.5 * Math.sin(x * 0.011 + 1.3) * Math.cos(z * 0.009 - 0.7) + 0.3 * Math.sin(x * 0.023 - z * 0.017 + 2.1)
    + 0.15 * Math.sin(x * 0.051 + z * 0.043) + 0.07 * Math.sin(x * 0.13 - z * 0.11 + 0.4);
}

function canvasTexture(w, h, draw, repeat = true) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 8;
  return t;
}

// ---------------------------------------------------------------- car on screen
class CarRig {
  constructor(world, color) {
    this.world = world;
    const m = world.models;
    this.root = new THREE.Group();                  // follows the physics body exactly
    this.body = m.CarBody.clone();
    this.tail = [];
    const paint = color ? C(color) : null;
    this.body.traverse(o => {
      if (!o.isMesh) return;
      if (o.material.name === 'Paint' && paint) { o.material = o.material.clone(); o.material.color.copy(paint); }
      if (o.material.name === 'Taillight') { o.material = o.material.clone(); this.tail.push(o.material); }
    });
    this.root.add(this.body);
    this.wheels = [];
    for (const [x, z, front] of [[WHEEL_X, WHEEL_Z, true], [-WHEEL_X, WHEEL_Z, true], [WHEEL_X, -WHEEL_Z, false], [-WHEEL_X, -WHEEL_Z, false]]) {
      const steer = new THREE.Group();
      steer.position.set(x, WHEEL_R, z);
      const spin = new THREE.Group();
      const w = m.Wheel.clone();
      if (x < 0) w.rotation.y = Math.PI;            // rim faces outward on the right side
      spin.add(w);
      steer.add(spin);
      this.root.add(steer);
      this.wheels.push({ steer, spin, front });
    }
    world.scene.add(this.root);
  }

  // s: { x, y, z, q: {x,y,z,w}, wheels?: [{ y, steer, spin }], steer, spin, brake }
  sync(s) {
    this.root.position.set(s.x, s.y, s.z);
    this.root.quaternion.set(s.q.x, s.q.y, s.q.z, s.q.w);
    this.wheels.forEach((w, i) => {
      const p = s.wheels ? s.wheels[i] : null;
      w.steer.position.y = p ? p.y : WHEEL_R;
      w.steer.rotation.y = w.front ? (p ? p.steer : s.steer) : 0;
      w.spin.rotation.x = p ? p.spin : s.spin;
    });
    const glow = s.brake ? 6 : 1.4;
    for (const m of this.tail) m.emissiveIntensity = glow;
  }

  dispose() { this.world.scene.remove(this.root); }
}

// ---------------------------------------------------------------- world
export class World {
  constructor(canvas, track) {
    this.track = track;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.55;
    r.outputColorSpace = THREE.SRGBColorSpace;

    const scene = this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 4000);
    this.camMode = 0;
    this.camYaw = 0; this.camInit = false; this.shake = 0;
    this.camPos = new THREE.Vector3();

    // golden-hour sky; also used as the environment map for paint reflections
    const sky = this.sky = new Sky();
    sky.scale.setScalar(3000);
    const u = sky.material.uniforms;
    u.turbidity.value = 6; u.rayleigh.value = 1.6; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.85;
    const sunDir = this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(76), THREE.MathUtils.degToRad(215));
    u.sunPosition.value.copy(sunDir);
    scene.add(sky);
    const pmrem = new THREE.PMREMGenerator(r);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    scene.environment = pmrem.fromScene(envScene).texture;
    scene.environmentIntensity = 0.9;
    scene.fog = new THREE.Fog(C('#e8c9a0'), 250, 1600);

    scene.add(new THREE.HemisphereLight('#ffe2bf', '#4a5a32', 0.9));
    const sun = this.sun = new THREE.DirectionalLight('#ffd6a0', 4.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 300;
    sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);

    // post: bloom makes lights, sun glints and chrome pop
    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.16, 0.4, 0.97);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.remotes = new Map();
    this.particles = [];
    this.skids = null;
  }

  async load() {
    const parse = u8 => new Promise((res, rej) =>
      new GLTFLoader().parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), '', res, rej));
    const [car, props] = await Promise.all([parse(carGlb), parse(propsGlb)]);
    const grab = (gltf, name) => {
      const o = gltf.scene.getObjectByName(name);
      if (!o) throw new Error('model missing: ' + name);
      o.position.set(0, 0, 0);
      o.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      return o;
    };
    this.models = {};
    for (const n of ['CarBody', 'Wheel']) this.models[n] = grab(car, n);
    for (const n of ['TreePine', 'TreeRound', 'Cone', 'TireStack', 'Grandstand', 'Bush', 'Rock']) this.models[n] = grab(props, n);
    this.buildTrack();
    this.buildTerrain();
    this.buildScenery();
    this.buildGantry();
    this.buildParticles();
    this.buildSkids();
    this.player = new CarRig(this, null);
  }

  // ------------------------------------------------------------ track mesh
  // One strip of quads along the loop between two lateral offsets.
  strip(lat0, lat1, dy0, dy1, material, { uScale = 1, vLen = 10, filter = null, walls = 0 } = {}) {
    const t = this.track, n = t.count;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= n; i++) {
      const k = i % n, lx = t.leftX(k), lz = t.leftZ(k), v = i * t.step / vLen;
      if (walls) {
        // vertical wall face at lat0, from dy0 up to dy1
        pos.push(t.x[k] + lx * lat0, t.y[k] + dy0, t.z[k] + lz * lat0, t.x[k] + lx * lat0, t.y[k] + dy1, t.z[k] + lz * lat0);
        uv.push(v, 0, v, 1);
      } else {
        pos.push(t.x[k] + lx * lat0, t.y[k] + dy0, t.z[k] + lz * lat0, t.x[k] + lx * lat1, t.y[k] + dy1, t.z[k] + lz * lat1);
        uv.push(0, v, uScale, v);
      }
    }
    for (let i = 0; i < n; i++) {
      if (filter && !filter(i)) continue;
      const a = i * 2, b = a + 2;
      // wind so the face points up (or toward the track for walls)
      if (walls ? walls > 0 : lat1 > lat0) idx.push(a, b, a + 1, b, b + 1, a + 1);
      else idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, material);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return mesh;
  }

  buildTrack() {
    const t = this.track;
    const asphalt = canvasTexture(512, 1024, (g, w, h) => {
      g.fillStyle = '#3a3b3e'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 26000; i++) {
        const v = 40 + Math.random() * 50 | 0;
        g.fillStyle = `rgba(${v},${v},${v + 3},${0.35 + Math.random() * 0.4})`;
        g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
      }
      // racing line rubber
      const grd = g.createLinearGradient(0, 0, w, 0);
      grd.addColorStop(0.25, 'rgba(10,10,12,0)'); grd.addColorStop(0.5, 'rgba(10,10,12,.28)'); grd.addColorStop(0.75, 'rgba(10,10,12,0)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
      g.fillStyle = '#e9e6dc';
      g.fillRect(10, 0, 9, h); g.fillRect(w - 19, 0, 9, h);
    });
    const roadMat = new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.82, metalness: 0.0, color: '#ffffff' });
    this.strip(-ROAD_HALF, ROAD_HALF, 0, 0, roadMat, { vLen: 14 });

    // kerbs on bends (red/white), grass verge elsewhere
    const kerbTex = canvasTexture(64, 256, (g, w, h) => {
      for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#f2f2ee' : '#d4261e'; g.fillRect(0, i * h / 8, w, h / 8); }
    });
    const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.6 });
    const bend = i => { for (let k = -4; k <= 4; k++) if (Math.abs(t.curv[t.wrap(i + k)]) > 0.0075) return true; return false; };
    for (const s of [1, -1]) this.strip(s * ROAD_HALF, s * (ROAD_HALF + KERB), 0.035, 0.0, kerbMat, { vLen: 8, filter: bend });

    // run-off grass and the barrier walls
    const verge = canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#5d7d33'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) {
        g.fillStyle = Math.random() < 0.5 ? 'rgba(120,150,60,.5)' : 'rgba(60,80,30,.5)';
        g.fillRect(Math.random() * w, Math.random() * h, 1, 2 + Math.random() * 3);
      }
    });
    const vergeMat = new THREE.MeshStandardMaterial({ map: verge, roughness: 0.95 });
    for (const s of [1, -1]) {
      this.strip(s * ROAD_HALF, s * (ROAD_HALF + KERB), -0.005, -0.01, vergeMat, { vLen: 6, uScale: 0.3, filter: i => !bend(i) });
      this.strip(s * (ROAD_HALF + KERB), s * CORRIDOR, -0.01, -0.06, vergeMat, { vLen: 6, uScale: 1.3 });
    }
    const wallTex = canvasTexture(256, 64, (g, w, h) => {
      g.fillStyle = '#b9b6ae'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? '#b31f18' : '#cfccc4'; g.fillRect(i * w / 4, 8, w / 4, h - 16); }
      g.fillStyle = '#9a978f'; g.fillRect(0, 0, w, 6); g.fillRect(0, h - 6, w, 6);
    });
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.7, side: THREE.DoubleSide });
    for (const s of [1, -1]) {
      const m = this.strip(s * CORRIDOR, 0, -0.3, 1.0, wallMat, { vLen: 8, walls: s });
      m.castShadow = true;
      // wall cap
      this.strip(s * CORRIDOR, s * (CORRIDOR + 0.4), 1.0, 1.0, new THREE.MeshStandardMaterial({ color: '#8e8b84', roughness: 0.8 }), { vLen: 8 });
    }

    // start/finish chequers and grid slots
    const chequer = canvasTexture(128, 32, (g, w, h) => {
      for (let i = 0; i < 16; i++) for (let j = 0; j < 4; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4'; g.fillRect(i * 8, j * 8, 8, 8); }
    }, false);
    const p0 = t.pointAt(0);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 1.6),
      new THREE.MeshStandardMaterial({ map: chequer, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 }));
    line.rotation.order = 'YXZ';                     // lay flat, then turn so its width runs across the road
    line.rotation.set(-Math.PI / 2, Math.atan2(p0.tx, p0.tz), 0);
    line.position.set(p0.x, p0.y + 0.01, p0.z);
    line.receiveShadow = true;
    this.scene.add(line);
    const slotMat = new THREE.MeshBasicMaterial({ color: '#e9e6dc', polygonOffset: true, polygonOffsetFactor: -2 });
    for (let k = 0; k < 8; k++) {
      const g = gridSlot(k);
      const p = t.pointAt(g.s + 2.6, g.lat);
      const mark = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.18), slotMat);
      mark.rotation.order = 'YXZ';
      mark.rotation.set(-Math.PI / 2, Math.atan2(p.tx, p.tz), 0);
      mark.position.set(p.x, p.y + 0.012, p.z);
      this.scene.add(mark);
    }
  }

  // ------------------------------------------------------------ terrain
  buildTerrain() {
    const t = this.track;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, sumY = 0;
    for (let i = 0; i < t.count; i++) {
      minX = Math.min(minX, t.x[i]); maxX = Math.max(maxX, t.x[i]);
      minZ = Math.min(minZ, t.z[i]); maxZ = Math.max(maxZ, t.z[i]);
      sumY += t.y[i];
    }
    this.baseY = sumY / t.count;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, size = 2600, seg = 220;
    this.terrainCenter = { cx, cz, size };
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, colors = [];
    const c = new THREE.Color(), g1 = C('#5f7f35'), g2 = C('#7d8f3e'), g3 = C('#a59a5c'), g4 = C('#4c6a2e');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx, z = pos.getZ(i) + cz;
      const y = this.terrainY(x, z);
      pos.setXYZ(i, x, y, z);
      const n = noise2(x * 2.3, z * 2.3);
      c.copy(g1).lerp(g2, smoothstep(-0.3, 0.6, n)).lerp(g3, smoothstep(0.55, 0.9, n) * 0.6).lerp(g4, smoothstep(0, -0.6, n) * 0.5);
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97 }));
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  nearestTrack(x, z) {
    const t = this.track;
    let best = 0, bd = Infinity;
    for (let i = 0; i < t.count; i += 3) {
      const d = (t.x[i] - x) ** 2 + (t.z[i] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    for (let k = -3; k <= 3; k++) {
      const i = t.wrap(best + k), d = (t.x[i] - x) ** 2 + (t.z[i] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return { d: Math.sqrt(bd), y: t.y[best], i: best };
  }

  terrainY(x, z) {
    const near = this.nearestTrack(x, z);
    const far = this.baseY + 4 + noise2(x, z) * 26 + Math.max(0, (near.d - 300) * 0.06);
    const k = smoothstep(CORRIDOR + 2, CORRIDOR + 70, near.d);
    return (near.y - 0.4) * (1 - k) + far * k;
  }

  // ------------------------------------------------------------ scenery
  instanced(model, transforms) {
    const meshes = [];
    model.updateMatrixWorld(true);
    model.traverse(o => { if (o.isMesh) meshes.push(o); });
    const tmp = new THREE.Matrix4();
    for (const src of meshes) {
      const im = new THREE.InstancedMesh(src.geometry, src.material, transforms.length);
      transforms.forEach((m, i) => im.setMatrixAt(i, tmp.multiplyMatrices(m, src.matrixWorld)));
      im.castShadow = true; im.receiveShadow = true;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      this.scene.add(im);
    }
  }

  buildScenery() {
    const t = this.track, R = rng(1234);
    const { cx, cz, size } = this.terrainCenter;
    const trees = { TreePine: [], TreeRound: [], Bush: [], Rock: [] };
    const m = (x, z, s, rot) => new THREE.Matrix4().compose(new THREE.Vector3(x, this.terrainY(x, z) - 0.2, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(s, s, s));
    let placed = 0;
    for (let tries = 0; placed < 1400 && tries < 9000; tries++) {
      const x = cx + (R() - 0.5) * size * 0.9, z = cz + (R() - 0.5) * size * 0.9;
      const d = this.nearestTrack(x, z).d;
      if (d < CORRIDOR + 6) continue;
      // forests cluster, thin out near the track
      const dens = 0.35 + 0.65 * smoothstep(-0.2, 0.5, noise2(x * 1.7 + 50, z * 1.7)) ;
      if (R() > dens * smoothstep(CORRIDOR + 6, CORRIDOR + 40, d) + 0.05) continue;
      const kind = R() < 0.6 ? 'TreePine' : 'TreeRound';
      trees[kind].push(m(x, z, 0.8 + R() * 0.7, R() * 6.28));
      placed++;
    }
    for (let k = 0; k < 500; k++) {
      const x = cx + (R() - 0.5) * size * 0.7, z = cz + (R() - 0.5) * size * 0.7;
      if (this.nearestTrack(x, z).d < CORRIDOR + 2) continue;
      trees[R() < 0.65 ? 'Bush' : 'Rock'].push(m(x, z, 0.7 + R() * 1.2, R() * 6.28));
    }
    for (const [name, list] of Object.entries(trees)) if (list.length) this.instanced(this.models[name], list);

    // tyre stacks on the outside of the tight corners, cones on the apexes
    const stacks = [], cones = [];
    for (let i = 0; i < t.count; i += 6) {
      const k = t.curv[i];
      if (Math.abs(k) < 0.012) continue;
      const outside = k > 0 ? 1 : -1;                  // right-hand bend → outside is left (+lat)
      const pa = t.pointAt(i * t.step, outside * (CORRIDOR - 0.9));
      stacks.push(new THREE.Matrix4().compose(new THREE.Vector3(pa.x, pa.y - 0.05, pa.z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)));
      if (i % 18 === 0) {
        const pc = t.pointAt(i * t.step, -outside * (ROAD_HALF + KERB + 1.2));
        cones.push(new THREE.Matrix4().compose(new THREE.Vector3(pc.x, pc.y - 0.06, pc.z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)));
      }
    }
    if (stacks.length) this.instanced(this.models.TireStack, stacks);
    if (cones.length) this.instanced(this.models.Cone, cones);

    // grandstands along the main straight, facing the track
    for (const s of [-70, -40, 40, 75]) {
      const side = s < 0 ? -1 : 1;
      const p = t.pointAt(s, side * (CORRIDOR + 7));
      const g = this.models.Grandstand.clone();
      const lx = t.leftX(t.wrap(Math.floor(((s % t.length) + t.length) % t.length / t.step))), lz = t.leftZ(t.wrap(Math.floor(((s % t.length) + t.length) % t.length / t.step)));
      g.position.set(p.x, p.y - 0.3, p.z);
      g.rotation.y = Math.atan2(-lx * side, -lz * side);   // face the road
      this.scene.add(g);
    }
  }

  // start/finish gantry with five start lights
  buildGantry() {
    const t = this.track, p = t.pointAt(0);
    const g = new THREE.Group();
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = Math.atan2(p.tx, p.tz);
    const steel = new THREE.MeshStandardMaterial({ color: '#2b2f35', metalness: 0.7, roughness: 0.4 });
    const span = ROAD_HALF + 2.2;
    for (const x of [-span, span]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7.2, 0.6), steel);
      post.position.set(x, 3.6, 0); post.castShadow = true; g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.6, 1.5, 0.8), steel);
    beam.position.set(0, 7.0, 0); beam.castShadow = true; g.add(beam);
    const banner = canvasTexture(1024, 128, (c, w, h) => {
      c.fillStyle = '#14181e'; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 64; i++) for (let j = 0; j < 2; j++) { c.fillStyle = (i + j) % 2 ? '#111' : '#eee'; c.fillRect(i * 16, j * 16 + (j ? h - 32 : 0), 16, 16); }
      c.fillStyle = '#fff'; c.font = 'bold 70px "Rajdhani", "Arial Narrow", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('START  ·  FINISH', w / 2, h / 2 + 2);
    }, false);
    for (const side of [1, -1]) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(span * 2, 1.25), new THREE.MeshStandardMaterial({ map: banner, roughness: 0.6 }));
      plane.position.set(0, 7.0, side * 0.41);
      if (side < 0) plane.rotation.y = Math.PI;
      g.add(plane);
    }
    // lights face the grid (behind the line, i.e. -z in gantry space)
    this.startLights = [];
    for (let k = 0; k < 5; k++) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.3), steel);
      pod.position.set(-2.4 + k * 1.2, 5.75, -0.4);
      g.add(pod);
      const mat = new THREE.MeshStandardMaterial({ color: '#300', emissive: '#ff1a10', emissiveIntensity: 0 });
      const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.24, 20), mat);
      lamp.position.set(-2.4 + k * 1.2, 5.75, -0.56);
      lamp.rotation.y = Math.PI;
      g.add(lamp);
      this.startLights.push(mat);
    }
    this.scene.add(g);
  }

  setStartLights(n) { this.startLights.forEach((m, k) => { m.emissiveIntensity = k < n ? 9 : 0; }); }

  // ------------------------------------------------------------ cars
  setPlayerColor(color) {
    if (this.player) this.player.dispose();
    this.player = new CarRig(this, color);
  }

  addRemote(id, color) {
    const rig = new CarRig(this, color);
    this.remotes.set(id, rig);
    return rig;
  }

  removeRemote(id) {
    const r = this.remotes.get(id);
    if (r) { r.dispose(); this.remotes.delete(id); }
  }

  clearRemotes() { for (const id of [...this.remotes.keys()]) this.removeRemote(id); }

  // ------------------------------------------------------------ smoke & skids
  buildParticles() {
    const geo = new THREE.IcosahedronGeometry(0.5, 1);
    for (let i = 0; i < 160; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: '#d9d4cc', roughness: 1, transparent: true, opacity: 0, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.particles.push({ mesh, life: 0 });
    }
    this.pIndex = 0;
  }

  smoke(x, y, z, vx, vz, color = '#d9d4cc', size = 0.6, life = 1.4, opacity = 0.45) {
    const p = this.particles[this.pIndex = (this.pIndex + 1) % this.particles.length];
    p.mesh.position.set(x, y, z);
    p.mesh.material.color.set(color);
    p.mesh.visible = true;
    Object.assign(p, { life, max: life, vx, vy: 0.6 + Math.random() * 0.6, vz, size, opacity });
  }

  updateParticles(dt) {
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.mesh.visible = false; continue; }
      const k = 1 - p.life / p.max;
      p.vx *= 1 - dt * 1.5; p.vz *= 1 - dt * 1.5;
      p.mesh.position.x += p.vx * dt; p.mesh.position.y += p.vy * dt; p.mesh.position.z += p.vz * dt;
      p.mesh.scale.setScalar(p.size * (1 + k * 4));
      p.mesh.material.opacity = p.opacity * (1 - k) * Math.min(1, k * 8);
    }
  }

  buildSkids() {
    const n = 1200;
    const mat = new THREE.MeshBasicMaterial({ color: '#111', transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });
    const geo = new THREE.PlaneGeometry(0.26, 1).rotateX(-Math.PI / 2);
    this.skids = new THREE.InstancedMesh(geo, mat, n);
    this.skids.count = 0;
    this.skids.frustumCulled = false;
    this.skidIndex = 0;
    this.scene.add(this.skids);
    this.lastSkid = [null, null];
  }

  skid(k, x, y, z, active) {
    const last = this.lastSkid[k];
    if (!active) { this.lastSkid[k] = null; return; }
    if (last) {
      const dx = x - last.x, dz = z - last.z, len = Math.hypot(dx, dz);
      if (len < 0.35) return;
      const m = new THREE.Matrix4().compose(new THREE.Vector3((x + last.x) / 2, y + 0.02, (z + last.z) / 2),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dx, dz)), new THREE.Vector3(1, 1, len));
      this.skids.setMatrixAt(this.skidIndex, m);
      this.skidIndex = (this.skidIndex + 1) % 1200;
      this.skids.count = Math.max(this.skids.count, this.skidIndex);
      if (this.skidIndex === 0) this.skids.count = 1200;
      this.skids.instanceMatrix.needsUpdate = true;
    }
    this.lastSkid[k] = { x, z };
  }

  // ------------------------------------------------------------ per frame
  update(car, input, dt) {
    const s = carVisual(car, input);
    this.player.sync(s);

    // tyre smoke and skid marks from the rear wheels
    const sliding = car.surface === 'road' && car.speed > 3 && (car.slipR > 0.22 || car.wheelspin > 0.15 || (input.handbrake && car.speed > 6));
    const fx = Math.sin(car.h), fz = Math.cos(car.h), lx = Math.cos(car.h), lz = -Math.sin(car.h);
    [-1, 1].forEach((side, k) => {
      const wx = car.x - fx * WHEEL_Z + lx * side * WHEEL_X, wz = car.z - fz * WHEEL_Z + lz * side * WHEEL_X;
      this.skid(k, wx, car.y, wz, sliding);
      if (sliding && Math.random() < 0.5) this.smoke(wx, car.y + 0.3, wz, car.vx * 0.3, car.vz * 0.3);
      if (car.surface === 'grass' && car.speed > 5 && Math.random() < 0.3) this.smoke(wx, car.y + 0.2, wz, car.vx * 0.2, car.vz * 0.2, '#9a8a62', 0.4, 0.9, 0.5);
    });
    this.updateParticles(dt);

    // camera
    const speed = car.speed;
    const velYaw = speed > 6 ? Math.atan2(car.vx, car.vz) : car.h;
    let target = car.h + angleDiff(car.h, velYaw) * 0.45 * (car.forwardSpeed > 0 ? 1 : 0);
    if (!this.camInit) { this.camYaw = target; this.camInit = true; }
    this.camYaw += angleDiff(this.camYaw, target) * Math.min(1, dt * 5);
    const modes = [{ back: 6.4, up: 2.0, look: 3.5, lookUp: 0.9 }, { back: 9.5, up: 3.2, look: 4, lookUp: 0.9 }, { back: -0.6, up: 1.15, look: 20, lookUp: 0.9 }];
    const md = modes[this.camMode];
    const bx = Math.sin(this.camYaw), bz = Math.cos(this.camYaw);
    const desired = new THREE.Vector3(car.x - bx * md.back, car.y + md.up, car.z - bz * md.back);
    if (this.camMode === 2) this.camPos.copy(desired);
    else this.camPos.lerp(desired, Math.min(1, dt * 12));
    const ground = this.camMode === 2 ? -Infinity : this.terrainYFast(this.camPos.x, this.camPos.z, car) + 0.6;
    if (this.camPos.y < ground) this.camPos.y = ground;
    this.shake = Math.max(0, this.shake - dt * 2);
    const sh = this.shake * this.shake * 0.5;
    this.camera.position.set(this.camPos.x + (Math.random() - 0.5) * sh, this.camPos.y + (Math.random() - 0.5) * sh, this.camPos.z);
    this.camera.lookAt(car.x + bx * md.look, car.y + md.lookUp, car.z + bz * md.look);
    const fov = 60 + Math.min(16, speed * 0.2);
    if (Math.abs(this.camera.fov - fov) > 0.05) { this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 3); this.camera.updateProjectionMatrix(); }

    this.sky.position.copy(this.camera.position);
    this.sun.position.set(car.x + this.sunDir.x * 150, car.y + this.sunDir.y * 150, car.z + this.sunDir.z * 150);
    this.sun.target.position.set(car.x, car.y, car.z);
  }

  // camera ground clamp: near the car the road is the ground
  terrainYFast(x, z, car) {
    const near = this.track.locate(x, z, car.hint);
    return Math.abs(near.lat) < CORRIDOR ? near.y : near.y + 0.5;
  }

  addShake(v) { this.shake = Math.min(1.2, this.shake + v); }
  cycleCamera() { this.camMode = (this.camMode + 1) % 3; this.player.root.visible = this.camMode !== 2; }

  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: (v.x + 1) / 2 * this.width, y: (1 - v.y) / 2 * this.height, behind: v.z > 1 };
  }

  resize(w, h) {
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() { this.composer.render(); }
}

export function angleDiff(a, b) { let d = b - a; return Math.atan2(Math.sin(d), Math.cos(d)); }

// visual state of a car for its rig
export function carVisual(car, input) {
  return {
    x: car.x, y: car.y, z: car.z, q: car.q, wheels: car.wheelPoses(),
    steer: car.steer, spin: car.wheelSpin, brake: input.brake > 0.1 && car.gear !== -1,
  };
}

// starting grid: two columns, staggered, behind the line
export function gridSlot(k) {
  return { s: -9 - k * 6.5, lat: (k % 2 ? -1 : 1) * 3.2 };
}
