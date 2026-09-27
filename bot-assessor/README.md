# Bot Assessor — assistente pessoal no Telegram

Um assessor de IA no Telegram, no estilo do "Meu Assessor": você manda mensagens soltas
("gastei 40 no almoço", "me lembra de pagar a luz dia 5 às 9h", "o que tenho amanhã?")
e ele registra gastos, agenda compromissos, cria lembretes e guarda notas. Tudo em
português, com respostas curtas.

**Stack:** Node.js 20+ · TypeScript · [Gemini](https://ai.google.dev) (plano gratuito) com *function calling*,
ou Claude como alternativa · Telegram Bot API · Supabase (Postgres).

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
│   ├── server.ts      # entrada: long polling do Telegram (ou webhook), agendador e /health
│   ├── assessor.ts    # system prompt + montagem do contexto (histórico, data/hora)
│   ├── llm.ts         # provedores de IA: GeminiProvider (padrão) e AnthropicProvider
│   ├── tools.ts       # ferramentas: gastos, receitas, resumo, lembretes, agenda, notas
│   ├── telegram.ts    # Bot API: envio, long polling, webhook, formatação
│   ├── scheduler.ts   # cron por minuto: dispara lembretes vencidos
│   ├── store.ts       # interface Store + SupabaseStore + MemoryStore
│   ├── dates.ts       # fuso horário, períodos (hoje/semana/mês), formatação
│   ├── config.ts      # variáveis de ambiente (zod)
│   └── chat.ts        # chat no terminal para testar sem Telegram
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

### 2. Chave do Gemini (grátis)

1. Entre em [aistudio.google.com/apikey](https://aistudio.google.com/apikey) com sua conta Google e clique em **Create API key**.
2. Cole em `GEMINI_API_KEY` no `.env`.

O plano gratuito não cobra por token, só limita a quantidade: o `gemini-2.5-flash` aceita
cerca de 10 requisições por minuto e 250 por dia; o `gemini-2.5-flash-lite` aceita 15 por minuto
e 1.000 por dia. Cada mensagem sua costuma gastar 2 requisições (uma para decidir a ação, outra
para responder), então dá para umas 120 mensagens por dia no Flash. Se estourar, o bot responde
pedindo para tentar em um minuto. Para trocar de modelo, mude `GEMINI_MODEL`.

### 3. Testar no terminal (sem Telegram, sem banco)

```bash
npm run chat
```

Os dados ficam em memória. Bom para ajustar o comportamento antes de ligar no Telegram.

### 4. Banco (Supabase)

1. Crie um projeto em [supabase.com](https://supabase.com).
2. No **SQL Editor**, cole e rode `supabase/migrations/0001_init.sql`.
3. Em *Project Settings → API*, copie a **URL** e a chave **service_role** para o `.env`
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). A chave service_role só vive no servidor.

### 5. Bot do Telegram (2 minutos)

1. No Telegram, abra o [@BotFather](https://t.me/BotFather) e mande `/newbot`. Escolha um nome e um
   username terminado em `bot`.
2. Copie o token que ele devolve (formato `123456789:AAH...`) para `TELEGRAM_BOT_TOKEN` no `.env`.
3. Opcional: mande `/setdescription` e `/setuserpic` no BotFather para deixar o bot com a sua cara.

Para o bot ser só seu, preencha `ALLOWED_CHAT_IDS` com o seu id de usuário. Não sabe o id? Deixe a
variável com qualquer valor (ex.: `0`), mande uma mensagem ao bot e ele responde informando o seu id.

### 6. Subir o servidor

Em **modo polling** (padrão) o próprio bot busca as mensagens no Telegram. Não precisa de URL pública,
HTTPS nem túnel: funciona no seu computador, num Raspberry Pi ou em qualquer VPS.

```bash
npm run dev            # desenvolvimento, recarrega ao salvar
```

Produção (Railway, Render, Fly.io, VPS...):

```bash
npm run build
npm start              # node dist/server.js
```

O processo precisa ficar ligado: além de responder, ele roda o agendador que dispara os lembretes a
cada minuto. Se o computador desligar, os lembretes atrasados são enviados quando ele voltar.

**Modo webhook** (opcional, para hospedagens que exigem um servidor HTTP): defina `TELEGRAM_MODE=webhook`,
`TELEGRAM_WEBHOOK_URL=https://seu-app.exemplo.com` e um `TELEGRAM_WEBHOOK_SECRET`. Ao subir, o bot
registra o webhook `https://seu-app.exemplo.com/telegram/webhook` sozinho e valida o segredo em cada chamada.

### 7. Testes

```bash
npm test               # datas, ferramentas, provedor Gemini, Telegram, agendador, servidor
npm run typecheck
```

## Configuração

| Variável | Para que serve |
|---|---|
| `LLM_PROVIDER` | `gemini` (padrão) ou `anthropic` |
| `GEMINI_API_KEY` | chave do Google AI Studio |
| `GEMINI_MODEL` | padrão `gemini-2.5-flash`; `gemini-2.5-flash-lite` tem cota diária maior |
| `GEMINI_THINKING_BUDGET` | opcional; `0` desliga o raciocínio interno e acelera as respostas |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT` | só quando `LLM_PROVIDER=anthropic` |
| `TELEGRAM_BOT_TOKEN` | token do @BotFather |
| `TELEGRAM_MODE` | `polling` (padrão) ou `webhook` |
| `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_WEBHOOK_SECRET` | só no modo webhook |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | banco |
| `DEFAULT_TIMEZONE` | fuso inicial dos usuários (padrão `America/Sao_Paulo`; cada um pode mudar conversando) |
| `ALLOWED_CHAT_IDS` | ids de usuário/chat permitidos, separados por vírgula (vazio = todos) |
| `PORT` | porta HTTP (padrão 3000) |

## Como funciona por dentro

1. O bot busca atualizações no Telegram com *long polling* (`getUpdates`), ou as recebe em `POST /telegram/webhook` validando o header secreto. Cada `update_id` é processado uma vez só, mesmo que o Telegram reentregue. `/start` responde com as boas-vindas sem gastar cota da IA.
2. O assessor busca as últimas 30 mensagens do usuário no banco, acrescenta a data/hora atual no fuso dele e chama o modelo com as 12 ferramentas declaradas (*function calling*). Se o modelo pedir ferramentas, o bot as executa (em paralelo), devolve os resultados e repete até receber o texto final. As ferramentas são definidas uma vez só, com schemas zod, e convertidas para o formato do Gemini ou do Claude.
3. Os parâmetros que o modelo manda são validados pelo schema antes de tocar no banco; erro de validação volta como texto para o modelo corrigir.
4. Bloqueios de segurança do modelo e limites de cota viram mensagens amigáveis para o usuário.
5. O agendador roda a cada minuto, envia lembretes com `remind_at` vencido e reagenda os recorrentes (diário, semanal, mensal).
6. As respostas vão em HTML do Telegram (*negrito* vira `<b>`); se o Telegram rejeitar a formatação, o texto é reenviado puro.

## Limitações e próximos passos

- Só texto: áudios e fotos recebem um aviso. Transcrição de áudio e leitura de comprovantes são extensões naturais (o Gemini aceita ambos).
- Em grupos, o bot só vê as mensagens se for administrador ou se o "modo privacidade" for desligado no BotFather; ele foi pensado para conversa individual.
- A versão anterior, para WhatsApp Cloud API, está no histórico do git (commit `b25d910`).
- Relatório mensal automático, exportação para planilha e metas de gasto ficam como sugestões de evolução.
