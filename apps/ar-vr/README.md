# Visão VR (v0.1): primeira pessoa no terreno marciano

Visão em primeira pessoa no chão de Mars, na altura dos olhos (1,7 m), no ponto de pouso do
Perseverance (Cratera Jezero). Quando você gira o celular, a câmera gira junto, como se fosse
uma janela para o local. No chão aparece uma **rota de exemplo**: uma faixa ciano com setas
animadas que leva até um farol âmbar no destino.

- **Tecnologia:** Three.js **0.160.0**, a mesma versão do `apps/map-3d`. Aqui ela vem do npm e
  é servida pelo Vite, que também fornece o HTTPS.
- **Dados:** os mesmos tiles WMTS do NASA Trek usados no mapa 3D: cor Viking MDIM 2.1,
  relevo MOLA ClrShade e o mosaico HiRISE/CTX/HRSC de Jezero. A fórmula de pseudo-elevação
  também é a mesma.
- **Controles:** sensores do celular (`DeviceOrientationEvent`) com suavização. No PC, ou sem
  sensores, dá para arrastar com o dedo ou o mouse.
- **Extras:** tela cheia, modo **estéreo** (tela dividida para óculos tipo Cardboard),
  "Recentralizar" e ⚙ ajustes (exagero do relevo e quanto os sensores são suavizados).

## Como rodar

Você precisa do Node.js 20 ou mais novo.

```bash
cd apps/ar-vr
npm install
```

### Opção A: HTTPS direto na rede Wi-Fi (recomendado)

```bash
npm run dev
```

O Vite mostra dois endereços:

```
➜  Local:   https://localhost:5173/
➜  Network: https://192.168.x.y:5173/
```

1. O PC e o celular precisam estar **na mesma rede Wi-Fi**.
2. No celular, abra o endereço **Network** (`https://192.168.x.y:5173/`). Se ele não aparecer,
   descubra o IP do PC com `ipconfig` (Windows; procure "Endereço IPv4" do adaptador Wi-Fi)
   ou `ipconfig getifaddr en0` (macOS).
3. O certificado é autoassinado, então o navegador vai avisar:
   - **iPhone (Safari):** "Esta conexão não é privada" → **Mostrar Detalhes** → **visitar este site** → confirmar.
   - **Android (Chrome):** "Sua conexão não é particular" → **Avançado** → **Continuar para 192.168.x.y (não seguro)**.
4. Toque em **Ativar sensores**. No iPhone, aceite o pedido de acesso a "Movimento e Orientação".
5. Se o celular não conseguir abrir a página, o mais provável é o **Firewall do Windows**.
   Na primeira execução, permita o Node.js em **redes privadas**. Confira também se o Wi-Fi do
   PC está marcado como rede *Privada*. Algumas redes (de faculdade, de evento ou de convidados)
   isolam os aparelhos entre si. Nesse caso, use a opção B.

### Opção B: túnel (cloudflared ou ngrok), quando a rede local bloqueia

O túnel cria um endereço HTTPS público com certificado válido, então não aparece aviso de
segurança. Use dois terminais:

```bash
# terminal 1: servidor em HTTP puro (o túnel cuida do HTTPS)
cd apps/ar-vr
npm run dev:tunnel
```

**cloudflared** (não precisa de conta):

```bash
# instalar uma vez no Windows:
winget install --id Cloudflare.cloudflared
# terminal 2:
cloudflared tunnel --url http://localhost:5173
```

Abra no celular o endereço `https://<algo>.trycloudflare.com` que aparecer.

**ngrok** (precisa de conta gratuita e authtoken):

```bash
ngrok config add-authtoken <SEU_TOKEN>
ngrok http 5173
```

Abra o endereço `https://<algo>.ngrok-free.app`. Os domínios dos túneis já estão liberados em
`server.allowedHosts` no [`vite.config.js`](vite.config.js).

### Testar no computador

Abra `https://localhost:5173/` e arraste com o mouse para olhar em volta. Para ver o modo
estéreo sem celular, use `https://localhost:5173/?estereo=1`.

## Como usar

