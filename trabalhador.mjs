// Trabalhador do PJe — roda NO SERVIDOR (container no EasyPanel, IP brasileiro).
// A cada rodada: varre os escritórios com certificado guardado, lê o A1 + a senha do cofre e o
// código 2FA do autenticador PDPJ, faz o login no PJe nacional pelo IP do servidor, consulta os
// processos do escritório no PDPJ e atualiza o estado do certificado. Grava a contagem de hoje
// no log (a escrita das movimentações no histórico do cliente é a fase 2).
//
// Variáveis de ambiente (no EasyPanel):
//   DATABASE_URL   conexão do Supabase (pooler) — obrigatória
//   PJE_LIMITE     nº de processos por escritório por rodada (padrão 8)
//   PJE_RODAR_JA   "1" = roda uma vez ao subir o container (bom para o 1º teste); senão só nos horários
//   TZ             America/Sao_Paulo (definido no Dockerfile)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import cron from 'node-cron';
import { chromium } from 'playwright';
import { carregarA1, iniciarAssinador } from './assinador.mjs';
import { codigoTotp, segundosRestantes } from './totp.mjs';

const LOGIN_URL = 'https://sso.cloud.pje.jus.br/auth/realms/pje/protocol/openid-connect/auth?client_id=jusbr&scope=openid&redirect_uri=https://www.jus.br&response_type=code';
const CONSULTA_URL = 'https://portaldeservicos.pdpj.jus.br/consulta-processual';
const API_PROCESSOS = 'https://portaldeservicos.pdpj.jus.br/api/v2/processos';
// Fluxo OAuth2 oficial do SSO (Keycloak, realm pje). Clientes públicos, na ordem de preferência: o do Portal de
// Serviços (é o token que a API /api/v2 aceita; config pública em /assets/config/env.js) e, de reserva, o do login.
const SSO_OIDC = 'https://sso.cloud.pje.jus.br/auth/realms/pje/protocol/openid-connect';
const OIDC_CLIENTES = [['portalexterno-frontend', 'https://portaldeservicos.pdpj.jus.br'], ['jusbr', 'https://www.jus.br']];
const LIMITE = Number(process.env.PJE_LIMITE || 8);
const PADRAO_PJE = /pdpj|pj-?e|jus\.?br/i;

// Log no console E num arquivo (ler no EasyPanel: Console → tail -n 80 /tmp/movimentacoes-julia.log).
const ARQ_LOG = process.env.PJE_LOG || '/tmp/movimentacoes-julia.log';
try { if (fs.statSync(ARQ_LOG).size > 5e6) fs.renameSync(ARQ_LOG, ARQ_LOG + '.old'); } catch { /* ainda não existe */ }
const log = (...a) => {
  const linha = new Date().toISOString() + ' ' + a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ');
  console.log(linha);
  try { fs.appendFileSync(ARQ_LOG, linha + '\n'); } catch { /* sem disco: segue só no console */ }
};
const hojeBRT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const dataBRT = (v) => { const d = new Date(v); return isNaN(d) ? null : d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); };

