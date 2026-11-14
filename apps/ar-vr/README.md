# Visão VR (v0.2): caminhar em Marte pelo celular

Você fica de pé no terreno marciano em **escala real (1:1)**, na altura dos olhos (1,7 m).
Girando o celular, a câmera gira junto. **Segurando o botão "Andar"**, você caminha na direção
para onde está olhando. No chão há uma rota (faixa ciano com setas animadas) que leva até um
farol âmbar no destino.

- **Relevo:** é o mesmo do `apps/map-3d`. A cor do MOLA ClrShade é convertida em elevação por
  cromaticidade, numa faixa de **-8,2 a +21,2 km**. Depois as sombras são preenchidas e o
  resultado passa por uma suavização gaussiana (ver [`src/mola.js`](src/mola.js)).
- **Cor:** mosaico Viking MDIM 2.1. Em Jezero, o mosaico HiRISE/CTX/HRSC entra perto de você,
  com até ~1,3 m/px.
- **Tecnologia:** Three.js **0.160.0**, a mesma do mapa 3D, servida pelo Vite com HTTPS.
- **Locais:** os mesmos atalhos do mapa 3D. São eles Jezero (pouso do Perseverance), Olympus
  Mons, Valles Marineris e Gale.

## Como rodar

Você precisa do Node.js 20 ou mais novo.

```bash
cd apps/ar-vr
npm install
npm run dev
```

> **Windows/PowerShell:** se aparecer "a execução de scripts foi desabilitada", use `npm.cmd`
> no lugar de `npm` (por exemplo, `npm.cmd run dev`). O caminho da pasta tem espaços, então
> coloque-o entre aspas no `cd`:
> `cd "C:\...\NASA Space Apps Challenge\peixonautas-space-apps-2026\apps\ar-vr"`

### Opção A: HTTPS direto na rede Wi-Fi (recomendado)

O Vite mostra dois endereços:

```
➜  Local:   https://localhost:5173/
➜  Network: https://192.168.x.y:5173/
```

1. O PC e o celular precisam estar **na mesma rede Wi-Fi**.
2. No celular, abra o endereço **Network**, com `https://` e `:5173`.
3. O certificado é autoassinado, então o navegador vai avisar:
   - **iPhone (Safari):** Mostrar Detalhes → **visitar este site** → confirmar.
   - **Android (Chrome):** Avançado → **Continuar para 192.168.x.y (não seguro)**.
4. Toque em **Ativar sensores**. No iPhone, aceite o acesso a "Movimento e Orientação".
5. Se o celular não conseguir abrir a página, o mais provável é o **Firewall do Windows**.
   Permita o Node.js em *redes privadas* e confira se o Wi-Fi do PC está marcado como rede
   *Privada*. Algumas redes (de faculdade, de evento ou de convidados) isolam os aparelhos
   entre si. Nesse caso, use a opção B.

### Opção B: túnel (cloudflared ou ngrok)

```bash
# terminal 1: servidor em HTTP puro (o túnel fornece o HTTPS)
cd apps/ar-vr
npm run dev:tunnel

# terminal 2: cloudflared (não precisa de conta). Instale uma vez com:
#   winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:5173
#   ou ngrok (precisa de conta):
#   ngrok config add-authtoken <SEU_TOKEN>
#   ngrok http 5173
```

Abra no celular o endereço `https://….trycloudflare.com` ou `https://….ngrok-free.app` que
aparecer. Pelo túnel não há aviso de certificado.

### Testar no computador

Abra `https://localhost:5173/`. Arraste com o mouse para olhar e use **W/A/S/D** ou as setas
para andar. **Shift** deixa 5x mais rápido. Alguns parâmetros de URL úteis:

- `?local=olympus`, `?local=valles`, `?local=gale` ou `?local=jezero` escolhem o local;
- `?estereo=1` abre direto no modo estéreo.

## Como usar

| Controle | O que faz |
|---|---|
| **⬆ Andar** (segure) | Anda na direção em que você olha. No **modo estéreo**, segurar em qualquer ponto da tela (ou o botão do Cardboard) também anda. |
| **🚶 / 🚙 / 🚀** | Troca a velocidade: caminhada (1,4 m/s), rover (15 m/s) ou rápido (300 m/s). Em escala real, as distâncias são enormes: o Olympus Mons tem ~600 km de largura. |
| **Ativar sensores** | Liga o giroscópio. No iOS, isso chama `DeviceOrientationEvent.requestPermission()`. |
| **Recentralizar** | Alinha a direção atual do celular com o próximo trecho da rota. |
| **Tela cheia** | Funciona no Android e no iPad. No iPhone, use Compartilhar → **Adicionar à Tela de Início**. |
| **Estéreo** | Tela dividida para Cardboard (separação de 64 mm entre os olhos). |
| ⚙ | Local, escala vertical (1,0x = real, como no mapa 3D), resposta dos sensores e textura de detalhe. |

