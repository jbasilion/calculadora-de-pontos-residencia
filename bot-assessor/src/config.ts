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

  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default("v21.0"),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  PORT: z.coerce.number().default(3000),
  DEFAULT_TIMEZONE: z.string().default("America/Sao_Paulo"),
  ALLOWED_PHONES: z.string().default(""),
});

export type Config = z.infer<typeof schema> & { allowedPhones: Set<string> };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  const allowedPhones = new Set(
    parsed.ALLOWED_PHONES.split(",").map((s) => s.trim()).filter(Boolean),
  );
  return { ...parsed, allowedPhones };
}

/** Variáveis exigidas pelo provedor de IA escolhido. */
export function requireLlmConfig(cfg: Config): void {
  const key = cfg.LLM_PROVIDER === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!cfg[key]) {
    throw new Error(`Variável de ambiente ausente: ${key} (LLM_PROVIDER=${cfg.LLM_PROVIDER}). Copie .env.example para .env e preencha.`);
  }
}

/** Garante as variáveis que o servidor WhatsApp precisa; falha cedo com mensagem clara. */
export function requireServerConfig(cfg: Config): void {
  requireLlmConfig(cfg);
  const missing = (
    [
      "WHATSAPP_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_VERIFY_TOKEN",
      "WHATSAPP_APP_SECRET",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
    ] as const
  ).filter((k) => !cfg[k]);
  if (missing.length) {
    throw new Error(
      `Variáveis de ambiente ausentes: ${missing.join(", ")}. Copie .env.example para .env e preencha.`,
    );
  }
}
