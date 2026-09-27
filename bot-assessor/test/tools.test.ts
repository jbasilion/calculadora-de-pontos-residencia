import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.ts";
import { buildTools } from "../src/tools.ts";

const TZ = "America/Sao_Paulo";
const NOW = new Date("2026-09-27T17:00:00Z"); // dom 27/09/2026 14:00 em SP

async function setup() {
  const store = new MemoryStore();
  const user = await store.getOrCreateUser("5511999999999", { tz: TZ, name: "Ana" });
  const tools = buildTools({ store, user, now: NOW });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const run = (name: string, input: unknown) => (byName[name] as any).run(input) as Promise<string>;
  return { store, user, run, tools };
}

test("todas as ferramentas têm nome e schema", async () => {
  const { tools } = await setup();
  assert.equal(tools.length, 12);
  for (const t of tools) {
    assert.ok(t.name);
    assert.ok(t.description.length > 10);
  }
});

test("registrar_gasto usa a data local de hoje por padrão", async () => {
  const { store, user, run } = await setup();
  const out = await run("registrar_gasto", { valor: 45.9, descricao: "almoço", categoria: "Alimentação" });
  assert.match(out, /Gasto registrado/);
  const [t] = store.transactions;
  assert.equal(t.user_id, user.id);
  assert.equal(t.occurred_on, "2026-09-27");
  assert.equal(t.category, "alimentação");
});

test("resumo_financeiro agrega por categoria e calcula saldo", async () => {
  const { run } = await setup();
  await run("registrar_gasto", { valor: 100, descricao: "mercado", categoria: "mercado" });
  await run("registrar_gasto", { valor: 50, descricao: "uber", categoria: "transporte" });
  await run("registrar_receita", { valor: 1000, descricao: "salário" });
  const out = await run("resumo_financeiro", { periodo: "mes" });
  assert.match(out, /3 lançamentos/);
  assert.match(out.replace(/ /g, " "), /Gastos: R\$ 150,00/);
  assert.match(out.replace(/ /g, " "), /Saldo: R\$ 850,00/);
  assert.match(out, /mercado: .*67%/);
});

test("excluir_lancamento aceita prefixo de id", async () => {
  const { store, run } = await setup();
  await run("registrar_gasto", { valor: 10, descricao: "café" });
  const id = store.transactions[0].id;
  const out = await run("excluir_lancamento", { id: id.slice(0, 8) });
  assert.match(out, /Excluído/);
  assert.equal(store.transactions.length, 0);
});

test("criar_lembrete converte horário local e recusa passado", async () => {
  const { store, run } = await setup();
  const ok = await run("criar_lembrete", { texto: "Tomar remédio", quando: "2026-09-27T20:00", recorrencia: "nenhuma" });
  assert.match(ok, /Lembrete criado/);
  assert.equal(store.reminders[0].due_at, "2026-09-27T23:00:00.000Z");
  const bad = await run("criar_lembrete", { texto: "x", quando: "2026-09-27T08:00", recorrencia: "nenhuma" });
  assert.match(bad, /já passou/);
  assert.equal(store.reminders.length, 1);
});

test("criar_compromisso agenda aviso antes e aparece na agenda de amanhã", async () => {
  const { store, run } = await setup();
  await run("criar_compromisso", { titulo: "Dentista", inicio: "2026-09-28T10:00", local: "Clínica X", avisar_minutos_antes: 30, recorrencia: "nenhuma" });
  const r = store.reminders[0];
  assert.equal(r.due_at, "2026-09-28T13:00:00.000Z");
  assert.equal(r.remind_at, "2026-09-28T12:30:00.000Z");
  const agenda = await run("agenda", { periodo: "amanha" });
  assert.match(agenda, /Dentista/);
  assert.match(agenda, /Clínica X/);
  const hoje = await run("agenda", { periodo: "hoje" });
  assert.match(hoje, /Nada pendente/);
});

test("cancelar_lembrete muda status e some da agenda", async () => {
  const { store, run } = await setup();
  await run("criar_lembrete", { texto: "Ligar pro João", quando: "2026-09-29T09:00", recorrencia: "nenhuma" });
  const out = await run("cancelar_lembrete", { id: store.reminders[0].id.slice(0, 8) });
  assert.match(out, /Cancelado/);
  assert.equal(store.reminders[0].status, "cancelado");
  assert.match(await run("agenda", { periodo: "todos" }), /Nada pendente/);
});

test("notas: salvar e buscar", async () => {
  const { run } = await setup();
  await run("salvar_nota", { texto: "Placa do carro: ABC1D23" });
  await run("salvar_nota", { texto: "Ideia: app de receitas" });
  assert.match(await run("buscar_notas", { consulta: "placa", limite: 10 }), /ABC1D23/);
  assert.doesNotMatch(await run("buscar_notas", { consulta: "placa", limite: 10 }), /receitas/);
  assert.match(await run("buscar_notas", { consulta: "xyz", limite: 10 }), /Nenhuma nota/);
});

test("atualizar_perfil valida fuso", async () => {
  const { store, run } = await setup();
  assert.match(await run("atualizar_perfil", { fuso: "Marte/Olympus" }), /inválido/);
  await run("atualizar_perfil", { nome: "Aninha", fuso: "America/Manaus" });
  assert.equal(store.users[0].name, "Aninha");
  assert.equal(store.users[0].tz, "America/Manaus");
});
