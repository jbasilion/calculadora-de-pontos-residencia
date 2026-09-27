/**
 * Provedores de IA. O assessor fala com uma interface única (`LlmProvider`);
 * aqui ficam as implementações para Gemini (padrão, tem plano gratuito) e Claude.
 */
import { GoogleGenAI, ApiError as GeminiApiError, FunctionCallingConfigMode, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { StoredMessage } from "./store.js";
import type { Config } from "./config.js";
import { executeTool, type ToolDef } from "./tools.js";

export interface LlmRequest {
  system: string;
  history: StoredMessage[];
  userText: string;
  tools: ToolDef[];
}

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<string>;
}

export const REFUSAL_TEXT =
  "Não consigo ajudar com isso por aqui. Posso registrar gastos, compromissos, lembretes e notas, se quiser. 🙂";

const MAX_ITERATIONS = 8;

/* ============================== Gemini ============================== */

/**
 * Converte o JSON Schema gerado pelo zod para o subconjunto que o Gemini aceita
 * em `parametersJsonSchema` (remove palavras-chave que ele não conhece).
 */
export function toGeminiSchema(schema: z.ZodObject): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return sanitize(json) as Record<string, unknown>;

  function sanitize(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(sanitize);
    if (!node || typeof node !== "object") return node;
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      switch (k) {
        case "$schema": case "additionalProperties": case "default": case "title":
          break; // ignorados
        case "exclusiveMinimum":
          if (typeof v === "number") out.minimum = out.minimum ?? v;
          break;
        case "exclusiveMaximum":
          if (typeof v === "number") out.maximum = out.maximum ?? v;
          break;
        case "properties": {
          const props: Record<string, unknown> = {};
          for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) props[pk] = sanitize(pv);
          out.properties = props;
          break;
        }
        case "items": case "anyOf": case "oneOf":
          out[k] = sanitize(v);
          break;
        default:
          out[k] = v;
      }
    }
    return out;
  }
}

export function toGeminiDeclarations(tools: ToolDef[]): FunctionDeclaration[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: toGeminiSchema(t.schema) }));
}

/** Subconjunto do cliente do Gemini que usamos (facilita testes com um cliente falso). */
export interface GeminiLike {
  models: { generateContent: GoogleGenAI["models"]["generateContent"] };
}

export interface GeminiOptions {
  apiKey?: string;
  model?: string;
  client?: GeminiLike;
  /** Orçamento de "pensamento" do modelo. 0 desliga (mais rápido), -1 automático. */
  thinkingBudget?: number;
}

export class GeminiProvider implements LlmProvider {
  readonly name: string;
  private ai: GeminiLike;
  private model: string;
  private thinkingBudget: number | undefined;

  constructor(opts: GeminiOptions = {}) {
    this.model = opts.model ?? "gemini-2.5-flash";
    this.name = `gemini:${this.model}`;
    this.ai = opts.client ?? new GoogleGenAI({ apiKey: opts.apiKey ?? process.env.GEMINI_API_KEY });
    this.thinkingBudget = opts.thinkingBudget;
  }

