// Locais disponíveis: os mesmos atalhos do apps/map-3d (Jezero usa o ponto de pouso exato).
// `route` (opcional) em lat/lon; sem ela, uma rota de exemplo é gerada no rumo mais plano.
export const PLACES = {
  jezero: {
    name: 'Cratera Jezero · pouso do Perseverance',
    lat: 18.4447,
    lon: 77.4508,
    route: {
      destName: 'Destino de exemplo',
      points: [
        { lat: 18.4447, lon: 77.4508 },
        { lat: 18.4458, lon: 77.4511 },
        { lat: 18.4467, lon: 77.4519 },
        { lat: 18.4482, lon: 77.4513 },
        { lat: 18.4498, lon: 77.4501 },
      ],
    },
  },
  olympus: { name: 'Olympus Mons (vulcão)', lat: 18.65, lon: -133.8 },
  valles: { name: 'Valles Marineris (cânion)', lat: -13.9, lon: -59.2 },
  // exactStart: nasce exatamente no ponto (sem procurar o lugar mais plano por perto)
  // dem: relevo real (DEM HiRISE + HRSC/MOLA) em public/gale/
  gale: { name: 'Cratera Gale (Monte Sharp)', lat: -4.59, lon: 137.44, exactStart: true, dem: 'gale' },
};
export const DEFAULT_PLACE = 'gale'; // ponto de localização da equipe: Cratera Gale (-4,59; 137,44)

/** Rota de exemplo genérica: ~800 m com uma curva, saindo de (x, z) no rumo `yaw` (o mais plano). */
export function exampleRouteFrom(x, z, yaw) {
  const pt = (d, turn) => ({ x: x - Math.sin(yaw + turn) * d, z: z - Math.cos(yaw + turn) * d });
  return [pt(0, 0), pt(150, 0.05), pt(320, 0.18), pt(520, 0.12), pt(800, -0.02)];
}
