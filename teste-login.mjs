// TESTE de login no Robô A1 — UMA tentativa só. Lê A1+senha do cofre e o segredo do autenticador do tribunal,
// faz UM login, lê intimações (sem ciência) e o acervo, e encerra a sessão. NÃO grava nada no banco.
// ⚠️ Se falhar por credencial, NÃO repita: tentar de novo pode bloquear a conta da advogada.
// Uso:  node teste-login.mjs TJSP
import pg from 'pg';
import { login, intimacoes, acervo, encerrar, temChave } from './robo-a1.mjs';

const ESC = process.env.ESCRITORIO || '8ecf2ba5-6e1d-42e9-95e5-8a556363b2ed'; // HH
const TRIBUNAL = (process.argv[2] || '').trim();
const AUT_FORCADO = (process.argv[3] || '').trim(); // opcional: nome do autenticador a usar (ex.: "PDPJ"), em vez de casar pela sigla
const log = (...a) => console.log(...a);

if (!TRIBUNAL) { log('uso: node teste-login.mjs <TRIBUNAL>   (ex.: TJSP)'); process.exit(1); }
if (!temChave()) { log('falta ROBO_A1_KEY no Environment'); process.exit(1); }

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await c.connect();
  const s = (await c.query("select integracao_segredo_ler($1,'pje_pfx') pfx, integracao_segredo_ler($1,'pje_senha') senha", [ESC])).rows[0] || {};
  if (!s.pfx || !s.senha) { log('falta A1/senha no cofre da HH'); process.exit(1); }

  // Autenticador: o forçado (3º argumento) ou o que casa com o tribunal (ex.: "TJSP-2G" → "TJSP").
  const auts = (await c.query('select id,nome,conta from escritorio_autenticadores where escritorio_id=$1', [ESC])).rows;
  let aut;
  if (AUT_FORCADO) {
    aut = auts.find(a => String(a.nome || '').toLowerCase().includes(AUT_FORCADO.toLowerCase()));
    if (!aut) { log(`sem autenticador chamado "${AUT_FORCADO}". A HH tem: ${auts.map(a => a.nome).join(', ')}`); process.exit(1); }
  } else {
    const base = TRIBUNAL.replace(/[-_].*$/, '').toLowerCase();
    aut = auts.find(a => String(a.nome || '').toLowerCase().includes(base)) || auts.find(a => String(a.conta || '').toLowerCase().includes(base));
    if (!aut) { log(`sem autenticador casando com "${TRIBUNAL}". A HH tem: ${auts.map(a => a.nome).join(', ')}`); process.exit(1); }
  }
  const mapa = (await c.query('select autenticadores_segredos($1) m', [ESC])).rows[0].m || {};
  const seed = mapa[aut.id];
  if (!seed) { log('sem o segredo do autenticador ' + aut.nome); process.exit(1); }

  log(`Login ÚNICO em ${TRIBUNAL} — A1 da HH + autenticador "${aut.nome}"…`);
  const sess = await login({ tribunal: TRIBUNAL, pfxBase64: s.pfx, senha: s.senha, totp: seed });
  log('✅ LOGIN OK · sessão', sess.sessao, '· titular:', sess.titular, '· cert. válido até:', sess.certificadoValidoAte);
  try {
    const it = await intimacoes(sess.sessao);
    log(`\n=== INTIMAÇÕES pendentes: ${it.total} (aguardando ciência: ${it.aguardandoCiencia}) ===`);
    if ((it.intimacoes || []).length) log('exemplo de intimação:\n' + JSON.stringify(it.intimacoes[0], null, 2));
    const ac = await acervo(sess.sessao);
    log(`\n=== ACERVO: ${ac.total} processo(s) ===`);
    if ((ac.processos || []).length) log('exemplo de processo:\n' + JSON.stringify(ac.processos[0], null, 2));
  } finally { await encerrar(sess.sessao); log('\n(sessão encerrada — bom cidadão)'); }
} catch (e) {
  log('❌ FALHOU:', e.message);
  log('⚠️  NÃO repita o comando se foi erro de login/credencial — pode bloquear a conta. Me cola o erro primeiro.');
} finally { await c.end().catch(() => {}); }
