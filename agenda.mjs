// Agenda da Movimentações da JulIA: roda a sincronização das intimações (robô A1) 2× por dia,
// às 08h e às 14h (America/Sao_Paulo). Cada rodada varre TODOS os tribunais que casam com os
// autenticadores da HH. Com SINC_JA=1 roda uma vez ao subir (bom para o 1º teste).
import cron from 'node-cron';
import { sincronizar } from './sincronizar.mjs';

const log = (...a) => console.log(new Date().toISOString(), ...a);

let rodando = false;
async function rodar(hora) {
  if (rodando) { log(`${hora}: a rodada anterior ainda está em curso — pulei`); return; }
  rodando = true;
  try { await sincronizar('ALL'); } catch (e) { log(`${hora}: falhou — ${e.message}`); } finally { rodando = false; }
}

log('agenda da JulIA iniciada · 08h e 14h (America/Sao_Paulo)');
cron.schedule('0 8 * * *', () => rodar('08h'), { timezone: 'America/Sao_Paulo' });
cron.schedule('0 14 * * *', () => rodar('14h'), { timezone: 'America/Sao_Paulo' });
if (process.env.SINC_JA === '1') rodar('inicial');
