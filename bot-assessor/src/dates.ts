/**
 * Utilitários de data com fuso horário, sem dependências externas.
 * O bot conversa em horário local do usuário (ex.: America/Sao_Paulo)
 * e grava tudo em UTC no banco.
 */

const PARTS_FMT = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = PARTS_FMT.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      weekday: "short",
    });
    PARTS_FMT.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  weekday: string;
}

export function localParts(date: Date, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: +get("year"), month: +get("month"), day: +get("day"),
    hour: +get("hour"), minute: +get("minute"), second: +get("second"),
    weekday: get("weekday"),
  };
}

/** Offset (ms) do fuso em relação ao UTC naquele instante. */
export function tzOffsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Converte um horário "de parede" (YYYY-MM-DD ou YYYY-MM-DDTHH:mm[:ss]) no fuso dado para Date (UTC).
 * Se a string já tiver offset (Z ou ±HH:mm), respeita o offset.
 */
export function localToDate(local: string, tz: string): Date {
  const s = local.trim();
  if (/([zZ]|[+-]\d{2}:\d{2})$/.test(s)) return new Date(s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`Data inválida: "${local}". Use YYYY-MM-DD ou YYYY-MM-DDTHH:mm.`);
  const [, y, mo, d, h = "0", mi = "0", se = "0"] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  let result = guess - tzOffsetMs(new Date(guess), tz);
  // Segunda passada para ajustar em transições de horário de verão.
  result = guess - tzOffsetMs(new Date(result), tz);
  return new Date(result);
}

export function pad(n: number): string { return String(n).padStart(2, "0"); }

/** YYYY-MM-DD no fuso. */
export function localDateString(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "dom, 27/09/2026 14:05" no fuso. */
export function formatPtBr(date: Date, tz: string, withTime = true): string {
  const p = localParts(date, tz);
  const dias: Record<string, string> = { Sun: "dom", Mon: "seg", Tue: "ter", Wed: "qua", Thu: "qui", Fri: "sex", Sat: "sáb" };
  const base = `${dias[p.weekday] ?? p.weekday}, ${pad(p.day)}/${pad(p.month)}/${p.year}`;
  return withTime ? `${base} ${pad(p.hour)}:${pad(p.minute)}` : base;
}

/** Texto de contexto temporal enviado ao modelo a cada mensagem. */
export function describeNow(now: Date, tz: string): string {
  const p = localParts(now, tz);
  return `${formatPtBr(now, tz)} (fuso ${tz}; ISO local ${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)})`;
}

export type Periodo = "hoje" | "ontem" | "semana" | "mes" | "mes_passado" | "ano" | "personalizado";

/** Intervalo [inicio, fim) em UTC para um período nomeado, no fuso dado. */
export function periodRange(
  periodo: Periodo, now: Date, tz: string, inicio?: string, fim?: string,
): { start: Date; end: Date; label: string } {
  const p = localParts(now, tz);
  const day = (y: number, m: number, d: number) => localToDate(`${y}-${pad(m)}-${pad(d)}`, tz);
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
  const today = day(p.year, p.month, p.day);
  switch (periodo) {
    case "hoje": return { start: today, end: addDays(today, 1), label: "hoje" };
    case "ontem": return { start: addDays(today, -1), end: today, label: "ontem" };
    case "semana": {
      // semana começa na segunda-feira
      const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
      const back = (dow + 6) % 7;
      const start = addDays(today, -back);
      return { start, end: addDays(start, 7), label: "esta semana" };
    }
    case "mes": return { start: day(p.year, p.month, 1), end: nextMonth(p.year, p.month), label: "este mês" };
    case "mes_passado": {
      const y = p.month === 1 ? p.year - 1 : p.year;
      const m = p.month === 1 ? 12 : p.month - 1;
      return { start: day(y, m, 1), end: day(p.year, p.month, 1), label: "mês passado" };
    }
    case "ano": return { start: day(p.year, 1, 1), end: day(p.year + 1, 1, 1), label: `${p.year}` };
    case "personalizado": {
      if (!inicio || !fim) throw new Error("Período personalizado exige inicio e fim (YYYY-MM-DD).");
      const s = localToDate(inicio, tz);
      const e = addDays(localToDate(fim, tz), 1); // fim inclusivo
      return { start: s, end: e, label: `${inicio} a ${fim}` };
    }
  }
  function nextMonth(y: number, m: number) { return m === 12 ? day(y + 1, 1, 1) : day(y, m + 1, 1); }
}

export function formatBRL(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
