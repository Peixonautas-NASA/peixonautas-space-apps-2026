import * as THREE from 'three';
import { StereoEffect } from 'three/addons/effects/StereoEffect.js';
import { TerrainWorld } from './terrain.js';
import { LookControls, yawOfDirection } from './orientation.js';
import { Walker } from './locomotion.js';
import { WidgetManager, Map2DWidget, Map3DWidget } from './widgets.js';
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
  playBtn: $('playBtn'),
  walkBtn: $('walkBtn'),
  map2dBtn: $('map2dBtn'),
  map3dBtn: $('map3dBtn'),
  speedBtn: $('speedBtn'),
  exitStereo: $('exitStereo'),
  hudDest: $('hudDest'),
  hudInfo: $('hudInfo'),
  hudSource: $('hudSource'),
  toast: $('toast'),
  start: $('start'),
  startPlace: $('startPlace'),
  startBtn: $('startBtn'),
  startPlain: $('startPlain'),
  startNote: $('startNote'),
  rotateOverlay: $('rotateOverlay'),
  rotateDismiss: $('rotateDismiss'),
  installSheet: $('installSheet'),
  installClose: $('installClose'),
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

// Widgets espaciais: seguem a posição do astronauta, não a rotação da cabeça (ver widgets.js)
const widgets = new WidgetManager({ scene, camera, dom: renderer.domElement });
const DEG = Math.PI / 180;
widgets.add(new Map2DWidget(), { daz: 31 * DEG, el: -12 * DEG }); // à esquerda
widgets.add(new Map3DWidget(renderer), { daz: -31 * DEG, el: -12 * DEG }); // à direita
if (params.has('debug')) window.__vr = { camera, widgets, walker, look, world }; // testes automatizados
widgets.onChange = () => {
  ui.map2dBtn.classList.toggle('on', widgets.get('map2d').open);
  ui.map3dBtn.classList.toggle('on', widgets.get('map3d').open);
};

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
  walker.setPath(route.path);

  const homeYaw = aimYaw();
  widgets.rebuild(world, route.path);
  widgets.get('map3d').faceYaw(homeYaw);
  widgets.layout(homeYaw);

  look.recenter(homeYaw);
  look.dragPitch = -0.12;
  camera.quaternion.setFromEuler(new THREE.Euler(look.dragPitch, look.dragYaw, 0, 'YXZ'));

  ui.loading.classList.add('hidden');
  showStart();
}

init().catch((err) => {
  console.error(err);
  ui.loadingText.textContent = `Erro ao carregar terreno: ${err.message}`;
});

// ---------- Plataforma: tela cheia, app instalado, orientação ----------
const isIOS = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalledApp =
  window.matchMedia('(display-mode: fullscreen)').matches ||
  window.matchMedia('(display-mode: standalone)').matches ||
  navigator.standalone === true;
const isTouch = window.matchMedia('(pointer: coarse)').matches;
const canFullscreen = Boolean(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
const isPortrait = () => window.innerHeight > window.innerWidth;

function isFullscreen() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}
/** Entra em tela cheia e trava na horizontal (Android). Chamar dentro de um toque do usuário. */
async function enterFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) {
    if (isIOS && !isInstalledApp) ui.installSheet.hidden = false;
    return false;
  }
  await req.call(el, { navigationUI: 'hide' });
  try {
    await screen.orientation?.lock?.('landscape');
  } catch {
    /* alguns navegadores não deixam travar; o aviso de "deite o celular" cobre isso */
  }
  return true;
}
async function exitFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (exit && isFullscreen()) await exit.call(document);
}
function syncFullscreenUi() {
  // Já instalado como app (tela cheia nativa): o botão não é necessário
  ui.fullscreenBtn.hidden = isInstalledApp && !canFullscreen;
  ui.fullscreenBtn.classList.toggle('on', isFullscreen() || isInstalledApp);
}
ui.fullscreenBtn.addEventListener('click', async () => {
  try {
    if (isFullscreen()) await exitFullscreen();
    else await enterFullscreen();
  } catch (err) {
    toast(`Tela cheia falhou: ${err.message}`);
  }
});
ui.installClose.addEventListener('click', () => (ui.installSheet.hidden = true));

