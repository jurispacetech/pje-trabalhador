// Assinador local do PJe (substitui o PJe Office) — contrato observado no PJe Office Pro 2.5.16.
// A página de login do SSO (pjeOffice.js) chama http://localhost:8800/pjeOffice/requisicao/?r=<json>
// e espera de volta uma imagem GIF: largura 1 = sucesso, largura 2 = erro.
// Este servidor assina a `mensagem` com a chave do A1 e POSTa {uuid, mensagem, assinatura, certChain}
// em servidor+enviarPara, levando o Cookie da sessão do navegador.
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const VERSAO_PJEOFFICE = '2.5.16';
const ALGORITMOS = { MD5withRSA: 'md5', SHA1withRSA: 'sha1', SHA256withRSA: 'sha256' };

// GIF mínimo: a página só lê a largura (1 = ok, 2 = erro).
function gif(largura) {
  const w = Buffer.from([largura & 0xff, (largura >> 8) & 0xff]);
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'), w, Buffer.from([1, 0]),           // tela lógica: largura x 1
    Buffer.from([0x80, 0x00, 0x00]), Buffer.from([0, 0, 0, 255, 255, 255]), // paleta 2 cores
    Buffer.from([0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00]),     // transparente
    Buffer.from([0x2c, 0, 0, 0, 0]), w, Buffer.from([1, 0, 0x00]),      // descritor da imagem
    Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]),                  // dados LZW + fim
  ]);
}
const GIF_OK = gif(1);
const GIF_ERRO = gif(2);

// Comprimento DER (forma curta/longa).
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
// certChain = base64( SEQUENCE OF Certificate ) — folha primeiro (formato PkiPath).
export function montarCertChain(certsDer) {
  const corpo = Buffer.concat(certsDer);
  return Buffer.concat([Buffer.from([0x30]), derLen(corpo.length), corpo]).toString('base64');
}

// Lê chave, certificado-folha e cadeia do .pfx (A1 em arquivo) com o openssl do sistema.
export function carregarA1(pfxPath, senha) {
  const ssl = (args) => execFileSync('openssl', ['pkcs12', '-in', pfxPath, '-passin', 'pass:' + senha, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const chave = crypto.createPrivateKey(ssl(['-nocerts', '-nodes']));
  const pems = (txt) => (txt.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []);
  const folha = pems(ssl(['-clcerts', '-nokeys'])).map((p) => new crypto.X509Certificate(p));
  let cadeia = [];
  try { cadeia = pems(ssl(['-cacerts', '-nokeys'])).map((p) => new crypto.X509Certificate(p)); } catch { /* sem cadeia no arquivo */ }
  if (!folha.length) throw new Error('nenhum certificado-folha no .pfx');
  return { chave, folha: folha[0], cadeia, certChain: montarCertChain([folha[0].raw, ...cadeia.map((c) => c.raw)]) };
}

export function assinarMensagem(chave, mensagem, algoritmo = 'MD5withRSA') {
  const hash = ALGORITMOS[algoritmo] || 'md5';
  return crypto.sign(hash, Buffer.from(String(mensagem), 'utf8'), chave).toString('base64'); // PKCS#1 v1.5
}

// Processa o envelope vindo da página e envia a assinatura ao tribunal.
export async function processarRequisicao(a1, bruto, log = console.log) {
  const env = typeof bruto === 'string' ? JSON.parse(bruto) : bruto;
  const tarefa = typeof env.tarefa === 'string' ? JSON.parse(env.tarefa) : (env.tarefa || {}); // vem "duplamente" codificada
  const algoritmo = tarefa.algoritmoAssinatura || 'MD5withRSA';
  const destino = String(env.servidor || '') + String(tarefa.enviarPara || '');
  if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(destino)) throw new Error('destino inválido: ' + destino); // http só no loopback (testes)
  const corpo = {
    uuid: tarefa.token,
    mensagem: tarefa.mensagem,
    assinatura: assinarMensagem(a1.chave, tarefa.mensagem, algoritmo),
    certChain: a1.certChain,
  };
  log(`[assinador] ${env.tarefaId || '?'} → ${destino} (${algoritmo})`);
  const cab = {
    versao: env.versao || VERSAO_PJEOFFICE,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'PJeOffice/' + VERSAO_PJEOFFICE,
    'Accept-Encoding': 'gzip,deflate',
  };
  if (env.sessao) cab.Cookie = env.sessao;
  const r = await fetch(destino, { method: 'POST', headers: cab, body: JSON.stringify(corpo) });
  const texto = await r.text().catch(() => '');
  log(`[assinador] tribunal respondeu ${r.status} ${texto.slice(0, 200)}`);
  return { ok: r.ok, status: r.status, texto, corpo };
}

export function iniciarAssinador({ a1, porta = 8800, log = console.log, enviar = processarRequisicao }) {
  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const responder = (buf) => { res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store', 'Content-Length': buf.length }); res.end(buf); };
    if (url.pathname === '/pjeOffice/' || url.pathname === '/pjeOffice') return responder(GIF_OK); // "está instalado?"
    if (url.pathname !== '/pjeOffice/requisicao/' && url.pathname !== '/pjeOffice/requisicao') { res.writeHead(404); return res.end(); }
    try {
      let bruto = url.searchParams.get('r');
      if (req.method === 'POST') bruto = await new Promise((ok, erro) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); req.on('error', erro); });
      const resultado = await enviar(a1, bruto, log);
      responder(resultado.ok ? GIF_OK : GIF_ERRO);
    } catch (e) {
      log('[assinador] erro: ' + e.message);
      responder(GIF_ERRO);
    }
  });
  return new Promise((ok, erro) => {
    servidor.once('error', erro);
    servidor.listen(porta, '127.0.0.1', () => { log(`[assinador] ouvindo em http://127.0.0.1:${porta}/pjeOffice/`); ok(servidor); });
  });
}