  async complete(req: LlmRequest): Promise<string> {
    const contents: Content[] = req.history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    contents.push({ role: "user", parts: [{ text: req.userText }] });

    const declarations = toGeminiDeclarations(req.tools);
    const byName = new Map(req.tools.map((t) => [t.name, t]));

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const res = await this.ai.models.generateContent({
        model: this.model,
        contents,
        config: {
          systemInstruction: req.system,
          tools: [{ functionDeclarations: declarations }],
          toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
          ...(this.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: this.thinkingBudget } } : {}),
        },
      });

      if (res.promptFeedback?.blockReason) return REFUSAL_TEXT;
      const candidate = res.candidates?.[0];
      if (!candidate?.content) return REFUSAL_TEXT;
      if (candidate.finishReason === "SAFETY" || candidate.finishReason === "PROHIBITED_CONTENT") return REFUSAL_TEXT;

      const calls = (candidate.content.parts ?? []).filter((p) => p.functionCall).map((p) => p.functionCall!);
      if (!calls.length) {
        const text = (candidate.content.parts ?? []).filter((p) => p.text && !p.thought).map((p) => p.text!.trim()).filter(Boolean).join("\n\n");
        return text || "Pronto! ✅";
      }

      // Executa todas as chamadas em paralelo e devolve as respostas em uma única mensagem.
      const results = await Promise.all(
        calls.map(async (c) => {
          const def = c.name ? byName.get(c.name) : undefined;
          const result = def ? await executeTool(def, c.args) : `Ferramenta desconhecida: ${c.name}`;
          return { id: c.id, name: c.name ?? "desconhecida", result };
        }),
      );
      contents.push(candidate.content);
      contents.push({
        role: "user",
        parts: results.map<Part>((r) => ({
          functionResponse: { ...(r.id ? { id: r.id } : {}), name: r.name, response: { result: r.result } },
        })),
      });
    }
    return "Fiz o que consegui, mas a tarefa ficou longa demais. Pode me pedir de novo em partes menores?";
  }
}

/* ============================== Claude ============================== */

export interface AnthropicOptions {
  client?: Anthropic;
  model?: string;
  effort?: "low" | "medium" | "high";
}

export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  private client: Anthropic;
  private model: string;
  private effort: "low" | "medium" | "high";

  constructor(opts: AnthropicOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? "claude-opus-5";
    this.effort = opts.effort ?? "medium";
    this.name = `anthropic:${this.model}`;
  }

  async complete(req: LlmRequest): Promise<string> {
    const messages: Anthropic.Beta.BetaMessageParam[] = req.history.map((m) => ({ role: m.role, content: m.content }));
    messages.push({ role: "user", content: req.userText });

    const tools = req.tools.map((t) =>
      betaZodTool({ name: t.name, description: t.description, inputSchema: t.schema, run: (input) => executeTool(t, input) }),
    );

    const runner = this.client.beta.messages.toolRunner({
      model: this.model,
      max_tokens: 4096,
      max_iterations: MAX_ITERATIONS,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: this.effort },
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    });
    const final = await runner.runUntilDone();
    if (final.stop_reason === "refusal") return REFUSAL_TEXT;
    const text = final.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text.trim()).filter(Boolean).join("\n\n");
    return text || "Pronto! ✅";
  }
}

/* ============================== Erros ============================== */

/** Mensagem de erro amigável, sem vazar detalhes técnicos ao usuário final. */
export function friendlyError(err: unknown): string {
  if (err instanceof GeminiApiError) {
    if (err.status === 429) return "Atingi o limite de mensagens do plano gratuito por agora. Tenta de novo em um minuto? 🙏";
    if (err.status === 401 || err.status === 403) return "Configuração do assistente inválida (chave da API). Avise o administrador.";
    if (err.status >= 500) return "O servidor de IA está instável. Tenta de novo em instantes.";
    return "Deu um erro ao processar sua mensagem. Pode repetir?";
  }
  if (err instanceof Anthropic.RateLimitError) return "Estou com muitas mensagens agora. Tenta de novo em um minuto? 🙏";
  if (err instanceof Anthropic.AuthenticationError) return "Configuração do assistente inválida (chave da API). Avise o administrador.";
  if (err instanceof Anthropic.APIConnectionError) return "Não consegui falar com o servidor de IA. Tenta de novo em instantes.";
  if (err instanceof Anthropic.APIError) return "Deu um erro ao processar sua mensagem. Pode repetir?";
  return "Ops, algo deu errado do meu lado. Pode repetir a mensagem?";
}

/* ============================== Fábrica ============================== */

export function createProvider(cfg: Config): LlmProvider {
  if (cfg.LLM_PROVIDER === "anthropic") {
    return new AnthropicProvider({ model: cfg.ANTHROPIC_MODEL, effort: cfg.ANTHROPIC_EFFORT });
  }
  return new GeminiProvider({ apiKey: cfg.GEMINI_API_KEY, model: cfg.GEMINI_MODEL, thinkingBudget: cfg.GEMINI_THINKING_BUDGET });
}