// ---------- Sensores ----------
async function turnSensorsOn() {
  try {
    look.pendingRecenter = null; // mantém a direção para onde a pessoa já está olhando
    await look.enableSensors();
    ui.sensorsBtn.classList.add('on');
    navigator.wakeLock?.request('screen').catch(() => {});
    return true;
  } catch (err) {
    toast(err.message, 5000);
    return false;
  }
}
ui.sensorsBtn.addEventListener('click', () => {
  if (look.sensorsActive) {
    look.disableSensors();
    ui.sensorsBtn.classList.remove('on');
    toast('Sensores desligados: arraste a tela para olhar.', 2500);
  } else turnSensorsOn();
});

// ---------- Tela de entrada: um toque = tela cheia + horizontal + sensores ----------
let started = false;
function showStart() {
  ui.startPlace.textContent = place.name;
  if (!canFullscreen) {
    ui.startPlain.hidden = true;
    if (isInstalledApp) ui.startNote.textContent = 'Liga os sensores de movimento. Segure o celular na horizontal.';
    else if (isIOS) ui.startNote.textContent = 'No iPhone, a tela cheia vem ao instalar como app (o botão de tela cheia explica como).';
    else ui.startNote.textContent = 'Liga os sensores de movimento.';
  }
  if (!isTouch) {
    ui.startNote.textContent = 'No computador: arraste para olhar, W/A/S/D para andar livre e espaço para seguir a rota sozinho.';
    ui.startPlain.hidden = true;
  }
  ui.start.hidden = false;
}
function begin({ fullscreen }) {
  if (started) return;
  started = true;
  ui.start.hidden = true;
  // Tudo disparado no mesmo toque (o iOS exige o gesto para pedir permissão dos sensores)
  if (isTouch || isIOS) turnSensorsOn();
  if (fullscreen && canFullscreen && isTouch) enterFullscreen().catch(() => {});
  updateRotateOverlay();
  setTimeout(() => toast('Segure Andar para caminhar para onde você olha. O play segue a rota sozinho.', 4500), 600);
}
ui.startBtn.addEventListener('click', () => begin({ fullscreen: true }));
ui.startPlain.addEventListener('click', () => begin({ fullscreen: false }));

// Celular em pé: pede para deitar (dá para dispensar)
let portraitOk = false;
function updateRotateOverlay() {
  ui.rotateOverlay.hidden = !(started && isTouch && isPortrait() && !portraitOk && !stereoOn);
}
ui.rotateDismiss.addEventListener('click', () => {
  portraitOk = true;
  updateRotateOverlay();
});

ui.recenterBtn.addEventListener('click', () => look.recenter(aimYaw()));

// Piloto automático: pausar / continuar / recomeçar
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
const ICON_RESTART =
  '<svg viewBox="0 0 24 24" class="stroke"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v3.8h3.8"/></svg>';
function renderPlay() {
  const state = walker.finished ? 'restart' : walker.auto ? 'pause' : 'play';
  if (ui.playBtn.dataset.state === state) return;
  ui.playBtn.dataset.state = state;
  ui.playBtn.innerHTML = state === 'restart' ? ICON_RESTART : state === 'pause' ? ICON_PAUSE : ICON_PLAY;
  const label = state === 'restart' ? 'Recomeçar a rota' : state === 'pause' ? 'Pausar caminhada' : 'Continuar caminhada';
  ui.playBtn.title = label;
  ui.playBtn.setAttribute('aria-label', label);
}
function togglePlay() {
  if (walker.finished) {
    walker.restart();
    toast('Recomeçando a rota.', 1800);
  } else {
    walker.auto = !walker.auto;
    toast(walker.auto ? 'Caminhando pela rota.' : 'Caminhada pausada.', 1500);
  }
  renderPlay();
}
ui.playBtn.addEventListener('click', togglePlay);
walker.onArrive = () => {
  toast('Destino alcançado.', 4000);
  renderPlay();
};
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
    e.preventDefault();
    togglePlay();
  }
});
renderPlay();

function renderSpeed() {
  const s = walker.speed;
  ui.speedBtn.textContent = `${s.v.toLocaleString('pt-BR')} m/s`;
  ui.speedBtn.title = `Velocidade: ${s.label}`;
}
ui.speedBtn.addEventListener('click', () => {
  walker.cycleSpeed();
  renderSpeed();
  toast(`Velocidade: ${walker.speed.label} (${walker.speed.v.toLocaleString('pt-BR')} m/s)`, 1800);
});
renderSpeed();

ui.map2dBtn.addEventListener('click', () => widgets.toggle('map2d'));
ui.map3dBtn.addEventListener('click', () => widgets.toggle('map3d'));

