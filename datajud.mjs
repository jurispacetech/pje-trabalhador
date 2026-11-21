// Núcleo do acompanhamento de processos pelo DataJud (arquivo com "_" no começo: não vira rota).
//
// Fonte: API Pública do DataJud, do CNJ (datajud-wiki.cnj.jus.br/api-publica). Gratuita, oficial, sem contrato:
// autentica com uma CHAVE PÚBLICA que o próprio CNJ publica na wiki e pode trocar a qualquer momento (por isso,
// se vier 401/403, lemos a chave vigente na wiki e tentamos de novo). Um endpoint por tribunal
// (https://api-publica.datajud.cnj.jus.br/api_publica_<alias>/_search), consulta estilo Elasticsearch.
//
// O que ela entrega (conferido em resposta real): capa (classe, órgão julgador, assuntos, grau, sigilo, data de
// ajuizamento), a lista de MOVIMENTOS (código da tabela processual unificada, nome, data/hora, complementos) e
// dataHoraUltimaAtualizacao. NÃO entrega o texto das decisões/despachos, nem as partes, nem processo em segredo
// de justiça, e depende de o tribunal ter enviado os dados ao CNJ (atraso de horas a dias). Quem precisar de
// intimações/publicações com texto ou de rastreio mais fresco precisa de um provedor pago (ex.: API do Jusbrasil,
// por contrato) — a função de aplicação (processo-andamentos.js) fala com este módulo por `consultarProcessos`,
// então trocar/somar um provedor é escrever outro módulo com a mesma saída.

import { createHash } from "node:crypto";

export const DATAJUD_BASE = "https://api-publica.datajud.cnj.jus.br/";
const WIKI_ACESSO = "https://datajud-wiki.cnj.jus.br/api-publica/acesso";
const TIMEOUT_MS = 30000;          // a API leva de 3 a 16 s por consulta (medido)
const PARALELO = 4;                // tribunais consultados ao mesmo tempo
const MAX_NUMEROS_POR_CONSULTA = 40;
// Chave publicada na wiki em 20/out/2026. Pública (qualquer pessoa lê na wiki), por isso pode estar no código;
// DATAJUD_API_KEY no ambiente tem prioridade e a leitura da wiki cobre uma troca.
const CHAVE_PUBLICADA = "cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==";

// ---------------------------------------------------------------------------
// Número único do CNJ: NNNNNNN-DD.AAAA.J.TR.OOOO (20 dígitos)
// ---------------------------------------------------------------------------

// Só dígitos, exatamente 20; devolve null se não for isso.
export function normalizarNumeroCnj(texto){
  const d = String(texto == null ? "" : texto).replace(/\D/g, "");
  return d.length === 20 ? d : null;
}

export function formatarNumeroCnj(d20){
  const d = String(d20 || "");
  return d.length === 20 ? `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d[13]}.${d.slice(14, 16)}.${d.slice(16)}` : d;
}

// Resolução CNJ 65/2008: os dígitos DD são 98 − (NNNNNNN AAAA J TR OOOO 00 mod 97).
export function cnjValido(d20){
  const d = normalizarNumeroCnj(d20);
  if (!d) return false;
  const corpo = d.slice(0, 7) + d.slice(9, 13) + d.slice(13, 14) + d.slice(14, 16) + d.slice(16) + "00";
  let resto = 0;
  for (const ch of corpo) resto = (resto * 10 + Number(ch)) % 97;
  const dv = 98 - resto;
  if (Number(d.slice(7, 9)) !== dv) return false;
  const ano = Number(d.slice(9, 13)), j = Number(d[13]);
  return ano >= 1900 && ano <= new Date().getFullYear() + 1 && j >= 1 && j <= 9;
}

const TJ = {
  "01": "tjac", "02": "tjal", "03": "tjap", "04": "tjam", "05": "tjba", "06": "tjce", "07": "tjdft", "08": "tjes",
  "09": "tjgo", "10": "tjma", "11": "tjmt", "12": "tjms", "13": "tjmg", "14": "tjpa", "15": "tjpb", "16": "tjpr",
  "17": "tjpe", "18": "tjpi", "19": "tjrj", "20": "tjrn", "21": "tjrs", "22": "tjro", "23": "tjrr", "24": "tjsc",
  "25": "tjse", "26": "tjsp", "27": "tjto",
};

