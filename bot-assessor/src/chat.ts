/**
 * Chat local no terminal para testar o assessor sem WhatsApp nem Supabase.
 * Uso: ANTHROPIC_API_KEY=... npm run chat
 * Os dados ficam só em memória (somem ao fechar).
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.js";
import { MemoryStore } from "./store.js";
import { Assessor, friendlyError } from "./assessor.js";
import { processDueReminders, reminderText } from "./scheduler.js";
import type { WhatsAppClient } from "./whatsapp.js";

async function main() {
  const cfg = loadConfig();
  const store = new MemoryStore();
  const assessor = new Assessor(store, { model: cfg.ASSESSOR_MODEL, effort: cfg.ASSESSOR_EFFORT });
  const user = await store.getOrCreateUser("5500000000000", { tz: cfg.DEFAULT_TIMEZONE, name: "Você" });

  // "WhatsApp" falso: imprime no terminal os lembretes que seriam enviados.
  const fakeWa = { sendText: async (_to: string, text: string) => { console.log(`\n🔔 ${text}\n`); } } as unknown as WhatsAppClient;
  setInterval(() => { processDueReminders(store, fakeWa).catch(() => {}); }, 15_000).unref();

  console.log(`Assessor local (modelo ${cfg.ASSESSOR_MODEL}). Digite sua mensagem; "sair" encerra.\n`);
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
  void reminderText;
}

main().catch((err) => { console.error(err); process.exit(1); });
