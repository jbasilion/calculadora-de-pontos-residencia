# Bot Assessor — assistente pessoal no WhatsApp

Um assessor de IA no WhatsApp, no estilo do "Meu Assessor": você manda mensagens soltas
("gastei 40 no almoço", "me lembra de pagar a luz dia 5 às 9h", "o que tenho amanhã?")
e ele registra gastos, agenda compromissos, cria lembretes e guarda notas. Tudo em
português, com respostas curtas.

**Stack:** Node.js 20+ · TypeScript · [Claude](https://platform.claude.com) com *tool use* ·
WhatsApp Cloud API (Meta) · Supabase (Postgres).

## O que ele faz

| Você escreve | O assessor |
|---|---|
| "paguei 120 de luz no pix" | registra o gasto (categoria moradia, pix, hoje) |
| "mercado 230, farmácia 45 e uber 18" | registra os três de uma vez |
| "quanto gastei esse mês?" | totais, saldo e quebra por categoria |
| "recebi 3500 de salário" | registra a receita |
| "me lembra de tomar o remédio às 20h" | manda mensagem às 20h |
| "dentista sexta às 10 na clínica X" | agenda e avisa 1h antes (configurável) |
| "toda segunda às 8 me lembra da reunião" | lembrete recorrente |
| "o que tenho essa semana?" | lista agenda e lembretes pendentes |
| "anota aí: placa do carro ABC1D23" | salva uma nota; "qual a placa?" busca |
| "apaga o gasto do uber" | lista, confirma e exclui |

## Estrutura

```
bot-assessor/
├── src/
│   ├── server.ts      # Express: webhook do WhatsApp (/webhook) e /health
│   ├── assessor.ts    # system prompt + chamada ao Claude com ferramentas
│   ├── tools.ts       # ferramentas: gastos, receitas, resumo, lembretes, agenda, notas
│   ├── whatsapp.ts    # Cloud API: envio, assinatura do webhook, parse do payload
│   ├── scheduler.ts   # cron por minuto: dispara lembretes vencidos
│   ├── store.ts       # interface Store + SupabaseStore + MemoryStore
│   ├── dates.ts       # fuso horário, períodos (hoje/semana/mês), formatação
│   ├── config.ts      # variáveis de ambiente (zod)
│   └── chat.ts        # chat no terminal para testar sem WhatsApp
├── supabase/migrations/0001_init.sql
├── test/              # node:test (npm test)
└── .env.example
```

## Rodando

### 1. Instalar

```bash
cd bot-assessor
npm install
cp .env.example .env
```

### 2. Testar no terminal (sem WhatsApp, sem banco)

Só precisa da chave da Anthropic no `.env`:

```bash
npm run chat
```

Os dados ficam em memória. Bom para ajustar o comportamento antes de ligar no WhatsApp.

### 3. Banco (Supabase)

1. Crie um projeto em [supabase.com](https://supabase.com).
2. No **SQL Editor**, cole e rode `supabase/migrations/0001_init.sql`.
3. Em *Project Settings → API*, copie a **URL** e a chave **service_role** para o `.env`
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). A chave service_role só vive no servidor.

### 4. WhatsApp Cloud API (Meta)

1. Em [developers.facebook.com](https://developers.facebook.com) crie um app do tipo **Business** e adicione o produto **WhatsApp**.
2. Em *WhatsApp → API Setup* copie o **Phone number ID** (`WHATSAPP_PHONE_NUMBER_ID`). O token temporário serve para testar; para produção crie um **System User** no Business Manager e gere um token permanente com as permissões `whatsapp_business_messaging` e `whatsapp_business_management` (`WHATSAPP_TOKEN`).
3. Em *App Settings → Basic* copie o **App Secret** (`WHATSAPP_APP_SECRET`).
4. Escolha uma frase qualquer para `WHATSAPP_VERIFY_TOKEN`.
5. Suba o servidor numa URL pública HTTPS (ver abaixo) e em *WhatsApp → Configuration* cadastre o webhook `https://SEU-HOST/webhook` com o verify token. Assine o campo **messages**.
6. Enquanto o app está em modo de desenvolvimento, só números adicionados como *test recipients* recebem mensagens. Adicione o seu.

Dica: preencha `ALLOWED_PHONES` com o seu número (com DDI, ex.: `5511999999999`) para que só você use o bot.

### 5. Subir o servidor

Desenvolvimento local com túnel (ex.: [ngrok](https://ngrok.com) ou `cloudflared tunnel`):

```bash
npm run dev            # porta 3000
ngrok http 3000        # use a URL https gerada no webhook da Meta
```

Produção (Railway, Render, Fly.io, VPS...):

```bash
npm run build
npm start              # node dist/server.js
```

O processo precisa ficar sempre ligado: além do webhook, ele roda o agendador que dispara os lembretes a cada minuto.

### 6. Testes

```bash
npm test               # 29 testes: datas, ferramentas, WhatsApp, agendador, webhook
npm run typecheck
```

## Configuração

| Variável | Para que serve |
|---|---|
| `ANTHROPIC_API_KEY` | chave da API do Claude |
| `ASSESSOR_MODEL` | modelo (padrão `claude-opus-5`; `claude-sonnet-5` é mais barato) |
| `ASSESSOR_EFFORT` | `low` / `medium` / `high` — profundidade do raciocínio (padrão `medium`) |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | credenciais da Cloud API |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | banco |
| `DEFAULT_TIMEZONE` | fuso inicial dos usuários (padrão `America/Sao_Paulo`; cada um pode mudar conversando) |
| `ALLOWED_PHONES` | lista de números permitidos, separados por vírgula (vazio = todos) |
| `PORT` | porta HTTP (padrão 3000) |

## Como funciona por dentro

1. A Meta chama `POST /webhook`. O servidor valida a assinatura HMAC (`X-Hub-Signature-256`), responde 200 imediatamente e processa a mensagem em segundo plano. IDs já processados são descartados (a Meta reenvia eventos em caso de falha).
2. O assessor busca as últimas 30 mensagens do usuário no banco, acrescenta a data/hora atual no fuso dele e chama o Claude com as 12 ferramentas. O SDK executa o loop de *tool use* (`toolRunner`): o modelo decide quais ferramentas chamar, elas gravam no Supabase e o texto final volta ao usuário.
3. O system prompt é fixo e marcado para cache de prompt, então só o histórico e a mensagem nova são cobrados integralmente a cada chamada.
4. Recusas de segurança do modelo caem em um modelo alternativo automaticamente (`fallbacks: "default"`), e o usuário recebe uma mensagem amigável se mesmo assim não houver resposta.
5. O agendador roda a cada minuto, envia lembretes com `remind_at` vencido e reagenda os recorrentes (diário, semanal, mensal).

## Limitações e próximos passos

- Só texto: áudios e imagens recebem um aviso. Transcrição de áudio e leitura de comprovantes são extensões naturais.
- Lembretes fora da janela de 24h desde a última mensagem do usuário exigem *message templates* aprovados pela Meta em contas de produção; em modo de teste, texto livre funciona.
- Relatório mensal automático, exportação para planilha e metas de gasto ficam como sugestões de evolução.