// Aliases que a wiki do DataJud lista (conferido em 20/out/2026). Usado pra o código nunca montar um endpoint que não existe.
export const ALIASES_DATAJUD = new Set([
  "tst", "stj", "stm",
  ...Array.from({ length: 6 }, (_, i) => "trf" + (i + 1)),
  ...Array.from({ length: 24 }, (_, i) => "trt" + (i + 1)),
  ...Object.values(TJ),
]);

// Tribunal a partir do próprio número (J = segmento da Justiça, TR = tribunal). null = o DataJud não cobre
// (STF, CNJ, Justiça Eleitoral e Militar estadual não têm endpoint nesta integração).
export function tribunalDoNumero(d20){
  const d = normalizarNumeroCnj(d20);
  if (!d) return null;
  const j = d[13], tr = d.slice(14, 16);
  let alias = null, nome = null;
  if (j === "3" && tr === "00"){ alias = "stj"; nome = "STJ"; }
  else if (j === "4" && /^0[1-6]$/.test(tr)){ alias = "trf" + Number(tr); nome = "TRF" + Number(tr); }
  else if (j === "5" && tr === "00"){ alias = "tst"; nome = "TST"; }
  else if (j === "5" && Number(tr) >= 1 && Number(tr) <= 24){ alias = "trt" + Number(tr); nome = "TRT" + Number(tr); }
  else if (j === "7" && tr === "00"){ alias = "stm"; nome = "STM"; }
  else if (j === "8" && TJ[tr]){ alias = TJ[tr]; nome = TJ[tr].toUpperCase(); }
  return alias && ALIASES_DATAJUD.has(alias) ? { alias, nome } : null;
}

// ---------------------------------------------------------------------------
// Chave pública
// ---------------------------------------------------------------------------

let chaveEmMemoria = null;
export function _zerarChave(){ chaveEmMemoria = null; }

export function chaveDaPagina(html){
  const texto = String(html || "").replace(/<[^>]+>/g, " ");
  const m = texto.match(/APIKey\s+([A-Za-z0-9+/=]{20,})/);
  return m ? m[1] : null;
}

async function chaveAtual(fetchImpl, forcarWiki){
  if (!forcarWiki){
    if (chaveEmMemoria) return chaveEmMemoria;
    chaveEmMemoria = process.env.DATAJUD_API_KEY || CHAVE_PUBLICADA;
    return chaveEmMemoria;
  }
  try{
    const r = await fetchComTempo(fetchImpl, WIKI_ACESSO, { headers: { "user-agent": "Mozilla/5.0 (compatible; JuriSpace)" } }, 15000);
    if (r.ok){
      const k = chaveDaPagina(await r.text());
      if (k) chaveEmMemoria = k;
    }
  }catch{ /* sem a wiki, fica com a chave que já tínhamos */ }
  return chaveEmMemoria;
}

async function fetchComTempo(fetchImpl, url, opts, ms){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try{ return await fetchImpl(url, { ...opts, signal: ctrl.signal }); }
  finally{ clearTimeout(t); }
}

// ---------------------------------------------------------------------------
// Consulta e mapeamento
// ---------------------------------------------------------------------------

function achatar(v){ return Array.isArray(v) ? v.flatMap(achatar) : [v]; }

// "20261006175629" (yyyyMMddHHmmss), ISO ou vazio → ISO (UTC) ou null.
export function parseDataDatajud(v){
  const s = String(v == null ? "" : v).trim();
  let m;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/))){
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    return isNaN(d) ? null : d.toISOString();
  }
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
}

// "tipo_de_distribuicao_redistribuicao: sorteio" → "Tipo de distribuicao redistribuicao: sorteio"
export function descreverComplementos(lista){
  if (!Array.isArray(lista)) return "";
  return lista.map(c => {
    if (!c || typeof c !== "object") return "";
    const rotulo = String(c.descricao || "").replace(/_/g, " ").trim();
    const valor = String(c.nome != null && c.nome !== "" ? c.nome : (c.valor != null ? c.valor : "")).trim();
    if (!valor) return "";
    return rotulo ? `${rotulo.charAt(0).toUpperCase()}${rotulo.slice(1)}: ${valor}` : valor;
  }).filter(Boolean).join(" · ").slice(0, 400);
}

