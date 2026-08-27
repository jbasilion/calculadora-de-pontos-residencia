# Bot de Notícias — Telegram → IA → WordPress

Envie uma **foto com a notícia crua na legenda** para um bot do Telegram. Uma
IA (Google Gemini, free tier) escreve a matéria pronta para o portal e te
devolve um **preview** com botões:

- **✅ Aprovar e publicar** → cria o post no WordPress (a foto vira imagem destacada);
- **🔄 Refazer** → a IA reescreve e manda um novo preview, quantas vezes precisar.

Roda 100% em **Supabase Edge Functions** (sem servidor para manter).

## Comece por aqui
👉 **[docs/SETUP.md](docs/SETUP.md)** — passo a passo de instalação e uso.

## Stack
- **Telegram Bot API** — entrada (foto + texto) e aprovação por botões.
- **Google Gemini** — geração do texto jornalístico (gratuito). Trocável por OpenAI.
- **Supabase** — Edge Function (orquestração), Postgres (rascunhos) e Storage (fotos).
- **WordPress REST API** + Application Password — publicação.

## Estrutura
```
supabase/
  migrations/0001_init.sql        Tabela de rascunhos (news_drafts)
  functions/telegram-webhook/     Handler que orquestra o fluxo
  functions/_shared/              Telegram, IA, preview, WordPress, DB
docs/SETUP.md                     Guia de instalação
.env.example                      Modelo das variáveis/secrets
```

> Nota: o arquivo `CALCUL~1.HTM` (calculadora) é conteúdo antigo do repositório
> e não faz parte deste bot.
