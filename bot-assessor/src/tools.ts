/**
 * Ferramentas que o assessor pode acionar. Cada ferramenta é criada "amarrada"
 * a um usuário e a um instante, para que o modelo nunca precise (nem possa)
 * informar o id do usuário.
 */
import { z } from "zod";
import type { Store, Recurrence, Reminder, Transaction, User } from "./store.js";
import {
  describeNow, formatBRL, formatPtBr, localDateString, localToDate, periodRange, type Periodo,
} from "./dates.js";

export interface ToolContext {
  store: Store;
  user: User;
  now: Date;
}

/**
 * Definição neutra de ferramenta (independente do provedor de IA).
 * `src/llm.ts` converte para o formato do Gemini ou do Claude.
 */
export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.output<S>) => Promise<string>;
}

function defineTool<S extends z.ZodObject>(def: {
  name: string; description: string; inputSchema: S; run: (input: z.output<S>) => Promise<string>;
}): ToolDef<S> {
  return { name: def.name, description: def.description, schema: def.inputSchema, run: def.run };
}

/** Valida a entrada (aplicando defaults) e executa. Erros de validação voltam como texto para o modelo corrigir. */
export async function executeTool(def: ToolDef, rawInput: unknown): Promise<string> {
  const parsed = def.schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`).join("; ");
    return `Erro de validação nos parâmetros de ${def.name}: ${issues}`;
  }
  try {
    return await def.run(parsed.data);
  } catch (err) {
    return `Erro ao executar ${def.name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const PERIODO = z.enum(["hoje", "ontem", "semana", "mes", "mes_passado", "ano", "personalizado"]);
const RECORRENCIA = z.enum(["nenhuma", "diaria", "semanal", "mensal"]);

const localDateTime = z
  .string()
  .describe("Data e hora LOCAL do usuário no formato YYYY-MM-DDTHH:mm (sem fuso). Ex.: 2026-09-28T09:00");
const localDate = z.string().describe("Data LOCAL no formato YYYY-MM-DD");

function fmtTx(t: Transaction): string {
  const sinal = t.kind === "gasto" ? "-" : "+";
  const extras = [t.category, t.payment_method].filter(Boolean).join(", ");
  return `${t.occurred_on} ${sinal}${formatBRL(Number(t.amount))} ${t.description}${extras ? ` (${extras})` : ""} [id ${t.id.slice(0, 8)}]`;
}

function fmtRem(r: Reminder, tz: string): string {
  const quando = formatPtBr(new Date(r.due_at), tz);
  const rec = r.recurrence !== "nenhuma" ? `, ${r.recurrence}` : "";
  const local = r.location ? ` @ ${r.location}` : "";
  return `${quando} ${r.kind === "compromisso" ? "📅" : "⏰"} ${r.title}${local}${rec} [id ${r.id.slice(0, 8)}]`;
}

/** Aceita id completo ou os 8 primeiros caracteres mostrados nas listagens. */
async function resolveId<T extends { id: string }>(prefix: string, candidates: T[]): Promise<T | undefined> {
  return candidates.find((c) => c.id === prefix || c.id.startsWith(prefix));
}

export function buildTools(ctx: ToolContext): ToolDef[] {
  const { store, user, now } = ctx;
  const tz = user.tz;

  const registrar_gasto = defineTool({
    name: "registrar_gasto",
    description:
      "Registra um gasto (despesa) do usuário. Use quando ele disser que gastou, pagou ou comprou algo. Se não informar a data, é hoje.",
    inputSchema: z.object({
      valor: z.number().positive().describe("Valor em reais, ex.: 45.9"),
      descricao: z.string().min(1).describe("O que foi, curto. Ex.: 'almoço', 'uber para o trabalho'"),
      categoria: z
        .string()
        .optional()
        .describe("Categoria curta em minúsculas: alimentação, transporte, moradia, saúde, lazer, educação, mercado, assinaturas, outros"),
      forma_pagamento: z.string().optional().describe("pix, crédito, débito, dinheiro, boleto..."),
      data: localDate.optional(),
    }),
    run: async (i) => {
      const t = await store.addTransaction({
        user_id: user.id, kind: "gasto", amount: i.valor, description: i.descricao,
        category: i.categoria?.toLowerCase() ?? null, payment_method: i.forma_pagamento?.toLowerCase() ?? null,
        occurred_on: i.data ?? localDateString(now, tz),
      });
      return `Gasto registrado: ${fmtTx(t)}`;
    },
  });

  const registrar_receita = defineTool({
    name: "registrar_receita",
    description: "Registra uma entrada de dinheiro (salário, pagamento recebido, venda, reembolso).",
    inputSchema: z.object({
      valor: z.number().positive(),
      descricao: z.string().min(1),
      categoria: z.string().optional().describe("salário, freela, reembolso, investimento, outros"),
      data: localDate.optional(),
    }),
    run: async (i) => {
      const t = await store.addTransaction({
        user_id: user.id, kind: "receita", amount: i.valor, description: i.descricao,
        category: i.categoria?.toLowerCase() ?? null, payment_method: null,
        occurred_on: i.data ?? localDateString(now, tz),
      });
      return `Receita registrada: ${fmtTx(t)}`;
    },
  });

  const resumo_financeiro = defineTool({
    name: "resumo_financeiro",
    description:
      "Totais de gastos e receitas em um período, com quebra por categoria. Use para 'quanto gastei', 'como está o mês', 'saldo'.",
    inputSchema: z.object({
      periodo: PERIODO,
      inicio: localDate.optional().describe("Só para periodo=personalizado"),
      fim: localDate.optional().describe("Só para periodo=personalizado (inclusivo)"),
    }),
    run: async (i) => {
      const range = periodRange(i.periodo as Periodo, now, tz, i.inicio, i.fim);
      const txs = await store.listTransactions(user.id, {
        startDate: localDateString(range.start, tz), endDate: localDateString(range.end, tz),
      });
      if (!txs.length) return `Nenhum lançamento em ${range.label}.`;
      let gastos = 0, receitas = 0;
      const porCat = new Map<string, number>();
      for (const t of txs) {
        const v = Number(t.amount);
        if (t.kind === "gasto") {
          gastos += v;
          const c = t.category ?? "sem categoria";
          porCat.set(c, (porCat.get(c) ?? 0) + v);
        } else receitas += v;
      }
      const cats = [...porCat.entries()].sort((a, b) => b[1] - a[1])
        .map(([c, v]) => `  • ${c}: ${formatBRL(v)} (${Math.round((v / gastos) * 100)}%)`).join("\n");
      return [
        `Período: ${range.label} (${txs.length} lançamentos)`,
        `Gastos: ${formatBRL(gastos)}`,
        `Receitas: ${formatBRL(receitas)}`,
        `Saldo: ${formatBRL(receitas - gastos)}`,
        cats ? `Gastos por categoria:\n${cats}` : "",
      ].filter(Boolean).join("\n");
    },
  });

  const listar_lancamentos = defineTool({
    name: "listar_lancamentos",
    description: "Lista os lançamentos (gastos e receitas) de um período, do mais recente para o mais antigo.",
    inputSchema: z.object({
      periodo: PERIODO,
      inicio: localDate.optional(),
      fim: localDate.optional(),
      limite: z.number().int().min(1).max(50).default(15),
    }),
    run: async (i) => {
      const range = periodRange(i.periodo as Periodo, now, tz, i.inicio, i.fim);
      const txs = await store.listTransactions(user.id, {
        startDate: localDateString(range.start, tz), endDate: localDateString(range.end, tz),
      }, i.limite);
      if (!txs.length) return `Nenhum lançamento em ${range.label}.`;
      return txs.map(fmtTx).join("\n");
    },
  });

  const excluir_lancamento = defineTool({
    name: "excluir_lancamento",
    description:
      "Exclui um lançamento pelo id (os 8 primeiros caracteres bastam). Antes de excluir, confirme com o usuário qual é, listando se necessário.",
    inputSchema: z.object({ id: z.string().min(4) }),
    run: async (i) => {
      const range = periodRange("ano", now, tz);
      const recent = await store.listTransactions(user.id, {
        startDate: localDateString(new Date(range.start.getTime() - 366 * 86_400_000), tz),
        endDate: localDateString(new Date(range.end.getTime() + 366 * 86_400_000), tz),
      }, 2000);
      const t = await resolveId(i.id, recent);
      if (!t) return `Não encontrei lançamento com id ${i.id}.`;
      await store.deleteTransaction(user.id, t.id);
      return `Excluído: ${fmtTx(t)}`;
    },
  });

  const criar_lembrete = defineTool({
    name: "criar_lembrete",
    description:
      "Cria um lembrete: o bot manda uma mensagem no WhatsApp no horário indicado. Use para 'me lembra de...', 'não me deixa esquecer...'. Interprete expressões relativas ('daqui 2 horas', 'amanhã cedo' = 08:00, 'à noite' = 20:00) usando a data/hora atual informada.",
    inputSchema: z.object({
      texto: z.string().min(1).describe("O que lembrar, na forma de aviso. Ex.: 'Tomar o remédio'"),
      quando: localDateTime,
      recorrencia: RECORRENCIA.default("nenhuma"),
    }),
    run: async (i) => {
      const due = localToDate(i.quando, tz);
      if (due.getTime() < now.getTime() - 60_000 && i.recorrencia === "nenhuma") {
        return `Erro: ${formatPtBr(due, tz)} já passou. Confirme com o usuário o horário correto.`;
      }
      const r = await store.addReminder({
        user_id: user.id, kind: "lembrete", title: i.texto, location: null,
        due_at: due.toISOString(), remind_at: due.toISOString(), recurrence: i.recorrencia as Recurrence,
      });
      return `Lembrete criado: ${fmtRem(r, tz)}`;
    },
  });

  const criar_compromisso = defineTool({
    name: "criar_compromisso",
    description:
      "Agenda um compromisso (reunião, consulta, evento) e opcionalmente um aviso alguns minutos antes.",
    inputSchema: z.object({
      titulo: z.string().min(1),
      inicio: localDateTime,
      local: z.string().optional(),
      avisar_minutos_antes: z.number().int().min(0).max(7 * 24 * 60).default(60)
        .describe("Quanto tempo antes avisar no WhatsApp. 0 = avisar na hora."),
      recorrencia: RECORRENCIA.default("nenhuma"),
    }),
    run: async (i) => {
      const due = localToDate(i.inicio, tz);
      const remind = new Date(due.getTime() - i.avisar_minutos_antes * 60_000);
      const r = await store.addReminder({
        user_id: user.id, kind: "compromisso", title: i.titulo, location: i.local ?? null,
        due_at: due.toISOString(), remind_at: remind.toISOString(), recurrence: i.recorrencia as Recurrence,
      });
      return `Compromisso agendado: ${fmtRem(r, tz)}. Aviso ${i.avisar_minutos_antes} min antes.`;
    },
  });

  const agenda = defineTool({
    name: "agenda",
    description: "Lista compromissos e lembretes pendentes de um período. Use para 'o que tenho hoje/amanhã/essa semana', 'minha agenda'.",
    inputSchema: z.object({
      periodo: z.enum(["hoje", "amanha", "semana", "proximos_30_dias", "todos"]).default("todos"),
    }),
    run: async (i) => {
      let from: string | undefined, to: string | undefined;
      const day = 86_400_000;
      const hoje = periodRange("hoje", now, tz);
      switch (i.periodo) {
        case "hoje": from = now.toISOString(); to = hoje.end.toISOString(); break;
        case "amanha": from = hoje.end.toISOString(); to = new Date(hoje.end.getTime() + day).toISOString(); break;
        case "semana": from = now.toISOString(); to = new Date(hoje.start.getTime() + 7 * day).toISOString(); break;
        case "proximos_30_dias": from = now.toISOString(); to = new Date(now.getTime() + 30 * day).toISOString(); break;
        case "todos": break;
      }
      const items = await store.listReminders(user.id, { status: "pendente", from, to, limit: 40 });
      if (!items.length) return `Nada pendente para ${i.periodo.replace("_", " ")}.`;
      return items.map((r) => fmtRem(r, tz)).join("\n");
    },
  });

  const cancelar_lembrete = defineTool({
    name: "cancelar_lembrete",
    description: "Cancela um lembrete ou compromisso pendente pelo id (8 primeiros caracteres bastam).",
    inputSchema: z.object({ id: z.string().min(4) }),
    run: async (i) => {
      const pend = await store.listReminders(user.id, { status: "pendente", limit: 500 });
      const r = await resolveId(i.id, pend);
      if (!r) return `Não encontrei item pendente com id ${i.id}.`;
      await store.cancelReminder(user.id, r.id);
      return `Cancelado: ${fmtRem(r, tz)}`;
    },
  });

  const salvar_nota = defineTool({
    name: "salvar_nota",
    description: "Guarda uma informação livre para consulta futura (ideias, senhas de wi-fi NÃO, listas, dados de contato, 'anota aí').",
    inputSchema: z.object({ texto: z.string().min(1) }),
    run: async (i) => {
      const n = await store.addNote(user.id, i.texto);
      return `Nota salva [id ${n.id.slice(0, 8)}]: ${n.text}`;
    },
  });

  const buscar_notas = defineTool({
    name: "buscar_notas",
    description: "Procura notas salvas por palavra-chave. Consulta vazia lista as mais recentes.",
    inputSchema: z.object({ consulta: z.string().default(""), limite: z.number().int().min(1).max(30).default(10) }),
    run: async (i) => {
      const notes = await store.searchNotes(user.id, i.consulta, i.limite);
      if (!notes.length) return i.consulta ? `Nenhuma nota com "${i.consulta}".` : "Nenhuma nota salva.";
      return notes.map((n) => `${formatPtBr(new Date(n.created_at), tz, false)}: ${n.text} [id ${n.id.slice(0, 8)}]`).join("\n");
    },
  });

  const atualizar_perfil = defineTool({
    name: "atualizar_perfil",
    description: "Atualiza o nome pelo qual o usuário quer ser chamado ou o fuso horário dele (IANA, ex.: America/Manaus).",
    inputSchema: z.object({ nome: z.string().optional(), fuso: z.string().optional() }),
    run: async (i) => {
      if (i.fuso) {
        try { new Intl.DateTimeFormat("en-US", { timeZone: i.fuso }); }
        catch { return `Fuso inválido: ${i.fuso}`; }
      }
      const u = await store.updateUser(user.id, { ...(i.nome ? { name: i.nome } : {}), ...(i.fuso ? { tz: i.fuso } : {}) });
      return `Perfil atualizado: nome=${u.name ?? "-"}, fuso=${u.tz}. Agora: ${describeNow(now, u.tz)}`;
    },
  });

  return [
    registrar_gasto, registrar_receita, resumo_financeiro, listar_lancamentos, excluir_lancamento,
    criar_lembrete, criar_compromisso, agenda, cancelar_lembrete,
    salvar_nota, buscar_notas, atualizar_perfil,
  ] as ToolDef[];
}
