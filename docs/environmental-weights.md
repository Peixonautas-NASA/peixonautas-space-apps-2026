# Pesos ambientais nas rotas

Em `apps/map-2d/index.html`, abra **Radiação, temperatura e magnetismo**. Cada peso começa em zero. Escolha uma fonte e um peso positivo para incluí-lo no A*. Há três opções: desligado, cenário uniforme e grade JSON importada. O botão **Usar exemplo SINTÉTICO** cria uma região central artificial para testar desvios; seus valores não são observações de Marte.

Um cenário uniforme permite testar a importância relativa dos critérios. Como não contém variação espacial, favorece menor tempo de percurso; não identifica um corredor ambiental mais favorável.

## Custo e hipóteses

O custo anterior de distância, inclinação, subida e transitabilidade permanece. Em cada aresta, o algoritmo usa a média dos valores/penalidades dos dois extremos e tempo `distância horizontal / velocidade constante`. Os termos adicionais são:

- Radiação: `1000 × peso × dose estimada / dose de referência`, com taxa em µSv/h e dose em µSv.
- Temperatura: `1000 × peso × horas × desvio da faixa / desvio de referência`. Dentro da faixa o desvio é zero; fora dela é a distância à extremidade mais próxima, em °C.
- Magnetismo: `1000 × peso × horas × max(0, campo − limiar) / excesso de referência`, com campo em nT.

O fator 1000 apenas ajusta a escala da pontuação comparativa frente ao custo de distância em metros; não é uma conversão física. As referências são parâmetros de normalização ajustáveis, não limites de saúde ou de equipamento. Magnetismo é um critério experimental de preferência por magnitude do campo; não se presume que indique risco ou proteção contra radiação.

Os campos são estáticos. A velocidade não varia com terreno, subida, paradas ou condições ambientais. A dose é a integral da taxa fornecida ao longo desse tempo hipotético, sem modelo de blindagem. Temperatura do ar e da superfície são grandezas distintas, preservadas nos metadados. O algoritmo não calcula temperatura corporal, do veículo ou consumo térmico.

## Formato das grades

Exemplo **inteiramente sintético**, com quatro células, linhas do norte para o sul e colunas do oeste para o leste:

```json
{
  "schemaVersion": 1,
  "planet": "Mars",
  "quantity": "radiationDoseEquivalentRate",
  "unit": "uSv/h",
  "width": 2,
  "height": 2,
  "bounds": { "latMin": -4.75, "latMax": -4.53, "lonMin": 137.31, "lonMax": 137.55 },
  "values": [10, 20, 10, null],
  "source": {
    "kind": "scenario",
    "reference": "surface",
    "title": "Exemplo sintético de formato; sem medições",
    "url": "",
    "resolutionM": 7000,
    "temporalContext": "Cenário artificial estático",
    "note": "Não representa o ambiente real de Gale"
  }
}
```

As combinações aceitas são:

| Camada | quantity | unit |
| --- | --- | --- |
| Radiação | radiationDoseEquivalentRate | uSv/h |
| Temperatura do ar | airTemperature | degC |
| Temperatura da superfície | surfaceTemperature | degC |
| Magnetismo | magneticFieldMagnitude | nT |

`source.kind` aceita `scenario`, `model` ou `observation`. Fonte, contexto temporal, resolução e referência de superfície são obrigatórios; a aplicação valida o formato, mas não verifica a autenticidade da procedência declarada. Campos orbitais não podem ser importados como medidas de superfície sem um modelo externo apropriado. Coordenadas são latitudes planetocêntricas e longitudes leste de Marte, em graus; grades não atravessam o antimeridiano e ficam entre ±75° de latitude. Máximo de 250 mil células por grade e 20 MB por arquivo importado.

O alinhamento ao DTM usa a célula ambiental que contém o centro da célula de terreno. Não interpola detalhes inexistentes. O resultado informa resolução efetiva conservadora: o maior valor entre resolução declarada e dimensões geográficas das células ambientais. Fora da cobertura e valores `null` ficam indisponíveis para passagem quando o peso daquela camada é positivo. Peso zero ignora a camada completamente. Se A ou B estiver sem dados, há uma mensagem específica; uma barreira sem dados pode impedir uma rota.

Grades ficam na memória da sessão. Exporte a configuração para preservá-las. O GeoJSON da rota inclui parâmetros, grades originais, procedência declarada, custos por critério e métricas ambientais, permitindo reproduzir o cálculo.

## Dados observacionais

Esta implementação não baixa automaticamente mapas ambientais. As medições [RAD no Curiosity](https://science.nasa.gov/resource/radiation-measurements-on-mars/) são locais. O [serviço de meteorologia REMS](https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json) não fornece uma grade espacial de temperatura da área inteira e destina-se à divulgação. Tampouco se deve tratar um modelo magnético orbital como um mapa de superfície na resolução de um DTM. Para usar observações ou modelos reais, prepare uma grade com cobertura, período e referência compatíveis e importe-a com a procedência correspondente.

## Verificação

`node --test packages/shared/navigation/tests/*.cjs tools/terrain/tests/*.test.mjs`

Inclui conservação dos custos, dose versus velocidade, faixa térmica, limiar magnético sem alteração de dose, desvios espaciais para os três critérios, NoData, validação de unidades/procedência e preservação da rota com pesos zero.
