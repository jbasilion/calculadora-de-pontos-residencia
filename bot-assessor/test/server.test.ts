import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, handleUpdate, WELCOME, type AppDeps } from "../src/server.ts";
import { MemoryStore } from "../src/store.ts";
import type { Assessor } from "../src/assessor.ts";

function update(text: string | undefined, id = 100, chatId = 42) {
  return {
    update_id: id,
    message: {
      message_id: id, date: Math.floor(Date.now() / 1000), text,
      from: { id: chatId, first_name: "Ana" }, chat: { id: chatId, type: "private" },
    },
  };
}

function makeDeps(overrides: Partial<AppDeps> = {}) {
  const store = new MemoryStore();
  const sent: Array<{ to: string; text: string }> = [];
  const telegram = {
    sendText: async (to: string, text: string) => { sent.push({ to, text }); },
    sendTyping: async () => {},
  };
  const assessor = { reply: async (_u: unknown, text: string) => `eco: ${text}` } as unknown as Assessor;
  const deps: AppDeps = { store, telegram, assessor, defaultTz: "America/Sao_Paulo", allowedChatIds: new Set(), ...overrides };
  return { deps, sent, store };
}

test("handleUpdate responde via assessor, cria o usuário e ignora duplicados", async () => {
  const { deps, sent, store } = makeDeps();
  await handleUpdate(deps, update("gastei 40 no almoço"));
  assert.deepEqual(sent, [{ to: "42", text: "eco: gastei 40 no almoço" }]);
  assert.equal(store.users[0]?.name, "Ana");
  assert.equal(store.users[0]?.chat_id, "42");
  await handleUpdate(deps, update("gastei 40 no almoço")); // mesmo update_id
  assert.equal(sent.length, 1);
});

test("/start responde com boas-vindas sem chamar a IA; outros comandos viram texto", async () => {
  const { deps, sent } = makeDeps();
  await handleUpdate(deps, update("/start", 1));
  assert.equal(sent[0].text, WELCOME);
  await handleUpdate(deps, update("/resumo mes", 2));
  assert.equal(sent[1].text, "eco: resumo mes");
});

test("chats fora de ALLOWED_CHAT_IDS recebem aviso com o próprio id", async () => {
  const { deps, sent, store } = makeDeps({ allowedChatIds: new Set(["999"]) });
  await handleUpdate(deps, update("oi", 5));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /privado.*42/);
  assert.equal(store.users.length, 0);
});

test("mensagem sem texto recebe aviso; erro do assessor vira mensagem amigável", async () => {
  const { deps, sent } = makeDeps();
  await handleUpdate(deps, update(undefined, 7));
  assert.match(sent[0].text, /mensagens de texto/);
  const failing = { reply: async () => { throw new Error("boom"); } } as unknown as Assessor;
  await handleUpdate({ ...deps, assessor: failing }, update("oi", 8));
  assert.match(sent[1].text, /Ops/);
});

test("webhook: exige o secret token e responde 200 processando em segundo plano", async () => {
  const { deps, sent } = makeDeps();
  const app = createApp(deps, { secret: "s3gredo" });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const bad = await fetch(`${base}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(update("oi", 20)) });
    assert.equal(bad.status, 401);
    const ok = await fetch(`${base}/telegram/webhook`, {
      method: "POST", body: JSON.stringify(update("oi", 21)),
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3gredo" },
    });
    assert.equal(ok.status, 200);
    const t0 = Date.now();
    while (sent.length < 1 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(sent, [{ to: "42", text: "eco: oi" }]);
    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), { ok: true });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("sem webhook configurado, a rota não existe", async () => {
  const { deps } = makeDeps();
  const app = createApp(deps);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const r = await fetch(`${base}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
