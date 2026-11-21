# Trabalhador do PJe — imagem com Chromium + dependências do navegador já prontas.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app
ENV TZ=America/Sao_Paulo NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY assinador.mjs totp.mjs trabalhador.mjs robo-a1.mjs probe-robo.mjs teste-login.mjs ./

# Horários 07/14/18/21h (America/Sao_Paulo) já embutidos no trabalhador.
# Para rodar uma vez ao subir (1º teste), definir PJE_RODAR_JA=1 no ambiente do EasyPanel.
CMD ["node", "trabalhador.mjs"]
