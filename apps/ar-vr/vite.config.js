import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev`        -> HTTPS na rede local (certificado autoassinado), para abrir no celular via Wi-Fi.
// `npm run dev:tunnel` -> HTTP puro em localhost, para expor com cloudflared/ngrok (o túnel fornece o HTTPS).
export default defineConfig(({ mode }) => {
  const tunnel = mode === 'tunnel';
  return {
    plugins: tunnel ? [] : [basicSsl()],
    server: {
      host: true, // escuta em 0.0.0.0 para o celular conseguir acessar pelo IP do PC
      port: 5173,
      // Vite bloqueia hosts desconhecidos; libera os domínios dos túneis.
      allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app', '.ngrok.io'],
    },
  };
});
