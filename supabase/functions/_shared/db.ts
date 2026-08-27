// Acesso ao Postgres (tabela news_drafts) e ao Storage, via service role.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { config } from "./config.ts";

export interface Draft {
  id: string;
  chat_id: number;
  source_text: string;
  telegram_file_id: string | null;
  photo_url: string | null;
  title: string | null;
  body: string | null;
  excerpt: string | null;
  status: string;
  attempts: number;
  preview_message_id: number | null;
  wp_post_id: number | null;
  wp_post_url: string | null;
  error: string | null;
}

let client: SupabaseClient | null = null;
export function db(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

export async function createDraft(row: Partial<Draft>): Promise<Draft> {
  const { data, error } = await db().from("news_drafts").insert(row).select().single();
  if (error) throw new Error(`DB insert falhou: ${error.message}`);
  return data as Draft;
}

export async function updateDraft(id: string, patch: Partial<Draft>): Promise<Draft> {
  const { data, error } = await db()
    .from("news_drafts").update(patch).eq("id", id).select().single();
  if (error) throw new Error(`DB update falhou: ${error.message}`);
  return data as Draft;
}

export async function getDraft(id: string): Promise<Draft | null> {
  const { data, error } = await db()
    .from("news_drafts").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`DB select falhou: ${error.message}`);
  return data as Draft | null;
}

// Sobe a foto original para o Storage e devolve a URL pública.
export async function uploadPhoto(
  draftId: string,
  bytes: Uint8Array,
  mime: string,
): Promise<string> {
  const bucket = config.storageBucket;
  const ext = mime.includes("png") ? "png" : "jpg";
  const path = `${draftId}/original.${ext}`;
  const { error } = await db().storage.from(bucket).upload(path, bytes, {
    contentType: mime,
    upsert: true,
  });
  if (error) throw new Error(`Storage upload falhou: ${error.message}`);
  const { data } = db().storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}
