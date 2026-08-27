// Publicação no WordPress via REST API + Application Password.
import { config } from "./config.ts";

function authHeader(): string {
  const token = btoa(`${config.wpUser()}:${config.wpAppPassword()}`);
  return `Basic ${token}`;
}

// Faz upload da imagem para a biblioteca de mídia e retorna o id do anexo.
export async function uploadMedia(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<number> {
  const res = await fetch(`${config.wpBaseUrl()}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      authorization: authHeader(),
      "content-type": mime,
      "content-disposition": `attachment; filename="${filename}"`,
    },
    body: bytes,
  });
  if (!res.ok) {
    throw new Error(`WP upload de mídia falhou: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.id as number;
}

export interface CreatePostInput {
  title: string;
  content: string; // HTML
  excerpt: string;
  featuredMediaId?: number;
}

export interface CreatedPost {
  id: number;
  link: string;
  status: string;
}

export async function createPost(input: CreatePostInput): Promise<CreatedPost> {
  const body: Record<string, unknown> = {
    title: input.title,
    content: input.content,
    excerpt: input.excerpt,
    status: config.wpDefaultStatus, // draft ou publish
  };
  if (input.featuredMediaId) body.featured_media = input.featuredMediaId;
  if (config.wpCategoryId) body.categories = [Number(config.wpCategoryId)];

  const res = await fetch(`${config.wpBaseUrl()}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: { authorization: authHeader(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`WP criação de post falhou: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return { id: json.id, link: json.link, status: json.status };
}
