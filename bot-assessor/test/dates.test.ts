import { test } from "node:test";
import assert from "node:assert/strict";
import { localToDate, localDateString, periodRange, formatPtBr, formatBRL } from "../src/dates.ts";

const TZ = "America/Sao_Paulo"; // UTC-3, sem horário de verão desde 2019

test("localToDate converte horário de parede para UTC", () => {
  const d = localToDate("2026-09-28T09:00", TZ);
  assert.equal(d.toISOString(), "2026-09-28T12:00:00.000Z");
});

test("localToDate respeita offset explícito", () => {
  assert.equal(localToDate("2026-09-28T09:00:00Z", TZ).toISOString(), "2026-09-28T09:00:00.000Z");
});

test("localToDate rejeita formato inválido", () => {
  assert.throws(() => localToDate("amanhã", TZ), /Data inválida/);
});

test("localDateString devolve a data local, não a UTC", () => {
  // 23:30 em SP de 27/09 = 02:30Z de 28/09
  const d = new Date("2026-09-28T02:30:00Z");
  assert.equal(localDateString(d, TZ), "2026-09-27");
});

test("periodRange: semana começa na segunda", () => {
  const now = new Date("2026-09-30T15:00:00Z"); // quarta-feira, 12:00 em SP
  const r = periodRange("semana", now, TZ);
  assert.equal(localDateString(r.start, TZ), "2026-09-28");
  assert.equal(localDateString(r.end, TZ), "2026-10-05");
});

test("periodRange: mês passado em janeiro volta um ano", () => {
  const now = new Date("2027-01-10T15:00:00Z");
  const r = periodRange("mes_passado", now, TZ);
  assert.equal(localDateString(r.start, TZ), "2026-12-01");
  assert.equal(localDateString(r.end, TZ), "2027-01-01");
});

test("periodRange personalizado é inclusivo no fim", () => {
  const r = periodRange("personalizado", new Date(), TZ, "2026-09-01", "2026-09-15");
  assert.equal(localDateString(r.end, TZ), "2026-09-16");
});

test("formatPtBr e formatBRL", () => {
  assert.equal(formatPtBr(new Date("2026-09-27T17:05:00Z"), TZ), "dom, 27/09/2026 14:05");
  assert.equal(formatBRL(1234.5).replace(/ /g, " "), "R$ 1.234,50");
});
