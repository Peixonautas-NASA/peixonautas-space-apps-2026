import * as THREE from 'three';
import { StereoEffect } from 'three/addons/effects/StereoEffect.js';
import { loadTerrain, loadDetailPatch } from './terrain.js';
import { LookControls, yawOfDirection } from './orientation.js';
import { buildRoute, START } from './route.js';

const EYE_HEIGHT = 1.7; // m
const BASE_METERS_PER_UNIT = 1500; // pseudo-elevação 0..1 -> metros (ver README: relevo aproximado)
const SKY_TOP = new THREE.Color(0x4a3328);
const SKY_HORIZON = new THREE.Color(0xc99a72);

const $ = (id) => document.getElementById(id);
const ui = {
  loading: $('loading'),
  loadingText: $('loadingText'),
  sensorsBtn: $('sensorsBtn'),
  recenterBtn: $('recenterBtn'),
  fullscreenBtn: $('fullscreenBtn'),
  stereoBtn: $('stereoBtn'),
  settingsBtn: $('settingsBtn'),
  settings: $('settings'),
  reliefSlider: $('reliefSlider'),
  reliefVal: $('reliefVal'),
  smoothSlider: $('smoothSlider'),
  smoothVal: $('smoothVal'),
  exitStereo: $('exitStereo'),
  hudHeading: $('hudHeading'),
  hudDest: $('hudDest'),
  hudSource: $('hudSource'),
  toast: $('toast'),
};

function toast(msg, ms = 3500) {
  ui.toast.textContent = msg;
  ui.toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ui.toast.classList.remove('show'), ms);
}

// ---------- Renderer / cena (mesmos ajustes de cor do map-3d) ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
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
scene.fog = new THREE.Fog(SKY_HORIZON, 150, 2300);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 8000);
camera.position.set(0, EYE_HEIGHT, 0);

// Céu marciano em degradê (cor do horizonte = cor da névoa, para esconder a borda do terreno)
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(5000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: SKY_TOP }, horizon: { value: SKY_HORIZON } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 horizon;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        gl_FragColor = vec4(mix(horizon, top, pow(h, 0.55)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
);
sky.renderOrder = -1;
scene.add(sky);

// Iluminação (sol com azimute 45° / elevação 30°, padrão do map-3d)
scene.add(new THREE.HemisphereLight(0xffe2c4, 0x3a2418, 0.55));
const sun = new THREE.DirectionalLight(0xfff1e0, 2.4);
{
  const az = (45 * Math.PI) / 180;
  const el = (30 * Math.PI) / 180;
  sun.position.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).multiplyScalar(1000);
}
scene.add(sun);

// ---------- Controles ----------
const look = new LookControls(camera, renderer.domElement);

// ---------- Terreno + rota ----------
let terrain = null;
let route = null;
let patch = null;
let destYaw = 0;
let aimYaw = 0;

