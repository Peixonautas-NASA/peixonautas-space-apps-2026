# Arquitetura

```
             ┌────────────────────────┐
             │   packages/shared       │
             │ terreno · rotas · alertas│
             └──────────┬─────────────┘
       ┌────────────────┼────────────────┐
  apps/map-2d      apps/map-3d       apps/ar-vr
  (antebraço)     (planejamento)    (capacete)
```

- **Fonte única de verdade:** terreno, waypoints e rota vivem em `packages/shared`. As visões
  só desenham; nenhuma recalcula a rota por conta própria.
- **Por que monorepo:** as três visões dependem do mesmo núcleo. Um só repositório evita
  duplicar código e permite mudar o modelo de dados e as três telas no mesmo commit.
- **Tecnologias:** CesiumJS para 3D, Three.js + WebXR para AR/VR, biblioteca de mapas 2D a definir.

## Decisões

Registre aqui cada decisão importante (data, o que foi decidido, por quê).
