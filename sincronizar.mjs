// Sincroniza as INTIMAÇÕES pela JulIA (Robô A1) para dentro da tabela `intimacoes` com fonte='julia'.
// UM login por tribunal, lê as intimações pendentes (SEM ciência) e grava/atualiza. Não repete login em erro.
// Uso:  node sincronizar.mjs TJPR     (um tribunal)   |   node sincronizar.mjs ALL   (todos os que casam)
import fs from 'node:fs';
import pg from 'pg';
import { login, intimacoes, encerrar, tribunais, temChave } from './robo-a1.mjs';

const ESC = process.env.ESCRITORIO || '8ecf2ba5-6e1d-42e9-95e5-8a556363b2ed'; // HH
// Log no console E num arquivo (ler no Console do EasyPanel: tail -n 80 /tmp/movimentacoes-julia.log).
const ARQ_LOG = process.env.SINC_LOG || '/tmp/movimentacoes-julia.log';
try { if (fs.statSync(ARQ_LOG).size > 5e6) fs.renameSync(ARQ_LOG, ARQ_LOG + '.old'); } catch { /* ainda não existe */ }
const log = (...a) => {
  const linha = new Date().toISOString() + ' ' + a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ');
  console.log(linha);
  try { fs.appendFileSync(ARQ_LOG, linha + '\n'); } catch { /* sem disco: segue só no console */ }
};

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const soData = (s) => { const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; };
const ts = (s) => (s && /\d{4}-\d{2}-\d{2}/.test(String(s))) ? String(s) : null;
// Código do tribunal/autenticador ignorando "eproc" e o grau (1G/2G): "Eproc/TJMG"≈"TJMG-EPROC"→"tjmg"; "TRF4-2G"→"trf4".
const sigla = (s) => String(s || '').toLowerCase().replace(/eproc/g, '').replace(/[^a-z0-9]/g, '').replace(/[12]g$/, '');

// "Exequente: X; Executado: Y" (intimação) ou "A X B" (acervo) → [{polo?, nome}]
function parsePartes(s) {
  s = String(s || '').trim();
  if (!s) return [];
  if (s.includes(';') || s.includes(':')) {
    return s.split(';').map(p => { const i = p.indexOf(':'); return i > 0 ? { polo: p.slice(0, i).trim(), nome: p.slice(i + 1).trim() } : { nome: p.trim() }; }).filter(x => x.nome);
  }
  return s.split(/\s+X\s+/i).map(n => ({ nome: n.trim() })).filter(x => x.nome);
}

async function lerCert(c, esc) {
  const r = (await c.query("select integracao_segredo_ler($1,'pje_pfx') pfx, integracao_segredo_ler($1,'pje_senha') senha", [esc])).rows[0] || {};
  return { pfx: r.pfx, senha: r.senha };
}

// Casa cada tribunal do catálogo do robô (login validado) com o autenticador da HH (pelo contaDoAutenticador).
async function paresParaRodar(c, esc) {
  const auts = (await c.query('select id,nome,conta from escritorio_autenticadores where escritorio_id=$1', [esc])).rows;
  const mapa = (await c.query('select autenticadores_segredos($1) m', [esc])).rows[0].m || {};
  const cat = await tribunais();
  const lista = Array.isArray(cat) ? cat : (cat.tribunais || cat.itens || []);
  const autPdpj = auts.find(a => /pdpj/i.test(a.nome || ''));   // o autenticador nacional (validado no TJPE)
  // PJe (sistema=pje): usa o PDPJ, mas só nos tribunais onde a HH atua (senão logaria em dezenas sem processo). Ajuste com PJE_TRIBUNAIS.
  const pjePermitidos = (process.env.PJE_TRIBUNAIS || 'TJPE,TJPI,TRT22,TRF1').split(',').map(s => sigla(s)).filter(Boolean);
  const pares = [];
  for (const t of lista) {
    if (!t.loginValidado) continue;
    let aut;
    if (t.sistema === 'pje') {
      if (autPdpj && pjePermitidos.includes(sigla(t.sigla || t.id))) aut = autPdpj;       // PJe → autenticador PDPJ
    } else {
      const alvo = sigla(t.contaDoAutenticador || t.sigla || t.id);                       // eProc → autenticador do próprio tribunal (TJSP, JFRS→TRF4…)
      if (alvo) aut = auts.find(a => sigla(a.nome) === alvo);
    }
    if (aut && mapa[aut.id]) pares.push({ tribunal: t.id, sigla: t.sigla || t.id, seed: mapa[aut.id], autNome: aut.nome, abre: !!(t.recursos && t.recursos.abrirIntimacao) });
  }
  return pares;
}

