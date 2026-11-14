import * as THREE from 'three';
import { StereoEffect } from 'three/addons/effects/StereoEffect.js';
import { TerrainWorld } from './terrain.js';
import { LookControls, yawOfDirection } from './orientation.js';
import { Walker } from './locomotion.js';
import { buildRoute } from './route.js';
import { PLACES, DEFAULT_PLACE, exampleRouteFrom } from './places.js';

const SKY_TOP = new THREE.Color(0x4a3328);
const SKY_HORIZON = new THREE.Color(0xc99a72);

const params = new URLSearchParams(location.search);
const placeKey = PLACES[params.get('local')] ? params.get('local') : DEFAULT_PLACE;
const place = PLACES[placeKey];

const $ = (id) => document.getElementById(id);
const ui = {
  loading: $('loading'),
  loadingPlace: $('loadingPlace'),
  loadingText: $('loadingText'),
  sensorsBtn: $('sensorsBtn'),
  recenterBtn: $('recenterBtn'),
  fullscreenBtn: $('fullscreenBtn'),
  stereoBtn: $('stereoBtn'),
  settingsBtn: $('settingsBtn'),
  settings: $('settings'),
  placeSelect: $('placeSelect'),
  exagSlider: $('exagSlider'),
  exagVal: $('exagVal'),
  exagReset: $('exagReset'),
  smoothSlider: $('smoothSlider'),
  smoothVal: $('smoothVal'),
  detailToggle: $('detailToggle'),
  walkBtn: $('walkBtn'),
  speedBtn: $('speedBtn'),
  exitStereo: $('exitStereo'),
  hudDest: $('hudDest'),
  hudInfo: $('hudInfo'),
  hudSource: $('hudSource'),
  toast: $('toast'),
};

function toast(msg, ms = 3500) {
  ui.toast.textContent = msg;
  ui.toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ui.toast.classList.remove('show'), ms);
}

// ---------- Renderer / cena ----------
// logarithmicDepthBuffer: precisão de profundidade de 10 cm (rota no chão) até 100+ km (paredões).
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
$('app').appendChild(renderer.domElement);

const stereo = new StereoEffect(renderer);
stereo.setEyeSeparation(0.064);
stereo.setSize(window.innerWidth, window.innerHeight);
let stereoOn = false;

