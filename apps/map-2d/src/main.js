import { sampleMission, planRoute } from '@peixonautas/shared';

// TODO: trocar por Leaflet/OpenLayers com camadas ótica, térmica, elevação e perigos.
const route = planRoute(sampleMission.terrain, sampleMission.start, sampleMission.goal);
document.getElementById('app').innerHTML =
  `<h1>Mapa 2D</h1><p>Rota de exemplo com ${route.length} pontos.</p>`;
