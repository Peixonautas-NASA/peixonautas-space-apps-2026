# Sprint: transitabilidade manual

**Status: IMPLEMENTADO — 2026-11-14.**

Entrega: primeira camada de interpretação manual do terreno no planejador 2D,
sem inferir propriedades do solo a partir de brilho de imagens. O DTM continua
sendo a fonte de elevação, e o A* continua compartilhado e executado em worker.

Critérios verificados:

- Desenhar polígonos, desfazer vértices, cancelar, reclassificar e remover áreas.
- Camada desligada preserva o comportamento anterior; ativação explícita aplica
  áreas bloqueadas/difíceis/normais/desconhecidas e política para o restante.
- Bloqueios e margem não são liberados por peso zero; custos por metro são
  não negativos e aparecem na decomposição do custo da rota.
- Rasterização conservadora preserva obstáculos finos e reavalia a geometria
  quando o terreno muda de área ou resolução; não altera elevação ou declividade.
- Persistência por origem do navegador; exportação/importação de áreas, política
  e peso. Importações inválidas não apagam dados existentes. Rotas exportadas
  carregam as interpretações e parâmetros utilizados.
- Alterações invalidam resultados antigos, inclusive cálculos em andamento.
- Testes com dados reais de Gale, modo arquivo local e serviço automático HTTP.

Referências de implementação e testes:

- `packages/shared/navigation/planner.js`
- `apps/map-2d/traversability-editor.js`
- `apps/map-2d/route-planner.js`
- `packages/shared/navigation/tests/traversability.cjs`
- `apps/map-2d/tests/traversability.cjs`

Não fazem parte desta entrega: classificação automática por imagens, rugosidade
adicional do DTM, modelos de tempo/energia, autonomia de retorno ou visada de
comunicação. São próximas propostas; nenhum desses fatores foi incorporado
silenciosamente ao custo atual.

Rastreabilidade: implementação e testes elaborados com auxílio de Codex.
Classificações manuais permanecem identificadas como interpretação, não sensor.
