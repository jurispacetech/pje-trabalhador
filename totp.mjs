// TOTP (RFC 6238) sem dependências — o mesmo código que o app autenticador mostra.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decodificar(texto) {
  const limpo = String(texto).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, valor = 0; const saida = [];
  for (const ch of limpo) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('segredo TOTP inválido (base32)');
    valor = (valor << 5) | i; bits += 5;
    if (bits >= 8) { saida.push((valor >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(saida);
}

export function codigoTotp(segredo, agoraMs = Date.now(), { passo = 30, digitos = 6 } = {}) {
  const contador = Math.floor(agoraMs / 1000 / passo);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(contador));
  const h = crypto.createHmac('sha1', base32Decodificar(segredo)).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digitos).padStart(digitos, '0');
}

export function segundosRestantes(agoraMs = Date.now(), passo = 30) {
  return passo - (Math.floor(agoraMs / 1000) % passo);
}
