import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import carGlb from '../models/car.glb';
import propsGlb from '../models/props.glb';
import { groundY, PX_PER_M, START_X, ANCHORS, WHEEL_R } from './physics.js';

const M = 1 / PX_PER_M;
const surf = xm => -groundY(xm * PX_PER_M) * M;                 // road surface height at x (meters)
const CHUNK = 40, DX = 0.5;
const ROAD = 1.8, EDGE = 3.4;
const WHEEL_Z = 0.82;
export const LANE_Z = 2.6;                                       // opponents drive one lane behind you

// In a race the road is two lanes wide; everything behind it shifts back.
let lane = 0;
const roadBack = () => -(ROAD + lane);
const shoulderBack = () => roadBack() - 1.0;
const RUTS = () => (lane ? [0.9, -0.9, -lane + 0.9, -lane - 0.9] : [0.9, -0.9]);

// front → back cross-section of the ground strip
function profile() {
  const p = [EDGE, 2.8, ROAD, 0.9, 0, -0.9];
  if (lane) p.push(-1.3, -lane + 0.9, -lane, -lane - 0.9);
  p.push(roadBack(), shoulderBack());
  for (const z of [-4, -6, -9, -13, -18, -25, -34, -46, -60, -78, -100, -125, -155]) {
    if (z - lane < shoulderBack() - 0.5) p.push(z - lane);
  }
  return p;
}

function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

function blurredSurf(x) {
  return (surf(x - 16) + surf(x - 8) + surf(x) + surf(x + 8) + surf(x + 16)) / 5;
}

// Height of the land at any (x, z). The road strip follows the physics exactly;
// behind it the ground rolls up into hills.
export function landY(x, z) {
  const sb = shoulderBack();
  if (z >= sb) {
    const lip = z > ROAD ? -0.06 * smoothstep(ROAD, EDGE, z) : 0;
    const bumps = z > ROAD || z < roadBack() ? 0.05 * Math.sin(x * 3.1 + z * 2) : 0;
    return surf(x) + lip + bumps;
  }
  const t = smoothstep(sb, sb - 27, z);
  const base = surf(x) * (1 - t) + blurredSurf(x) * t;
  const d = -z - lane;
  const n = 0.5 + 0.3 * Math.sin(x * 0.045 + d * 0.06) + 0.2 * Math.sin(x * 0.011 - d * 0.027 + 1.7)
          + 0.12 * Math.sin(x * 0.13 + d * 0.21);
  return base + smoothstep(sb - 7, sb - 67, z) * n * (1 + d * 0.2) + smoothstep(sb, sb - 3.2, z) * 0.15;
}

const C = (h) => new THREE.Color(h);
const COL = {
  road: C('#b48c5c'), divider: C('#c49c6a'), rut: C('#8f6a42'), grass: C('#67b444'), grass2: C('#86c454'), dry: C('#a8b55a'),
  far: C('#4f8f4a'), rock: C('#8d8f84'), dirt1: C('#7c4f2c'), dirt2: C('#5f3a20'), dirt3: C('#8f6038'), lip: C('#3f8a2a'),
};

// ---------------------------------------------------------------- one car on screen
class CarRig {
  constructor(world, color, laneZ) {
    this.world = world;
    this.laneZ = laneZ;
    const scene = world.scene, models = world.models;
    this.objects = [];
    const add = o => { scene.add(o); this.objects.push(o); return o; };

    this.root = add(new THREE.Group());
    this.body = models.CarBody.clone();
    if (color) {
      const paint = C(color), dark = C(color).multiplyScalar(0.7);
      this.body.traverse(m => {
        if (!m.isMesh) return;
        if (m.material.name === 'Paint') { m.material = m.material.clone(); m.material.color.copy(paint); }
        else if (m.material.name === 'PaintDark') { m.material = m.material.clone(); m.material.color.copy(dark); }
      });
    }
    this.root.add(this.body);

    this.wheels = [];
    for (let i = 0; i < 2; i++) {
      const pair = [];
      for (const side of [1, -1]) {
        const pivot = add(new THREE.Group());
        const w = models.Wheel.clone();
        if (side < 0) w.rotation.y = Math.PI;      // hub faces outward on the far side
        pivot.add(w);
        pivot.userData.side = side;
        pair.push(pivot);
      }
      this.wheels.push(pair);
    }
    this.struts = [];
    for (let i = 0; i < 2; i++) for (const side of [1, -1]) {
      const shock = add(new THREE.Mesh(world.shockGeo, world.steelMat));
      const coil = add(new THREE.Mesh(world.springGeo, world.springMat));
      shock.castShadow = coil.castShadow = true;
      this.struts.push({ i, side, shock, coil });
    }
  }

