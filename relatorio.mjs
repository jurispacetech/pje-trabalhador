// Relatório de movimentações de HOJE pelo DataJud (API pública do CNJ) — o caminho que FUNCIONA, sem certificado
// nem WAF. Lê os números de processo do escritório no banco, consulta o DataJud e conta os movimentos do dia.
//
// Variáveis de ambiente:
//   DATABASE_URL   conexão do Supabase (pooler) — obrigatória (já está no Environment)
//   REL_LIMITE     nº máximo de processos por execução (padrão 150; suba aos poucos)
//   REL_ESCRITORIO escritorio_id específico (padrão: todos os que tiverem processos)
import pg from 'pg';
import { consultarProcessos } from './datajud.mjs';

const LIMITE = Number(process.env.REL_LIMITE || 150);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const hojeBRT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const dataBRT = (v) => { const d = new Date(v); return isNaN(d) ? null : d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); };
const soDigitos = (n) => String(n).replace(/\D/g, '');

function conectar() {
  if (!process.env.DATABASE_URL) throw new Error('falta DATABASE_URL');
  return new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

// Números de processo do escritório: da tabela `processos` (coluna com "numero") e de `clientes.numero_processo`.
async function numerosDoEscritorio(c, esc) {
  const cols = (await c.query("select column_name from information_schema.columns where table_name='processos'")).rows.map((r) => r.column_name);
  const colNum = cols.find((n) => /^numero(_processo)?$/.test(n)) || cols.find((n) => /numero/.test(n));
  const temEsc = cols.includes('escritorio_id');
  const nums = new Set();
  if (colNum) for (const r of (await c.query(`select ${colNum} as n from processos where ${colNum} is not null` + (temEsc && esc ? ' and escritorio_id=$1' : ''), temEsc && esc ? [esc] : [])).rows) nums.add(r.n);
  const q = 'select numero_processo as n from clientes where numero_processo is not null' + (esc ? ' and escritorio_id=$1' : '');
  for (const r of (await c.query(q, esc ? [esc] : [])).rows) nums.add(r.n);
  return [...nums].map(soDigitos).filter((n) => n.length === 20);
}

async function main() {
  const c = conectar(); await c.connect(); await c.query("set statement_timeout='60s'");
  try {
    const esc = process.env.REL_ESCRITORIO || null;
    let numeros = await numerosDoEscritorio(c, esc);
    log(`processos do escritório${esc ? ' ' + esc : ' (todos)'}: ${numeros.length}`);
    if (numeros.length > LIMITE) { log(`consultando os primeiros ${LIMITE} (ajuste REL_LIMITE para mais)`); numeros = numeros.slice(0, LIMITE); }
    if (!numeros.length) { log('nenhum número de processo válido para consultar'); return; }

    const hoje = hojeBRT();
    const t0 = Date.now();
    const res = await consultarProcessos(numeros, { orcamentoMs: 280000 });
    const seg = Math.round((Date.now() - t0) / 1000);

    let ok = 0, naoEnc = 0, erro = 0, comMovHoje = 0, totalMovHoje = 0;
    const linhas = [];
    for (const n of numeros) {
      const r = res[n] || { situacao: 'sem_resposta' };
      if (r.situacao === 'ok') {
        ok++;
        const doDia = (r.movimentos || []).filter((m) => dataBRT(m.ocorridoEm) === hoje);
        if (doDia.length) { comMovHoje++; totalMovHoje += doDia.length; for (const m of doDia) linhas.push(`${n} · ${r.tribunal || ''} · ${m.nome}`); }
      } else if (r.situacao === 'nao_encontrado') naoEnc++;
      else erro++;
    }

    log('———————————————————————————————————————————');
    log(`RELATÓRIO DE HOJE (${hoje}) — fonte: DataJud/CNJ · ${seg}s`);
    log(`consultados: ${numeros.length} · encontrados: ${ok} · não encontrados: ${naoEnc} · com erro: ${erro}`);
    log(`MOVIMENTAÇÕES DE HOJE: ${totalMovHoje} em ${comMovHoje} processo(s)`);
    for (const l of linhas.slice(0, 30)) log('  • ' + l);
    if (linhas.length > 30) log(`  … e mais ${linhas.length - 30}`);
    log('———————————————————————————————————————————');
  } finally {
    await c.end().catch(() => {});
  }
}

main().catch((e) => { log('relatório falhou:', e.message); process.exit(1); });
