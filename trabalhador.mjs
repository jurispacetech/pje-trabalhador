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
import pg from 'pg';
import cron from 'node-cron';
import { chromium } from 'playwright';
import { carregarA1, iniciarAssinador } from './assinador.mjs';
import { codigoTotp, segundosRestantes } from './totp.mjs';

const LOGIN_URL = 'https://sso.cloud.pje.jus.br/auth/realms/pje/protocol/openid-connect/auth?client_id=jusbr&scope=openid&redirect_uri=https://www.jus.br&response_type=code';
const CONSULTA_URL = 'https://portaldeservicos.pdpj.jus.br/consulta-processual';
const API_PROCESSOS = 'https://portaldeservicos.pdpj.jus.br/api/v2/processos';
const LIMITE = Number(process.env.PJE_LIMITE || 8);
const PADRAO_PJE = /pdpj|pj-?e|jus\.?br/i;

const log = (...a) => console.log(new Date().toISOString(), ...a);
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

// Faz o login por certificado + 2FA e devolve o bearer do PDPJ (ou lança erro).
async function logar(a1, totpConf) {
  const assinador = await iniciarAssinador({ a1, log });
  const navegador = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await (await navegador.newContext({ locale: 'pt-BR' })).newPage();
  const cap = { bearer: null };
  pagina.on('request', (r) => { const h = r.headers()['authorization']; if (!cap.bearer && h && r.url().includes('/api/v2/')) cap.bearer = h; });
  try {
    await pagina.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
      await pagina.waitForSelector('#kc-pje-office', { timeout: 30000 });
    } catch {
      const url = pagina.url(); const titulo = await pagina.title().catch(() => '');
      const txt = await pagina.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
      throw new Error(`login não carregou o botão. URL=${url} título="${titulo}" texto="${String(txt).replace(/\s+/g, ' ').slice(0, 500)}"`);
    }
    await pagina.click('#kc-pje-office');
    const inicio = Date.now(); let totpFeito = false;
    while (Date.now() - inicio < 180000) {
      await pagina.waitForTimeout(1500);
      if (new URL(pagina.url()).hostname !== 'sso.cloud.pje.jus.br') break;
      const otp = await pagina.$('input[name="otp"], input#otp, input[name="totp"], input[autocomplete="one-time-code"]');
      if (otp && !totpFeito) {
        if (!totpConf) throw new Error('o PJe pediu 2FA mas não há autenticador PDPJ cadastrado');
        if (segundosRestantes(Date.now(), totpConf.periodo) < 5) await pagina.waitForTimeout(6000);
        await otp.fill(codigoTotp(totpConf.segredo, Date.now(), { passo: totpConf.periodo, digitos: totpConf.digitos }));
        const btn = await pagina.$('#kc-login, button[type="submit"], input[type="submit"]');
        if (btn) await btn.click(); else await otp.press('Enter');
        totpFeito = true;
      }
    }
    if (new URL(pagina.url()).hostname === 'sso.cloud.pje.jus.br') throw new Error('não passou do login em 3 min');
    await pagina.goto(CONSULTA_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pagina.waitForTimeout(4000);
    return { cap, pagina, navegador, assinador };
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
  try { a1 = carregarA1(pfxTmp, cert.senha); } catch (e) { await marcarErro('senha do certificado não abre o .pfx'); throw e; } finally { fs.rmSync(pfxTmp, { force: true }); }
  totpConf = await lerTotp(c, esc);
  const cn = (a1.folha.subject.split('\n').find((l) => l.startsWith('CN=')) || 'CN=').slice(3);
  const cpf = (cn.match(/(\d{11})\s*$/) || [])[1] || null;

  let sessao;
  try { sessao = await logar(a1, totpConf); } catch (e) { await marcarErro(e.message); throw e; }
  const { cap, pagina, navegador, assinador } = sessao;
  try {
    const numeros = await numerosDoEscritorio(c, esc);
    if (!cap.bearer && numeros.length) {
      const campo = await pagina.$('input[formcontrolname*="numero" i], input[placeholder*="processo" i], input[type="text"]');
      if (campo) { await campo.fill(numeros[0]); await campo.press('Enter'); }
      for (let i = 0; i < 40 && !cap.bearer; i++) await pagina.waitForTimeout(1000);
    }
    const bearerOk = cap.bearer;
    if (!bearerOk) throw new Error('não capturei o bearer do portal');

    const hoje = hojeBRT(); let totalHoje = 0, consultados = 0;
    for (const n of numeros.slice(0, LIMITE)) {
      const r = await fetch(`${API_PROCESSOS}?numeroProcesso=${n}`, { headers: { Authorization: bearerOk, Accept: 'application/json' } });
      if (!r.ok) { log(`  ${esc} ${n}: HTTP ${r.status}`); continue; }
      consultados++;
      const movs = extrairMovimentos(await r.json().catch(() => ({})));
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
  }
}

async function rodada() {
  const c = conectar(); await c.connect(); await c.query("set statement_timeout='30s'");
  try {
    const escs = await escritoriosParaRodar(c);
    log(`rodada: ${escs.length} escritório(s) com certificado`);
    for (const esc of escs) { try { await processarEscritorio(c, esc); } catch (e) { log(`escritório ${esc}: FALHOU — ${e.message}`); } }
  } finally { await c.end().catch(() => {}); }
}

log('trabalhador do PJe iniciado · horários 07/14/18/21h (America/Sao_Paulo)');
cron.schedule('0 7,14,18,21 * * *', () => rodada().catch((e) => log('rodada falhou:', e.message)), { timezone: 'America/Sao_Paulo' });
if (process.env.PJE_RODAR_JA === '1') rodada().catch((e) => log('rodada inicial falhou:', e.message));