  // b = { x, y, a } chassis in px; wheels = [{ x, y, a }, …] in px
  sync(b, wheels) {
    const z = this.laneZ;
    this.root.position.set(b.x * M, -b.y * M, z);
    this.root.rotation.z = -b.a;
    wheels.forEach((wh, i) => {
      for (const pivot of this.wheels[i]) {
        pivot.position.set(wh.x * M, -wh.y * M, z + pivot.userData.side * WHEEL_Z);
        pivot.rotation.z = -wh.a;
      }
    });
    const cos = Math.cos(b.a), sin = Math.sin(b.a);
    const up = _v0.set(0, 1, 0);
    for (const s of this.struts) {
      const wh = wheels[s.i], [ax, ay] = ANCHORS[s.i];
      const lx = ax, ly = ay - 22;
      _a.set((b.x + lx * cos - ly * sin) * M, -(b.y + lx * sin + ly * cos) * M, z + s.side * 0.62);
      _w.set(wh.x * M, -wh.y * M, z + s.side * 0.66);
      _d.subVectors(_w, _a);
      const len = _d.length();
      _d.normalize();
      _q.setFromUnitVectors(up, _d);
      s.shock.position.copy(_a).addScaledVector(_d, len / 2);
      s.shock.quaternion.copy(_q); s.shock.scale.set(1, len, 1);
      s.coil.position.copy(_a).addScaledVector(_d, len * 0.32);
      s.coil.quaternion.copy(_q); s.coil.scale.set(1, len * 0.55, 1);
    }
  }

  dispose() { for (const o of this.objects) this.world.scene.remove(o); }
}
const _v0 = new THREE.Vector3(), _a = new THREE.Vector3(), _w = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion();

// ---------------------------------------------------------------- world
export class World {
  constructor(canvas) {
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.92;
    r.outputColorSpace = THREE.SRGBColorSpace;

    const scene = this.scene = new THREE.Scene();
    const horizon = new THREE.Color('#cfe6f2');
    scene.fog = new THREE.Fog(horizon, 70, 230);
    scene.background = horizon;
    // soft studio reflections so the gold, chrome and paint read as metal
    const pmrem = new THREE.PMREMGenerator(r);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.5;

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1200);
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.shake = 0;

