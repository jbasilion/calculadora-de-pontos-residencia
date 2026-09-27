import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { signPortalToken, verifyPortalToken, portalLink, transactionsToCsv, createPortalRouter } from "../src/portal.ts";
import { MemoryStore } from "../src/store.ts";
import { handleUpdate, type AppDeps } from "../src/server.ts";
import type { Assessor } from "../src/assessor.ts";

const SECRET = "segredo-do-portal";

test("token: assina, verifica, expira e rejeita adulteração", () => {
  const t = signPortalToken("user-1", SECRET, Date.now() + 60_000);
  assert.deepEqual(verifyPortalToken(t, SECRET), { userId: "user-1" });
  assert.equal(verifyPortalToken(t, "outro"), null);
  assert.equal(verifyPortalToken(t + "x", SECRET), null);
  assert.equal(verifyPortalToken(undefined, SECRET), null);
  const expired = signPortalToken("user-1", SECRET, Date.now() - 1);
  assert.equal(verifyPortalToken(expired, SECRET), null);
  // troca o payload mantendo a assinatura
  const [payload, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ u: "user-2", e: Date.now() + 60_000 })).toString("base64url") + "." + sig;
  assert.equal(verifyPortalToken(forged, SECRET), null);
  void payload;
  assert.equal(portalLink("https://x.exemplo.com/", "abc.def"), "https://x.exemplo.com/portal#t=abc.def");
});

test("CSV: separador ;, vírgula decimal, aspas escapadas e BOM", () => {
  const csv = transactionsToCsv([{
    id: "id-1", user_id: "u", kind: "gasto", amount: 1234.5, description: 'almoço "executivo"; com suco',
    category: "alimentação", payment_method: "pix", occurred_on: "2026-09-27", created_at: "2026-09-27T17:00:00Z",
  }]);
  assert.ok(csv.startsWith("﻿"));
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], "data;tipo;valor;descricao;categoria;forma_pagamento;id");
  assert.equal(lines[1], '2026-09-27;gasto;1234,50;"almoço ""executivo""; com suco";alimentação;pix;id-1');
});

async function startPortal() {
  const store = new MemoryStore();
  const user = await store.getOrCreateUser("42", { tz: "America/Sao_Paulo", name: "Ana" });
  const other = await store.getOrCreateUser("99", { tz: "America/Sao_Paulo", name: "Intruso" });
  await store.addTransaction({ user_id: user.id, kind: "gasto", amount: 40, description: "almoço", category: "alimentação", payment_method: "pix", occurred_on: "2026-09-27" });
  await store.addTransaction({ user_id: user.id, kind: "gasto", amount: 18, description: "uber", category: "transporte", payment_method: null, occurred_on: "2026-09-26" });
  await store.addTransaction({ user_id: user.id, kind: "receita", amount: 1000, description: "salário", category: null, payment_method: null, occurred_on: "2026-09-05" });
  await store.addTransaction({ user_id: user.id, kind: "gasto", amount: 99, description: "fora do período", category: "x", payment_method: null, occurred_on: "2026-08-30" });
  await store.addTransaction({ user_id: other.id, kind: "gasto", amount: 500, description: "do outro", category: "x", payment_method: null, occurred_on: "2026-09-27" });
  await store.addReminder({ user_id: user.id, kind: "compromisso", title: "Dentista", location: "Clínica", due_at: "2026-10-02T13:00:00.000Z", remind_at: "2026-10-02T12:00:00.000Z", recurrence: "nenhuma" });
  await store.addNote(user.id, "Placa ABC1D23");

  const app = express();
  app.use(express.json());
  app.use(createPortalRouter({ store, secret: SECRET }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = signPortalToken(user.id, SECRET);
  const get = (path: string, tok: string | null = token) =>
    fetch(base + path, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
  return { store, user, other, base, token, get, close: () => new Promise((r) => server.close(r)) };
}

test("portal: página HTML servida e API protegida por token", async () => {
  const p = await startPortal();
  try {
    const html = await fetch(`${p.base}/portal`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<title>Meu Assessor/);

    assert.equal((await p.get("/api/portal/me", null)).status, 401);
    assert.equal((await p.get("/api/portal/me", "abc.def")).status, 401);
    const me = await p.get("/api/portal/me");
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { name: "Ana", tz: "America/Sao_Paulo", since: p.user.created_at });
  } finally { await p.close(); }
});

test("portal: transações do período só do próprio usuário, fim inclusivo", async () => {
  const p = await startPortal();
  try {
    const r = await p.get("/api/portal/transactions?from=2026-09-01&to=2026-09-27");
    assert.equal(r.status, 200);
    const txs = await r.json();
    assert.deepEqual(txs.map((t: any) => t.description), ["almoço", "uber", "salário"]);
    assert.equal(typeof txs[0].amount, "number");
    assert.equal((await p.get("/api/portal/transactions?from=x&to=y")).status, 400);
  } finally { await p.close(); }
});

test("portal: exclusão só do próprio usuário", async () => {
  const p = await startPortal();
  try {
    const mine = p.store.transactions.find((t) => t.description === "almoço")!;
    const theirs = p.store.transactions.find((t) => t.description === "do outro")!;
    const r1 = await fetch(`${p.base}/api/portal/transactions/${theirs.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${p.token}` } });
    assert.equal(r1.status, 404);
    const r2 = await fetch(`${p.base}/api/portal/transactions/${mine.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${p.token}` } });
    assert.equal(r2.status, 200);
    assert.equal(p.store.transactions.some((t) => t.id === mine.id), false);
    assert.equal(p.store.transactions.some((t) => t.id === theirs.id), true);
  } finally { await p.close(); }
});

test("portal: CSV aceita token na query (download) e lembretes/notas respondem", async () => {
  const p = await startPortal();
  try {
    const csv = await fetch(`${p.base}/api/portal/export.csv?from=2026-09-01&to=2026-09-30&t=${encodeURIComponent(p.token)}`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(csv.headers.get("content-disposition") ?? "", /lancamentos_2026-09-01_2026-09-30\.csv/);
    const body = await csv.text();
    assert.match(body, /almoço/); assert.doesNotMatch(body, /do outro/);

    const rem = await (await p.get("/api/portal/reminders")).json();
    assert.equal(rem.length, 1);
    assert.equal(rem[0].due_label, "sex, 02/10/2026 10:00");
    const notes = await (await p.get("/api/portal/notes")).json();
    assert.equal(notes[0].text, "Placa ABC1D23");
  } finally { await p.close(); }
});

test("/portal no Telegram devolve link com token válido", async () => {
  const store = new MemoryStore();
  const sent: string[] = [];
  const deps: AppDeps = {
    store, defaultTz: "America/Sao_Paulo", allowedChatIds: new Set(),
    telegram: { sendText: async (_to, text) => { sent.push(text); }, sendTyping: async () => {} },
    assessor: { reply: async () => "nunca" } as unknown as Assessor,
    portal: { baseUrl: "https://bot.exemplo.com", secret: SECRET },
  };
  await handleUpdate(deps, { update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000), text: "/portal", from: { id: 42, first_name: "Ana" }, chat: { id: 42, type: "private" } } });
  assert.equal(sent.length, 1);
  const m = sent[0].match(/https:\/\/bot\.exemplo\.com\/portal#t=(\S+)/);
  assert.ok(m, sent[0]);
  assert.deepEqual(verifyPortalToken(m![1], SECRET), { userId: store.users[0].id });
});
