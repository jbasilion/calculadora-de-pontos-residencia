/**
 * Servidor HTTP: webhook do WhatsApp + healthcheck. Ponto de entrada em produção.
 */
import express, { type Request, type Response } from "express";
import { loadConfig, requireServerConfig } from "./config.js";
import { SupabaseStore, type Store } from "./store.js";
import { Assessor, friendlyError } from "./assessor.js";
import { createProvider } from "./llm.js";
import { WhatsAppClient, extractMessages, verifySignature, type IncomingMessage } from "./whatsapp.js";
import { startScheduler } from "./scheduler.js";

export interface AppDeps {
  store: Store;
  assessor: Assessor;
  wa: WhatsAppClient;
  verifyToken: string;
  appSecret: string;
  defaultTz: string;
  allowedPhones: Set<string>;
}

type RawRequest = Request & { rawBody?: Buffer };

export function createApp(deps: AppDeps) {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as RawRequest).rawBody = buf; } }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Verificação do webhook (feita uma vez, no painel da Meta).
  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === deps.verifyToken && typeof challenge === "string") {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  app.post("/webhook", (req: RawRequest, res: Response) => {
    const sig = req.header("x-hub-signature-256");
    if (!req.rawBody || !verifySignature(req.rawBody, sig, deps.appSecret)) {
      return res.sendStatus(401);
    }
    // A Meta exige resposta rápida; processa em segundo plano.
    res.sendStatus(200);
    for (const msg of extractMessages(req.body)) {
      handleIncoming(deps, msg).catch((err) => console.error("[webhook] erro não tratado:", err));
    }
  });

  return app;
}

export async function handleIncoming(deps: AppDeps, msg: IncomingMessage): Promise<void> {
  // Ignora eventos antigos (a Meta reenvia em caso de falha) e duplicados.
  if (Date.now() / 1000 - msg.timestamp > 6 * 3600) return;
  if (!(await deps.store.markProcessed(msg.id))) return;

  if (deps.allowedPhones.size && !deps.allowedPhones.has(msg.from)) {
    console.log(`[webhook] número não autorizado: ${msg.from}`);
    return;
  }

  if (!msg.text) {
    await deps.wa.sendText(msg.from, "Por enquanto eu só entendo mensagens de texto. 🙂 Me escreve o que precisa!");
    return;
  }

  deps.wa.markReadAndTyping(msg.id).catch(() => { /* cosmético */ });

  const user = await deps.store.getOrCreateUser(msg.from, { tz: deps.defaultTz, name: msg.name });
  let answer: string;
  try {
    answer = await deps.assessor.reply(user, msg.text);
  } catch (err) {
    console.error(`[assessor] erro para ${msg.from}:`, err);
    answer = friendlyError(err);
  }
  await deps.wa.sendText(msg.from, answer);
}

async function main() {
  const cfg = loadConfig();
  requireServerConfig(cfg);

  const store = new SupabaseStore(cfg.SUPABASE_URL!, cfg.SUPABASE_SERVICE_ROLE_KEY!);
  const wa = new WhatsAppClient({
    token: cfg.WHATSAPP_TOKEN!, phoneNumberId: cfg.WHATSAPP_PHONE_NUMBER_ID!, apiVersion: cfg.WHATSAPP_API_VERSION,
  });
  const assessor = new Assessor(store, createProvider(cfg));

  const app = createApp({
    store, assessor, wa,
    verifyToken: cfg.WHATSAPP_VERIFY_TOKEN!, appSecret: cfg.WHATSAPP_APP_SECRET!,
    defaultTz: cfg.DEFAULT_TIMEZONE, allowedPhones: cfg.allowedPhones,
  });

  startScheduler(store, wa);
  app.listen(cfg.PORT, () => {
    console.log(`Assessor ouvindo em http://localhost:${cfg.PORT} (IA: ${assessor.providerName})`);
  });
}

// Só sobe o servidor quando executado diretamente (permite importar createApp nos testes).
const invokedDirectly = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
