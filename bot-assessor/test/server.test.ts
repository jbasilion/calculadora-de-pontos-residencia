import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp, type AppDeps } from "../src/server.ts";
import { MemoryStore } from "../src/store.ts";
import type { Assessor } from "../src/assessor.ts";
import type { WhatsAppClient } from "../src/whatsapp.ts";

const SECRET = "app-secret";

function payload(text: string, id = "wamid.1", from = "5511999999999") {
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: {
      contacts: [{ wa_id: from, profile: { name: "Ana" } }],
      messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
    } }] }],
  };
}

async function startApp(overrides: Partial<AppDeps> = {}) {
  const store = new MemoryStore();
  const sent: Array<{ to: string; text: string }> = [];
  const wa = {
    sendText: async (to: string, text: string) => { sent.push({ to, text }); },
    markReadAndTyping: async () => {},
  } as unknown as WhatsAppClient;
  const assessor = {
    reply: async (_user: unknown, text: string) => `eco: ${text}`,
  } as unknown as Assessor;
  const app = createApp({
    store, wa, assessor, verifyToken: "verify-me", appSecret: SECRET,
    defaultTz: "America/Sao_Paulo", allowedPhones: new Set(), ...overrides,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, sign = true) => {
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (sign) headers["x-hub-signature-256"] = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
    return fetch(`${base}/webhook`, { method: "POST", headers, body: raw });
  };
  const waitFor = async (pred: () => boolean, ms = 2000) => {
    const t0 = Date.now();
    while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  };
  return { base, post, sent, store, waitFor, close: () => new Promise((r) => server.close(r)) };
}

test("GET /webhook responde ao challenge com o verify token certo", async () => {
  const s = await startApp();
  try {
    const ok = await fetch(`${s.base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "12345");
    const bad = await fetch(`${s.base}/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1`);
    assert.equal(bad.status, 403);
  } finally { await s.close(); }
});

test("POST /webhook rejeita assinatura ausente ou inválida", async () => {
  const s = await startApp();
  try {
    assert.equal((await s.post(payload("oi"), false)).status, 401);
    const raw = JSON.stringify(payload("oi"));
    const r = await fetch(`${s.base}/webhook`, {
      method: "POST", body: raw,
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + "0".repeat(64) },
    });
    assert.equal(r.status, 401);
    assert.equal(s.sent.length, 0);
  } finally { await s.close(); }
});

test("POST /webhook responde 200 e envia a resposta do assessor; duplicados são ignorados", async () => {
  const s = await startApp();
  try {
    const r = await s.post(payload("gastei 40 no almoço"));
    assert.equal(r.status, 200);
    await s.waitFor(() => s.sent.length === 1);
    assert.deepEqual(s.sent, [{ to: "5511999999999", text: "eco: gastei 40 no almoço" }]);
    assert.equal(s.store.users[0]?.name, "Ana");

    await s.post(payload("gastei 40 no almoço")); // mesmo wamid.1
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.sent.length, 1);
  } finally { await s.close(); }
});

test("números fora de ALLOWED_PHONES são ignorados", async () => {
  const s = await startApp({ allowedPhones: new Set(["5500000000000"]) });
  try {
    await s.post(payload("oi", "wamid.9"));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.sent.length, 0);
  } finally { await s.close(); }
});

test("mensagem sem texto recebe aviso", async () => {
  const s = await startApp();
  try {
    const p = payload("x", "wamid.audio");
    p.entry[0].changes[0].value.messages[0] = { id: "wamid.audio", from: "5511999999999", timestamp: String(Math.floor(Date.now() / 1000)), type: "audio" } as any;
    await s.post(p);
    await s.waitFor(() => s.sent.length === 1);
    assert.match(s.sent[0].text, /mensagens de texto/);
  } finally { await s.close(); }
});
