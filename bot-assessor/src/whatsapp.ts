/**
 * Integração com a WhatsApp Cloud API (Meta). Envio de mensagens, validação da
 * assinatura do webhook e extração das mensagens recebidas.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface WhatsAppConfig {
  token: string;
  phoneNumberId: string;
  apiVersion: string;
  fetchImpl?: typeof fetch;
}

export interface IncomingMessage {
  id: string;
  from: string;          // número do remetente, ex.: 5511999999999
  name: string | null;   // nome do perfil do WhatsApp
  timestamp: number;     // epoch segundos
  type: string;          // text, audio, image, ...
  text: string | null;   // corpo do texto (ou legenda), quando houver
}

/** Valida o header X-Hub-Signature-256 contra o corpo bruto da requisição. */
export function verifySignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

/** Extrai todas as mensagens de um payload de webhook (ignora status de entrega etc.). */
export function extractMessages(payload: unknown): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  const body = payload as { object?: string; entry?: Array<{ changes?: Array<{ field?: string; value?: any }> }> };
  if (body?.object !== "whatsapp_business_account") return out;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value ?? {};
      const contacts: Array<{ wa_id?: string; profile?: { name?: string } }> = value.contacts ?? [];
      for (const m of value.messages ?? []) {
        const contact = contacts.find((c) => c.wa_id === m.from);
        let text: string | null = null;
        if (m.type === "text") text = m.text?.body ?? null;
        else if (m.type === "interactive") text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
        else if (m.type === "button") text = m.button?.text ?? null;
        else if (["image", "video", "document"].includes(m.type)) text = m[m.type]?.caption ?? null;
        out.push({
          id: String(m.id),
          from: String(m.from),
          name: contact?.profile?.name ?? null,
          timestamp: Number(m.timestamp) || Math.floor(Date.now() / 1000),
          type: String(m.type ?? "unknown"),
          text,
        });
      }
    }
  }
  return out;
}

export class WhatsAppClient {
  private fetchImpl: typeof fetch;
  constructor(private cfg: WhatsAppConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private get url() {
    return `https://graph.facebook.com/${this.cfg.apiVersion}/${this.cfg.phoneNumberId}/messages`;
  }

  private async post(body: Record<string, unknown>): Promise<void> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`WhatsApp API ${res.status}: ${detail.slice(0, 500)}`);
    }
  }

  /** Envia texto. O WhatsApp limita a 4096 caracteres; mensagens maiores são divididas. */
  async sendText(to: string, text: string): Promise<void> {
    for (const chunk of splitMessage(text, 4000)) {
      await this.post({ to, type: "text", text: { body: chunk, preview_url: false } });
    }
  }

  /** Marca como lida e mostra "digitando..." enquanto o assessor pensa. */
  async markReadAndTyping(messageId: string): Promise<void> {
    await this.post({ status: "read", message_id: messageId, typing_indicator: { type: "text" } });
  }
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
