/**
 * O "cérebro" do assessor: monta o contexto, chama o Claude com as ferramentas
 * e devolve o texto final para ser enviado ao usuário.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Store, User } from "./store.js";
import { buildTools } from "./tools.js";
import { describeNow } from "./dates.js";

export const SYSTEM_PROMPT = `Você é o Assessor, um assistente pessoal que conversa pelo WhatsApp em português do Brasil.
Sua função é organizar a vida da pessoa: registrar gastos e receitas, agendar compromissos, criar lembretes e guardar notas.

Como agir:
- Use as ferramentas para registrar e consultar dados. Nunca finja que registrou algo sem chamar a ferramenta.
- Quando a pessoa contar um gasto de forma solta ("gastei 40 no almoço", "paguei 120 de luz"), registre direto, inferindo categoria e descrição. Não peça confirmação para gastos simples.
- Uma mensagem pode ter vários itens ("mercado 230, farmácia 45 e uber 18"): registre todos, em chamadas paralelas.
- Datas e horários relativos ("amanhã", "sexta", "daqui 2h", "dia 5") devem ser convertidos usando a data/hora atual fornecida na mensagem. Se o horário for ambíguo (ex.: "às 8" sem manhã/noite), pergunte antes de agendar.
- Para excluir ou cancelar algo, identifique o item (liste se preciso) e confirme antes de apagar.
- Responda curto, no tom de uma mensagem de WhatsApp: direto, cordial, sem enrolação. Use no máximo alguns emojis. Sem Markdown de títulos ou tabelas (o WhatsApp não renderiza); listas simples com "•" são ok e *negrito* com asteriscos simples funciona.
- Valores em reais no formato R$ 1.234,56.
- Ao confirmar um registro, repita o essencial (valor, descrição, data/hora) para a pessoa checar.
- Não invente dados que não estão nas ferramentas. Se algo falhar, diga o que aconteceu e proponha tentar de novo.
- Não dê conselhos médicos, jurídicos ou de investimento específicos; você organiza informações.
- Se a mensagem não tiver relação com organização pessoal, ajude brevemente e volte ao seu papel.`;

export interface AssessorOptions {
  client?: Anthropic;
  model?: string;
  effort?: "low" | "medium" | "high";
  historyLimit?: number;
  now?: () => Date;
}

export class Assessor {
  private client: Anthropic;
  private model: string;
  private effort: "low" | "medium" | "high";
  private historyLimit: number;
  private now: () => Date;

  constructor(private store: Store, opts: AssessorOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? "claude-opus-5";
    this.effort = opts.effort ?? "medium";
    this.historyLimit = opts.historyLimit ?? 30;
    this.now = opts.now ?? (() => new Date());
  }

  /** Processa uma mensagem do usuário e devolve a resposta em texto. */
  async reply(user: User, text: string): Promise<string> {
    const now = this.now();
    const history = await this.store.recentMessages(user.id, this.historyLimit);

    const messages: Anthropic.Beta.BetaMessageParam[] = history.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    // Contexto temporal vai na mensagem do usuário (e não no system) para não invalidar o cache do prefixo.
    messages.push({
      role: "user",
      content: `[agora: ${describeNow(now, user.tz)}${user.name ? `; usuário: ${user.name}` : ""}]\n${text}`,
    });

    const tools = buildTools({ store: this.store, user, now });

    const runner = this.client.beta.messages.toolRunner({
      model: this.model,
      max_tokens: 4096, // respostas de WhatsApp são curtas por natureza
      max_iterations: 8,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: this.effort },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    });

    const final = await runner.runUntilDone();

    let answer: string;
    if (final.stop_reason === "refusal") {
      answer = "Não consigo ajudar com isso por aqui. Posso registrar gastos, compromissos, lembretes e notas, se quiser. 🙂";
    } else {
      answer = final.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text.trim())
        .filter(Boolean)
        .join("\n\n");
      if (!answer) answer = "Pronto! ✅";
    }

    await this.store.appendMessage(user.id, "user", text);
    await this.store.appendMessage(user.id, "assistant", answer);
    return answer;
  }
}

/** Mensagem de erro amigável, sem vazar detalhes técnicos ao usuário final. */
export function friendlyError(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) return "Estou com muitas mensagens agora. Tenta de novo em um minuto? 🙏";
  if (err instanceof Anthropic.AuthenticationError) return "Configuração do assistente inválida (chave da API). Avise o administrador.";
  if (err instanceof Anthropic.APIConnectionError) return "Não consegui falar com o servidor de IA. Tenta de novo em instantes.";
  if (err instanceof Anthropic.APIError) return "Deu um erro ao processar sua mensagem. Pode repetir?";
  return "Ops, algo deu errado do meu lado. Pode repetir a mensagem?";
}
