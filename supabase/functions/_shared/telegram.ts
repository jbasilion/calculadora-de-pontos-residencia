// Wrapper fino sobre a Bot API do Telegram.
import { config } from "./config.ts";

const api = (method: string) =>
  `https://api.telegram.org/bot${config.telegramToken()}/${method}`;
const fileApi = (path: string) =>
  `https://api.telegram.org/file/bot${config.telegramToken()}/${path}`;

async function call<T = unknown>(method: string, body: unknown): Promise<T> {
  const res = await fetch(api(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`Telegram ${method} falhou: ${JSON.stringify(json)}`);
  }
  return json.result as T;
}

export async function sendMessage(
  chatId: number | string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

export async function sendChatAction(chatId: number | string, action = "typing") {
  try {
    await call("sendChatAction", { chat_id: chatId, action });
  } catch (_) { /* não é crítico */ }
}

// Envia a foto de preview com botões de Aprovar / Refazer.
export async function sendPreview(
  chatId: number | string,
  photo: Blob,
  caption: string,
  draftId: string,
): Promise<{ message_id: number }> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", photo, "preview.png");
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append(
    "reply_markup",
    JSON.stringify({
      inline_keyboard: [[
        { text: "✅ Aprovar e publicar", callback_data: `approve:${draftId}` },
        { text: "🔄 Refazer", callback_data: `reject:${draftId}` },
      ]],
    }),
  );
  const res = await fetch(api("sendPhoto"), { method: "POST", body: form });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram sendPhoto falhou: ${JSON.stringify(json)}`);
  return json.result;
}

export async function answerCallback(callbackId: string, text = "") {
  return call("answerCallbackQuery", { callback_query_id: callbackId, text });
}

// Remove os botões da mensagem de preview depois de decidida.
export async function editReplyMarkup(
  chatId: number | string,
  messageId: number,
  keyboard: unknown = { inline_keyboard: [] },
) {
  try {
    await call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: keyboard,
    });
  } catch (_) { /* mensagem pode já ter sido editada */ }
}

// Baixa um arquivo (foto) do Telegram a partir do file_id.
export async function downloadFile(fileId: string): Promise<Uint8Array> {
  const file = await call<{ file_path: string }>("getFile", { file_id: fileId });
  const res = await fetch(fileApi(file.file_path));
  if (!res.ok) throw new Error(`Falha ao baixar arquivo do Telegram: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Escolhe a maior resolução da foto enviada.
export function largestPhoto(
  photos: Array<{ file_id: string; width: number; height: number }>,
): { file_id: string } {
  return photos.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
}
