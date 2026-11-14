import { sampleMission, planRoute } from '@peixonautas/shared';

// TODO: inicializar CesiumJS (Viewer + terreno) e desenhar a rota como polyline.
const route = planRoute(sampleMission.terrain, sampleMission.start, sampleMission.goal);
document.getElementById('app').innerHTML =
  `<h1>Mapa 3D</h1><p>Rota de exemplo com ${route.length} pontos.</p>`;
