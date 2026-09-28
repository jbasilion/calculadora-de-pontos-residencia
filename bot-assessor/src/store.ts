/**
 * Camada de dados. `Store` é a interface; `SupabaseStore` é a implementação real
 * e `MemoryStore` serve para testes e para o chat local (npm run chat).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

export interface User {
  id: string;
  chat_id: string;   // id do chat no Telegram (usuário ou grupo)
  name: string | null;
  tz: string;
  created_at: string;
}

export type Role = "user" | "assistant";
export interface StoredMessage { role: Role; content: string; created_at: string }

export type TransactionKind = "gasto" | "receita";
export interface Transaction {
  id: string;
  user_id: string;
  kind: TransactionKind;
  amount: number;
  description: string;
  category: string | null;
  payment_method: string | null;
  occurred_on: string; // YYYY-MM-DD (data local)
  created_at: string;
}

export type ReminderKind = "lembrete" | "compromisso";
export type Recurrence = "nenhuma" | "diaria" | "semanal" | "mensal";
export type ReminderStatus = "pendente" | "enviado" | "cancelado";
export interface Reminder {
  id: string;
  user_id: string;
  kind: ReminderKind;
  title: string;
  location: string | null;
  due_at: string;    // ISO UTC: quando o compromisso acontece / o lembrete deve disparar
  remind_at: string; // ISO UTC: quando o bot envia a mensagem
  recurrence: Recurrence;
  status: ReminderStatus;
  created_at: string;
}

export interface Note {
  id: string;
  user_id: string;
  text: string;
  created_at: string;
}

export interface Store {
  getOrCreateUser(chatId: string, defaults: { tz: string; name?: string | null }): Promise<User>;
  getUser(userId: string): Promise<User | null>;
  updateUser(userId: string, patch: Partial<Pick<User, "name" | "tz">>): Promise<User>;

  appendMessage(userId: string, role: Role, content: string): Promise<void>;
  recentMessages(userId: string, limit: number): Promise<StoredMessage[]>;

  addTransaction(t: Omit<Transaction, "id" | "created_at">): Promise<Transaction>;
  listTransactions(userId: string, range: { startDate: string; endDate: string }, limit?: number): Promise<Transaction[]>;
  deleteTransaction(userId: string, id: string): Promise<boolean>;

  addReminder(r: Omit<Reminder, "id" | "created_at" | "status">): Promise<Reminder>;
  listReminders(userId: string, opts: { status?: ReminderStatus; from?: string; to?: string; limit?: number }): Promise<Reminder[]>;
  updateReminder(id: string, patch: Partial<Pick<Reminder, "status" | "due_at" | "remind_at">>): Promise<void>;
  cancelReminder(userId: string, id: string): Promise<boolean>;
  dueReminders(now: string): Promise<Array<Reminder & { chat_id: string; tz: string }>>;

  addNote(userId: string, text: string): Promise<Note>;
  searchNotes(userId: string, query: string, limit?: number): Promise<Note[]>;

  /** Retorna true se o id ainda não havia sido processado (e o marca). */
  markProcessed(externalId: string): Promise<boolean>;
}

/* ============================ Supabase ============================ */

export class SupabaseStore implements Store {
  private db: SupabaseClient;
  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  private unwrap<T>(r: { data: T | null; error: { message: string } | null }, ctx: string): T {
    if (r.error) throw new Error(`${ctx}: ${r.error.message}`);
    return r.data as T;
  }

  async getOrCreateUser(chat_id: string, defaults: { tz: string; name?: string | null }): Promise<User> {
    const found = await this.db.from("users").select("*").eq("chat_id", chat_id).maybeSingle();
    if (found.error) throw new Error(`users.select: ${found.error.message}`);
    if (found.data) return found.data as User;
    const created = await this.db
      .from("users")
      .insert({ chat_id, tz: defaults.tz, name: defaults.name ?? null })
      .select("*")
      .single();
    return this.unwrap(created, "users.insert") as User;
  }

  async getUser(userId: string): Promise<User | null> {
    const r = await this.db.from("users").select("*").eq("id", userId).maybeSingle();
    if (r.error) throw new Error(`users.get: ${r.error.message}`);
    return (r.data as User | null) ?? null;
  }

  async updateUser(userId: string, patch: Partial<Pick<User, "name" | "tz">>): Promise<User> {
    const r = await this.db.from("users").update(patch).eq("id", userId).select("*").single();
    return this.unwrap(r, "users.update") as User;
  }

