/**
 * What happens to a request once triage has decided it needs a person.
 *
 * Up to this point the app has been working out *what is wrong*: the tenant
 * picks an issue, the assistant narrows it down, and anything it cannot talk
 * the tenant through becomes an open request. This module handles the other
 * half — *who goes, how far they may go, and who pays* — which is the part a
 * managing agent does between the tenant hanging up and a van arriving.
 *
 * Five decisions, made in this order, because each one constrains the next:
 *
 *   1. TRADE          which contractor this actually needs. Not the same as the
 *                     category: a tenant files a leaking dishwasher under
 *                     plumbing, and it is an appliance engineer who fixes it.
 *   2. NOT-TO-EXCEED  the spend cap the vendor works under. Without one, every
 *                     job is a phone call before anyone picks up a tool.
 *   3. APPROVAL       whether the landlord has to say yes before work starts.
 *                     Cheap work goes ahead; expensive work waits. Emergencies
 *                     never wait — see `approvalFor`.
 *   4. ACCESS         whether the vendor can let themselves in, and what they
 *                     will find when they do.
 *   5. BILLING        who the invoice belongs to. This one only ever asks a
 *                     question; it never answers it — see `billingSuggestion`.
 *
 * `plan()` at the bottom runs all five and hands back the whole work order.
 */
import type { Priority } from "./db";
import type { SlaTier } from "./sla";

/* ------------------------------------------------------------------ trade */

/**
 * Who you actually call.
 *
 * Deliberately not the same list as the tenant-facing categories in `bot.ts`.
 * Categories are how a problem looks from inside the home — "plumbing",
 * "electrical". Trades are how it looks from a phone book, and the two come
 * apart often enough to be worth keeping separate: a dead washing machine is
 * electrical to the tenant, plumbing to the optimist, and an appliance engineer
 * in practice.
 */
export const TRADES = [
  "plumber",
  "electrician",
  "hvac",
  "appliance",
  "locksmith",
  "pest",
  "roofer",
  "landscaper",
  "cleaner",
  "handyman",
  "general",
] as const;

export type Trade = (typeof TRADES)[number];

export const TRADE_LABEL: Record<Trade, string> = {
  plumber: "Plumber",
  electrician: "Electrician",
  hvac: "Heating and cooling",
  appliance: "Appliance engineer",
  locksmith: "Locksmith",
  pest: "Pest control",
  roofer: "Roofer",
  landscaper: "Grounds",
  cleaner: "Cleaner",
  handyman: "Handyman",
  general: "General contractor",
};

/** The trade each category falls to when nothing more specific applies. */
const TRADE_BY_CATEGORY: Record<string, Trade> = {
  plumbing: "plumber",
  sewer: "plumber",
  electrical: "electrician",
  hvac: "hvac",
  appliance: "appliance",
  pest: "pest",
  locks_security: "locksmith",
  roofing: "roofer",
  landscaping: "landscaper",
  cleaning: "cleaner",
  structural: "general",
  common_area: "handyman",
  other: "handyman",
};

/**
 * Wording that overrules the category, checked in order.
 *
 * Each of these is a case where the category is honestly filed and still sends
 * the wrong van. An appliance that happens to be plumbed in is the common one;
 * so is anything above the ceiling, which is a roofer however it presents
 * inside. First match wins, so the specific ones come first.
 */
const TRADE_OVERRIDES: [RegExp, Trade][] = [
  // Named appliances, whatever they are plumbed or wired into.
  [/\b(?:dishwasher|washing machine|washer|dryer|refrigerator|fridge|freezer|oven|stove|cooktop|hob|cooker|range|microwave|garbage disposal|waste disposal)\b/, "appliance"],
  // A water heater is plumbing; a boiler or furnace is heating. Tenants use all
  // three words for whichever box is in their cupboard, so both lines are here.
  [/\bwater heater\b|\bimmersion\b|\bhot water (?:tank|cylinder)\b/, "plumber"],
  [/\bboiler\b|\bfurnace\b|\bradiator\b|\bthermostat\b|\bair ?con\b|\bac unit\b|\bheat pump\b/, "hvac"],
  // Gas is its own competence and the one thing here nobody improvises on.
  [/\bgas\b[^.]{0,20}\b(?:leak|leaking|smell)\b|\bsmell(?:s|ing)?\b[^.]{0,12}\bgas\b/, "hvac"],
  [/\bsewage\b|\bsewer\b|\bseptic\b|\bmain line\b|\bsoil (?:pipe|stack)\b/, "plumber"],
  [/\broof\b|\bgutter\b|\bdownpipe\b|\bdownspout\b|\bchimney\b|\bflashing\b/, "roofer"],
  [/\block\b|\bkeys?\b|\bdeadbolt\b|\blatch\b|\bbuzzer\b|\bintercom\b/, "locksmith"],
  // The things that need a survey before they need a tradesman.
  [/\basbestos\b|\bsubsidence\b|\bfoundation\b|\bstructural\b|\bcollaps(?:e|ed|ing)\b|\bblack mold\b/, "general"],
  // Making good and decorating: a trade in its own right, and cheaper than any
  // of the above. Worth catching, because a scuffed wall files itself under
  // "structural" and would otherwise go out as a general contractor at $750.
  [/\bdrywall\b|\bplaster\b|\bskirting\b|\bhinge\b|\bhandle\b|\bshelf\b|\bcabinet door\b|\bblind\b|\bcurtain rail\b/, "handyman"],
  [/\bpaint(?:ing|ed)?\b|\brepaint\b|\bdecorat(?:e|ing|ion)\b|\bscuff\b|\bpatch(?:ing|ed)?\b|\btouch(?:ing)? up\b|\bfiller\b/, "handyman"],
];