O HUD mostra a distância até o destino, para que lado virar, o rumo, a elevação em que você
está e quanto já andou.

## Como funciona

```
src/
  main.js         cena, céu, luz, interface, estéreo, tela cheia, HUD
  mola.js         elevação por cromaticidade do MOLA ClrShade (porta do map-3d)
  terrain.js      mundo em metros: blocos de terreno que se trocam ao andar,
                  remendos HiRISE no shader, textura de detalhe procedural
  locomotion.js   caminhar (botão, toque no estéreo, teclado), câmera presa ao chão
  orientation.js  DeviceOrientation -> quaternion, suavização, arrastar, recentralizar
  route.js        rota colada ao terreno: faixa, setas, farol
  places.js       locais (os mesmos atalhos do map-3d) e rota de exemplo
```

- **Blocos de terreno:** cada bloco tem 3×3 tiles em **z7**, cerca de 250 km de lado, com um
  vértice a cada ~650 m. O z7 é o maior zoom *nativo* do MOLA e do Viking no NASA Trek, então
  dar mais zoom não traz informação de relevo nova. Quando você atravessa para outro tile
  (cada um tem ~83 km), um bloco novo centrado em você é carregado e substitui o anterior.
- **Altura do chão:** `heightAt(x, z)` reproduz exatamente os triângulos da malha. A câmera
  fica a 1,7 m acima dela, com suavização vertical, e a rota também é desenhada a partir dela.
- **HiRISE em Jezero:** são dois "remendos" de textura, um em z12 (~13 km, ~10 m/px) e outro em
  z15 (~1,6 km, ~1,3 m/px). Eles são misturados no shader do terreno pela posição no mundo e se
  recentralizam conforme você anda. Como não são malhas extras, não há z-fighting nem costura.
- **Textura de detalhe:** perto dos pés, um ruído procedural escurece e clareia levemente o
  chão. Ela **não é um dado real**: serve só para dar noção de movimento, porque o dado mais
  fino tem centenas de metros por pixel. Ela some à distância e quando ficaria menor que um
  pixel, e dá para desligar em ⚙.
- **Profundidade:** o renderizador usa `logarithmicDepthBuffer`, que dá precisão tanto para a
  rota a 10 cm do chão quanto para paredões a 80 km.
- **Normal map:** usa tangentes calculadas na geometria. Sem elas, o three.js deriva o
  referencial a partir de `dFdx(uv)`, que perde precisão perto da câmera e vira um "chuvisco"
  escuro.
- **Rota:** em Jezero, a rota de exemplo é definida em lat/lon. Nos outros locais, o ponto de
  partida é o lugar mais plano num raio de 15 km do preset, e a rota de ~800 m segue o rumo
  mais plano a partir dali.

## Limitações conhecidas

- **O relevo é uma reconstrução**, igual à do mapa 3D: ele vem da cor do MOLA ClrShade, não de
  um DEM medido. Exemplo: no centro do Olympus Mons (18,65°N, −133,8°), a reconstrução dá
  **−0,27 km**, enquanto o cume real fica em torno de +21 km. O mapa 3D mostra o mesmo valor
  (+0,03 km na tela dele). Então os paredões ao redor aparecem, mas a altitude absoluta do
  topo está errada. Próximo passo: um DEM real (MOLA MEGDR ou os DTMs HiRISE do NASA Trek).
- **As sombras do Viking são da foto.** O mosaico Viking é uma imagem, com sombras reais
  "gravadas" nela. As paredes de Valles Marineris, por exemplo, aparecem pretas em qualquer
  posição do sol.
- **Resolução:** fora de Jezero, o dado mais fino tem ~330 m/px. Por isso o chão perto de você
  é liso, e o detalhe visível é a textura procedural.
- **Sem curvatura:** o planeta é tratado como plano. Em Marte, o horizonte de uma pessoa de pé
  fica a ~3,4 km. Aqui dá para ver mais longe.
- **Andar fisicamente:** na v0.2 você anda pelo botão. Para andar com passos reais, a próxima
  etapa seria WebXR AR, que funciona no Chrome do Android.

## Proposta: código para `packages/shared` (ainda não movido)

Hoje estas partes estão **duplicadas** do `apps/map-3d/index.html`, e o map-3d não foi
alterado:

- a elevação por cromaticidade, o preenchimento de sombras e a suavização gaussiana (`src/mola.js`);
- a geometria dos tiles do Trek, as camadas e o carregamento WMTS com cache (`src/terrain.js`).

A proposta é criar `packages/shared/` com essas funções, mais os modelos de rota e waypoints.
O mapa 2D, o mapa 3D e a Visão VR passariam a importar dali. Assim, uma correção no relevo
(como a do cume do Olympus) vale para todas as visões ao mesmo tempo.