  async appendMessage(userId: string, role: Role, content: string): Promise<void> {
    const r = await this.db.from("messages").insert({ user_id: userId, role, content });
    if (r.error) throw new Error(`messages.insert: ${r.error.message}`);
  }

  async recentMessages(userId: string, limit: number): Promise<StoredMessage[]> {
    const r = await this.db
      .from("messages")
      .select("role,content,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    return (this.unwrap(r, "messages.select") as StoredMessage[]).reverse();
  }

  async addTransaction(t: Omit<Transaction, "id" | "created_at">): Promise<Transaction> {
    const r = await this.db.from("transactions").insert(t).select("*").single();
    return this.unwrap(r, "transactions.insert") as Transaction;
  }

  async listTransactions(userId: string, range: { startDate: string; endDate: string }, limit = 500): Promise<Transaction[]> {
    const r = await this.db
      .from("transactions")
      .select("*")
      .eq("user_id", userId)
      .gte("occurred_on", range.startDate)
      .lt("occurred_on", range.endDate)
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    return this.unwrap(r, "transactions.select") as Transaction[];
  }

  async deleteTransaction(userId: string, id: string): Promise<boolean> {
    const r = await this.db.from("transactions").delete().eq("user_id", userId).eq("id", id).select("id");
    return (this.unwrap(r, "transactions.delete") as unknown[]).length > 0;
  }

  async addReminder(rem: Omit<Reminder, "id" | "created_at" | "status">): Promise<Reminder> {
    const r = await this.db.from("reminders").insert({ ...rem, status: "pendente" }).select("*").single();
    return this.unwrap(r, "reminders.insert") as Reminder;
  }

  async listReminders(userId: string, opts: { status?: ReminderStatus; from?: string; to?: string; limit?: number }): Promise<Reminder[]> {
    let q = this.db.from("reminders").select("*").eq("user_id", userId);
    if (opts.status) q = q.eq("status", opts.status);
    if (opts.from) q = q.gte("due_at", opts.from);
    if (opts.to) q = q.lt("due_at", opts.to);
    const r = await q.order("due_at", { ascending: true }).limit(opts.limit ?? 100);
    return this.unwrap(r, "reminders.select") as Reminder[];
  }

  async updateReminder(id: string, patch: Partial<Pick<Reminder, "status" | "due_at" | "remind_at">>): Promise<void> {
    const r = await this.db.from("reminders").update(patch).eq("id", id);
    if (r.error) throw new Error(`reminders.update: ${r.error.message}`);
  }

  async cancelReminder(userId: string, id: string): Promise<boolean> {
    const r = await this.db
      .from("reminders")
      .update({ status: "cancelado" })
      .eq("user_id", userId)
      .eq("id", id)
      .eq("status", "pendente")
      .select("id");
    return (this.unwrap(r, "reminders.cancel") as unknown[]).length > 0;
  }

  async dueReminders(now: string): Promise<Array<Reminder & { chat_id: string; tz: string }>> {
    const r = await this.db
      .from("reminders")
      .select("*, users!inner(chat_id, tz)")
      .eq("status", "pendente")
      .lte("remind_at", now)
      .limit(200);
    const rows = this.unwrap(r, "reminders.due") as Array<Reminder & { users: { chat_id: string; tz: string } }>;
    return rows.map(({ users, ...rem }) => ({ ...rem, chat_id: users.chat_id, tz: users.tz }));
  }

  async addNote(userId: string, text: string): Promise<Note> {
    const r = await this.db.from("notes").insert({ user_id: userId, text }).select("*").single();
    return this.unwrap(r, "notes.insert") as Note;
  }

  async searchNotes(userId: string, query: string, limit = 10): Promise<Note[]> {
    let q = this.db.from("notes").select("*").eq("user_id", userId);
    if (query.trim()) q = q.ilike("text", `%${query.trim()}%`);
    const r = await q.order("created_at", { ascending: false }).limit(limit);
    return this.unwrap(r, "notes.select") as Note[];
  }

  async markProcessed(externalId: string): Promise<boolean> {
    const r = await this.db.from("processed_messages").insert({ external_id: externalId });
    if (!r.error) return true;
    if (r.error.code === "23505") return false; // unique_violation: já processada
    throw new Error(`processed_messages.insert: ${r.error.message}`);
  }
}

/* ============================ Memória ============================ */

export class MemoryStore implements Store {
  users: User[] = [];
  messages: Array<StoredMessage & { user_id: string }> = [];
  transactions: Transaction[] = [];
  reminders: Reminder[] = [];
  notes: Note[] = [];
  processed = new Set<string>();

