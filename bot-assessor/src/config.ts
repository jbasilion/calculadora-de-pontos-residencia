import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  LLM_PROVIDER: z.enum(["gemini", "anthropic"]).default("gemini"),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_THINKING_BUDGET: z.coerce.number().int().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** polling: o bot busca as mensagens (não precisa de URL pública). webhook: o Telegram chama o servidor. */
  TELEGRAM_MODE: z.enum(["polling", "webhook"]).default("polling"),
  TELEGRAM_WEBHOOK_URL: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  PORT: z.coerce.number().default(3000),
  DEFAULT_TIMEZONE: z.string().default("America/Sao_Paulo"),
  ALLOWED_CHAT_IDS: z.string().default(""),
});

export type Config = z.infer<typeof schema> & { allowedChatIds: Set<string> };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  const allowedChatIds = new Set(
    parsed.ALLOWED_CHAT_IDS.split(",").map((s) => s.trim()).filter(Boolean),
  );
  return { ...parsed, allowedChatIds };
}

/** Variáveis exigidas pelo provedor de IA escolhido. */
export function requireLlmConfig(cfg: Config): void {
  const key = cfg.LLM_PROVIDER === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!cfg[key]) {
    throw new Error(`Variável de ambiente ausente: ${key} (LLM_PROVIDER=${cfg.LLM_PROVIDER}). Copie .env.example para .env e preencha.`);
  }
}

/** Garante as variáveis que o servidor precisa; falha cedo com mensagem clara. */
export function requireServerConfig(cfg: Config): void {
  requireLlmConfig(cfg);
  const required: Array<keyof Config> = ["TELEGRAM_BOT_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  if (cfg.TELEGRAM_MODE === "webhook") required.push("TELEGRAM_WEBHOOK_URL", "TELEGRAM_WEBHOOK_SECRET");
  const missing = required.filter((k) => !cfg[k]);
  if (missing.length) {
    throw new Error(
      `Variáveis de ambiente ausentes: ${missing.join(", ")}. Copie .env.example para .env e preencha.`,
    );
  }
}
