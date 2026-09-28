import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMessage, verifySecret, toTelegramHtml, splitMessage, TelegramClient, TelegramApiError, runPolling } from "../src/telegram.ts";
import { MemoryStore } from "../src/store.ts";
import { nextOccurrence, processDueReminders } from "../src/scheduler.ts";

function update(text: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    update_id: 100,
    message: {
      message_id: 7, date: 1790000000, text,
      from: { id: 42, first_name: "Ana", username: "ana" },
      chat: { id: 42, type: "private" },
      ...extra,
    },
  };
}

test("extractMessage lê texto, legenda, comandos e ignora bots/edições", () => {
  const m = extractMessage(update("gastei 40 no almoço"))!;
  assert.deepEqual(m, { id: "100", chatId: "42", fromId: "42", name: "Ana", timestamp: 1790000000, text: "gastei 40 no almoço", isCommand: false });
  assert.equal(extractMessage(update(undefined, { caption: "nota fiscal" }))!.text, "nota fiscal");
  assert.equal(extractMessage(update(undefined))!.text, null);
  assert.equal(extractMessage(update("/start"))!.isCommand, true);
  assert.equal(extractMessage(update("oi", { from: { id: 1, is_bot: true } })), null);
  assert.equal(extractMessage({ update_id: 1, edited_message: update("x").message }), null);
});

test("verifySecret compara em tempo constante e rejeita tamanhos diferentes", () => {
  assert.equal(verifySecret("segredo", "segredo"), true);
  assert.equal(verifySecret("segredx", "segredo"), false);
  assert.equal(verifySecret("seg", "segredo"), false);
  assert.equal(verifySecret(undefined, "segredo"), false);
});

test("toTelegramHtml escapa HTML e converte *negrito*", () => {
  assert.equal(toTelegramHtml("Anotei: *almoço* R$ 40,00 <ok> & tal"), "Anotei: <b>almoço</b> R$ 40,00 &lt;ok&gt; &amp; tal");
  assert.equal(toTelegramHtml("• *Dentista* às 10h"), "• <b>Dentista</b> às 10h");
  assert.equal(toTelegramHtml("2*3 = 6 e a*b"), "2*3 = 6 e a*b"); // asteriscos de multiplicação ficam
  assert.equal(toTelegramHtml("*linha inteira*"), "<b>linha inteira</b>");
});

test("splitMessage respeita o limite e preserva o conteúdo", () => {
  const text = Array.from({ length: 50 }, (_, i) => `linha ${i} ${"x".repeat(80)}`).join("\n");
  const parts = splitMessage(text, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 1000);
  assert.equal(parts.join("\n").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});

function fakeFetch(handler: (method: string, body: any) => { ok: boolean; result?: unknown; description?: string; error_code?: number }) {
  const calls: Array<{ method: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const body = JSON.parse(init.body as string);
    calls.push({ method, body });
    const r = handler(method, body);
    return new Response(JSON.stringify(r), { status: r.ok ? 200 : (r.error_code ?? 500) });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("TelegramClient.sendText usa HTML e a URL certa", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ ok: true, result: {} }));
  const tg = new TelegramClient({ token: "TOKEN", fetchImpl });
  await tg.sendText("42", "Anotei: *almoço*");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendMessage");
  assert.deepEqual(calls[0].body, { chat_id: "42", text: "Anotei: <b>almoço</b>", parse_mode: "HTML" });
});

test("TelegramClient.sendText cai para texto puro quando o HTML é rejeitado", async () => {
  const { fetchImpl, calls } = fakeFetch((_m, body) => body.parse_mode ? { ok: false, error_code: 400, description: "can't parse entities" } : { ok: true, result: {} });
  const tg = new TelegramClient({ token: "TOKEN", fetchImpl });
  await tg.sendText("42", "texto *quebrado");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.parse_mode, undefined);
  assert.equal(calls[1].body.text, "texto *quebrado");
});

