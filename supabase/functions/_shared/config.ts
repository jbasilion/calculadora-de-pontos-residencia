// Centraliza a leitura das variáveis de ambiente (secrets do Supabase).
// Defina-as com:  supabase secrets set NOME=valor

function must(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Variável de ambiente ausente: ${name}`);
  return v;
}

function opt(name: string, fallback = ""): string {
  return Deno.env.get(name) ?? fallback;
}

export const config = {
  // Supabase (injetadas automaticamente no runtime das Edge Functions)
  supabaseUrl: must("SUPABASE_URL"),
  supabaseServiceRoleKey: must("SUPABASE_SERVICE_ROLE_KEY"),
  storageBucket: opt("STORAGE_BUCKET", "news-photos"),

  // Telegram
  telegramToken: () => must("TELEGRAM_BOT_TOKEN"),
  // Segredo na URL do webhook — o Telegram devolve no header. Barra requests falsas.
  telegramWebhookSecret: opt("TELEGRAM_WEBHOOK_SECRET"),
  // Só aceita mensagens deste chat (o seu). Deixe vazio para aceitar de qualquer um.
  allowedChatId: opt("TELEGRAM_ALLOWED_CHAT_ID"),

  // IA (Google Gemini — free tier)
  aiProvider: opt("AI_PROVIDER", "gemini"), // gemini | openai
  geminiApiKey: () => must("GEMINI_API_KEY"),
  geminiModel: opt("GEMINI_MODEL", "gemini-2.0-flash"),
  openaiApiKey: () => must("OPENAI_API_KEY"),
  openaiModel: opt("OPENAI_MODEL", "gpt-4o-mini"),

  // WordPress
  wpBaseUrl: () => must("WP_BASE_URL").replace(/\/+$/, ""), // sem barra no fim
  wpUser: () => must("WP_USER"),
  wpAppPassword: () => must("WP_APP_PASSWORD"),
  wpDefaultStatus: opt("WP_DEFAULT_STATUS", "draft"), // draft | publish
  wpCategoryId: opt("WP_CATEGORY_ID"), // opcional: id numérico da categoria

  // Aparência
  siteName: opt("SITE_NAME", "Portal de Notícias"),
};