    // sky dome
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: C('#3b86d1') }, mid: { value: C('#86bfe8') }, bottom: { value: horizon } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP;
        void main(){ float h = vP.y; vec3 c = h > 0.12 ? mix(mid, top, smoothstep(0.12, 0.7, h)) : mix(bottom, mid, smoothstep(-0.05, 0.12, h));
        gl_FragColor = vec4(c, 1.0); }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), skyMat);
    scene.add(this.sky);
    this.sun = new THREE.Mesh(new THREE.CircleGeometry(26, 32), new THREE.MeshBasicMaterial({ color: '#fff6d8', fog: false }));
    scene.add(this.sun);

    scene.add(new THREE.HemisphereLight('#cfe8ff', '#5a4a2c', 0.75));
    const sunLight = this.sunLight = new THREE.DirectionalLight('#fff1d6', 2.6);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    const sc = sunLight.shadow.camera;
    sc.left = -16; sc.right = 16; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 80;
    sunLight.shadow.bias = -0.0004;
    sunLight.shadow.normalBias = 0.03;
    scene.add(sunLight, sunLight.target);

    this.groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.25 });
    this.steelMat = new THREE.MeshStandardMaterial({ color: '#2d3136', metalness: 0.8, roughness: 0.35 });
    this.springMat = new THREE.MeshStandardMaterial({ color: '#f2c230', metalness: 0.5, roughness: 0.35 });
    this.shockGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 10);
    this.springGeo = new THREE.CylinderGeometry(0.085, 0.085, 1, 12);
    this.chunks = new Map();
    this.signs = new Map();
    this.particles = [];
    this.remotes = new Map();
    this.finish = null;
    this.flashTime = 0;
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
    for (const n of ['Coin', 'FuelCan', 'TreePine', 'TreeRound', 'Rock', 'Bush', 'Fence', 'Cloud', 'Sign']) this.models[n] = grab(props, n);
    // big coins: a redder, richer gold
    this.models.CoinBig = this.models.Coin.clone();
    this.models.CoinBig.traverse(m => { if (m.isMesh) { m.material = m.material.clone(); m.material.color.multiply(C('#ffb07a')); } });
    this.models.Cloud.traverse(m => { if (m.isMesh) { m.castShadow = false; m.material.fog = true; } });
    this.player = new CarRig(this, null, 0);
    this.buildParticles();
    this.exhaustLight = new THREE.PointLight('#ff8a2a', 0, 5, 2);
    this.scene.add(this.exhaustLight);
  }

  // ------------------------------------------------------------ race setup
  // Two-lane road while racing; the local car keeps the front lane.
  setRaceLayout(racing, playerColor) {
    const want = racing ? LANE_Z : 0;
    if (want !== lane) { lane = want; this.clearChunks(); }
    this.player.dispose();
    this.player = new CarRig(this, playerColor, 0);
  }

  addRemote(id, color) {
    if (this.remotes.has(id)) return this.remotes.get(id);
    const rig = new CarRig(this, color, -LANE_Z);
    this.remotes.set(id, rig);
    return rig;
  }

  removeRemote(id) {
    const rig = this.remotes.get(id);
    if (rig) { rig.dispose(); this.remotes.delete(id); }
  }

  clearRemotes() { for (const id of [...this.remotes.keys()]) this.removeRemote(id); }

  setFinish(meters) {
    if (this.finish) { this.scene.remove(this.finish); this.finish = null; }
    if (meters == null) return;
    const x = START_X * M + meters;
    const canvasTex = (w, h, draw) => {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      draw(cv.getContext('2d'));
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    };
    const checks = (g, cols, rows, size) => {
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        g.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4';
        g.fillRect(i * size, j * size, size, size);
      }
    };
    const bannerTex = canvasTex(512, 160, g => {
      checks(g, 32, 10, 16);
      g.fillStyle = '#d62f26'; g.fillRect(96, 28, 320, 104);
      g.fillStyle = '#fff'; g.font = 'bold 76px "Baloo 2", "Trebuchet MS", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('FINISH', 256, 84);
    });
    const lineTex = canvasTex(64, 512, g => checks(g, 4, 32, 16));

    const g = new THREE.Group();
    const zf = EDGE - 0.4, zb = shoulderBack() + 0.3;
    const y0 = surf(x);
    for (const z of [zf, zb]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 5, 12), this.steelMat);
      post.position.set(x, y0 + 2.3, z);
      post.castShadow = true;
      g.add(post);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, zf - zb, 10), this.steelMat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(x, y0 + 4.6, (zf + zb) / 2);
    g.add(bar);
    // the banner faces the camera, hung from the front post
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.06),
      new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.7, side: THREE.DoubleSide }));
    banner.position.set(x, y0 + 4.05, zf + 0.18);
    banner.castShadow = true;
    g.add(banner);
    // chequered line across the road
    const slope = Math.atan2(surf(x + 0.5) - surf(x - 0.5), 1);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.5, ROAD - roadBack()),
      new THREE.MeshStandardMaterial({ map: lineTex, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
    line.rotation.x = -Math.PI / 2;
    line.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), slope);
    line.position.set(x, y0 + 0.02, (ROAD + roadBack()) / 2);
    line.receiveShadow = true;
    g.add(line);
    this.finish = g;
    this.scene.add(g);
  }

  // ------------------------------------------------------------ particles
  buildParticles() {
    const geo = new THREE.IcosahedronGeometry(0.16, 0);
    for (let i = 0; i < 140; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: '#c7a074', roughness: 1, transparent: true, opacity: 0, depthWrite: false, flatShading: true });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.particles.push({ mesh, life: 0, max: 1, vx: 0, vy: 0, vz: 0, grow: 1 });
    }
    this.pIndex = 0;
  }

  emit(x, y, z, vx, vy, vz, color, life, size, grow = 1.6, opacity = 0.85) {
    const p = this.particles[this.pIndex = (this.pIndex + 1) % this.particles.length];
    p.mesh.position.set(x, y, z);
    p.mesh.material.color.set(color);
    p.mesh.material.opacity = opacity;
    p.mesh.scale.setScalar(size);
    p.mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    p.mesh.visible = true;
    Object.assign(p, { life, max: life, vx, vy, vz, size, grow, opacity });
  }

  updateParticles(dt) {
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.mesh.visible = false; continue; }
      const k = 1 - p.life / p.max;
      p.vy -= 1.5 * dt;
      p.mesh.position.x += p.vx * dt; p.mesh.position.y += p.vy * dt; p.mesh.position.z += p.vz * dt;
      p.mesh.scale.setScalar(p.size * (1 + k * p.grow));
      p.mesh.material.opacity = p.opacity * (1 - k);
    }
  }

  // dust from a car's tyres; laneZ is the car's lane
  tyreDust(wheels, laneZ, chance = 1) {
    for (const wh of wheels) {
      if (!wh.contact) continue;
      const spin = Math.abs(wh.w * WHEEL_R - wh.vx);
      const rate = Math.min(0.9, spin / 500 + Math.abs(wh.vx) / 3000) * chance;
      if (Math.random() >= rate) continue;
      const side = Math.random() < 0.5 ? 1 : -1;
      const dir = Math.sign(wh.w) || 1;
      this.emit(wh.x * M - dir * 0.3, -wh.y * M - 0.35, laneZ + side * (WHEEL_Z + 0.1), -dir * (1 + Math.random() * 2.5),
        0.8 + Math.random() * 1.8, side * Math.random() * 0.6, Math.random() < 0.3 ? '#9c7a52' : '#c7a074',
        0.5 + Math.random() * 0.5, 0.45 + Math.random() * 0.4);
    }
  }

  backfireFlash() { this.flashTime = 0.09; }
  addShake(v) { this.shake = Math.min(0.6, this.shake + v); }

  // ------------------------------------------------------------ terrain
  buildChunk(idx) {
    const x0 = idx * CHUNK;
    const PROFILE = profile();
    const sb = shoulderBack(), rb = roadBack(), ruts = RUTS();
    const nx = Math.round(CHUNK / DX) + 1, nz = PROFILE.length;
    const group = new THREE.Group();

    // top surface grid
    const pos = [], col = [], index = [];
    const c = new THREE.Color();
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * DX;
      for (let j = 0; j < nz; j++) {
        const z = PROFILE[j];
        const jx = (z < sb - 0.5 ? (hash(x * 3.7 + j) - 0.5) * DX * 0.8 : 0);
        const y = landY(x + jx, z);
        pos.push(x + jx, y, z);
        const v = hash(Math.floor(x * 2) * 13 + j * 7) * 0.08 - 0.04;
        if (z < ROAD - 0.01 && z > rb + 0.01) {
          c.copy(ruts.some(r => Math.abs(z - r) < 0.01) ? COL.rut : z === -1.3 ? COL.divider : COL.road);
        } else if (z > 0) c.copy(COL.grass);
        else {
          const far = smoothstep(sb - 3, sb - 90, z);
          const patch = 0.5 + 0.5 * Math.sin(x * 0.07 + z * 0.13);
          c.copy(COL.grass).lerp(COL.grass2, patch * 0.6).lerp(COL.dry, smoothstep(0.75, 1, patch) * 0.5).lerp(COL.far, far * 0.7);
          if (y - surf(x) > 14) c.lerp(COL.rock, 0.35);
        }
        c.offsetHSL(0, 0, v);
        col.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < nx - 1; i++) for (let j = 0; j < nz - 1; j++) {
      const a = i * nz + j, b = a + nz;
      index.push(a, b, a + 1, b, b + 1, a + 1);   // counter-clockwise seen from above
    }
    const top = new THREE.BufferGeometry();
    top.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    top.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    top.setIndex(index);
    top.computeVertexNormals();
    const topMesh = new THREE.Mesh(top, this.groundMat);
    topMesh.receiveShadow = true;
    group.add(topMesh);

    // front cliff face (the cut-away earth you see under the track)
    const depths = [0, 0.35, 0.9, 1.6, 2.6, 3.8, 5.5, 8, 12, 20];
    const fpos = [], fcol = [], findex = [];
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * DX;
      const yTop = landY(x, EDGE);
      for (let j = 0; j < depths.length; j++) {
        const d = depths[j];
        const wob = j > 1 ? (hash(x * 1.3 + j * 5) - 0.5) * 0.25 : 0;
        fpos.push(x, yTop - d + wob * 0.5, EDGE + 0.02 + d * 0.03 + wob * 0.2);
        const band = Math.sin((yTop - d) * 1.4 + x * 0.05);
        c.copy(j === 0 ? COL.lip : j === 1 ? COL.lip.clone().lerp(COL.dirt1, 0.6) : band > 0.3 ? COL.dirt3 : band > -0.4 ? COL.dirt1 : COL.dirt2);
        c.offsetHSL(0, 0, hash(x * 5 + j) * 0.05 - 0.025);
        fcol.push(c.r, c.g, c.b);
      }
    }
    const nd = depths.length;
    for (let i = 0; i < nx - 1; i++) for (let j = 0; j < nd - 1; j++) {
      const a = i * nd + j, b = a + nd;
      findex.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const face = new THREE.BufferGeometry();
    face.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
    face.setAttribute('color', new THREE.Float32BufferAttribute(fcol, 3));
    face.setIndex(findex);
    face.computeVertexNormals();
    group.add(new THREE.Mesh(face, this.groundMat));

    // scenery
    const R = rng(idx * 7919 + 17);
    const place = (name, x, z, s, castShadow) => {
      const o = this.models[name].clone();
      o.position.set(x, landY(x, z) - 0.05, z);
      o.scale.setScalar(s);
      o.rotation.y = R() * Math.PI * 2;
      if (!castShadow) o.traverse(m => { if (m.isMesh) m.castShadow = false; });
      group.add(o);
      return o;
    };
    for (let k = 0; k < 26; k++) {
      const z = sb - 2.2 - Math.pow(R(), 1.4) * 95, x = x0 + R() * CHUNK;
      place(R() < 0.55 ? 'TreePine' : 'TreeRound', x, z, 0.9 + R() * 0.9 + (-z) * 0.006, z > sb - 9);
    }
    for (let k = 0; k < 3; k++) place(R() < 0.5 ? 'TreeRound' : 'TreePine', x0 + R() * CHUNK, sb - 0.8 - R() * 1.5, 0.8 + R() * 0.4, true);
    for (let k = 0; k < 10; k++) place('Bush', x0 + R() * CHUNK, sb - 0.4 - R() * 30, 0.7 + R() * 0.8, false);
    for (let k = 0; k < 7; k++) place('Rock', x0 + R() * CHUNK, sb - 0.4 - R() * 40, 0.5 + R() * 1.4, false);
    for (let k = 0; k < 2; k++) place('Rock', x0 + R() * CHUNK, 2.3 + R() * 0.7, 0.18 + R() * 0.15, true);
    // fence runs along the back of the track
    if (R() < 0.6) {
      const start = x0 + R() * 10, n = 3 + Math.floor(R() * 6), fz = sb - 0.3;
      for (let k = 0; k < n; k++) {
        const fx = start + k * 3.1;
        const o = this.models.Fence.clone();
        const yl = landY(fx - 1.5, fz), yr = landY(fx + 1.5, fz);
        o.position.set(fx, (yl + yr) / 2 - 0.05, fz);
        o.rotation.z = Math.atan2(yr - yl, 3);
        group.add(o);
      }
    }
    for (let k = 0; k < 2; k++) {
      const cl = this.models.Cloud.clone();
      const x = x0 + R() * CHUNK, z = -70 - R() * 80;
      cl.position.set(x, blurredSurf(x) + 26 + R() * 22, z);
      cl.scale.setScalar(2 + R() * 3);
      group.add(cl);
    }

    this.scene.add(group);
    return group;
  }

  updateChunks(camX) {
    const from = Math.floor((camX - 130) / CHUNK), to = Math.floor((camX + 170) / CHUNK);
    for (let i = from; i <= to; i++) if (!this.chunks.has(i)) this.chunks.set(i, this.buildChunk(i));
    for (const [i, g] of this.chunks) {
      if (i >= from && i <= to) continue;
      this.scene.remove(g);
      g.traverse(o => { if (o.isMesh && o.material === this.groundMat) o.geometry.dispose(); });
      this.chunks.delete(i);
    }
  }

  clearChunks() {
    for (const [, g] of this.chunks) {
      this.scene.remove(g);
      g.traverse(o => { if (o.isMesh && o.material === this.groundMat) o.geometry.dispose(); });
    }
    this.chunks.clear();
    for (const [, s] of this.signs) this.scene.remove(s);
    this.signs.clear();
  }

  // ------------------------------------------------------------ signs
  makeSign(label, gold) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 104;
    const g = cv.getContext('2d');
    g.fillStyle = gold ? '#f2c230' : '#f4ecd8'; g.fillRect(0, 0, 256, 104);
    g.strokeStyle = gold ? '#7a5208' : '#6b4528'; g.lineWidth = 8; g.strokeRect(4, 4, 248, 96);
    g.fillStyle = gold ? '#3a2400' : '#3b2614';
    g.font = 'bold 54px "Baloo 2", "Trebuchet MS", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, 128, 56);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const o = this.models.Sign.clone();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.18, 0.48), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
    plane.position.set(0, 1.75, 0.155);   // just in front of the board's front face
    o.add(plane);
    return o;
  }

  // signposts every 100 m, plus a BEST sign in solo runs
  updateSigns(camX, best) {
    const step = 100;
    const m0 = Math.max(1, Math.ceil((camX - 60 - START_X * M) / step)), m1 = Math.floor((camX + 80 - START_X * M) / step);
    const want = new Set();
    for (let m = m0; m <= m1; m++) want.add('d' + m);
    if (best > 0) want.add('best' + best);
    const sz = shoulderBack() + 0.3;
    for (const key of want) {
      if (this.signs.has(key)) continue;
      const isBest = key.startsWith('best');
      const meters = isBest ? best : +key.slice(1);
      const s = this.makeSign(isBest ? 'BEST' : meters + ' m', isBest);
      const x = START_X * M + meters;
      s.position.set(x + (isBest ? 0.8 : 0), landY(x, sz) - 0.05, sz);
      this.scene.add(s);
      this.signs.set(key, s);
    }
    for (const [key, s] of this.signs) if (!want.has(key)) { this.scene.remove(s); this.signs.delete(key); }
  }

  // ------------------------------------------------------------ items
  syncItem(it, t, dt) {
    if (!it.mesh) {
      it.mesh = (it.kind === 'coin' ? (it.value > 5 ? this.models.CoinBig : this.models.Coin) : this.models.FuelCan).clone();
      if (it.kind === 'coin' && it.value > 5) it.mesh.scale.setScalar(1.25);
      this.scene.add(it.mesh);
      it.baseScale = it.mesh.scale.x;
    }
    const m = it.mesh;
    if (it.taken) {
      it.fly = (it.fly || 0) + dt;
      const k = it.fly / 0.35;
      m.position.y += dt * 6;
      m.rotation.y += dt * 20;
      m.scale.setScalar(it.baseScale * Math.max(0.01, 1 - k));
      if (k >= 1) this.dropItem(it);
      return;
    }
    if (it.kind === 'coin') {
      m.position.set(it.x * M, -it.y * M, 0);
      m.rotation.y = t * 2.5 + it.x * 0.01;
    } else {
      m.position.set(it.x * M, -it.y * M + Math.sin(t * 3) * 0.1, 0);
      m.rotation.y = Math.sin(t * 1.5) * 0.6;
    }
  }

  dropItem(it) {
    if (it.mesh) { this.scene.remove(it.mesh); it.mesh = null; }
    it.gone = true;
  }

  // ------------------------------------------------------------ per-frame
  update(game, dt, t) {
    const car = game.car, b = car.body;
    const bx = b.x * M, by = -b.y * M, ang = -b.a;
    this.player.sync(b, car.wheels);

    // exhaust smoke, dust, backfire glow
    const ex = new THREE.Vector3(-1.75, -0.36, 0.55).applyAxisAngle(new THREE.Vector3(0, 0, 1), ang).add(this.player.root.position);
    if (game.engineOn && Math.random() < (game.input.gas ? 0.55 : 0.12)) {
      this.emit(ex.x, ex.y, ex.z, -0.6 - Math.random() * 0.6 + b.vx * M * 0.4, 0.4 + Math.random() * 0.4, Math.random() * 0.3,
        game.input.gas ? '#5f6266' : '#9a9da0', 0.7 + Math.random() * 0.5, 0.35, 2.5, game.input.gas ? 0.5 : 0.3);
    }
    if (game.engineOn) this.tyreDust(car.wheels, 0);
    if (game.landDust > 0) {
      for (let k = 0; k < Math.min(24, game.landDust * 30); k++) {
        const wh = car.wheels[k % 2], side = k % 4 < 2 ? 1 : -1;
        this.emit(wh.x * M + (Math.random() - 0.5), -wh.y * M - 0.4, side * WHEEL_Z, (Math.random() - 0.5) * 4,
          0.5 + Math.random() * 1.5, side * Math.random(), '#c7a074', 0.6 + Math.random() * 0.4, 0.5);
      }
      game.landDust = 0;
    }
    this.flashTime = Math.max(0, this.flashTime - dt);
    this.exhaustLight.position.copy(ex);
    this.exhaustLight.intensity = this.flashTime > 0 ? 30 : 0;
    if (this.flashTime > 0.06) this.emit(ex.x - 0.2, ex.y, ex.z, -2, 0.2, 0, '#ffb347', 0.08, 0.6, 1, 1);
    this.updateParticles(dt);

    // items, chunks, signs
    for (const it of game.items) this.syncItem(it, t, dt);
    this.updateChunks(bx);
    this.updateSigns(bx, game.mode === 'solo' ? game.best : 0);

    // camera: in a race pull back a little so the opponent lane fits
    const aspect = this.camera.aspect;
    const speed = Math.hypot(b.vx, b.vy) * M;
    const look = Math.max(-2, Math.min(4.5, b.vx * M * 0.32));
    const dist = (15.5 + Math.min(5, speed * 0.2) + (lane ? 2 : 0)) * (aspect < 1 ? 1.9 : aspect < 1.4 ? 1.3 : 1);
    const tx = bx + look, ty = by + 0.6, tz = lane ? -lane * 0.4 : 0;
    const k = Math.min(1, dt * 3.5);
    if (!this.camInit) { this.camPos.set(tx - 2, ty + 2.1, dist + tz); this.camLook.set(tx, ty, tz); this.camInit = true; }
    this.camPos.lerp(_v0.set(tx - 2.2, ty + 2.1 + (lane ? 0.6 : 0), dist + tz), k);
    this.camLook.lerp(_v0.set(tx, ty + 1.1, tz), Math.min(1, dt * 5));
    this.shake = Math.max(0, this.shake - dt * 1.6);
    const sh = this.shake * this.shake;
    this.camera.position.set(this.camPos.x + (Math.random() - 0.5) * sh, this.camPos.y + (Math.random() - 0.5) * sh, this.camPos.z);
    this.camera.lookAt(this.camLook);

    this.sky.position.copy(this.camera.position);
    this.sun.position.set(this.camera.position.x + 260, this.camera.position.y + 250, this.camera.position.z - 600);
    this.sun.lookAt(this.camera.position);
    this.sunLight.position.set(bx + 9, by + 20, 16);
    this.sunLight.target.position.set(bx + 2, by, 0);
  }

  resetCamera() { this.camInit = false; this.shake = 0; }

  project(xm, ym, zm = 0) {
    const v = _v0.set(xm, ym, zm).project(this.camera);
    return { x: (v.x + 1) / 2 * this.width, y: (1 - v.y) / 2 * this.height, behind: v.z > 1 };
  }

  resize(w, h) {
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 1 ? 50 : 38;
    this.camera.updateProjectionMatrix();
  }

  render() { this.renderer.render(this.scene, this.camera); }
}
