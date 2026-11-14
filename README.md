# 🐟🚀 Peixonautas · NASA Space Apps Challenge 2026

Software de navegação para astronautas em superfície planetária, pensado para rodar em um
display de antebraço e no visor do capacete. Três visões compartilham os mesmos dados de
terreno, rotas e lógica de planejamento:

| Visão | Pasta | Tecnologia | Para quê |
|---|---|---|---|
| Mapa 2D | [`apps/map-2d`](apps/map-2d) | Leaflet / OpenLayers | Visão rápida no antebraço, camadas ótica, térmica, elevação, perigos |
| Mapa 3D | [`apps/map-3d`](apps/map-3d) | CesiumJS | Terreno 3D, planejamento de rota e briefing |
| Visão AR/VR | [`apps/ar-vr`](apps/ar-vr) | Three.js + WebXR | HUD do capacete com rota sobreposta ao terreno |
| Núcleo comum | [`packages/shared`](packages/shared) | JavaScript (ES modules) | Terreno, rotas, waypoints, alertas |

## Estrutura

```
apps/
  map-2d/      Mapa 2D com camadas
  map-3d/      Globo/terreno 3D
  ar-vr/       Visão AR/VR do capacete (protótipo inicial em Three.js)
packages/
  shared/      Modelos de dados e planejamento de rota usados pelas três visões
data/          Amostras de dados NASA (DEMs, imagens) usadas na demo
docs/          Arquitetura, decisões e material da submissão
```

## Como rodar

Requer Node.js 20+.

```bash
npm install
npm run dev:2d     # mapa 2D
npm run dev:3d     # mapa 3D
npm run dev:ar     # visão AR/VR
```

O protótipo AR atual também abre direto no navegador: `apps/ar-vr/index.html`.

## Equipe

Peixonautas: adicione aqui os nomes e papéis.

## Dados e créditos

Liste aqui cada conjunto de dados NASA usado (nome, link, licença). Veja [`data/README.md`](data/README.md).

## Licença

MIT, veja [LICENSE](LICENSE).
