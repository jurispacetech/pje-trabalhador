# Trabalhador do PJe — imagem com Chromium + dependências do navegador já prontas.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app
ENV TZ=America/Sao_Paulo NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY assinador.mjs totp.mjs trabalhador.mjs robo-a1.mjs probe-robo.mjs teste-login.mjs sincronizar.mjs agenda.mjs ./

# Movimentações da JulIA: a agenda roda a sincronização das intimações (robô A1) às 08h e 14h.
# Para rodar uma vez ao subir (1º teste), definir SINC_JA=1 no ambiente do EasyPanel.
CMD ["node", "agenda.mjs"]
