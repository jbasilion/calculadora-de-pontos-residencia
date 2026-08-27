// Gera a imagem de PREVIEW do card da notícia (foto + título + fonte),
// simulando como o artigo vai aparecer no portal. SVG -> PNG via resvg-wasm.
import { initWasm, Resvg } from "https://esm.sh/@resvg/resvg-wasm@2.6.2";

let wasmReady = false;
async function ensureWasm() {
  if (wasmReady) return;
  const wasm = await fetch(
    "https://esm.sh/@resvg/resvg-wasm@2.6.2/index_bg.wasm",
  );
  await initWasm(wasm);
  wasmReady = true;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Quebra o título em linhas para caber na largura do card.
function wrapTitle(title: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = title.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = w;
      if (lines.length === maxLines - 1) break;
    } else {
      current = candidate;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (last.length >= maxCharsPerLine - 1) {
      lines[maxLines - 1] = last.slice(0, maxCharsPerLine - 1).trimEnd() + "…";
    }
  }
  return lines;
}

export interface PreviewInput {
  title: string;
  siteName: string;
  photoBytes: Uint8Array;
  photoMime: string;
}

export async function buildPreviewImage(input: PreviewInput): Promise<Uint8Array> {
  await ensureWasm();

  const W = 1200;
  const H = 675; // 16:9
  const dataUri = `data:${input.photoMime};base64,${base64(input.photoBytes)}`;

  const lines = wrapTitle(input.title, 34, 3);
  const lineHeight = 62;
  const blockHeight = lines.length * lineHeight;
  const titleStartY = H - 70 - blockHeight + lineHeight;

  const titleTspans = lines
    .map((l, i) =>
      `<tspan x="60" y="${titleStartY + i * lineHeight}">${escapeXml(l)}</tspan>`
    )
    .join("");

  const svg = `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.35" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.85"/>
    </linearGradient>
    <clipPath id="frame"><rect x="0" y="0" width="${W}" height="${H}" rx="0"/></clipPath>
  </defs>
  <g clip-path="url(#frame)">
    <image href="${dataUri}" x="0" y="0" width="${W}" height="${H}"
           preserveAspectRatio="xMidYMid slice"/>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#shade)"/>
  </g>
  <rect x="60" y="48" width="${18 + input.siteName.length * 16}" height="46" rx="6" fill="#c8102e"/>
  <text x="79" y="80" font-family="Arial, sans-serif" font-size="26" font-weight="700"
        fill="#ffffff">${escapeXml(input.siteName.toUpperCase())}</text>
  <text font-family="Georgia, 'Times New Roman', serif" font-size="50" font-weight="700"
        fill="#ffffff">${titleTspans}</text>
</svg>`.trim();

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: { loadSystemFonts: true },
  });
  return resvg.render().asPng();
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