/**
 * Which contractor this request needs.
 *
 * `text` is the title and summary together — whatever the request says about
 * itself. It is consulted before the category because the overrides above exist
 * precisely for the cases where the category is right and the trade is not.
 */
export function tradeFor(category: string | null | undefined, text?: string | null): Trade {
  const t = String(text ?? "").toLowerCase().replace(/\s+/g, " ");
  for (const [pattern, trade] of TRADE_OVERRIDES) {
    if (pattern.test(t)) return trade;
  }
  return TRADE_BY_CATEGORY[String(category ?? "other").toLowerCase()] ?? "handyman";
}

/* ---------------------------------------------------------- not-to-exceed */

/**
 * The spend cap a vendor works under: go up to this without asking, stop and
 * come back above it.
 *
 * The point of the cap is that most jobs never need a conversation. Set it too
 * low and the landlord fields a call about every washer; too high and a
 * two-hundred-pound visit quietly becomes a two-thousand-pound one. These
 * numbers are a first guess from the trade and how urgent it is — the landlord
 * can move any of them on the request itself, and what they set sticks.
 */
const NTE_BASE: Record<Trade, number> = {
  plumber: 35000,
  electrician: 40000,
  hvac: 45000,
  appliance: 30000,
  locksmith: 20000,
  pest: 25000,
  roofer: 60000,
  landscaper: 20000,
  cleaner: 15000,
  handyman: 20000,
  general: 75000,
};

/**
 * Urgent work costs more, and not because anyone is being opportunistic: it is
 * out of hours, it is a call-out rather than a scheduled visit, and the part
 * comes off the van instead of from a supplier. A cap that ignores that is a
 * cap every emergency breaches on arrival.
 *
 * Low priority goes the other way — it can wait for someone who is already
 * nearby, and should be priced as if it will.
 */
const NTE_FACTOR: Record<Priority, number> = { urgent: 1.5, high: 1, normal: 1, low: 0.75 };

/** Round to the nearest $25, because a cap of $337.50 reads as a calculation. */
const round25 = (cents: number) => Math.round(cents / 2500) * 2500;

export function nteFor(trade: Trade, priority: Priority): number {
  return round25(NTE_BASE[trade] * (NTE_FACTOR[priority] ?? 1));
}

