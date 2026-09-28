import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ApiError } from "@google/genai";
import { GeminiProvider, toGeminiSchema, toGeminiDeclarations, friendlyError, REFUSAL_TEXT, type GeminiLike } from "../src/llm.ts";
import { MemoryStore } from "../src/store.ts";
import { buildTools, executeTool } from "../src/tools.ts";
import { Assessor, SYSTEM_PROMPT } from "../src/assessor.ts";

const TZ = "America/Sao_Paulo";
const NOW = new Date("2026-09-27T17:00:00Z");

test("toGeminiSchema remove palavras-chave não suportadas e converte exclusiveMinimum", () => {
  const schema = z.object({
    valor: z.number().positive().describe("Valor"),
    periodo: z.enum(["hoje", "mes"]).default("hoje"),
    limite: z.number().int().min(1).max(50).default(15),
    data: z.string().optional(),
  });
  const out = toGeminiSchema(schema) as any;
  assert.equal(out.$schema, undefined);
  assert.equal(out.additionalProperties, undefined);
  assert.equal(out.type, "object");
  assert.deepEqual(out.required, ["valor"]);
  assert.deepEqual(out.properties.valor, { type: "number", minimum: 0, description: "Valor" });
  assert.deepEqual(out.properties.periodo, { type: "string", enum: ["hoje", "mes"] });
  assert.deepEqual(out.properties.limite, { type: "integer", minimum: 1, maximum: 50 });
  assert.equal(JSON.stringify(out).includes("default"), false);
});

test("toGeminiDeclarations gera uma declaração por ferramenta", async () => {
  const store = new MemoryStore();
  const user = await store.getOrCreateUser("1", { tz: TZ });
  const decls = toGeminiDeclarations(buildTools({ store, user, now: NOW }));
  assert.equal(decls.length, 12);
  assert.ok(decls.every((d) => d.name && d.description && d.parametersJsonSchema));
});

test("executeTool aplica defaults e devolve erro de validação como texto", async () => {
  const store = new MemoryStore();
  const user = await store.getOrCreateUser("1", { tz: TZ });
  const tools = buildTools({ store, user, now: NOW });
  const agenda = tools.find((t) => t.name === "agenda")!;
  assert.match(await executeTool(agenda, {}), /Nada pendente/); // periodo default = "todos"
  const gasto = tools.find((t) => t.name === "registrar_gasto")!;
  assert.match(await executeTool(gasto, { valor: -5 }), /Erro de validação/);
  assert.equal(store.transactions.length, 0);
});

/** Cliente Gemini falso: devolve as respostas na ordem e grava as requisições. */
function fakeGemini(responses: any[]) {
  const requests: any[] = [];
  const client: GeminiLike = {
    models: {
      generateContent: (async (params: any) => {
        requests.push(params);
        const next = responses.shift();
        if (!next) throw new Error("sem resposta programada");
        return next;
      }) as any,
    },
  };
  return { client, requests };
}

test("GeminiProvider executa function calls, devolve functionResponse e retorna o texto final", async () => {
  const store = new MemoryStore();
  const user = await store.getOrCreateUser("42", { tz: TZ, name: "Ana" });
  await store.appendMessage(user.id, "user", "oi");
  await store.appendMessage(user.id, "assistant", "Oi, Ana!");

  const callContent = {
    role: "model",
    parts: [
      { functionCall: { id: "c1", name: "registrar_gasto", args: { valor: 40, descricao: "almoço", categoria: "alimentação" } } },
      { functionCall: { id: "c2", name: "registrar_gasto", args: { valor: 18, descricao: "uber", categoria: "transporte" } } },
    ],
  };
  const { client, requests } = fakeGemini([
    { candidates: [{ content: callContent, finishReason: "STOP" }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "Anotei: almoço R$ 40,00 e uber R$ 18,00 ✅" }] }, finishReason: "STOP" }] },
  ]);

  const provider = new GeminiProvider({ client, model: "gemini-teste", thinking: "low" });
  const assessor = new Assessor(store, provider, { now: () => NOW });
  const answer = await assessor.reply(user, "gastei 40 no almoço e 18 de uber");

  assert.equal(answer, "Anotei: almoço R$ 40,00 e uber R$ 18,00 ✅");
  assert.equal(store.transactions.length, 2);
  assert.equal(requests.length, 2);

  const first = requests[0];
  assert.equal(first.model, "gemini-teste");
  assert.equal(first.config.systemInstruction, SYSTEM_PROMPT);
  assert.equal(first.config.tools[0].functionDeclarations.length, 12);
  assert.deepEqual(first.contents[0], { role: "user", parts: [{ text: "oi" }] });
  assert.deepEqual(first.contents[1], { role: "model", parts: [{ text: "Oi, Ana!" }] });
  assert.match(first.contents[2].parts[0].text, /^\[agora: dom, 27\/09\/2026 14:00 .*usuário: Ana\]\ngastei 40/);

  const second = requests[1];
  assert.equal(second.contents.length, 5);
  assert.equal(second.contents[3], callContent);
  const fr = second.contents[4];
  assert.equal(fr.role, "user");
  assert.equal(fr.parts.length, 2);
  assert.equal(fr.parts[0].functionResponse.id, "c1");
  assert.equal(fr.parts[0].functionResponse.name, "registrar_gasto");
  assert.match(fr.parts[0].functionResponse.response.result, /Gasto registrado/);
  assert.match(fr.parts[1].functionResponse.response.result, /uber/);

  // histórico persistido
  const hist = await store.recentMessages(user.id, 10);
  assert.equal(hist.length, 4);
  assert.equal(hist[2].content, "gastei 40 no almoço e 18 de uber");
  assert.equal(hist[3].role, "assistant");
});

