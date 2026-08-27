// Geração do texto do artigo a partir da notícia crua.
// Provider padrão: Google Gemini (free tier). Alternativa: OpenAI.
import { config } from "./config.ts";

export interface Article {
  title: string;
  excerpt: string; // lead / resumo curto
  body: string; // corpo em HTML simples (<p>, <h2>...)
}

function buildPrompt(rawNews: string, retry: boolean): string {
  return [
    "Você é um editor de um portal de notícias brasileiro.",
    "A partir da NOTÍCIA CRUA abaixo, escreva uma matéria pronta para publicação,",
    "em português do Brasil, com apuração jornalística, tom informativo e imparcial.",
    "Regras:",
    "- Não invente fatos, números, nomes ou citações que não estejam na notícia crua.",
    "- Título objetivo e chamativo (sem clickbait exagerado), até 90 caracteres.",
    "- Um lead (resumo) de 1 a 2 frases.",
    "- Corpo em HTML simples: parágrafos <p> e, se fizer sentido, subtítulos <h2>.",
    "- Não inclua <html>, <head> ou <body>. Apenas o conteúdo do artigo.",
    retry
      ? "- Esta é uma NOVA versão: mude a abordagem, o título e a estrutura em relação à anterior."
      : "",
    "",
    "Responda ESTRITAMENTE com um JSON válido, sem markdown, no formato:",
    '{"title": "...", "excerpt": "...", "body": "<p>...</p>"}',
    "",
    "NOTÍCIA CRUA:",
    rawNews,
  ].join("\n");
}

function parseArticle(text: string): Article {
  // Remove cercas de código markdown se o modelo insistir em usá-las.
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let data: Partial<Article>;
  try {
    data = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("IA não retornou JSON válido.");
    data = JSON.parse(cleaned.slice(start, end + 1));
  }
  if (!data.title || !data.body) throw new Error("IA retornou JSON incompleto.");
  return {
    title: String(data.title).trim(),
    excerpt: String(data.excerpt ?? "").trim(),
    body: String(data.body).trim(),
  };
}

async function generateGemini(prompt: string): Promise<string> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini falhou: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini não retornou texto.");
  return text;
}

async function generateOpenAI(prompt: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.openaiApiKey()}`,
    },
    body: JSON.stringify({
      model: config.openaiModel,
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI falhou: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI não retornou texto.");
  return text;
}

export async function generateArticle(rawNews: string, retry = false): Promise<Article> {
  const prompt = buildPrompt(rawNews, retry);
  const raw = config.aiProvider === "openai"
    ? await generateOpenAI(prompt)
    : await generateGemini(prompt);
  return parseArticle(raw);
}
