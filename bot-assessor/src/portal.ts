/**
 * Portal web: uma página para ver todos os gastos, gráficos, agenda e notas.
 * O acesso é por link mágico assinado, que o bot manda no Telegram (/portal).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Router, type Request, type Response, type NextFunction } from "express";
import type { Store, Transaction, User } from "./store.js";
import { formatPtBr } from "./dates.js";

export const PORTAL_TOKEN_TTL_MS = 7 * 24 * 3600_000;

/* ============================ Token ============================ */

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signPortalToken(userId: string, secret: string, expiresAt = Date.now() + PORTAL_TOKEN_TTL_MS): string {
  const payload = b64url(JSON.stringify({ u: userId, e: expiresAt }));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyPortalToken(token: string | undefined, secret: string, now = Date.now()): { userId: string } | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload, secret);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: string; e?: number };
    if (!data.u || typeof data.e !== "number" || data.e < now) return null;
    return { userId: data.u };
  } catch {
    return null;
  }
}

export function portalLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/portal#t=${token}`;
}

/* ============================ CSV ============================ */

export function transactionsToCsv(txs: Transaction[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; // separador é ";", então vírgula decimal não precisa de aspas
  };
  const header = "data;tipo;valor;descricao;categoria;forma_pagamento;id";
  const rows = txs.map((t) =>
    [t.occurred_on, t.kind, Number(t.amount).toFixed(2).replace(".", ","), t.description, t.category ?? "", t.payment_method ?? "", t.id]
      .map(esc).join(";"),
  );
  return "﻿" + [header, ...rows].join("\r\n"); // BOM para o Excel abrir com acentos
}

/* ============================ Router ============================ */

export interface PortalDeps {
  store: Store;
  secret: string;
  /** Para testes: caminho alternativo do HTML. */
  htmlPath?: URL | string;
}

type AuthedRequest = Request & { portalUser?: User };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createPortalRouter(deps: PortalDeps): Router {
  const router = Router();
  const htmlPath = deps.htmlPath ?? new URL("../public/portal.html", import.meta.url);

  router.get("/portal", async (_req, res) => {
    try {
      res.type("html").send(await readFile(htmlPath, "utf8"));
    } catch (err) {
      console.error("[portal] não consegui ler o HTML:", err);
      res.status(500).send("Portal indisponível");
    }
  });

  const auth = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : (typeof req.query.t === "string" ? req.query.t : undefined);
    const claims = verifyPortalToken(token, deps.secret);
    if (!claims) return res.status(401).json({ error: "Link inválido ou expirado. Peça um novo com /portal no Telegram." });
    const user = await deps.store.getUser(claims.userId);
    if (!user) return res.status(401).json({ error: "Usuário não encontrado." });
    req.portalUser = user;
    next();
  };

  const range = (req: Request) => {
    const from = typeof req.query.from === "string" ? req.query.from : "";
    const to = typeof req.query.to === "string" ? req.query.to : "";
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return null;
    // `to` é inclusivo na URL; o store usa fim exclusivo.
    const end = new Date(`${to}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    return { startDate: from, endDate: end.toISOString().slice(0, 10) };
  };

  router.get("/api/portal/me", auth, (req: AuthedRequest, res) => {
    const u = req.portalUser!;
    res.json({ name: u.name, tz: u.tz, since: u.created_at });
  });

  router.get("/api/portal/transactions", auth, async (req: AuthedRequest, res) => {
    const r = range(req);
    if (!r) return res.status(400).json({ error: "Informe from e to no formato YYYY-MM-DD." });
    const txs = await deps.store.listTransactions(req.portalUser!.id, r, 5000);
    res.json(txs.map((t) => ({ ...t, amount: Number(t.amount) })));
  });

  router.delete("/api/portal/transactions/:id", auth, async (req: AuthedRequest, res) => {
    const ok = await deps.store.deleteTransaction(req.portalUser!.id, String(req.params.id));
    if (!ok) return res.status(404).json({ error: "Lançamento não encontrado." });
    res.json({ ok: true });
  });

  router.get("/api/portal/export.csv", auth, async (req: AuthedRequest, res) => {
    const r = range(req);
    if (!r) return res.status(400).json({ error: "Informe from e to no formato YYYY-MM-DD." });
    const txs = await deps.store.listTransactions(req.portalUser!.id, r, 50000);
    res.setHeader("Content-Disposition", `attachment; filename="lancamentos_${r.startDate}_${req.query.to}.csv"`);
    res.type("text/csv; charset=utf-8").send(transactionsToCsv(txs));
  });

  router.get("/api/portal/reminders", auth, async (req: AuthedRequest, res) => {
    const u = req.portalUser!;
    const items = await deps.store.listReminders(u.id, { status: "pendente", limit: 200 });
    res.json(items.map((r) => ({ ...r, due_label: formatPtBr(new Date(r.due_at), u.tz) })));
  });

  router.get("/api/portal/notes", auth, async (req: AuthedRequest, res) => {
    res.json(await deps.store.searchNotes(req.portalUser!.id, "", 500));
  });

  return router;
}