function conectar() {
  if (!process.env.DATABASE_URL) throw new Error('falta DATABASE_URL');
  return new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

async function escritoriosParaRodar(c) {
  return (await c.query("select escritorio_id from pje_certificados where status in ('pendente','ativo','erro') order by atualizado_em")).rows.map((r) => r.escritorio_id);
}
async function lerCertificado(c, esc) {
  const r = (await c.query("select integracao_segredo_ler($1,'pje_pfx') pfx, integracao_segredo_ler($1,'pje_senha') senha", [esc])).rows[0] || {};
  if (!r.pfx || !r.senha) throw new Error('certificado ausente no cofre');
  return { pfxBase64: r.pfx, senha: r.senha };
}
async function lerTotp(c, esc) {
  const linhas = (await c.query('select id, nome, conta, digitos, periodo, algoritmo from escritorio_autenticadores where escritorio_id=$1', [esc])).rows;
  const aut = linhas.find((l) => PADRAO_PJE.test(l.nome || '')) || linhas.find((l) => PADRAO_PJE.test(l.conta || ''));
  if (!aut) return null;
  const mapa = (await c.query('select autenticadores_segredos($1) m', [esc])).rows[0].m || {};
  if (!mapa[aut.id]) return null;
  return { nome: aut.nome, segredo: mapa[aut.id], digitos: Number(aut.digitos) || 6, periodo: Number(aut.periodo) || 30 };
}
async function numerosDoEscritorio(c, esc) {
  const cols = (await c.query("select column_name from information_schema.columns where table_name='processos'")).rows.map((r) => r.column_name);
  const colNum = cols.find((n) => /^numero(_processo)?$/.test(n)) || cols.find((n) => /numero/.test(n));
  const temEsc = cols.includes('escritorio_id');
  const nums = new Set();
  if (colNum) for (const r of (await c.query(`select ${colNum} as n from processos where ${colNum} is not null` + (temEsc ? ' and escritorio_id=$1' : ''), temEsc ? [esc] : [])).rows) nums.add(r.n);
  for (const r of (await c.query('select numero_processo as n from clientes where numero_processo is not null and escritorio_id=$1', [esc])).rows) nums.add(r.n);
  return [...nums].map((n) => String(n).replace(/\D/g, '')).filter((n) => n.length === 20);
}
function extrairMovimentos(obj, achados = []) {
  if (Array.isArray(obj)) {
    if (obj.length && obj.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      const k = Object.keys(obj[0]);
      const kData = k.find((n) => /^(dataHora|data|dataMovimento|dataHoraMovimento|dataMovimentacao)$/i.test(n));
      const kDesc = k.find((n) => /^(descricao|nome|movimento|nomeMovimento|texto)$/i.test(n));
      if (kData && kDesc) { for (const m of obj) achados.push({ data: m[kData], descricao: m[kDesc] }); return achados; }
    }
    for (const x of obj) extrairMovimentos(x, achados);
  } else if (obj && typeof obj === 'object') for (const v of Object.values(obj)) extrairMovimentos(v, achados);
  return achados;
}

// Origens em que o navegador apresenta o A1 se o servidor pedir certificado (mTLS) — o Portal Jus.br
// pode autenticar pelo navegador em vez do PJe Office; assim os dois caminhos ficam cobertos.
const ORIGENS_CERT = ['https://sso.cloud.pje.jus.br', 'https://www.jus.br', 'https://portaldeservicos.pdpj.jus.br'];
// Promessa com prazo: nenhuma leitura da página pode segurar a rodada para sempre.
const comTempo = (p, ms, padrao) => Promise.race([Promise.resolve(p).catch(() => padrao), new Promise((ok) => setTimeout(() => ok(padrao), ms))]);
const TETO_LOGIN_MS = 240000;

// Abre o assinador na 8800. A página do PJe só fala nessa porta, então duas rodadas não podem coexistir:
// se outra ainda estiver com a porta (rodada do boot + teste à mão, por exemplo), espera ela terminar (até 5 min).
async function abrirAssinador(a1) {
  const ate = Date.now() + 300000; let avisou = false;
  for (;;) {
    try { return await iniciarAssinador({ a1, log }); } catch (e) {
      if (e.code !== 'EADDRINUSE' || Date.now() > ate) throw e;
      if (!avisou) { avisou = true; log('  porta 8800 ocupada por outra rodada — aguardando ela terminar…'); }
      await new Promise((ok) => setTimeout(ok, 5000));
    }
  }
}

// Faz o login por certificado + 2FA e devolve o bearer do PDPJ (ou lança erro).
async function logar(a1, totpConf, certNav, numeros = []) {
  const assinador = await abrirAssinador(a1);
  const navegador = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const contexto = await navegador.newContext({
      locale: 'pt-BR',
      clientCertificates: ORIGENS_CERT.map((origin) => ({ origin, pfxPath: certNav.pfxPath, passphrase: certNav.senha })),
    });
    const pagina = await contexto.newPage();
    const cap = { bearer: null, origem: null, qualquer: null };
    const rede = []; // últimas requisições, para o diagnóstico
    const anota = (s) => { rede.push(s); if (rede.length > 30) rede.shift(); };
    // No CONTEXTO (não só nesta página): pega o bearer mesmo se o portal abrir outra aba.
    contexto.on('request', (r) => {
      const u = r.url(); const h = r.headers()['authorization'];
      let host = ''; try { host = new URL(u).hostname; } catch { /* url estranha */ }
      if (h && /^bearer /i.test(h) && /\.jus\.br$/.test(host)) {
        if (!cap.bearer && /\/api\//.test(u)) { cap.bearer = h; cap.origem = u.slice(0, 140); }
        else if (!cap.qualquer) cap.qualquer = { h, u: u.slice(0, 140) };
      }
      if (!/\.(png|jpe?g|gif|svg|woff2?|ttf|css|ico|map)(\?|$)/i.test(u)) anota(r.method() + ' ' + u.slice(0, 140));
    });
    contexto.on('requestfailed', (r) => anota('FALHOU ' + r.url().slice(0, 140) + ' ' + ((r.failure() || {}).errorText || '')));
    pagina.on('popup', (p) => anota('POPUP ' + p.url().slice(0, 140)));
    pagina.on('dialog', (d) => { anota('DIALOG ' + d.message().slice(0, 100)); d.dismiss().catch(() => {}); });
    const diagnostico = async () => {
      const url = pagina.url();
      const titulo = await comTempo(pagina.title(), 5000, '');
      const txt = await comTempo(pagina.evaluate(() => (document.body ? document.body.innerText : '')), 5000, '');
      return `URL=${url} título="${titulo}" texto="${String(txt).replace(/\s+/g, ' ').slice(0, 400)}" rede=[${rede.slice(-12).join(' | ')}]`;
    };

    const fluxo = async () => {
      await pagina.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // Portal Jus.br (tema novo): o botão se chama "Entrar com seu certificado digital" e pode ficar
      // atrás de "Outras opções de acesso". Na tela antiga era #kc-pje-office / onclick="autenticar(".
      await pagina.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      const candidatos = [
        pagina.getByRole('button', { name: /certificado digital/i }),
        pagina.getByRole('link', { name: /certificado digital/i }),
        pagina.getByText(/certificado digital/i),
        pagina.locator('[onclick^="autenticar("], #kc-pje-office'),
      ];
      const acharVisivel = async (loc) => { const n = await loc.count().catch(() => 0); for (let i = 0; i < n; i++) { const el = loc.nth(i); if (await el.isVisible().catch(() => false)) return el; } return null; };
      const primeiroExistente = async () => { for (const c of candidatos) if (await c.count().catch(() => 0)) return c.first(); return null; };
      const primeiroVisivel = async () => { for (const c of candidatos) { const v = await acharVisivel(c); if (v) return v; } return null; };
      // Espera a tela montar (algum candidato existir, mesmo escondido).
      for (let i = 0; i < 20 && !(await primeiroExistente()); i++) await pagina.waitForTimeout(1000);
      // Estratégias, em ordem: já visível → abre "Outras opções" com clique → abre por JS → clica o próprio botão por JS.
      const outras = pagina.getByText(/outras op[cç][oõ]es de acesso/i);
      let botao = await primeiroVisivel(); let clicadoPorJs = false;
      if (!botao) { const o = await acharVisivel(outras); if (o) { log('  abrindo "Outras opções de acesso"…'); await o.click({ timeout: 4000 }).catch(() => {}); await pagina.waitForTimeout(1500); botao = await primeiroVisivel(); } }
      if (!botao && (await outras.count().catch(() => 0))) { log('  abrindo "Outras opções de acesso" por JS…'); await outras.first().evaluate((el) => el.click()).catch(() => {}); await pagina.waitForTimeout(1500); botao = await primeiroVisivel(); }
      if (!botao) { const e = await primeiroExistente(); if (e) { log('  botão do certificado existe mas está escondido; clicando por JS…'); await e.evaluate((el) => el.click()).catch(() => {}); clicadoPorJs = true; botao = e; } }
      if (!botao) throw new Error('login não carregou o botão. ' + await diagnostico());
      if (!clicadoPorJs) {
        log('  botão do certificado encontrado, clicando…');
        // noWaitAfter: não fica preso esperando a navegação que o clique dispara — o diagnóstico abaixo mostra o que houve.
        await botao.click({ timeout: 10000, noWaitAfter: true });
      }
      log('  clique feito · URL agora: ' + pagina.url());
      await pagina.waitForTimeout(3000);
      log('  após o clique: ' + await diagnostico());

      const inicio = Date.now(); let totpFeito = false; let ultimoAviso = 0;
      while (Date.now() - inicio < 180000) {
        await pagina.waitForTimeout(1500);
        if (new URL(pagina.url()).hostname !== 'sso.cloud.pje.jus.br') break;
        if (Date.now() - ultimoAviso > 30000) { ultimoAviso = Date.now(); log('  aguardando o login… ' + await diagnostico()); }
        const otp = await comTempo(pagina.$('input[name="otp"], input#otp, input[name="totp"], input[autocomplete="one-time-code"]'), 5000, null);
        if (otp && !totpFeito) {
          if (!totpConf) throw new Error('o PJe pediu 2FA mas não há autenticador PDPJ cadastrado');
          if (segundosRestantes(Date.now(), totpConf.periodo) < 5) await pagina.waitForTimeout(6000);
          await otp.fill(codigoTotp(totpConf.segredo, Date.now(), { passo: totpConf.periodo, digitos: totpConf.digitos }));
          const btn = await pagina.$('#kc-login, button[type="submit"], input[type="submit"]');
          if (btn) await btn.click({ noWaitAfter: true }); else await otp.press('Enter');
          totpFeito = true; log('  código 2FA preenchido');
        }
      }
      if (new URL(pagina.url()).hostname === 'sso.cloud.pje.jus.br') throw new Error('não passou do login em 3 min. ' + await diagnostico());
      log('  passou do login → ' + pagina.url().slice(0, 120));

      // Token pela porta oficial: fluxo OAuth2 authorization_code + PKCE contra o SSO, cuja sessão já está aberta
      // (é o mesmo fluxo que o portal faz por baixo). Não passamos pela tela do Portal de Serviços — ela devolve 403
      // ao navegador automatizado, e a API em si responde normalmente (sem token dá 401). O contexto.request usa os
      // MESMOS cookies do navegador; com maxRedirects:0 o "code" vem no cabeçalho Location.
      // Para QUEM pedimos o token importa: a API do Portal de Serviços aceita o token do cliente que o próprio
      // portal usa (config pública em /assets/config/env.js: clientId "portalexterno-frontend"). O cliente do
      // login (jusbr) fica de reserva — o token dele sai com aud=["broker","account"] e a API o recusa.
      const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const tokenViaSso = async (cliente, redirect) => {
        const verificador = b64url(crypto.randomBytes(32));
        const desafio = b64url(crypto.createHash('sha256').update(verificador).digest());
        const estado = b64url(crypto.randomBytes(12));
        const urlAuth = `${SSO_OIDC}/auth?client_id=${encodeURIComponent(cliente)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=openid&state=${estado}&code_challenge=${desafio}&code_challenge_method=S256`;
        let codigo = null;
        try {
          const r = await contexto.request.get(urlAuth, { maxRedirects: 0, timeout: 30000 });
          const loc = r.headers()['location'] || '';
          try { const u = new URL(loc, redirect); codigo = u.searchParams.get('code') || new URLSearchParams(u.hash.slice(1)).get('code'); } catch { /* sem location */ }
          if (!codigo) { log(`  [${cliente}] SSO não devolveu code: HTTP ${r.status()} location="${loc.slice(0, 160)}" corpo="${(await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)}"`); return null; }
        } catch (e) { log(`  [${cliente}] pedido de autorização ao SSO falhou: ` + e.message); return null; }
        const corpo = new URLSearchParams({ grant_type: 'authorization_code', client_id: cliente, redirect_uri: redirect, code: codigo, code_verifier: verificador });
        try {
          const r = await fetch(`${SSO_OIDC}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: corpo });
          const txt = await r.text().catch(() => '');
          let j = {}; try { j = JSON.parse(txt); } catch { /* não era JSON */ }
          if (!(r.ok && j.access_token)) { log(`  [${cliente}] troca do code por token falhou: HTTP ${r.status} ${txt.replace(/\s+/g, ' ').slice(0, 160)}`); return null; }
          try { const p = JSON.parse(Buffer.from(j.access_token.split('.')[1], 'base64url').toString()); log(`  [${cliente}] token: aud=${JSON.stringify(p.aud)} azp=${p.azp} scope="${p.scope}" expira em ${Math.round((p.exp * 1000 - Date.now()) / 60000)} min`); } catch { /* sem claims legíveis */ }
          return 'Bearer ' + j.access_token;
        } catch (e) { log(`  [${cliente}] troca do code por token falhou: ` + e.message); return null; }
      };
      for (const [cliente, redirect] of OIDC_CLIENTES) {
        const b = await tokenViaSso(cliente, redirect);
        if (b) { cap.bearer = b; cap.origem = `SSO (authorization_code + PKCE, cliente ${cliente})`; break; }
      }
      // Alternativas: um bearer visto em outra chamada *.jus.br, ou um token que o jus.br guardou no navegador.
      if (!cap.bearer && cap.qualquer) { cap.bearer = cap.qualquer.h; cap.origem = cap.qualquer.u + ' (não era /api/)'; }
      if (!cap.bearer) {
        const jwt = await comTempo(pagina.evaluate(() => {
          const acha = (s) => { for (let i = 0; i < s.length; i++) { const v = s.getItem(s.key(i)) || ''; const m = v.match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/); if (m) return m[0]; } return null; };
          return acha(localStorage) || acha(sessionStorage);
        }), 5000, null);
        if (jwt) { cap.bearer = 'Bearer ' + jwt; cap.origem = 'armazenamento do navegador (jus.br)'; }
      }
      if (!cap.bearer) throw new Error('não obtive o token do SSO. ' + await diagnostico());
      log('  token obtido via: ' + cap.origem);
      return { cap, pagina, navegador, assinador };
    };
    const f = fluxo(); f.catch(() => {}); // o teto abaixo pode vencer antes; a rejeição de f fica tratada
    let teto;
    try { return await Promise.race([f, new Promise((_, rej) => { teto = setTimeout(() => rej(new Error('login travou (passou de 4 min)')), TETO_LOGIN_MS); })]); }
    finally { clearTimeout(teto); }
  } catch (e) {
    await navegador.close().catch(() => {});
    assinador.close();
    throw e;
  }
}

async function processarEscritorio(c, esc) {
  const marcarErro = (msg) => c.query('update pje_certificados set status=$2, ultimo_erro=$3, atualizado_em=now() where escritorio_id=$1', [esc, 'erro', String(msg).slice(0, 300)]).catch(() => {});
  let a1, totpConf;
  const cert = await lerCertificado(c, esc);
  const pfxTmp = path.join(os.tmpdir(), 'pje-' + esc + '-' + Date.now() + '.pfx');
  fs.writeFileSync(pfxTmp, Buffer.from(cert.pfxBase64, 'base64'), { mode: 0o600 });
  try { a1 = carregarA1(pfxTmp, cert.senha); } catch (e) { fs.rmSync(pfxTmp, { force: true }); await marcarErro('senha do certificado não abre o .pfx'); throw e; } // o .pfx fica até o fim: o navegador também o usa (mTLS)
  totpConf = await lerTotp(c, esc);
  const cn = (a1.folha.subject.split('\n').find((l) => l.startsWith('CN=')) || 'CN=').slice(3);
  const cpf = (cn.match(/(\d{11})\s*$/) || [])[1] || null;

  const numeros = await numerosDoEscritorio(c, esc);
  log(`  ${numeros.length} processo(s) do escritório para consultar`);
  let sessao;
  try { sessao = await logar(a1, totpConf, { pfxPath: pfxTmp, senha: cert.senha }, numeros); } catch (e) { fs.rmSync(pfxTmp, { force: true }); await marcarErro(e.message); throw e; }
  const { cap, pagina, navegador, assinador } = sessao;
  try {
    const bearerOk = cap.bearer;
    // Consulta pelo Node com o token (a API não barra o servidor: sem token já respondia 401); se falhar, de dentro da página.
    const consultar = async (n) => {
      const url = `${API_PROCESSOS}?numeroProcesso=${n}`;
      try { const r = await fetch(url, { headers: { Authorization: bearerOk, Accept: 'application/json' } }); return { status: r.status, texto: await r.text().catch(() => '') }; }
      catch (e) { log('  fetch pelo Node falhou (' + e.message + '); tentando de dentro da página'); }
      const viaPagina = await comTempo(pagina.evaluate(async ([u, auth]) => {
        try { const r = await fetch(u, { headers: { Authorization: auth, Accept: 'application/json' } }); return { status: r.status, texto: await r.text() }; }
        catch (e) { return { status: 0, texto: String(e) }; }
      }, [url, bearerOk]), 30000, null);
      return viaPagina || { status: 0, texto: 'sem resposta' };
    };
    const hoje = hojeBRT(); let totalHoje = 0, consultados = 0;
    for (const n of numeros.slice(0, LIMITE)) {
      const r = await consultar(n);
      if (r.status < 200 || r.status >= 300) { log(`  ${n}: HTTP ${r.status} ${String(r.texto).replace(/\s+/g, ' ').slice(0, 120)}`); continue; }
      consultados++;
      let json = {}; try { json = JSON.parse(r.texto); } catch { /* não era JSON */ }
      if (consultados === 1) log('  exemplo de resposta: ' + String(r.texto).replace(/\s+/g, ' ').slice(0, 300));
      const movs = extrairMovimentos(json);
      totalHoje += movs.filter((m) => dataBRT(m.data) === hoje).length;
      await new Promise((ok) => setTimeout(ok, 800));
    }
    await c.query('update pje_certificados set status=$2, cn=$3, cpf=$4, valido_ate=$5, ultimo_uso_em=now(), ultimo_erro=null, atualizado_em=now() where escritorio_id=$1',
      [esc, 'ativo', cn, cpf, new Date(a1.folha.validTo)]);
    log(`escritório ${esc}: LOGIN OK · ${consultados}/${numeros.length} processos · ${totalHoje} movimentações hoje`);
  } catch (e) {
    await marcarErro(e.message); throw e;
  } finally {
    await navegador.close().catch(() => {});
    assinador.close();
    fs.rmSync(pfxTmp, { force: true });
  }
}

let rodadaEmCurso = false; // duas rodadas no mesmo processo nunca se atropelam
async function rodada() {
  if (rodadaEmCurso) { log('rodada pulada: a anterior ainda está em curso'); return; }
  rodadaEmCurso = true;
  const c = conectar(); await c.connect().catch((e) => { rodadaEmCurso = false; throw e; }); await c.query("set statement_timeout='30s'");
  try {
    const escs = await escritoriosParaRodar(c);
    log(`rodada: ${escs.length} escritório(s) com certificado`);
    for (const esc of escs) { try { await processarEscritorio(c, esc); } catch (e) { log(`escritório ${esc}: FALHOU — ${e.message}`); } }
  } finally { await c.end().catch(() => {}); rodadaEmCurso = false; }
}

log('trabalhador do PJe iniciado · horários 07/14/18/21h (America/Sao_Paulo)');
cron.schedule('0 7,14,18,21 * * *', () => rodada().catch((e) => log('rodada falhou:', e.message)), { timezone: 'America/Sao_Paulo' });
if (process.env.PJE_RODAR_JA === '1') rodada().catch((e) => log('rodada inicial falhou:', e.message));
