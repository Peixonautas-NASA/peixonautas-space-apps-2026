# 🐟🚀 Peixonautas · NASA Space Apps Challenge 2026

Software de navegação para astronautas em superfície planetária, pensado para rodar em um
display de antebraço e no visor do capacete. Três visões compartilham os mesmos dados de
terreno, rotas e lógica de planejamento:

| Visão | Pasta | Tecnologia | Para quê |
|---|---|---|---|
| Mapa 2D | [`apps/map-2d`](apps/map-2d) | a definir | Visão rápida no antebraço, camadas ótica, térmica, elevação, perigos |
| Mapa 3D | [`apps/map-3d`](apps/map-3d) | CesiumJS | Terreno 3D, planejamento de rota e briefing |
| Visão AR/VR | [`apps/ar-vr`](apps/ar-vr) | Three.js + WebXR | HUD do capacete com rota sobreposta ao terreno |
| Núcleo comum | [`packages/shared`](packages/shared) | a definir | Terreno, rotas, waypoints, alertas |

## Estrutura

```
apps/
  map-2d/      Mapa 2D com camadas
  map-3d/      Globo/terreno 3D
  ar-vr/       Visão AR/VR do capacete
packages/
  shared/      Modelos de dados e planejamento de rota usados pelas três visões
data/          Amostras de dados NASA (DEMs, imagens) usadas na demo
docs/          Arquitetura, decisões e material da submissão
```

## Planejamento de rotas em Gale

Para buscar terreno automaticamente em outras áreas ou percursos maiores:

```powershell
npm.cmd ci --prefix tools/terrain
node tools/terrain/server.mjs
```

Abra **http://127.0.0.1:7878/**, escolha A/B e calcule. O modo automático usa
HRSC 30 m em Gale quando a área cabe na grade; fora dessa cobertura, usa MOLA
numérico de aproximadamente 463 m ou 3,7 km, informando a resolução. Os blocos
baixados ficam em cache; o primeiro acesso pode levar alguns minutos.
Limites atuais: etapas de até 1.500 km, latitudes de -75° a +75°, sem cruzar o
antimeridiano. [Serviço, catálogo e limitações](tools/terrain/README.md).

Abra [`apps/map-2d/index.html`](apps/map-2d/index.html) mantendo a estrutura de
pastas do repositório. O mapa inicia em uma área de aproximadamente 13 × 12 km
próxima ao Curiosity, com um recorte numérico HRSC de 30 m e uma rota de exemplo.
Use **Marcar A / Marcar B** (ou arraste os marcadores), ajuste os pesos de
distância, inclinação e subida, e clique em **Calcular rota A → B**. O limite
de inclinação bloqueia passagens; os pesos penalizam os trechos restantes.

O A* roda em um worker e permite exportar a rota com suas métricas e parâmetros.
É um protótipo regional: não inclui validação de obstáculos pequenos, solo ou
condições operacionais. Pesos e limites são hipóteses ajustáveis.

- [Fonte, recorte e preparação do DTM](data/gale/README.md)
- [Algoritmo, fórmula de custo e testes](packages/shared/navigation/README.md)

## Equipe

Peixonautas: adicione aqui os nomes e papéis.

## Dados e créditos

Liste aqui cada conjunto de dados NASA usado (nome, link, licença).

## Licença

MIT, veja [LICENSE](LICENSE).
