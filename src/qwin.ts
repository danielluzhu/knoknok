/**
 * Qwin: the second voice on a tenant's request.
 *
 * The maintenance assistant establishes the category and the four basics —
 * what, where, when, and what has been tried. Once those are covered the
 * conversation is handed to Qwin, an external service, which works through the
 * fix with the tenant from there. This module is the whole of that connection:
 * one HTTP call per turn, with the request written out in full each time, so
 * Qwin needs to hold nothing between turns unless it wants to.
 *
 * Configured by two environment variables. With either missing, `usingQwin` is
 * false and the assistant carries the conversation itself, exactly as before.
 *
 *   QWIN_API_URL   the endpoint one turn is POSTed to
 *   QWIN_API_KEY   sent as `Authorization: Bearer <key>`
 *
 * The request and reply shapes below are this app's side of the contract. If
 * Qwin's own API differs, `toWire` and `fromWire` are the two places to change.
 */
import type { Message, Priority } from "./db";
import { findIssue, whenText, whereText, type Intake } from "./intake";

export const usingQwin = Boolean(process.env.QWIN_API_URL && process.env.QWIN_API_KEY);

/** How long one turn may take before the assistant answers instead. */
const TIMEOUT_MS = Number(process.env.QWIN_TIMEOUT_MS ?? 25_000);

/** Everything Qwin is told about the request, beyond the messages themselves. */
export interface QwinContext {
  ticketId: number;
  title: string;
  category: string;
  priority: Priority;
  intake: Intake | null;
  property: { name: string } | null;
  tenant: { name: string; unit: string | null } | null;
  /** Qwin's own conversation id from an earlier turn, if it gave one. */
  session: string | null;
}

export interface QwinTurn {
  /** What Qwin says to the tenant. */
  reply: string;
  /** Same three outcomes as the assistant; `ask` when Qwin does not say. */
  action: "ask" | "resolved" | "escalate";
  /** Only when Qwin overrides what the intake already decided. */
  priority: Priority | null;
  /** The landlord's one-liner, when Qwin writes one. */
  summary: string | null;
  /** Whatever Qwin wants sent back next turn. */
  session: string | null;
}

const PRIORITIES = new Set<Priority>(["low", "normal", "high", "urgent"]);

/** The body of one turn, as it goes over the wire. */
function toWire(ctx: QwinContext, history: Message[]) {
  const issue = ctx.intake ? findIssue(ctx.intake.issue) : null;
  return {
    session: ctx.session,
    request: {
      id: ctx.ticketId,
      title: ctx.title,
      category: ctx.category,
      priority: ctx.priority,
      issue: issue ? { id: issue.id, name: issue.name } : null,
      basics: ctx.intake
        ? {
            what: ctx.intake.what,
            where: whereText(ctx.intake),
            when: whenText(ctx.intake) || null,
            other: ctx.intake.notes || null,
          }
        : null,
      property: ctx.property,
      tenant: ctx.tenant,
    },
    // The thread so far, minus status lines. The assistant's own turns are
    // labelled as such so Qwin can tell who asked what.
    messages: history
      .filter((m) => m.author === "tenant" || m.author === "bot" || m.author === "qwin")
      .map((m) => ({
        role: m.author === "tenant" ? "tenant" : m.author === "qwin" ? "qwin" : "assistant",
        content: m.body,
      })),
  };
}

/** Read a reply back, tolerating a missing action or priority. */
function fromWire(raw: unknown): QwinTurn {
  const r = (raw ?? {}) as Record<string, unknown>;
  const reply = typeof r.reply === "string" ? r.reply.trim()
    : typeof r.message === "string" ? r.message.trim()
    : "";
  if (!reply) throw new Error("Qwin answered without a reply");
  const action = r.action === "resolved" || r.action === "escalate" ? r.action : "ask";
  const priority = PRIORITIES.has(r.priority as Priority) ? (r.priority as Priority) : null;
  return {
    reply,
    action,
    priority,
    summary: typeof r.summary === "string" && r.summary.trim() ? r.summary.trim() : null,
    session: typeof r.session === "string" && r.session ? r.session : null,
  };
}

/**
 * One turn with Qwin. Throws on any failure — network, a non-2xx status, or a
 * reply that cannot be read — and the caller falls back to the assistant, so a
 * request is never left hanging because Qwin was unreachable.
 */
export async function askQwin(ctx: QwinContext, history: Message[]): Promise<QwinTurn> {
  const url = process.env.QWIN_API_URL;
  const key = process.env.QWIN_API_KEY;
  if (!url || !key) throw new Error("Qwin is not configured");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(toWire(ctx, history)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Qwin answered ${res.status}: ${text.slice(0, 200)}`);
  }
  return fromWire(await res.json());
}