/** Cents to the string people actually write. */
export const money = (cents: number | null | undefined): string =>
  cents == null ? "—" : `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;

/**
 * Read a dollar amount a person typed. Accepts "$1,200", "1200", "1200.50".
 * Returns null for anything that is not a usable amount, so the caller can tell
 * "they cleared it" from "they typed nonsense".
 */
export function parseMoney(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(String(raw).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return null;
  return Math.round(n * 100);
}

/* -------------------------------------------------------------- approval */

export type ApprovalState = "not_required" | "pending" | "approved" | "declined";

/**
 * Above this, the landlord is asked first. Per property; this is the default.
 *
 * Set against the caps above, $500 is the line between work that happens and
 * work that gets discussed: a plumber, an electrician, a locksmith or an
 * appliance engineer on an ordinary call all come in under it and simply go,
 * while a roofer, a general contractor and anything at emergency call-out rates
 * stop for a yes. A threshold that catches everything is a threshold nobody
 * reads, and an approval queue nobody reads is slower than no queue at all.
 */
export const DEFAULT_APPROVAL_THRESHOLD = 50000; // $500

/**
 * Whether work can start, or whether the landlord has to say yes first.
 *
 * The one rule worth stating plainly: emergency work is never held for
 * approval. Water, power, winter heat, flooding, a door that will not lock — a
 * home that is unsafe or unlivable right now is a duty the landlord already
 * owes, and the clock on it is the statute's, not the owner's. Holding a burst
 * main in an approval queue over a spend cap is how a repair bill becomes a
 * habitability claim, and it makes a liar of the 24-hour target the tenant was
 * given in the same breath. So the cap still travels with the job — the vendor
 * knows what they are working to, and the landlord is told what was authorised
 * in their name — but nobody waits.
 */
export function approvalFor(input: {
  nte: number;
  threshold: number;
  tier?: SlaTier | null;
}): { state: ApprovalState; why: string } {
  if (input.tier === "emergency") {
    return {
      state: "approved",
      why: `Emergency — authorised automatically up to ${money(input.nte)}. `
        + "Work on a home that is unsafe or unlivable does not wait for approval.",
    };
  }
  if (input.nte > input.threshold) {
    return {
      state: "pending",
      why: `${money(input.nte)} is over the ${money(input.threshold)} approval limit for this property.`,
    };
  }
  return {
    state: "not_required",
    why: `${money(input.nte)} is within the ${money(input.threshold)} approval limit for this property.`,
  };
}

/* ---------------------------------------------------------------- access */

export type Entry = "permitted" | "call_first" | "must_be_home";

export const ENTRY_OPTIONS: { id: Entry; label: string; eg: string }[] = [
  { id: "permitted", label: "Let them in", eg: "They can enter while I'm out" },
  { id: "call_first", label: "Call or text first", eg: "Then they can enter" },
  { id: "must_be_home", label: "Only when I'm home", eg: "Book a time with me" },
];

export const ENTRY_LABEL: Record<Entry, string> = {
  permitted: "May enter when nobody is home",
  call_first: "Call or text the tenant first",
  must_be_home: "Tenant must be home — book a time",
};

export function parseEntry(raw: unknown): Entry | null {
  const v = String(raw ?? "");
  return ENTRY_OPTIONS.some((o) => o.id === v) ? (v as Entry) : null;
}

/**
 * Whether this job can simply be attended, or has to be booked with the tenant
 * first.
 *
 * An emergency is the exception, and it is the exception in law as well as
 * here: the right of entry without notice exists for exactly the conditions
 * that make a home unsafe. A tenant who asked to be home for a dripping tap has
 * not thereby asked to be home for a gas leak.
 */
export function mustBook(entry: Entry | null, tier: SlaTier | null): boolean {
  if (tier === "emergency") return false;
  return entry === "must_be_home";
}

/* --------------------------------------------------------------- billing */

export type Billable = "landlord" | "tenant" | "undecided";

export const BILLABLE_LABEL: Record<Billable, string> = {
  landlord: "Landlord",
  tenant: "Tenant — to confirm",
  undecided: "Worth checking",
};

/**
 * Wording that suggests the damage was caused rather than suffered, with the
 * reason to show the landlord. Each one is a question worth asking, and not one
 * of them is proof.
 */
const TENANT_SIGNALS: [RegExp, string][] = [
  [/\block(?:ed)? (?:my|our)self out\b|\block(?:ed)? out\b|\blost (?:my |the )?keys?\b|\bbroke (?:my |the )?key\b|\bkey (?:snapped|broke)\b/,
   "a lost or broken key is normally the resident's to replace"],
  [/\b(?:wipes?|nappy|nappies|diaper|sanitary|kitchen roll|paper towel|grease|cooking oil|fat)\b[^.]{0,40}\b(?:flush|drain|down|toilet|sink)\b|\bflushed\b[^.]{0,30}\b(?:wipes?|nappy|diaper|sanitary|toy)\b/,
   "a blockage caused by something that went down the drain is normally chargeable"],
  [/\b(?:i|we|my (?:son|daughter|kid|child|partner|dog|cat)|our (?:kid|dog|cat)|a guest|my guest)\b[^.]{0,30}\b(?:broke|dropped|knocked|spilled|smashed|cracked|tore|ripped)\b/,
   "the request describes accidental damage rather than a failure"],
  [/\bbulb (?:is )?(?:blown|burnt out|gone|dead)\b|\bneeds? a new bulb\b|\bbatter(?:y|ies) (?:is |are )?(?:dead|flat|need)/,
   "bulbs and batteries are normally the resident's to change"],
  [/\bpicture hook\b|\bshelf i (?:put|hung)\b|\bmy (?:tv|television) (?:mount|bracket)\b|\bi (?:drilled|hung|mounted)\b/,
   "the damage follows from something the resident installed"],
];

/**
 * Who the invoice looks like it belongs to.
 *
 * This function is allowed to say "landlord" and it is allowed to say "worth
 * checking". It is never allowed to say "tenant" on its own, and that is
 * deliberate: charging a resident for a repair is a decision with a tenancy
 * agreement behind it and a deposit dispute in front of it, and a regular
 * expression that saw the word "flushed" is not the thing that should make it.
 * What it can usefully do is stop the question going unasked, which is the
 * failure mode that actually costs landlords money.
 *
 * So: repairs are the landlord's unless something in the request suggests
 * otherwise, and when something does, the landlord gets the suggestion, the
 * reason, and a button.
 */
export function billingSuggestion(input: {
  text?: string | null;
  statutory?: boolean;
}): { to: Billable; why: string } {
  // Habitability is the landlord's whatever caused it. Chasing a tenant over
  // who broke the boiler comes after the boiler is fixed, not instead.
  if (input.statutory) {
    return { to: "landlord", why: "An emergency repair is the landlord's regardless of cause." };
  }
  const text = String(input.text ?? "").toLowerCase().replace(/\s+/g, " ");
  for (const [pattern, why] of TENANT_SIGNALS) {
    if (pattern.test(text)) return { to: "undecided", why: `Possibly rechargeable — ${why}.` };
  }
  return { to: "landlord", why: "Repairs and wear are the landlord's unless something says otherwise." };
}

export function parseBillable(raw: unknown): Billable | null {
  const v = String(raw ?? "");
  return v === "landlord" || v === "tenant" || v === "undecided" ? v : null;
}

/* ------------------------------------------------------------- lifecycle */

/**
 * Where a job has got to.
 *
 * This is a finer grain than the ticket's own status, which only knows triage,
 * open and closed. An open request that nobody has been assigned to and an open
 * request whose plumber is coming Thursday are the same row to the list and
 * very different things to everyone waiting on them.
 */
export const WO_STATUSES = [
  "new",
  "awaiting_approval",
  "assigned",
  "scheduled",
  "work_done",
  "closed",
] as const;

export type WoStatus = (typeof WO_STATUSES)[number];

export const WO_LABEL: Record<WoStatus, string> = {
  new: "Needs a vendor",
  awaiting_approval: "Awaiting approval",
  assigned: "Vendor assigned",
  scheduled: "Scheduled",
  work_done: "Work done",
  closed: "Closed",
};

/**
 * Which moves are legal from each state.
 *
 * Backwards moves are in here on purpose, and they are the ones that matter:
 * a vendor hands a job back, a landlord declines the estimate, the work did not
 * hold and the thing is broken again on Friday. A lifecycle that only goes
 * forwards is one people work around.
 */
const WO_NEXT: Record<WoStatus, WoStatus[]> = {
  new: ["awaiting_approval", "assigned", "closed"],
  awaiting_approval: ["new", "assigned", "closed"],
  assigned: ["scheduled", "work_done", "new", "awaiting_approval", "closed"],
  scheduled: ["work_done", "assigned", "new", "closed"],
  work_done: ["closed", "scheduled", "assigned", "awaiting_approval"],
  closed: ["new", "assigned", "scheduled"],
};

export function canAdvance(from: WoStatus | null, to: WoStatus): boolean {
  if (!from) return true;
  if (from === to) return false;
  return WO_NEXT[from].includes(to);
}

export function parseWoStatus(raw: unknown): WoStatus | null {
  const v = String(raw ?? "");
  return (WO_STATUSES as readonly string[]).includes(v) ? (v as WoStatus) : null;
}

/* ------------------------------------------------------------------ plan */

export interface WorkOrderPlan {
  trade: Trade;
  nte: number;
  approval: ApprovalState;
  approvalWhy: string;
  billable: Billable;
  billableWhy: string;
  /** Where the job starts: waiting on the landlord, or ready for a vendor. */
  status: WoStatus;
}

/**
 * The whole decision, in one place, from what triage already worked out.
 *
 * Kept pure — no database, no clock beyond what is handed in — so the rules can
 * be read and tested as rules. Everything that touches a row lives in `app.ts`,
 * which calls this and writes down what it says.
 */
export function plan(input: {
  category?: string | null;
  priority: Priority;
  text?: string | null;
  tier?: SlaTier | null;
  statutory?: boolean;
  threshold?: number;
}): WorkOrderPlan {
  const trade = tradeFor(input.category, input.text);
  const nte = nteFor(trade, input.priority);
  const threshold = input.threshold ?? DEFAULT_APPROVAL_THRESHOLD;
  const approval = approvalFor({ nte, threshold, tier: input.tier });
  // Approval turns on the response target — anything unlivable goes now —
  // while billing turns on the narrower statutory question, which is the one
  // that settles who pays regardless of who caused it.
  const billing = billingSuggestion({ text: input.text, statutory: input.statutory });

  return {
    trade,
    nte,
    approval: approval.state,
    approvalWhy: approval.why,
    billable: billing.to,
    billableWhy: billing.why,
    status: approval.state === "pending" ? "awaiting_approval" : "new",
  };
}
