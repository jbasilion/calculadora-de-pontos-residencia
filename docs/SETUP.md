# Bot de Notícias — Telegram → IA → WordPress

Fluxo automatizado para publicar no seu portal a partir do Telegram:

```
Você envia foto + notícia crua  ─▶  Bot do Telegram (Edge Function)
        │
        ▼
  IA (Gemini) escreve a matéria
        │
        ▼
  Bot te devolve um PREVIEW (imagem do card + título + lead)
   com botões  [✅ Aprovar e publicar]   [🔄 Refazer]
        │
   ┌────┴─────────────┐
   ▼                  ▼
Aprovar            Refazer
   │                  │
   ▼                  ▼
Publica no        IA reescreve
WordPress         e manda novo preview
(foto = imagem     (repete quantas
 destacada)         vezes quiser)
```

## Como usar no dia a dia

1. Abra a conversa com o seu bot no Telegram.
2. Envie **uma foto** com a **notícia crua na legenda** (a foto vira a imagem
   destacada; o texto vira a matéria).
3. Aguarde alguns segundos: chega um preview com o card e o resumo.
4. Toque em **✅ Aprovar e publicar** ou **🔄 Refazer** até gostar.
5. Ao aprovar, o bot cria o post no WordPress (rascunho ou publicado, conforme
   `WP_DEFAULT_STATUS`) e te manda o link.

---

## Instalação (uma vez)

### Pré-requisitos
- Conta no [Supabase](https://supabase.com) (plano free serve).
- [Supabase CLI](https://supabase.com/docs/guides/local-development) instalada.
- Um bot do Telegram e um chat com ele.
- Chave da API do Google Gemini (free).
- WordPress auto-hospedado com REST API + Application Password.

### 1. Criar o bot do Telegram
1. No Telegram, fale com **@BotFather** → `/newbot` → siga os passos.
2. Guarde o **token** (`TELEGRAM_BOT_TOKEN`).
3. Descubra seu chat id com **@userinfobot** (`TELEGRAM_ALLOWED_CHAT_ID`).

### 2. Chave da IA (grátis)
1. Acesse https://aistudio.google.com/app/apikey e gere uma API key.
2. Guarde em `GEMINI_API_KEY`. Modelo padrão: `gemini-2.0-flash` (free tier).

### 3. WordPress — Application Password
1. No painel: **Usuários → Perfil → Application Passwords**.
2. Crie uma senha nova (ex.: "bot-noticias") e copie o valor.
3. Preencha `WP_BASE_URL`, `WP_USER`, `WP_APP_PASSWORD`.
   - `WP_DEFAULT_STATUS=draft` publica como rascunho (recomendado no começo);
     troque para `publish` quando confiar no fluxo.

### 4. Projeto Supabase
```bash
supabase login
supabase link --project-ref SEU_PROJECT_REF   # edite também em supabase/config.toml

# Banco de dados
supabase db push        # aplica supabase/migrations/0001_init.sql

# Bucket público para as fotos originais
# (crie no Dashboard → Storage → New bucket → nome "news-photos" → Public)
```

### 5. Secrets
Copie `.env.example`, preencha os valores e envie ao Supabase:
```bash
supabase secrets set --env-file ./.env
```
> `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já existem no runtime das
> Edge Functions — não precisa defini-las.

### 6. Deploy da função
```bash
supabase functions deploy telegram-webhook --no-verify-jwt
```
Anote a URL: `https://SEU_PROJECT_REF.functions.supabase.co/telegram-webhook`

### 7. Registrar o webhook no Telegram
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://SEU_PROJECT_REF.functions.supabase.co/telegram-webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d "allowed_updates=[\"message\",\"callback_query\"]"
```
Confirme com:
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

Pronto. Mande uma foto com legenda para o bot e teste o fluxo.

---

## Estrutura do código
```
supabase/
  migrations/0001_init.sql          Tabela news_drafts + RLS
  config.toml                       verify_jwt=false para o webhook
  functions/
    telegram-webhook/index.ts       Orquestra todo o fluxo
    _shared/
      config.ts                     Variáveis de ambiente
      telegram.ts                   Bot API (mensagens, fotos, botões, download)
      ai.ts                         Geração do artigo (Gemini/OpenAI)
      preview.ts                    Monta a imagem de preview (SVG→PNG)
      wordpress.ts                  Upload de mídia + criação do post
      db.ts                         Postgres (drafts) + Storage
```

## Ajustes comuns
- **Trocar de IA:** `AI_PROVIDER=openai` + `OPENAI_API_KEY`.
- **Publicar direto (sem rascunho):** `WP_DEFAULT_STATUS=publish`.
- **Categoria fixa:** `WP_CATEGORY_ID=<id>`.
- **Estilo do prompt jornalístico:** edite `_shared/ai.ts` (função `buildPrompt`).
- **Visual do card de preview:** edite `_shared/preview.ts`.

## Segurança
- `TELEGRAM_WEBHOOK_SECRET` bloqueia chamadas forjadas ao webhook.
- `TELEGRAM_ALLOWED_CHAT_ID` faz o bot responder só a você.
- A tabela usa RLS sem policies públicas: só a Edge Function (service role) acessa.
- Nunca comite o `.env` real nem as Application Passwords.
