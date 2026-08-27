// Webhook do Telegram: recebe notícia crua + foto, gera artigo com IA,
// manda um preview com botões e publica no WordPress quando aprovado.
//
// Deploy:  supabase functions deploy telegram-webhook --no-verify-jwt
import { config } from "../_shared/config.ts";
import {
  answerCallback,
  downloadFile,
  editReplyMarkup,
  largestPhoto,
  sendChatAction,
  sendMessage,
  sendPreview,
} from "../_shared/telegram.ts";
import { generateArticle } from "../_shared/ai.ts";
import { buildPreviewImage } from "../_shared/preview.ts";
import { createPost, uploadMedia } from "../_shared/wordpress.ts";
import {
  createDraft,
  type Draft,
  getDraft,
  updateDraft,
  uploadPhoto,
} from "../_shared/db.ts";

Deno.serve(async (req) => {
  // 1) Valida o segredo do webhook (evita chamadas forjadas).
  if (config.telegramWebhookSecret) {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (got !== config.telegramWebhookSecret) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Responde 200 rápido; o processamento continua em background para o
  // Telegram não reenviar o update por timeout.
  const task = update.callback_query
    ? handleCallback(update.callback_query)
    : handleMessage(update.message);

  // @ts-ignore EdgeRuntime existe no runtime do Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(task);
  else await task;

  return new Response("ok", { status: 200 });
});

function allowed(chatId: number): boolean {
  if (!config.allowedChatId) return true;
  return String(chatId) === config.allowedChatId;
}

// ---------- Mensagem nova: notícia crua + foto ----------
async function handleMessage(message: any) {
  if (!message) return;
  const chatId = message.chat.id;
  if (!allowed(chatId)) {
    await sendMessage(chatId, "⛔ Este bot é privado.");
    return;
  }

  const rawText = (message.caption ?? message.text ?? "").trim();

  if (!message.photo) {
    await sendMessage(
      chatId,
      "📸 Envie a <b>notícia crua</b> como <b>legenda de uma foto</b>. " +
        "A foto vira a imagem destacada e o texto vira a matéria.",
    );
    return;
  }
  if (rawText.length < 20) {
    await sendMessage(
      chatId,
      "✍️ A notícia está muito curta. Envie a foto com a notícia crua na legenda " +
        "(pelo menos algumas frases).",
    );
    return;
  }

  await sendChatAction(chatId);
  let draft: Draft | null = null;
  try {
    const fileId = largestPhoto(message.photo).file_id;
    const photoBytes = await downloadFile(fileId);
    const mime = "image/jpeg"; // Telegram entrega fotos como JPEG

    draft = await createDraft({
      chat_id: chatId,
      source_text: rawText,
      telegram_file_id: fileId,
      status: "pending",
      attempts: 1,
    });

    draft.photo_url = await uploadPhoto(draft.id, photoBytes, mime);
    await updateDraft(draft.id, { photo_url: draft.photo_url });

    await generateAndPreview(draft, photoBytes, mime, false);
  } catch (err) {
    console.error(err);
    if (draft) await updateDraft(draft.id, { status: "error", error: String(err) });
    await sendMessage(chatId, `❌ Erro ao processar: ${String(err)}`);
  }
}

// Gera (ou regenera) o artigo e envia o preview.
async function generateAndPreview(
  draft: Draft,
  photoBytes: Uint8Array,
  mime: string,
  retry: boolean,
) {
  const chatId = draft.chat_id;
  await sendChatAction(chatId);

  const article = await generateArticle(draft.source_text, retry);
  await updateDraft(draft.id, {
    title: article.title,
    body: article.body,
    excerpt: article.excerpt,
    status: "pending",
  });

  const previewPng = await buildPreviewImage({
    title: article.title,
    siteName: config.siteName,
    photoBytes,
    photoMime: mime,
  });

  const caption = [
    `<b>${escapeHtml(article.title)}</b>`,
    "",
    escapeHtml(article.excerpt),
    "",
    `<i>Versão ${draft.attempts} • assim vai aparecer no ${escapeHtml(config.siteName)}</i>`,
  ].join("\n");

  const sent = await sendPreview(
    chatId,
    new Blob([previewPng], { type: "image/png" }),
    caption.slice(0, 1024),
    draft.id,
  );
  await updateDraft(draft.id, { preview_message_id: sent.message_id });
}

// ---------- Clique nos botões: Aprovar / Refazer ----------
async function handleCallback(cb: any) {
  const chatId = cb.message?.chat?.id;
  const [action, draftId] = String(cb.data ?? "").split(":");
  if (!allowed(chatId) || !draftId) {
    await answerCallback(cb.id, "Ação inválida.");
    return;
  }

  const draft = await getDraft(draftId);
  if (!draft) {
    await answerCallback(cb.id, "Rascunho não encontrado.");
    return;
  }
  if (draft.status === "published") {
    await answerCallback(cb.id, "Esta notícia já foi publicada.");
    return;
  }

  // Remove os botões para evitar clique duplo.
  if (draft.preview_message_id) {
    await editReplyMarkup(chatId, draft.preview_message_id);
  }

  if (action === "approve") {
    await answerCallback(cb.id, "Publicando...");
    await publish(draft);
  } else if (action === "reject") {
    await answerCallback(cb.id, "Refazendo a matéria...");
    await regenerate(draft);
  } else {
    await answerCallback(cb.id, "Ação desconhecida.");
  }
}

async function publish(draft: Draft) {
  const chatId = draft.chat_id;
  try {
    await sendChatAction(chatId);
    let featuredMediaId: number | undefined;
    if (draft.telegram_file_id) {
      const bytes = await downloadFile(draft.telegram_file_id);
      featuredMediaId = await uploadMedia(bytes, `${draft.id}.jpg`, "image/jpeg");
    }
    const post = await createPost({
      title: draft.title ?? "Sem título",
      content: draft.body ?? "",
      excerpt: draft.excerpt ?? "",
      featuredMediaId,
    });
    await updateDraft(draft.id, {
      status: "published",
      wp_post_id: post.id,
      wp_post_url: post.link,
    });
    const statusMsg = post.status === "publish"
      ? "✅ <b>Publicado no site!</b>"
      : "✅ <b>Salvo como rascunho no WordPress</b> (revise e publique quando quiser).";
    await sendMessage(chatId, `${statusMsg}\n${post.link}`);
  } catch (err) {
    console.error(err);
    await updateDraft(draft.id, { status: "error", error: String(err) });
    await sendMessage(chatId, `❌ Falha ao publicar no WordPress: ${String(err)}`);
  }
}

async function regenerate(draft: Draft) {
  const chatId = draft.chat_id;
  try {
    const updated = await updateDraft(draft.id, { attempts: draft.attempts + 1 });
    const mime = "image/jpeg";
    const bytes = draft.telegram_file_id
      ? await downloadFile(draft.telegram_file_id)
      : new Uint8Array();
    await generateAndPreview(updated, bytes, mime, true);
  } catch (err) {
    console.error(err);
    await updateDraft(draft.id, { status: "error", error: String(err) });
    await sendMessage(chatId, `❌ Falha ao refazer a matéria: ${String(err)}`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