test("GeminiProvider ignora partes de pensamento e trata bloqueio de segurança", async () => {
  const store = new MemoryStore();
  const user = await store.getOrCreateUser("1", { tz: TZ });
  const tools = buildTools({ store, user, now: NOW });

  const a = new GeminiProvider({ client: fakeGemini([
    { candidates: [{ content: { role: "model", parts: [{ text: "pensando...", thought: true }, { text: "Resposta" }] } }] },
  ]).client });
  assert.equal(await a.complete({ system: "s", history: [], userText: "oi", tools }), "Resposta");

  const b = new GeminiProvider({ client: fakeGemini([{ promptFeedback: { blockReason: "SAFETY" }, candidates: [] }]).client });
  assert.equal(await b.complete({ system: "s", history: [], userText: "x", tools }), REFUSAL_TEXT);

  const c = new GeminiProvider({ client: fakeGemini([{ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] }]).client });
  assert.equal(await c.complete({ system: "s", history: [], userText: "x", tools }), "Pronto! ✅");
});

test("GeminiProvider responde a ferramenta desconhecida sem quebrar", async () => {
  const store = new MemoryStore();
  const user = await store.getOrCreateUser("1", { tz: TZ });
  const { client, requests } = fakeGemini([
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "nao_existe", args: {} } }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] },
  ]);
  const p = new GeminiProvider({ client });
  assert.equal(await p.complete({ system: "s", history: [], userText: "x", tools: buildTools({ store, user, now: NOW }) }), "ok");
  const fr = requests[1].contents.at(-1).parts[0].functionResponse;
  assert.equal(fr.id, undefined);
  assert.match(fr.response.result, /desconhecida/);
});

test("friendlyError traduz erros da API do Gemini", () => {
  assert.match(friendlyError(new ApiError({ message: "quota", status: 429 })), /limite/);
  assert.match(friendlyError(new ApiError({ message: "bad key", status: 403 })), /chave da API/);
  assert.match(friendlyError(new ApiError({ message: "boom", status: 503 })), /instável/);
  assert.match(friendlyError(new Error("x")), /Ops/);
});

test("GeminiProvider envia thinkingLevel conforme configurado", async () => {
  const store = new MemoryStore();
  const user = await store.getOrCreateUser("1", { tz: TZ });
  const tools = buildTools({ store, user, now: NOW });
  const { client, requests } = fakeGemini([{ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] }]);
  await new GeminiProvider({ client }).complete({ system: "s", history: [], userText: "x", tools });
  assert.equal(requests[0].config.thinkingConfig.thinkingLevel, "LOW");
  const b = fakeGemini([{ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] }]);
  await new GeminiProvider({ client: b.client, thinking: "high" }).complete({ system: "s", history: [], userText: "x", tools });
  assert.equal(b.requests[0].config.thinkingConfig.thinkingLevel, "HIGH");
});

test("GeminiProvider concatena vários parts de texto sem inserir quebras", async () => {
  const store = new MemoryStore();
  const user = await store.getOrCreateUser("1", { tz: TZ });
  const tools = buildTools({ store, user, now: NOW });
  const { client } = fakeGemini([{ candidates: [{ content: { role: "model", parts: [{ text: "• R$ 40,00 – almoço (alimentação, " }, { text: "pix)\n" }] } }] }]);
  assert.equal(await new GeminiProvider({ client }).complete({ system: "s", history: [], userText: "x", tools }), "• R$ 40,00 – almoço (alimentação, pix)");
});

test("GeminiProvider repete em 503 e desiste após as tentativas", async () => {
  const store = new MemoryStore();
  const user = await store.getOrCreateUser("1", { tz: TZ });
  const tools = buildTools({ store, user, now: NOW });
  const ok = { candidates: [{ content: { role: "model", parts: [{ text: "voltou" }] } }] };

  let n = 0;
  const flaky: GeminiLike = { models: { generateContent: (async () => {
    n++;
    if (n < 3) throw new ApiError({ message: "high demand", status: 503 });
    return ok;
  }) as any } };
  const p = new GeminiProvider({ client: flaky });
  p.sleep = async () => {};
  assert.equal(await p.complete({ system: "s", history: [], userText: "x", tools }), "voltou");
  assert.equal(n, 3);

  const dead: GeminiLike = { models: { generateContent: (async () => { throw new ApiError({ message: "down", status: 503 }); }) as any } };
  const q = new GeminiProvider({ client: dead });
  q.sleep = async () => {};
  await assert.rejects(q.complete({ system: "s", history: [], userText: "x", tools }), (e: unknown) => e instanceof ApiError && e.status === 503);

  const quota: GeminiLike = { models: { generateContent: (async () => { throw new ApiError({ message: "quota", status: 429 }); }) as any } };
  let calls = 0;
  const r = new GeminiProvider({ client: { models: { generateContent: (async (...a: any[]) => { calls++; return quota.models.generateContent(...(a as [any])); }) as any } } });
  await assert.rejects(r.complete({ system: "s", history: [], userText: "x", tools }));
  assert.equal(calls, 1); // 429 (cota) não é repetido
});
