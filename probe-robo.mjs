// Teste rápido do Robô A1: confere a chave (/v1/conta) e lista os tribunais (/v1/tribunais).
// Não vai a tribunal nenhum, não faz login, não lê processo. Rodar no Console do movimentacoes-julia:
//   node probe-robo.mjs
import { conta, tribunais, temChave, BASE } from './robo-a1.mjs';

const mostra = (nome, v) => console.log(`\n=== ${nome} ===\n` + JSON.stringify(v, null, 2).slice(0, 2500));

(async () => {
  console.log('robo-a1 em:', BASE, '· chave:', temChave() ? 'presente' : 'AUSENTE (põe ROBO_A1_KEY no Environment)');
  if (!temChave()) return;
  try { mostra('/v1/conta (o que a chave pode fazer)', await conta()); }
  catch (e) { console.log('conta FALHOU:', e.message); }
  try { mostra('/v1/tribunais (catálogo)', await tribunais()); }
  catch (e) { console.log('tribunais FALHOU:', e.message); }
})();