test("TelegramClient propaga outros erros da API", async () => {
  const { fetchImpl } = fakeFetch(() => ({ ok: false, error_code: 401, description: "Unauthorized" }));
  const tg = new TelegramClient({ token: "TOKEN", fetchImpl });
  await assert.rejects(tg.sendText("42", "x"), (e: unknown) => e instanceof TelegramApiError && e.status === 401 && /Unauthorized/.test(e.message));
});

test("runPolling avança o offset e entrega cada atualização", async () => {
  const batches: any[][] = [[update("a"), { ...update("b"), update_id: 101 }], []];
  const { fetchImpl, calls } = fakeFetch((method) => {
    if (method !== "getUpdates") return { ok: true, result: {} };
    const next = batches.shift();
    if (!next) { ac.abort(); return { ok: false, error_code: 499, description: "abort" }; }
    return { ok: true, result: next };
  });
  const ac = new AbortController();
  const tg = new TelegramClient({ token: "TOKEN", fetchImpl });
  const seen: number[] = [];
  await runPolling(tg, async (u) => { seen.push(u.update_id); }, { signal: ac.signal, timeoutSeconds: 0 });
  assert.deepEqual(seen, [100, 101]);
  const gets = calls.filter((c) => c.method === "getUpdates");
  assert.equal(gets[0].body.offset, undefined);
  assert.equal(gets[1].body.offset, 102);
  assert.deepEqual(gets[0].body.allowed_updates, ["message"]);
});

test("nextOccurrence: diária, semanal e mensal (fim de mês)", () => {
  const tz = "America/Sao_Paulo";
  assert.equal(nextOccurrence("2026-09-27T12:00:00.000Z", "nenhuma", tz), null);
  assert.equal(nextOccurrence("2026-09-27T12:00:00.000Z", "diaria", tz), "2026-09-28T12:00:00.000Z");
  assert.equal(nextOccurrence("2026-09-27T12:00:00.000Z", "semanal", tz), "2026-10-04T12:00:00.000Z");
  assert.equal(nextOccurrence("2026-01-31T12:00:00.000Z", "mensal", tz), "2026-02-28T12:00:00.000Z");
});

test("processDueReminders envia vencidos, reagenda recorrentes e marca únicos", async () => {
  const store = new MemoryStore();
  const u = await store.getOrCreateUser("42", { tz: "America/Sao_Paulo" });
  const sent: Array<{ to: string; text: string }> = [];
  const sender = { sendText: async (to: string, text: string) => { sent.push({ to, text }); } };
  const now = new Date("2026-09-27T12:00:00.000Z");
  await store.addReminder({ user_id: u.id, kind: "lembrete", title: "Água", location: null,
    due_at: now.toISOString(), remind_at: now.toISOString(), recurrence: "diaria" });
  await store.addReminder({ user_id: u.id, kind: "compromisso", title: "Reunião", location: "Sala 2",
    due_at: "2026-09-27T12:30:00.000Z", remind_at: "2026-09-27T11:55:00.000Z", recurrence: "nenhuma" });
  await store.addReminder({ user_id: u.id, kind: "lembrete", title: "Futuro", location: null,
    due_at: "2026-09-30T12:00:00.000Z", remind_at: "2026-09-30T12:00:00.000Z", recurrence: "nenhuma" });

  const n = await processDueReminders(store, sender, now);
  assert.equal(n, 2);
  assert.equal(sent[0].to, "42");
  assert.match(sent[0].text, /Água/);
  assert.match(sent[1].text, /Reunião/);
  assert.match(sent[1].text, /Sala 2/);
  const [diario, unico, futuro] = store.reminders;
  assert.equal(diario.status, "pendente");
  assert.equal(diario.due_at, "2026-09-28T12:00:00.000Z");
  assert.equal(unico.status, "enviado");
  assert.equal(futuro.status, "pendente");
});