function chaveMovimento(grau, mov, orgao, complementos){
  return createHash("sha1").update([grau, mov.codigo, mov.dataHora, orgao, complementos].join("|")).digest("hex").slice(0, 24);
}

// Uma resposta _search → { [numero20]: capa + movimentos }. As várias instâncias (G1, G2, TR…) do mesmo número
// viram um resultado só: movimentos de todas, cada um marcado com o seu grau.
export function mapearRespostaDatajud(resposta){
  const hits = (((resposta || {}).hits || {}).hits) || [];
  const porNumero = {};
  for (const h of hits){
    const s = (h && h._source) || {};
    const numero = normalizarNumeroCnj(s.numeroProcesso);
    if (!numero) continue;
    const reg = porNumero[numero] || (porNumero[numero] = {
      numero, classe: null, orgaoJulgador: null, graus: [], assuntos: [], dataAjuizamento: null, nivelSigilo: 0,
      atualizadoEm: null, movimentos: [],
    });
    const grau = String(s.grau || "").slice(0, 8);
    if (grau && !reg.graus.includes(grau)) reg.graus.push(grau);
    // a capa mostrada é a da instância mais recente (a última em ordem de grau: G1 < G2 < TR…, JE por último é raro)
    const maisNova = !reg.classe || grau >= (reg._grauCapa || "");
    if (maisNova){
      reg.classe = (s.classe && s.classe.nome) || reg.classe;
      reg.orgaoJulgador = (s.orgaoJulgador && s.orgaoJulgador.nome) || reg.orgaoJulgador;
      reg._grauCapa = grau;
    }
    for (const a of achatar(s.assuntos || [])){
      const nome = a && a.nome ? String(a.nome).trim() : "";
      if (nome && !reg.assuntos.includes(nome)) reg.assuntos.push(nome);
    }
    reg.dataAjuizamento = reg.dataAjuizamento || parseDataDatajud(s.dataAjuizamento);
    reg.nivelSigilo = Math.max(reg.nivelSigilo, Number(s.nivelSigilo) || 0);
    const atu = parseDataDatajud(s.dataHoraUltimaAtualizacao);
    if (atu && (!reg.atualizadoEm || atu > reg.atualizadoEm)) reg.atualizadoEm = atu;
    for (const mv of Array.isArray(s.movimentos) ? s.movimentos : []){
      if (!mv || !mv.nome) continue;
      const quando = parseDataDatajud(mv.dataHora);
      if (!quando) continue;
      const orgao = (mv.orgaoJulgador && (mv.orgaoJulgador.nome || mv.orgaoJulgador.nomeOrgao)) || "";
      const complementos = descreverComplementos(mv.complementosTabelados);
      reg.movimentos.push({
        grau, codigo: Number.isFinite(Number(mv.codigo)) ? Number(mv.codigo) : null, nome: String(mv.nome).trim().slice(0, 300),
        complementos, orgaoJulgador: String(orgao).slice(0, 200), ocorridoEm: quando,
        _ch: chaveMovimento(grau, { codigo: mv.codigo, dataHora: quando }, orgao, complementos),
      });
    }
  }
  for (const reg of Object.values(porNumero)){
    reg.movimentos.sort((a, b) => a.ocorridoEm.localeCompare(b.ocorridoEm) || a._ch.localeCompare(b._ch));
    const vistos = new Map();
    for (const m of reg.movimentos){            // dois movimentos idênticos no mesmo segundo não podem colidir
      const n = (vistos.get(m._ch) || 0) + 1;
      vistos.set(m._ch, n);
      m.chave = n === 1 ? m._ch : `${m._ch}#${n}`;
      delete m._ch;
    }
    delete reg._grauCapa;
  }
  return porNumero;
}

