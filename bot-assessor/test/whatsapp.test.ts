import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature, extractMessages, splitMessage, WhatsAppClient } from "../src/whatsapp.ts";
import { MemoryStore } from "../src/store.ts";
import { nextOccurrence, processDueReminders } from "../src/scheduler.ts";

test("verifySignature aceita assinatura correta e rejeita alterada", () => {
  const body = Buffer.from('{"a":1}');
  const sig = "sha256=" + createHmac("sha256", "segredo").update(body).digest("hex");
  assert.equal(verifySignature(body, sig, "segredo"), true);
  assert.equal(verifySignature(body, sig, "outro"), false);
  assert.equal(verifySignature(body, undefined, "segredo"), false);
  assert.equal(verifySignature(body, "sha256=abcd", "segredo"), false);
});

test("extractMessages lê texto e legenda, ignora status", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: {
      contacts: [{ wa_id: "5511999999999", profile: { name: "Ana" } }],
      messages: [
        { id: "wamid.1", from: "5511999999999", timestamp: "1790000000", type: "text", text: { body: "gastei 40 no almoço" } },
        { id: "wamid.2", from: "5511999999999", timestamp: "1790000001", type: "image", image: { caption: "nota fiscal" } },
        { id: "wamid.3", from: "5511999999999", timestamp: "1790000002", type: "audio", audio: {} },
      ],
    } }, { field: "messages", value: { statuses: [{ id: "x", status: "delivered" }] } }] }],
  };
  const msgs = extractMessages(payload);
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs[0], { id: "wamid.1", from: "5511999999999", name: "Ana", timestamp: 1790000000, type: "text", text: "gastei 40 no almoço" });
  assert.equal(msgs[1].text, "nota fiscal");
  assert.equal(msgs[2].text, null);
  assert.deepEqual(extractMessages({ object: "page" }), []);
});

test("splitMessage quebra em limites de linha", () => {
  const text = Array.from({ length: 50 }, (_, i) => `linha ${i} ${"x".repeat(80)}`).join("\n");
  const parts = splitMessage(text, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 1000);
  assert.equal(parts.join("\n").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});

test("WhatsAppClient.sendText chama a Graph API com o corpo certo", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const wa = new WhatsAppClient({ token: "T", phoneNumberId: "123", apiVersion: "v21.0", fetchImpl });
  await wa.sendText("5511999999999", "oi");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://graph.facebook.com/v21.0/123/messages");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer T");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    messaging_product: "whatsapp", to: "5511999999999", type: "text", text: { body: "oi", preview_url: false },
  });
});

test("WhatsAppClient lança erro em resposta não-2xx", async () => {
  const fetchImpl = (async () => new Response("bad token", { status: 401 })) as unknown as typeof fetch;
  const wa = new WhatsAppClient({ token: "T", phoneNumberId: "123", apiVersion: "v21.0", fetchImpl });
  await assert.rejects(wa.sendText("1", "x"), /WhatsApp API 401/);
});

test("nextOccurrence: diária, semanal e mensal (fim de mês)", () => {
  const tz = "America/Sao_Paulo";
  assert.equal(nextOccurrence("2026-09-27T12:00:00.000Z", "nenhuma", tz), null);
  assert.equal(nextOccurrence("2026-09-27T12:00:00.000Z", "diaria", tz), "2026-09-28T12:00:00.000Z");
  assert.equal(nextOccurrence("2026-09-27T12:00:00.000Z", "semanal", tz), "2026-10-04T12:00:00.000Z");
  // 31/01 09:00 local -> 28/02 09:00 local
  assert.equal(nextOccurrence("2026-01-31T12:00:00.000Z", "mensal", tz), "2026-02-28T12:00:00.000Z");
});

test("processDueReminders envia vencidos, reagenda recorrentes e marca únicos", async () => {
  const store = new MemoryStore();
  const u = await store.getOrCreateUser("5511999999999", { tz: "America/Sao_Paulo" });
  const sent: string[] = [];
  const wa = { sendText: async (_to: string, text: string) => { sent.push(text); } } as unknown as WhatsAppClient;
  const now = new Date("2026-09-27T12:00:00.000Z");
  await store.addReminder({ user_id: u.id, kind: "lembrete", title: "Água", location: null,
    due_at: now.toISOString(), remind_at: now.toISOString(), recurrence: "diaria" });
  await store.addReminder({ user_id: u.id, kind: "compromisso", title: "Reunião", location: "Sala 2",
    due_at: "2026-09-27T12:30:00.000Z", remind_at: "2026-09-27T11:55:00.000Z", recurrence: "nenhuma" });
  await store.addReminder({ user_id: u.id, kind: "lembrete", title: "Futuro", location: null,
    due_at: "2026-09-30T12:00:00.000Z", remind_at: "2026-09-30T12:00:00.000Z", recurrence: "nenhuma" });

  const n = await processDueReminders(store, wa, now);
  assert.equal(n, 2);
  assert.match(sent[0], /Água/);
  assert.match(sent[1], /Reunião/);
  assert.match(sent[1], /Sala 2/);
  const [diario, unico, futuro] = store.reminders;
  assert.equal(diario.status, "pendente");
  assert.equal(diario.due_at, "2026-09-28T12:00:00.000Z");
  assert.equal(unico.status, "enviado");
  assert.equal(futuro.status, "pendente");
});
