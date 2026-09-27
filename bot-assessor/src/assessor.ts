/**
 * O "cérebro" do assessor: monta o contexto (histórico + data/hora), entrega ao
 * provedor de IA com as ferramentas e devolve o texto final para o usuário.
 */
import type { Store, User } from "./store.js";
import { buildTools } from "./tools.js";
import { describeNow } from "./dates.js";
import type { LlmProvider } from "./llm.js";
export { friendlyError } from "./llm.js";

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
  historyLimit?: number;
  now?: () => Date;
}

export class Assessor {
  private historyLimit: number;
  private now: () => Date;

  constructor(private store: Store, private llm: LlmProvider, opts: AssessorOptions = {}) {
    this.historyLimit = opts.historyLimit ?? 30;
    this.now = opts.now ?? (() => new Date());
  }

  get providerName(): string { return this.llm.name; }

  /** Processa uma mensagem do usuário e devolve a resposta em texto. */
  async reply(user: User, text: string): Promise<string> {
    const now = this.now();
    const history = await this.store.recentMessages(user.id, this.historyLimit);
    const tools = buildTools({ store: this.store, user, now });

    // Contexto temporal vai junto da mensagem (e não no system prompt) para não invalidar cache de prefixo.
    const userText = `[agora: ${describeNow(now, user.tz)}${user.name ? `; usuário: ${user.name}` : ""}]\n${text}`;

    const answer = await this.llm.complete({ system: SYSTEM_PROMPT, history, userText, tools });

    await this.store.appendMessage(user.id, "user", text);
    await this.store.appendMessage(user.id, "assistant", answer);
    return answer;
  }
}
