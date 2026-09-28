/**
 * Ponto de entrada em produção: recebe mensagens do Telegram (long polling por
 * padrão, ou webhook), roda o agendador de lembretes e expõe /health.
 */
import express, { type Request, type Response } from "express";
import { loadConfig, requireServerConfig } from "./config.js";
import { SupabaseStore, type Store } from "./store.js";
import { Assessor, friendlyError } from "./assessor.js";
import { createProvider } from "./llm.js";
import { TelegramClient, extractMessage, runPolling, verifySecret, type TelegramUpdate } from "./telegram.js";
import { startScheduler } from "./scheduler.js";
import { createPortalRouter, portalLink, signPortalToken } from "./portal.js";
import { createHash } from "node:crypto";

export interface AppDeps {
  store: Store;
  assessor: Assessor;
  telegram: Pick<TelegramClient, "sendText" | "sendTyping">;
  defaultTz: string;
  allowedChatIds: Set<string>;
  /** Portal web: URL pública e segredo que assina os links. */
  portal: { baseUrl: string; secret: string };
}

export const WELCOME =
  "Oi! Eu sou o seu Assessor 🙂\n\nMe conta as coisas do seu dia e eu organizo:\n" +
  "• \"gastei 40 no almoço\" → registro o gasto\n" +
  "• \"quanto gastei esse mês?\" → resumo por categoria\n" +
  "• \"me lembra de pagar a luz dia 5 às 9h\" → te aviso na hora\n" +
  "• \"dentista sexta às 10\" → agendo e aviso antes\n" +
  "• \"anota aí: ...\" → guardo a nota\n\n" +
  "Para ver tudo em uma tela, com gráficos e exportação, mande /portal.\n\nPode falar do seu jeito, sem comandos.";

/** Processa uma atualização do Telegram (idempotente, tolerante a erros). */
export async function handleUpdate(deps: AppDeps, update: TelegramUpdate): Promise<void> {
  const msg = extractMessage(update);
  if (!msg) return;
  if (Date.now() / 1000 - msg.timestamp > 6 * 3600) return; // atualização antiga, reentregue
  if (!(await deps.store.markProcessed(msg.id))) return;

  if (deps.allowedChatIds.size && !deps.allowedChatIds.has(msg.fromId) && !deps.allowedChatIds.has(msg.chatId)) {
    console.log(`[telegram] chat não autorizado: chat=${msg.chatId} from=${msg.fromId}`);
    await deps.telegram.sendText(msg.chatId, `Este bot é privado. Seu id é ${msg.fromId}; peça ao administrador para autorizá-lo.`);
    return;
  }

  if (!msg.text) {
    await deps.telegram.sendText(msg.chatId, "Por enquanto eu só entendo mensagens de texto. 🙂 Me escreve o que precisa!");
    return;
  }

  if (msg.isCommand) {
    const cmd = msg.text.split(/\s|@/)[0].toLowerCase();
    if (cmd === "/start" || cmd === "/help" || cmd === "/ajuda") {
      await deps.store.getOrCreateUser(msg.chatId, { tz: deps.defaultTz, name: msg.name });
      await deps.telegram.sendText(msg.chatId, WELCOME);
      return;
    }
    if (cmd === "/portal") {
      const u = await deps.store.getOrCreateUser(msg.chatId, { tz: deps.defaultTz, name: msg.name });
      const link = portalLink(deps.portal.baseUrl, signPortalToken(u.id, deps.portal.secret));
      await deps.telegram.sendText(
        msg.chatId,
        `Seu portal 📊\n${link}\n\nO link vale por 7 dias e dá acesso aos seus dados: não compartilhe. Quando expirar, mande /portal de novo.`,
      );
      return;
    }
    // Outros comandos seguem para o assessor como texto normal (ex.: "/resumo" → "resumo").
    msg.text = msg.text.replace(/^\/(\w+)(@\w+)?/, "$1");
  }

  deps.telegram.sendTyping(msg.chatId).catch(() => { /* cosmético */ });

  const user = await deps.store.getOrCreateUser(msg.chatId, { tz: deps.defaultTz, name: msg.name });
  let answer: string;
  try {
    answer = await deps.assessor.reply(user, msg.text);
  } catch (err) {
    console.error(`[assessor] erro para chat ${msg.chatId}:`, err);
    answer = friendlyError(err);
  }
  await deps.telegram.sendText(msg.chatId, answer);
}

export function createApp(deps: AppDeps, webhook?: { secret: string }) {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use(createPortalRouter({ store: deps.store, secret: deps.portal.secret }));

  if (webhook) {
    app.post("/telegram/webhook", (req: Request, res: Response) => {
      if (!verifySecret(req.header("x-telegram-bot-api-secret-token"), webhook.secret)) return res.sendStatus(401);
      res.sendStatus(200); // o Telegram reenvia se demorarmos; processa em segundo plano
      handleUpdate(deps, req.body as TelegramUpdate).catch((err) => console.error("[webhook] erro não tratado:", err));
    });
  }
  return app;
}

async function main() {
  const cfg = loadConfig();
  requireServerConfig(cfg);

  const store = new SupabaseStore(cfg.SUPABASE_URL!, cfg.SUPABASE_SERVICE_ROLE_KEY!);
  const telegram = new TelegramClient({ token: cfg.TELEGRAM_BOT_TOKEN! });
  const assessor = new Assessor(store, createProvider(cfg));
  const portal = {
    baseUrl: cfg.PORTAL_URL ?? `http://localhost:${cfg.PORT}`,
    secret: cfg.PORTAL_SECRET ?? createHash("sha256").update(`portal:${cfg.TELEGRAM_BOT_TOKEN}`).digest("hex"),
  };
  const deps: AppDeps = { store, assessor, telegram, defaultTz: cfg.DEFAULT_TIMEZONE, allowedChatIds: cfg.allowedChatIds, portal };

  const me = await telegram.getMe();
  console.log(`Bot @${me.username ?? me.id} (IA: ${assessor.providerName})`);

  startScheduler(store, telegram);

  if (cfg.TELEGRAM_MODE === "webhook") {
    const app = createApp(deps, { secret: cfg.TELEGRAM_WEBHOOK_SECRET! });
    app.listen(cfg.PORT, async () => {
      const url = cfg.TELEGRAM_WEBHOOK_URL!.replace(/\/$/, "") + "/telegram/webhook";
      await telegram.setWebhook(url, cfg.TELEGRAM_WEBHOOK_SECRET!);
      console.log(`Webhook registrado em ${url}; ouvindo na porta ${cfg.PORT}`);
    });
  } else {
    const app = createApp(deps);
    app.listen(cfg.PORT, () => console.log(`Portal em ${portal.baseUrl}/portal (mande /portal ao bot para receber o link)`));
    await telegram.deleteWebhook(); // getUpdates não funciona com webhook ativo
    console.log("Long polling ativo. Mande uma mensagem para o bot no Telegram.");
    const ac = new AbortController();
    process.on("SIGINT", () => ac.abort());
    process.on("SIGTERM", () => ac.abort());
    await runPolling(telegram, (u) => handleUpdate(deps, u), {
      signal: ac.signal,
      onError: (err) => console.error("[polling] erro:", err instanceof Error ? err.message : err),
    });
    process.exit(0);
  }
}

// Só sobe o servidor quando executado diretamente (permite importar createApp nos testes).
const invokedDirectly = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