// Consulta vários números do MESMO tribunal numa chamada só.
// Resultado: { ok: true, porNumero } | { ok: false, erro: "chave"|"limite"|"indisponivel"|"alias" }
export async function consultarDatajud(alias, numeros, { fetchImpl = fetch } = {}){
  if (!ALIASES_DATAJUD.has(alias)) return { ok: false, erro: "alias" };
  const lista = [...new Set(numeros.map(normalizarNumeroCnj).filter(Boolean))].slice(0, MAX_NUMEROS_POR_CONSULTA);
  if (!lista.length) return { ok: true, porNumero: {} };
  const corpo = JSON.stringify({ size: Math.min(100, lista.length * 3), query: { terms: { numeroProcesso: lista } } });
  const url = `${DATAJUD_BASE}api_publica_${alias}/_search`;
  let renovou = false;
  for (let tentativa = 0; tentativa < 2; tentativa++){
    let r;
    try{
      r = await fetchComTempo(fetchImpl, url, {
        method: "POST",
        headers: { Authorization: "APIKey " + await chaveAtual(fetchImpl, false), "Content-Type": "application/json" },
        body: corpo,
      }, TIMEOUT_MS);
    }catch{ return { ok: false, erro: "indisponivel" }; }
    if ((r.status === 401 || r.status === 403) && !renovou){ renovou = true; await chaveAtual(fetchImpl, true); continue; }
    if (r.status === 401 || r.status === 403) return { ok: false, erro: "chave" };
    if (r.status === 429) return { ok: false, erro: "limite" };
    if (!r.ok) return { ok: false, erro: "indisponivel" };
    let json;
    try{ json = await r.json(); }catch{ return { ok: false, erro: "indisponivel" }; }
    if (json && json.timed_out) return { ok: false, erro: "indisponivel" };
    return { ok: true, porNumero: mapearRespostaDatajud(json) };
  }
  return { ok: false, erro: "chave" };
}

// Interface do provedor usada pela função de aplicação: { itens: [{numero}] } → { [numero]: resultado|"erro_provedor" }.
// Agrupa por tribunal (uma chamada por tribunal). Quem implementar outro provedor devolve o mesmo formato.
export async function consultarProcessos(numeros, { fetchImpl = fetch, orcamentoMs = 50000 } = {}){
  const inicio = Date.now();
  const grupos = new Map();
  const saida = {};
  for (const n of numeros){
    const t = tribunalDoNumero(n);
    if (!t){ saida[n] = { situacao: "tribunal_nao_suportado" }; continue; }
    if (!grupos.has(t.alias)) grupos.set(t.alias, { tribunal: t.nome, numeros: [] });
    grupos.get(t.alias).numeros.push(n);
  }
  const tarefas = [];
  for (const [alias, g] of grupos){
    for (let i = 0; i < g.numeros.length; i += MAX_NUMEROS_POR_CONSULTA) tarefas.push({ alias, tribunal: g.tribunal, fatia: g.numeros.slice(i, i + MAX_NUMEROS_POR_CONSULTA) });
  }
  let proxima = 0;
  const operario = async () => {
    while (proxima < tarefas.length){
      const { alias, tribunal, fatia } = tarefas[proxima++];
      if (Date.now() - inicio > orcamentoMs){ for (const n of fatia) saida[n] = { situacao: "adiado" }; continue; }
      const r = await consultarDatajud(alias, fatia, { fetchImpl });
      for (const n of fatia){
        if (!r.ok) saida[n] = { situacao: "erro_provedor", motivo: r.erro, tribunalAlias: alias, tribunal };
        else if (!r.porNumero[n]) saida[n] = { situacao: "nao_encontrado", tribunalAlias: alias, tribunal };
        else saida[n] = { situacao: "ok", tribunalAlias: alias, tribunal, ...r.porNumero[n] };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALELO, tarefas.length) }, operario));
  return saida;
}

// Só confere se o DataJud responde daqui, com a chave vigente (consulta de contagem, sem trazer processo nenhum).
export async function sondarDatajud({ fetchImpl = fetch } = {}){
  const t = Date.now();
  try{
    const r = await fetchComTempo(fetchImpl, `${DATAJUD_BASE}api_publica_trt22/_search`, {
      method: "POST", headers: { Authorization: "APIKey " + await chaveAtual(fetchImpl, false), "Content-Type": "application/json" },
      body: JSON.stringify({ size: 0, query: { match_all: {} } }),
    }, 30000);
    return { status: r.status, ms: Date.now() - t };
  }catch(e){ return { erro: String((e && e.message) || e).slice(0, 80), ms: Date.now() - t }; }
}