  private now() { return new Date().toISOString(); }

  async getOrCreateUser(chat_id: string, defaults: { tz: string; name?: string | null }): Promise<User> {
    let u = this.users.find((x) => x.chat_id === chat_id);
    if (!u) {
      u = { id: randomUUID(), chat_id, name: defaults.name ?? null, tz: defaults.tz, created_at: this.now() };
      this.users.push(u);
    }
    return u;
  }
  async getUser(userId: string): Promise<User | null> {
    return this.users.find((x) => x.id === userId) ?? null;
  }
  async updateUser(userId: string, patch: Partial<Pick<User, "name" | "tz">>): Promise<User> {
    const u = this.users.find((x) => x.id === userId);
    if (!u) throw new Error("usuário não encontrado");
    Object.assign(u, patch);
    return u;
  }
  async appendMessage(userId: string, role: Role, content: string): Promise<void> {
    this.messages.push({ user_id: userId, role, content, created_at: this.now() });
  }
  async recentMessages(userId: string, limit: number): Promise<StoredMessage[]> {
    return this.messages.filter((m) => m.user_id === userId).slice(-limit).map(({ user_id: _u, ...m }) => m);
  }
  async addTransaction(t: Omit<Transaction, "id" | "created_at">): Promise<Transaction> {
    const row: Transaction = { ...t, id: randomUUID(), created_at: this.now() };
    this.transactions.push(row);
    return row;
  }
  async listTransactions(userId: string, range: { startDate: string; endDate: string }, limit = 500): Promise<Transaction[]> {
    return this.transactions
      .filter((t) => t.user_id === userId && t.occurred_on >= range.startDate && t.occurred_on < range.endDate)
      .sort((a, b) => (b.occurred_on + b.created_at).localeCompare(a.occurred_on + a.created_at))
      .slice(0, limit);
  }
  async deleteTransaction(userId: string, id: string): Promise<boolean> {
    const i = this.transactions.findIndex((t) => t.user_id === userId && t.id === id);
    if (i < 0) return false;
    this.transactions.splice(i, 1);
    return true;
  }
  async addReminder(r: Omit<Reminder, "id" | "created_at" | "status">): Promise<Reminder> {
    const row: Reminder = { ...r, id: randomUUID(), status: "pendente", created_at: this.now() };
    this.reminders.push(row);
    return row;
  }
  async listReminders(userId: string, opts: { status?: ReminderStatus; from?: string; to?: string; limit?: number }): Promise<Reminder[]> {
    return this.reminders
      .filter((r) => r.user_id === userId)
      .filter((r) => !opts.status || r.status === opts.status)
      .filter((r) => !opts.from || r.due_at >= opts.from)
      .filter((r) => !opts.to || r.due_at < opts.to)
      .sort((a, b) => a.due_at.localeCompare(b.due_at))
      .slice(0, opts.limit ?? 100);
  }
  async updateReminder(id: string, patch: Partial<Pick<Reminder, "status" | "due_at" | "remind_at">>): Promise<void> {
    const r = this.reminders.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
  }
  async cancelReminder(userId: string, id: string): Promise<boolean> {
    const r = this.reminders.find((x) => x.user_id === userId && x.id === id && x.status === "pendente");
    if (!r) return false;
    r.status = "cancelado";
    return true;
  }
  async dueReminders(now: string): Promise<Array<Reminder & { chat_id: string; tz: string }>> {
    return this.reminders
      .filter((r) => r.status === "pendente" && r.remind_at <= now)
      .map((r) => {
        const u = this.users.find((x) => x.id === r.user_id)!;
        return { ...r, chat_id: u.chat_id, tz: u.tz };
      });
  }
  async addNote(userId: string, text: string): Promise<Note> {
    const n: Note = { id: randomUUID(), user_id: userId, text, created_at: this.now() };
    this.notes.push(n);
    return n;
  }
  async searchNotes(userId: string, query: string, limit = 10): Promise<Note[]> {
    const q = query.trim().toLowerCase();
    return this.notes
      .filter((n) => n.user_id === userId && (!q || n.text.toLowerCase().includes(q)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }
  async markProcessed(id: string): Promise<boolean> {
    if (this.processed.has(id)) return false;
    this.processed.add(id);
    return true;
  }
}