// Caminhada livre: segurar Andar anda para onde você olha (e pausa o piloto automático)
walker.bindHold(ui.walkBtn);

// Modo estéreo: segurar em qualquer lugar da tela (ou o botão do Cardboard) = andar
renderer.domElement.addEventListener('pointerdown', () => {
  if (stereoOn) walker.holding = true;
});
['pointerup', 'pointercancel'].forEach((ev) =>
  renderer.domElement.addEventListener(ev, () => {
    if (stereoOn) walker.holding = false;
  })
);

async function setStereo(on) {
  stereoOn = on;
  look.dragEnabled = !on;
  widgets.enabled = !on; // no estéreo, o toque serve para andar
  walker.holding = false;
  document.body.classList.toggle('stereo', on);
  if (on) {
    try {
      if (!isFullscreen()) await enterFullscreen();
    } catch {
      /* segue sem tela cheia */
    }
    toast('Estéreo: segure a tela (ou o botão do Cardboard) para andar.');
    if (!look.sensorsActive) setTimeout(() => toast('Dica: ative os sensores antes do modo estéreo.'), 3600);
  }
  onResize();
}
ui.stereoBtn.addEventListener('click', () => setStereo(true));
ui.exitStereo.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.exitStereo.addEventListener('click', () => setStereo(false));
if (params.has('estereo')) {
  started = true;
  setStereo(true); // atalho para testar no PC
}

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
  if (route) widgets.rebuild(world, route.path);
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
  // Deitado (modo principal) o campo de visão horizontal fica largo: reduz o vertical para não distorcer
  camera.fov = w > h ? 55 : 70;
  camera.updateProjectionMatrix();
  updateRotateOverlay();
  syncFullscreenUi();
  renderer.setSize(w, h);
  stereo.setSize(w, h);
}
window.addEventListener('resize', onResize);
screen.orientation?.addEventListener?.('change', onResize);
document.addEventListener('fullscreenchange', onResize);
document.addEventListener('webkitfullscreenchange', onResize);
onResize();

// ---------- HUD ----------
const fwd = new THREE.Vector3();
const fmtDist = (m) => (Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const DIRS = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
function updateHud(ground, camYaw, hFov) {
  const heading = ((((-camYaw * 180) / Math.PI) % 360) + 360) % 360;
  ui.hudInfo.textContent =
    `${heading.toFixed(0).padStart(3, '0')}° ${DIRS[Math.round(heading / 45) % 8]} · ` +
    `elev. ${ground >= 0 ? '+' : ''}${fmtDist(ground)} · andou ${fmtDist(walker.walked)}`;
  ui.hudSource.textContent =
    `Agora: MOLA cromaticidade 1:1 + ${world.hiriseActive ? 'HiRISE perto' : 'Viking'}` +
    (world.loadingChunk ? ' · carregando terreno…' : '');
  if (!route) return;
  const p = camera.position;
  const dist = Math.hypot(route.dest.x - p.x, route.dest.z - p.z);
  let rel = yawOfDirection(route.dest.x - p.x, route.dest.z - p.z) - camYaw;
  rel = Math.atan2(Math.sin(rel), Math.cos(rel));
  let hint;
  if (walker.finished || dist < 6) hint = 'chegou';
  else if (Math.abs(rel) < (hFov / 2) * 0.8) hint = 'à frente';
  else if (rel > 0) hint = '← à esquerda';
  else hint = 'à direita →';
  const paused = walker.finished || walker.auto ? '' : ' · rota pausada';
  ui.hudDest.textContent = `Destino ${fmtDist(dist)} · ${hint}${paused}`;
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
  camera.getWorldDirection(fwd);
  const camYaw = yawOfDirection(fwd.x, fwd.z);
  const hFov = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
  if (route) {
    widgets.update(dt, t, {
      pos: camera.position,
      yaw: camYaw,
      hFov,
      path: route.path,
      progress: walker.progress,
      total: walker.total,
    });
  }
  sky.position.copy(camera.position);
  sun.position.copy(camera.position).addScaledVector(SUN_DIR, 2000);
  sun.target.position.copy(camera.position);
  route?.update(t, camera);
  if ((hudTimer += dt) > 0.1) {
    hudTimer = 0;
    updateHud(ground, camYaw, hFov);
    renderPlay();
  }
  ui.walkBtn.classList.toggle('active', walker.holding);
  if (stereoOn) stereo.render(scene, camera);
  else renderer.render(scene, camera);
});
