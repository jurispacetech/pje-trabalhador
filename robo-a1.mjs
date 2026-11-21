// Cliente da API do Robô A1 (serviço do mdelmiro, hospedado/mantido por ele; a plataforma é só CLIENTE).
// A gente NUNCA chama /intimacoes/abrir (esse registra ciência). Só leitura: acervo, intimações e movimentos.
// Endereço interno no EasyPanel: http://hha_robo-a1:8787 ; a chave (ra1_...) vem do ambiente, nunca do código.
const BASE = (process.env.ROBO_A1_URL || 'http://hha_robo-a1:8787').replace(/\/$/, '');
const CHAVE = process.env.ROBO_A1_KEY || '';
const TIMEOUT_MS = Number(process.env.ROBO_A1_TIMEOUT_MS || 600000); // leituras longas (acervo grande) levam minutos

function temChave() { return /^ra1_/.test(CHAVE); }

async function chamar(metodo, caminho, corpo) {
  if (!temChave()) throw new Error('falta ROBO_A1_KEY (a chave do Robô A1, começa com ra1_)');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetch(BASE + caminho, {
      method: metodo,
      headers: { Authorization: 'Bearer ' + CHAVE, Accept: 'application/json', ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) { throw new Error('robo-a1 fora de alcance: ' + e.message); }
  finally { clearTimeout(t); }
  const txt = await r.text().catch(() => '');
  let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch { /* resposta não-JSON */ }
  if (!r.ok) { const e = new Error(`robo-a1 ${caminho}: HTTP ${r.status} ${j.erro || txt.slice(0, 160)}`); e.status = r.status; e.motivo = j.motivo || null; throw e; }
  return j;
}

// Diagnóstico/catálogo (não precisam de certificado)
export const conta = () => chamar('GET', '/v1/conta');
export const tribunais = () => chamar('GET', '/v1/tribunais');

// Login: UMA tentativa; o .pfx/senha/totp servem só para este login e não ficam guardados no robô.
// Sem totp, para no 2º fator (HTTP 424). Regra do tribunal: UM login por dia por tribunal — não insista em erro.
export const login = ({ tribunal, pfxBase64, senha, totp }) => chamar('POST', '/v1/login', { tribunal, pfxBase64, senha, totp });

// Só leitura — nenhum processo é aberto, nenhuma ciência é registrada:
export const acervo = (sessao) => chamar('POST', `/v1/sessoes/${encodeURIComponent(sessao)}/acervo`, {});
export const intimacoes = (sessao) => chamar('POST', `/v1/sessoes/${encodeURIComponent(sessao)}/intimacoes`, {});
export const movimentos = (sessao, { cnj, idNoTribunal, chave }) => chamar('POST', `/v1/sessoes/${encodeURIComponent(sessao)}/movimentos`, { cnj, idNoTribunal, chave });

// Encerra a sessão no fim (bom cidadão: libera a vez na fila do tribunal).
export const encerrar = (sessao) => chamar('DELETE', `/v1/sessoes/${encodeURIComponent(sessao)}`).catch(() => {});

export { temChave, BASE };
