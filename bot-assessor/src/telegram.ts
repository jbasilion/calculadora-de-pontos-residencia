/**
 * Integração com a Bot API do Telegram, sem dependências: envio de mensagens,
 * long polling, webhook e extração das mensagens recebidas.
 * Referência: https://core.telegram.org/bots/api
 */
import { timingSafeEqual } from "node:crypto";
import type { MessageSender } from "./scheduler.js";

export interface TelegramConfig {
  token: string;
  fetchImpl?: typeof fetch;
  apiBase?: string; // para testes
}

export interface IncomingMessage {
  id: string;          // id único da atualização (update_id)
  chatId: string;      // chat de origem (usuário ou grupo)
  fromId: string;      // id do usuário que escreveu
  name: string | null; // primeiro nome do perfil
  timestamp: number;   // epoch em segundos
  text: string | null; // texto ou legenda; null para áudio/foto sem legenda
  isCommand: boolean;  // começa com "/"
}

/** Telegram Update (subconjunto que usamos). */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}
interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  from?: { id: number; first_name?: string; last_name?: string; username?: string; is_bot?: boolean };
  chat: { id: number; type: string };
}

export function extractMessage(update: TelegramUpdate): IncomingMessage | null {
  const m = update.message; // mensagens editadas são ignoradas para não reprocessar
  if (!m || m.from?.is_bot) return null;
  const text = m.text ?? m.caption ?? null;
  return {
    id: String(update.update_id),
    chatId: String(m.chat.id),
    fromId: String(m.from?.id ?? m.chat.id),
    name: m.from?.first_name ?? null,
    timestamp: m.date,
    text,
    isCommand: !!text && text.startsWith("/"),
  };
}

/** Compara o header X-Telegram-Bot-Api-Secret-Token com o segredo configurado. */
export function verifySecret(header: string | undefined, secret: string): boolean {
  if (!header || header.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(secret));
}

/**
 * Converte o texto do assessor (estilo chat: *negrito*, quebras de linha) para HTML do Telegram.
 * Escapa <, > e & e transforma *texto* em <b>texto</b>.
 */
export function toTelegramHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(/(^|[\s(\[•])\*([^*\n]+?)\*(?=$|[\s.,;:!?)\]])/gm, "$1<b>$2</b>");
}

export function splitMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export class TelegramApiError extends Error {
  constructor(message: string, readonly status: number, readonly method: string) {
    super(message);
  }
}

export class TelegramClient implements MessageSender {
  private fetchImpl: typeof fetch;
  private base: string;

  constructor(cfg: TelegramConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.base = `${cfg.apiBase ?? "https://api.telegram.org"}/bot${cfg.token}`;
  }

  async call<T = unknown>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
    if (!res.ok || !data.ok) {
      throw new TelegramApiError(data.description ?? `HTTP ${res.status}`, data.error_code ?? res.status, method);
    }
    return data.result as T;
  }

  /** Envia texto (limite do Telegram: 4096 caracteres). Tenta HTML; se o Telegram rejeitar, envia puro. */
  async sendText(chatId: string, text: string): Promise<void> {
    for (const chunk of splitMessage(text, 4000)) {
      try {
        await this.call("sendMessage", { chat_id: chatId, text: toTelegramHtml(chunk), parse_mode: "HTML" });
      } catch (err) {
        if (err instanceof TelegramApiError && err.status === 400) {
          await this.call("sendMessage", { chat_id: chatId, text: chunk });
        } else throw err;
      }
    }
  }

  /** Mostra "digitando..." por alguns segundos. */
  async sendTyping(chatId: string): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  /** Long polling: bloqueia até `timeoutSeconds` esperando novas atualizações. */
  async getUpdates(offset: number | undefined, timeoutSeconds = 30, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      { ...(offset !== undefined ? { offset } : {}), timeout: timeoutSeconds, allowed_updates: ["message"] },
      signal,
    );
  }

  async setWebhook(url: string, secret: string): Promise<void> {
    await this.call("setWebhook", { url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: false });
  }

  async deleteWebhook(): Promise<void> {
    await this.call("deleteWebhook", { drop_pending_updates: false });
  }

  async getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
    return this.call("getMe");
  }
}

/**
 * Loop de long polling. Chama `onUpdate` para cada atualização e só avança o
 * offset depois de entregá-la. Encerra quando `signal` for abortado.
 */
export async function runPolling(
  client: TelegramClient,
  onUpdate: (u: TelegramUpdate) => Promise<void>,
  opts: { signal?: AbortSignal; timeoutSeconds?: number; onError?: (err: unknown) => void } = {},
): Promise<void> {
  let offset: number | undefined;
  let backoff = 1000;
  while (!opts.signal?.aborted) {
    try {
      const updates = await client.getUpdates(offset, opts.timeoutSeconds ?? 30, opts.signal);
      backoff = 1000;
      for (const u of updates) {
        offset = u.update_id + 1;
        await onUpdate(u);
      }
    } catch (err) {
      if (opts.signal?.aborted) return;
      opts.onError?.(err);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