const UPSERT = `insert into intimacoes
  (escritorio_id, chave, numero_processo, tribunal, orgao, classe, tipo, disponibilizada_em, partes, contas_ids, fonte, prazo, fim_do_prazo, limite_ciencia, ciencia_pendente, id_processo_tribunal, abre_ciencia)
  values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'{}','julia',$10,$11,$12,$13,$14,$15)
  on conflict (escritorio_id, chave) do update set
    numero_processo=excluded.numero_processo, tribunal=excluded.tribunal, orgao=excluded.orgao, classe=excluded.classe,
    tipo=excluded.tipo, disponibilizada_em=excluded.disponibilizada_em, partes=excluded.partes,
    prazo=excluded.prazo, fim_do_prazo=excluded.fim_do_prazo, limite_ciencia=excluded.limite_ciencia,
    ciencia_pendente=excluded.ciencia_pendente, id_processo_tribunal=excluded.id_processo_tribunal, abre_ciencia=excluded.abre_ciencia`;

async function gravar(c, esc, sigla, it, abre) {
  const chave = it.idExpediente || (soDigitos(it.cnj) + '-' + (it.criadoEm || ''));
  const disp = soData(it.criadoEm) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  await c.query(UPSERT, [
    esc, chave, soDigitos(it.cnj), sigla, it.orgao || null, it.classe || null, it.tipo || null,
    disp, JSON.stringify(parsePartes(it.partes)), it.prazo || null, ts(it.fimDoPrazo), ts(it.limiteCiencia),
    typeof it.cienciaPendente === 'boolean' ? it.cienciaPendente : null, it.idProcessoTribunal || null, !!abre,
  ]);
}

async function umTribunal(c, esc, cert, t) {
  log(`  ${t.sigla}: login (autenticador "${t.autNome}")…`);
  let sess;
  try { sess = await login({ tribunal: t.tribunal, pfxBase64: cert.pfx, senha: cert.senha, totp: t.seed }); }
  catch (e) { log(`  ${t.sigla}: login FALHOU — ${e.message} · NÃO repito hoje`); return; }
  try {
    const r = await intimacoes(sess.sessao);
    let n = 0;
    for (const it of (r.intimacoes || [])) { try { await gravar(c, esc, t.sigla, it, t.abre); n++; } catch (e) { log(`    erro ao gravar ${it.idExpediente}: ${e.message}`); } }
    log(`  ${t.sigla}: ${r.total} intimação(ões) pendente(s) · ${n} gravada(s) com fonte=julia`);
  } finally { await encerrar(sess.sessao); }
}

export async function sincronizar(alvo = 'ALL') {
  const ALVO = String(alvo || 'ALL').trim().toUpperCase();
  if (!temChave()) { log('falta ROBO_A1_KEY'); return; }
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const cert = await lerCert(c, ESC);
    if (!cert.pfx || !cert.senha) { log('falta A1/senha no cofre'); return; }
    let pares = await paresParaRodar(c, ESC);
    if (ALVO !== 'ALL') pares = pares.filter(p => p.sigla.toUpperCase() === ALVO || p.tribunal.toUpperCase() === ALVO);
    log(`JulIA: ${pares.length} tribunal(is) — ${pares.map(p => p.sigla).join(', ') || '(nenhum casou)'}`);
    for (const t of pares) { await umTribunal(c, ESC, cert, t); await new Promise(ok => setTimeout(ok, 3000)); }
    log('fim da sincronização');
  } finally { await c.end().catch(() => {}); }
}

// Rodar direto pela linha de comando: node sincronizar.mjs [TRIBUNAL|ALL]
if (import.meta.url === `file://${process.argv[1]}`) {
  sincronizar(process.argv[2] || 'ALL').catch(e => { log('sincronização falhou:', e.message); process.exit(1); });
}