const scene = new THREE.Scene();
// Névoa leve: em escala real dá para ver paredões a dezenas de km; esconde a borda do bloco (83+ km).
scene.fog = new THREE.Fog(SKY_HORIZON, 4000, 80000);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200000);

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(5000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: SKY_TOP }, horizon: { value: SKY_HORIZON } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 top;
      uniform vec3 horizon;
      varying vec3 vDir;
      void main() {
        #include <logdepthbuf_fragment>
        float h = clamp(vDir.y, 0.0, 1.0);
        gl_FragColor = vec4(mix(horizon, top, pow(h, 0.55)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
);
sky.renderOrder = -1;
scene.add(sky);

// Iluminação (sol: azimute 45°, elevação 28°, padrão do map-3d)
// Luz do céu forte: a poeira marciana espalha bastante luz e as encostas em sombra não ficam pretas
scene.add(new THREE.HemisphereLight(0xffe2c4, 0x6a4a36, 0.95));
const sun = new THREE.DirectionalLight(0xfff1e0, 2.4);
const SUN_EL = (28 * Math.PI) / 180;
const SUN_AZ = (45 * Math.PI) / 180;
const SUN_DIR = new THREE.Vector3(
  Math.cos(SUN_EL) * Math.cos(SUN_AZ),
  Math.sin(SUN_EL),
  Math.cos(SUN_EL) * Math.sin(SUN_AZ)
);
scene.add(sun, sun.target);

// ---------- Mundo, controles, rota ----------
const world = new TerrainWorld(scene, { lat: place.lat, lon: place.lon });
const look = new LookControls(camera, renderer.domElement);
const walker = new Walker(camera, world);
let route = null;
let arrived = false;

function aimYaw() {
  // aponta para o próximo trecho da rota a partir de onde a pessoa está
  if (!route) return 0;
  const p = camera.position;
  const ahead = route.points.find((q) => Math.hypot(q.x - p.x, q.z - p.z) > 25) ?? route.dest;
  return yawOfDirection(ahead.x - p.x, ahead.z - p.z);
}

async function init() {
  ui.loadingPlace.textContent = place.name;
  await world.init((d, t) => (ui.loadingText.textContent = `Baixando tiles NASA Trek… ${d}/${t}`));
  // Rota: a do local (lat/lon) ou uma de exemplo saindo do ponto mais plano por perto
  let points;
  let destName;
  if (place.route) {
    camera.position.set(0, 0, 0);
    points = place.route.points.map((p) => world.toWorld(p.lat, p.lon));
    destName = place.route.destName;
  } else {
    const spot = world.findFlatSpot(0, 0); // evita nascer numa encosta (ex.: parede do cânion)
    camera.position.set(spot.x, 0, spot.z);
    points = exampleRouteFrom(spot.x, spot.z, world.yawFlattest(spot.x, spot.z));
    destName = 'Destino de exemplo';
  }
  walker.snapToGround();
  route = buildRoute(world, points, destName);
  route.points = points;
  scene.add(route.group);
  world.onChunkChange = () => route.relayout();

  look.recenter(aimYaw());
  look.dragPitch = -0.12;
  camera.quaternion.setFromEuler(new THREE.Euler(look.dragPitch, look.dragYaw, 0, 'YXZ'));

  ui.loading.classList.add('hidden');
  if (!window.isSecureContext) toast('Página sem HTTPS: sensores indisponíveis. Arraste para olhar.', 6000);
  else toast('Segure "Andar" para caminhar na direção em que você olha.', 4500);
}

init().catch((err) => {
  console.error(err);
  ui.loadingText.textContent = `Erro ao carregar terreno: ${err.message}`;
});

// ---------- Botões ----------
ui.sensorsBtn.addEventListener('click', async () => {
  if (look.sensorsActive) {
    look.disableSensors();
    ui.sensorsBtn.textContent = 'Ativar sensores';
    ui.sensorsBtn.classList.remove('on');
    return;
  }
  try {
    look.pendingRecenter = null; // mantém a direção para onde a pessoa já está olhando
    await look.enableSensors();
    ui.sensorsBtn.textContent = 'Sensores ✓';
    ui.sensorsBtn.classList.add('on');
    navigator.wakeLock?.request('screen').catch(() => {});
  } catch (err) {
    toast(err.message, 5000);
  }
});

ui.recenterBtn.addEventListener('click', () => look.recenter(aimYaw()));

walker.bindHold(ui.walkBtn);
function renderSpeed() {
  const s = walker.speed;
  ui.speedBtn.textContent = `${s.icon} ${s.v.toLocaleString('pt-BR')} m/s`;
  ui.speedBtn.title = s.label;
}
ui.speedBtn.addEventListener('click', () => {
  walker.cycleSpeed();
  renderSpeed();
  toast(`Velocidade: ${walker.speed.label} (${walker.speed.v.toLocaleString('pt-BR')} m/s)`, 1800);
});
renderSpeed();

// Modo estéreo: segurar em qualquer lugar da tela = andar (o botão do Cardboard também conta)
renderer.domElement.addEventListener('pointerdown', () => {
  if (stereoOn) walker.holding = true;
});
['pointerup', 'pointercancel'].forEach((ev) =>
  renderer.domElement.addEventListener(ev, () => {
    if (stereoOn) walker.holding = false;
  })
);

function isFullscreen() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}
async function enterFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) {
    toast('Tela cheia não suportada aqui. No iPhone: Compartilhar → "Adicionar à Tela de Início".', 6000);
    return false;
  }
  await req.call(el);
  return true;
}
async function exitFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (exit && isFullscreen()) await exit.call(document);
}
ui.fullscreenBtn.addEventListener('click', async () => {
  try {
    if (isFullscreen()) await exitFullscreen();
    else await enterFullscreen();
  } catch (err) {
    toast(`Tela cheia falhou: ${err.message}`);
  }
});

async function setStereo(on) {
  stereoOn = on;
  look.dragEnabled = !on;
  walker.holding = false;
  document.body.classList.toggle('stereo', on);
  if (on) {
    try {
      if (!isFullscreen()) await enterFullscreen();
      await screen.orientation?.lock?.('landscape');
    } catch {
      /* iOS não deixa travar a orientação: basta virar o celular */
    }
    toast('Estéreo: segure a tela (ou o botão do Cardboard) para andar.');
    if (!look.sensorsActive) setTimeout(() => toast('Dica: ative os sensores antes do modo estéreo.'), 3600);
  } else {
    screen.orientation?.unlock?.();
  }
  onResize();
}
ui.stereoBtn.addEventListener('click', () => setStereo(true));
ui.exitStereo.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.exitStereo.addEventListener('click', () => setStereo(false));
if (params.has('estereo')) setStereo(true); // atalho para testar no PC

