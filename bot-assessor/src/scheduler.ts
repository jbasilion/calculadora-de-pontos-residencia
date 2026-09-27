/**
 * Dispara lembretes e avisos de compromisso vencidos, a cada minuto.
 */
import cron from "node-cron";
import type { Reminder, Store } from "./store.js";
import type { WhatsAppClient } from "./whatsapp.js";
import { formatPtBr, localParts } from "./dates.js";

export function nextOccurrence(iso: string, recurrence: Reminder["recurrence"], tz: string): string | null {
  if (recurrence === "nenhuma") return null;
  const d = new Date(iso);
  if (recurrence === "diaria") return new Date(d.getTime() + 86_400_000).toISOString();
  if (recurrence === "semanal") return new Date(d.getTime() + 7 * 86_400_000).toISOString();
  // mensal: mesmo dia do mês seguinte, preservando o horário local
  const p = localParts(d, tz);
  const target = new Date(d);
  const nextMonth = p.month === 12 ? 1 : p.month + 1;
  const year = p.month === 12 ? p.year + 1 : p.year;
  const lastDay = new Date(Date.UTC(year, nextMonth, 0)).getUTCDate();
  const day = Math.min(p.day, lastDay);
  const deltaDays = Math.round((Date.UTC(year, nextMonth - 1, day) - Date.UTC(p.year, p.month - 1, p.day)) / 86_400_000);
  target.setTime(d.getTime() + deltaDays * 86_400_000);
  return target.toISOString();
}

export function reminderText(r: Reminder, tz: string): string {
  if (r.kind === "compromisso") {
    const quando = formatPtBr(new Date(r.due_at), tz);
    const local = r.location ? `\n📍 ${r.location}` : "";
    return `📅 Lembrete de compromisso: *${r.title}*\n🕐 ${quando}${local}`;
  }
  return `⏰ Lembrete: ${r.title}`;
}

export async function processDueReminders(store: Store, wa: WhatsAppClient, now = new Date()): Promise<number> {
  const due = await store.dueReminders(now.toISOString());
  let sent = 0;
  for (const r of due) {
    try {
      await wa.sendText(r.phone, reminderText(r, r.tz));
      sent++;
      const nextDue = nextOccurrence(r.due_at, r.recurrence, r.tz);
      if (nextDue) {
        const gap = new Date(r.due_at).getTime() - new Date(r.remind_at).getTime();
        await store.updateReminder(r.id, {
          due_at: nextDue,
          remind_at: new Date(new Date(nextDue).getTime() - gap).toISOString(),
        });
      } else {
        await store.updateReminder(r.id, { status: "enviado" });
      }
    } catch (err) {
      console.error(`[scheduler] falha ao enviar lembrete ${r.id}:`, err);
    }
  }
  return sent;
}

export function startScheduler(store: Store, wa: WhatsAppClient): void {
  let running = false;
  cron.schedule("* * * * *", async () => {
    if (running) return;
    running = true;
    try {
      const n = await processDueReminders(store, wa);
      if (n) console.log(`[scheduler] ${n} lembrete(s) enviado(s)`);
    } catch (err) {
      console.error("[scheduler] erro:", err);
    } finally {
      running = false;
    }
  });
  console.log("[scheduler] ativo (a cada minuto)");
}