| Botão | O que faz |
|---|---|
| **Ativar sensores** | Liga o giroscópio/bússola. No iOS isso chama `DeviceOrientationEvent.requestPermission()`, que precisa de um toque do usuário. Toque de novo para desligar. |
| **Recentralizar** | Gira a cena para que a direção em que o celular aponta agora fique alinhada com a rota. Sem bússola confiável, é isso que alinha você ao caminho. |
| **Tela cheia** | Funciona no Android e no iPad. O **iPhone não permite tela cheia** em páginas: use Compartilhar → **Adicionar à Tela de Início** e abra pelo ícone. |
| **Estéreo** | Divide a tela em olho esquerdo e direito (separação de 64 mm) para usar com Cardboard. Vire o celular na horizontal. No Android a orientação também fica travada. |
| ⚙ | Ajusta o exagero do relevo e a resposta dos sensores (mais baixo = mais suave, com mais atraso). |

Com os sensores ligados, arrastar na horizontal corrige só o rumo, o que ajuda a compensar o
desvio da bússola.

## Como funciona

```
src/
  main.js         cena, céu, luz, interface, estéreo, tela cheia, HUD
  terrain.js      tiles NASA Trek -> malha métrica (1 un = 1 m) com alturas na CPU
                  + "remendo" HiRISE de alta resolução perto do usuário
  orientation.js  DeviceOrientation -> quaternion, suavização, arrastar, recentralizar
  route.js        rota de exemplo (lat/lon) colada ao terreno: faixa, setas, farol
```

- **Terreno:** grade de 5×5 tiles em **z13** (~6 km, ~5 m/px) em volta do ponto inicial.
  Mais um remendo de 5×5 tiles HiRISE em **z16** (~800 m, ~0,6 m/px) que se funde ao terreno
  base por um degradê radial. O mosaico de Jezero tem tiles até z17. A névoa, na cor do
  horizonte, esconde a borda do terreno.
- **Por que não reaproveitar a malha do map-3d:** lá o relevo é aplicado na GPU
  (`displacementMap`), numa escala de 1° = 10 unidades. Assim a CPU não sabe a altura do chão
  e "1,7 m" não tem significado. Aqui as alturas ficam nos vértices, em metros, e
  `heightAt(x, z)` reproduz exatamente os triângulos da malha. Com isso, a câmera e a rota
  ficam sempre coladas ao solo.
- **Sensores:** `alpha/beta/gamma` → quaternion (mesma conversão do antigo
  `DeviceOrientationControls` do Three.js), compensando a rotação da tela. O movimento é
  suavizado por `slerp` exponencial, independente do FPS. O "Recentralizar" aplica uma rotação
  de rumo por cima.

## Limitações conhecidas (v0.1)

- **O relevo é aproximado.** Assim como no mapa 3D, a altura vem da *cor* do MOLA sombreado
  (`0,55·hipsometria + 0,45·luminância`), e não de um modelo digital de elevação (DEM). A escala
  de 1500 m por unidade foi escolhida a olho, e você pode ajustá-la em ⚙. Próximo passo: usar
  um DEM de verdade, como o DTM de Jezero do NASA Trek ou o MOLA MEGDR, em `packages/shared`.
- A posição é fixa: dá para girar, mas não para andar.
- Com a resolução disponível, o chão a menos de 1 m dos pés continua borrado.
- Não usa WebXR. Esta versão é "janela mágica" + Cardboard. A próxima etapa, com WebXR, deve
  reaproveitar a mesma cena.

## Proposta: código para `packages/shared` (ainda não movido)

Hoje estas partes estão **duplicadas** do `apps/map-3d/index.html`, e os arquivos do map-3d não
foram alterados:

- a geometria dos tiles do Trek (`latLonToTile`, `tileBounds`) e as URLs/IDs das camadas;
- o carregamento de tiles com cache e o recorte quando se pede um zoom acima do nativo (`drawLayerTile`);
- a pseudo-elevação MOLA e o normal map por Sobel.

A proposta é criar `packages/shared/trek-tiles.js` com essas funções e, mais adiante, os
modelos de rota e waypoints. O mapa 2D, o mapa 3D e a Visão VR passariam a importar dali.
Isso fica para quando a equipe aprovar.