// ---------- Ajustes ----------
ui.settingsBtn.addEventListener('click', () => ui.settings.classList.toggle('open'));
for (const [key, p] of Object.entries(PLACES)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = p.name;
  opt.selected = key === placeKey;
  ui.placeSelect.appendChild(opt);
}
ui.placeSelect.addEventListener('change', () => {
  const q = new URLSearchParams(location.search);
  q.set('local', ui.placeSelect.value);
  location.search = q.toString();
});

function applyExag(k) {
  ui.exagSlider.value = k;
  ui.exagVal.textContent = k === 1 ? '1.0x (real 1:1)' : `${k.toFixed(1)}x`;
  world.setExag(k);
  route?.relayout();
  walker.snapToGround();
}
ui.exagSlider.addEventListener('input', () => applyExag(parseFloat(ui.exagSlider.value)));
ui.exagReset.addEventListener('click', () => applyExag(1));
ui.smoothSlider.addEventListener('input', () => {
  look.smoothing = parseFloat(ui.smoothSlider.value); // 1 (bem suave) .. 30 (quase sem filtro)
  ui.smoothVal.textContent = look.smoothing.toFixed(0);
});
ui.detailToggle.addEventListener('change', () => world.setDetail(ui.detailToggle.checked));

// ---------- Resize ----------
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h; // o StereoEffect já usa metade da largura por olho
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  stereo.setSize(w, h);
}
window.addEventListener('resize', onResize);
screen.orientation?.addEventListener?.('change', onResize);
document.addEventListener('fullscreenchange', onResize);

// ---------- HUD ----------
const fwd = new THREE.Vector3();
const fmtDist = (m) => (Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
function updateHud(ground) {
  camera.getWorldDirection(fwd);
  const camYaw = yawOfDirection(fwd.x, fwd.z);
  const heading = ((((-camYaw * 180) / Math.PI) % 360) + 360) % 360;
  const dirs = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
  ui.hudInfo.textContent =
    `Rumo ${heading.toFixed(0).padStart(3, '0')}° ${dirs[Math.round(heading / 45) % 8]} · ` +
    `Elev. ${ground >= 0 ? '+' : ''}${fmtDist(ground)} · Andou ${fmtDist(walker.walked)}`;
  ui.hudSource.textContent =
    `MOLA cromaticidade 1:1 + ${world.hiriseActive ? 'HiRISE perto' : 'Viking'}` +
    (world.loadingChunk ? ' · carregando terreno…' : '');
  if (!route) return;
  const p = camera.position;
  const dist = Math.hypot(route.dest.x - p.x, route.dest.z - p.z);
  if (dist < 6 && !arrived) {
    arrived = true;
    toast('🎯 Destino alcançado!', 4000);
  } else if (dist > 15) arrived = false;
  let rel = yawOfDirection(route.dest.x - p.x, route.dest.z - p.z) - camYaw;
  rel = Math.atan2(Math.sin(rel), Math.cos(rel));
  const hFov = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
  let hint;
  if (arrived) hint = '🎯 você chegou';
  else if (Math.abs(rel) < (hFov / 2) * 0.8) hint = '▲ à frente';
  else if (rel > 0) hint = '◀ vire à esquerda';
  else hint = 'vire à direita ▶';
  ui.hudDest.textContent = `Destino ${fmtDist(dist)} · ${hint}`;
}

// ---------- Loop ----------
const clock = new THREE.Clock();
let hudTimer = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  look.update(dt);
  const ground = walker.update(dt);
  world.update(camera.position);
  sky.position.copy(camera.position);
  sun.position.copy(camera.position).addScaledVector(SUN_DIR, 2000);
  sun.target.position.copy(camera.position);
  route?.update(t, camera);
  if ((hudTimer += dt) > 0.1) {
    hudTimer = 0;
    updateHud(ground);
  }
  ui.walkBtn.classList.toggle('active', walker.holding);
  if (stereoOn) stereo.render(scene, camera);
  else renderer.render(scene, camera);
});