async function init() {
  terrain = await loadTerrain({
    lat0: START.lat,
    lon0: START.lon,
    zoom: 13,
    grid: 5,
    metersPerUnit: BASE_METERS_PER_UNIT,
    onProgress: (d, t) => (ui.loadingText.textContent = `Baixando tiles NASA Trek… ${d}/${t}`),
  });
  scene.add(terrain.mesh);
  camera.position.y = terrain.heightAt(0, 0) + EYE_HEIGHT;

  route = buildRoute(terrain);
  scene.add(route.group);

  destYaw = yawOfDirection(route.dest.x, route.dest.z);
  // olhar inicial (e "Recentralizar"): ao longo do primeiro trecho da rota, para a faixa aparecer
  aimYaw = yawOfDirection(route.aim.x, route.aim.z);
  look.recenter(aimYaw);
  look.dragPitch = -0.12; // levemente para baixo, mostrando o caminho
  camera.quaternion.setFromEuler(new THREE.Euler(look.dragPitch, aimYaw, 0, 'YXZ'));

  ui.hudSource.textContent =
    terrain.hiriseCount > 0
      ? `Jezero · HiRISE+Viking+MOLA (z${terrain.zoom})`
      : `Viking+MOLA interpolado (z${terrain.zoom})`;
  ui.loading.classList.add('hidden');

  // Detalhe HiRISE perto do usuário (carrega depois, sem travar a entrada na cena)
  loadDetailPatch(terrain, { lat0: START.lat, lon0: START.lon, zoom: 16, grid: 5 })
    .then((p) => {
      if (!p) return;
      patch = p;
      scene.add(p.mesh);
      ui.hudSource.textContent = `Jezero · HiRISE z${p.zoom} perto · z${terrain.zoom} ao longe`;
    })
    .catch((e) => console.warn('Detalhe HiRISE indisponível', e));
  if (!window.isSecureContext) toast('Página sem HTTPS: sensores indisponíveis. Arraste para olhar.', 6000);
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

ui.recenterBtn.addEventListener('click', () => look.recenter(aimYaw));

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
  document.body.classList.toggle('stereo', on);
  if (on) {
    try {
      if (!isFullscreen()) await enterFullscreen();
      await screen.orientation?.lock?.('landscape');
    } catch {
      /* iOS não deixa travar a orientação: basta virar o celular */
    }
    if (window.innerHeight > window.innerWidth) toast('Vire o celular na horizontal e encaixe no Cardboard.');
    if (!look.sensorsActive) toast('Dica: ative os sensores antes do modo estéreo.');
  } else {
    screen.orientation?.unlock?.();
  }
  onResize();
}
ui.stereoBtn.addEventListener('click', () => setStereo(true));
ui.exitStereo.addEventListener('click', () => setStereo(false));
// Atalho para testar no PC: ?estereo=1
if (new URLSearchParams(location.search).has('estereo')) setStereo(true);

ui.settingsBtn.addEventListener('click', () => ui.settings.classList.toggle('open'));
ui.reliefSlider.addEventListener('input', () => {
  const k = parseFloat(ui.reliefSlider.value);
  ui.reliefVal.textContent = `${k.toFixed(1)}x`;
  if (!terrain) return;
  terrain.setVerticalScale(BASE_METERS_PER_UNIT * k);
  route.relayout();
  patch?.relayout();
  camera.position.y = terrain.heightAt(0, 0) + EYE_HEIGHT;
});
ui.smoothSlider.addEventListener('input', () => {
  // 1 (bem suave) .. 30 (quase sem filtro)
  look.smoothing = parseFloat(ui.smoothSlider.value);
  ui.smoothVal.textContent = look.smoothing.toFixed(0);
});

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
function updateHud() {
  camera.getWorldDirection(fwd);
  const camYaw = yawOfDirection(fwd.x, fwd.z);
  const heading = (((-camYaw * 180) / Math.PI) % 360 + 360) % 360; // 0 = N, 90 = L
  const dirs = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
  ui.hudHeading.textContent = `Rumo ${heading.toFixed(0).padStart(3, '0')}° ${dirs[Math.round(heading / 45) % 8]}`;
  if (!route) return;
  let rel = destYaw - camYaw;
  rel = Math.atan2(Math.sin(rel), Math.cos(rel));
  const hFov = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
  const dist = Math.round(Math.hypot(route.dest.x, route.dest.z));
  let hint;
  if (Math.abs(rel) < hFov / 2 * 0.8) hint = '▲ à frente';
  else if (rel > 0) hint = '◀ vire à esquerda';
  else hint = 'vire à direita ▶';
  ui.hudDest.textContent = `Destino ${dist} m (rota ${Math.round(route.total)} m) · ${hint}`;
}

// ---------- Loop ----------
const clock = new THREE.Clock();
let hudTimer = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  look.update(dt);
  sky.position.copy(camera.position);
  route?.update(t, camera);
  if ((hudTimer += dt) > 0.1) {
    hudTimer = 0;
    updateHud();
  }
  if (stereoOn) stereo.render(scene, camera);
  else renderer.render(scene, camera);
});
