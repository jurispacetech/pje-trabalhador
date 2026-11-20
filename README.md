# pje-trabalhador — Movimentações da JulIA

Trabalhador do PJe que roda **no servidor brasileiro** (EasyPanel/VPS). Para cada
escritório com certificado guardado na plataforma, lê o A1 + a senha do cofre e o
código 2FA do autenticador "PDPJ", faz o login no PJe nacional e consulta as
movimentações no PDPJ. Nada de certificado ou segredo fica neste repositório.

## Como roda
- Horários automáticos: **07h, 14h, 18h e 21h** (America/Sao_Paulo).
- Com `PJE_RODAR_JA=1`, roda **uma vez ao subir** (bom para o 1º teste).

## Variáveis de ambiente (no EasyPanel)
| Variável | Obrigatória | O que é |
|---|---|---|
| `DATABASE_URL` | sim | Conexão do Supabase (pooler) — a mesma do `.env` do app. **Segredo.** |
| `PJE_RODAR_JA` | não | `1` = roda uma vez ao subir. Deixe em branco depois do 1º teste. |
| `PJE_LIMITE` | não | Nº de processos por escritório por rodada (padrão 8). |

## Deploy no EasyPanel
1. Create Service → **App**.
2. Source → **GitHub** → este repositório, branch `main` → Build: **Dockerfile**.
3. Environment → `DATABASE_URL` (cole a conexão do Supabase) e, no 1º teste, `PJE_RODAR_JA=1`.
4. **Deploy**. No log deve aparecer: `escritório … LOGIN OK · N processos · M movimentações hoje`.

## Arquivos
- `trabalhador.mjs` — o serviço (agenda + login + consulta + grava status).
- `assinador.mjs` — assinador local do desafio do PJe (substitui o PJe Office).
- `totp.mjs` — gera o código 2FA (RFC 6238).
- `Dockerfile` — imagem com Chromium embutido (Playwright).
