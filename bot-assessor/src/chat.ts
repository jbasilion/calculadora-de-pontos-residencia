/**
 * Chat local no terminal para testar o assessor sem WhatsApp nem Supabase.
 * Uso: GEMINI_API_KEY=... npm run chat   (ou LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=...)
 * Os dados ficam só em memória (somem ao fechar).
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig, requireLlmConfig } from "./config.js";
import { MemoryStore } from "./store.js";
import { Assessor, friendlyError } from "./assessor.js";
import { createProvider } from "./llm.js";
import { processDueReminders } from "./scheduler.js";
import type { WhatsAppClient } from "./whatsapp.js";

async function main() {
  const cfg = loadConfig();
  requireLlmConfig(cfg);
  const store = new MemoryStore();
  const assessor = new Assessor(store, createProvider(cfg));
  const user = await store.getOrCreateUser("5500000000000", { tz: cfg.DEFAULT_TIMEZONE, name: "Você" });

  // "WhatsApp" falso: imprime no terminal os lembretes que seriam enviados.
  const fakeWa = { sendText: async (_to: string, text: string) => { console.log(`\n🔔 ${text}\n`); } } as unknown as WhatsAppClient;
  setInterval(() => { processDueReminders(store, fakeWa).catch(() => {}); }, 15_000).unref();

  console.log(`Assessor local (IA: ${assessor.providerName}). Digite sua mensagem; "sair" encerra.\n`);
  const rl = createInterface({ input: stdin, output: stdout });
  for (;;) {
    const line = (await rl.question("você> ")).trim();
    if (!line) continue;
    if (["sair", "exit", "quit"].includes(line.toLowerCase())) break;
    try {
      const answer = await assessor.reply(user, line);
      console.log(`\nassessor> ${answer}\n`);
    } catch (err) {
      console.error("\n[erro]", err instanceof Error ? err.message : err);
      console.log(`assessor> ${friendlyError(err)}\n`);
    }
  }
  rl.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
