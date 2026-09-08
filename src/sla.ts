/**
 * How quickly a request is meant to be dealt with.
 *
 * Three targets, applied to every maintenance request:
 *
 *   within 24 hours   water, electricity or winter heat off, or anything
 *                     life-threatening
 *   within 72 hours   a broken refrigerator, oven or stove, or major plumbing
 *                     such as a sink or bathtub
 *   within 10 days    everything else
 *
 * The clock starts when the tenant reports the problem, not when it reaches the
 * landlord — waiting on triage is still waiting.
 *
 * Classification reads the request's text as well as the category and priority
 * the bot assigned, because the categories are broader than the targets: a
 * blocked sink and a burst main are both `plumbing`, and only one of them is a
 * 24-hour problem.
 */

export type SlaTier = "emergency" | "major" | "standard";

export const SLA_HOURS: Record<SlaTier, number> = {
  emergency: 24,
  major: 72,
  standard: 24 * 10,
};

export const SLA_LABEL: Record<SlaTier, string> = {
  emergency: "within 24 hours",
  major: "within 72 hours",
  standard: "within 10 days",
};

/**
 * Fold the ways people actually write these things into one shape, so the
 * patterns below do not each have to spell out every variant: contractions,
 * British and American spellings, and "isn't working" vs "is not working".
 */
function normalize(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\b(\w+)n't\b/g, (_m, verb) => (verb === "ca" ? "cannot" : `${verb} not`))
    .replace(/\bwon not\b/g, "will not")
    .replace(/\bfridge\b/g, "refrigerator")
    .replace(/\bmould\b/g, "mold")
    .replace(/\s+/g, " ");
}

const matches = (text: string, patterns: RegExp[]) => patterns.some((p) => p.test(text));

/**
 * Words meaning "this thing is not working at all".
 *
 * `out` refuses to match "out of": water gushing out of a ceiling is a leak, not
 * a supply that has been cut, and the difference decides whether the tenant is
 * handed the emergency number. No phrasing here loses its dead sense to the
 * exclusion — "the water is out" still matches, "pouring out of" no longer does.
 */
const DEAD = String.raw`(?:off|out(?! of)|dead|gone|shut off|cut off|not working|stopped|`
  + String.raw`will not work|does not work|cannot|no longer works?)`;

/**
 * Danger to life, in the statutory sense — the repair itself is what could hurt
 * someone. This is the narrow list, and it is the one that decides whether the
 * tenant is handed the emergency service number.
 */
const DANGER_TO_LIFE = [
  /\bgas\b[^.]{0,20}\b(leak|leaking)\b|\bsmell(?:s|ing)?\b[^.]{0,12}\bgas\b/,
  /\bcarbon monoxide\b|\bco alarm\b|\bco detector\b/,
  /\bfire\b|\bsmoke\b(?![^.]{0,10}\balarm (?:battery|chirp)) |\bburning smell\b|\bsmells? (?:of )?burning\b/,
  /\bspark(?:s|ing)\b|\bexposed wir|\blive wire\b|\belectric(?:al)? shock\b|\belectrocut/,
  /\bcollaps(?:e|ed|ing)\b|\bceiling (?:is )?(?:falling|coming down)\b/,
  /\basbestos\b|\bblack mold\b/,
];

/**
 * Serious, and answered just as fast, but not a danger to life: a home that
 * cannot be secured, or water where it should not be.
 *
 * These earn the 24-hour target and they skip troubleshooting — what they do not
 * earn is the emergency call-out number, which is reserved for the four
 * statutory conditions. A line that rings for a stuck window is a line that goes
 * unanswered for a gas leak.
 */
const URGENT_NOT_STATUTORY = [
  /\bflood(?:ed|ing)?\b|\bsewage\b|\bsewer backing\b/,
  /\bbroke(?:n)? into\b|\bbreak[- ]in\b/,
  // A door that will not lock is a security emergency, not a repair.
  /\b(?:door|window|lock)\b[^.]{0,24}\b(?:cannot|will not|does not|not)\b[^.]{0,8}\block\b/,
  /\bcannot\b[^.]{0,12}\block\b[^.]{0,16}\b(?:door|window|flat|apartment|house)\b/,
];

/** Everything that earns the fastest response target, whatever the reason. */
const LIFE_THREATENING = [...DANGER_TO_LIFE, ...URGENT_NOT_STATUTORY];

/** A utility that is off, rather than merely misbehaving. */
const NO_WATER = [
  new RegExp(String.raw`\bno (?:running |hot )?water\b`),
  new RegExp(String.raw`\b(?:hot )?water\b[^.]{0,28}\b` + DEAD + String.raw`\b`),
  /\bburst\b[^.]{0,14}\b(?:pipe|main)\b|\bwater main\b/,
];
const NO_POWER = [
  /\bno (?:power|electricity|lights anywhere)\b/,
  new RegExp(String.raw`\b(?:power|electricity)\b[^.]{0,24}\b(?:` + DEAD + String.raw`|outage)\b`),
  /\bpower outage\b|\bbreaker keeps\b|\bfuse box\b/,
];
const NO_HEAT = [
  /\bno (?:heat|heating|hot air)\b/,
  new RegExp(String.raw`\b(?:heat|heating|boiler|furnace)\b[^.]{0,24}\b` + DEAD + String.raw`\b`),
  /\bradiators? (?:are |is )?cold\b|\bfreezing (?:cold )?in\b/,
];

/** The named 72-hour things: cooking and cold storage, and major plumbing. */
const APPLIANCE = [/\brefrigerator\b|\bfreezer\b|\boven\b|\bstove\b|\bcooktop\b|\bhob\b|\bcooker\b|\brange\b/];
// "like the sink or bathtub" — the fixtures you cannot do without, as opposed to
// a dripping tap or a slow drain.
const MAJOR_PLUMBING = [
  /\bsink\b|\bbath ?tub\b|\btub\b|\bshower\b|\btoilet\b|\bwc\b|\blavatory\b/,
  /\bdrain\b[^.]{0,20}\b(?:blocked|clogged|backing up|backed up|will not drain)\b/,
  /\b(?:blocked|clogged)\b[^.]{0,12}\bdrain\b/,
];

/**
 * Months counted as winter, when heat being off is an emergency rather than a
 * comfort problem. October to April inclusive — the same shape as the statutory
 * heating seasons this rule is modelled on, and deliberately generous at both
 * ends, since being cold in a shoulder month is not less urgent than being cold
 * in January.
 */
const HEATING_SEASON = new Set([10, 11, 12, 1, 2, 3, 4]);

/** Whether heat being off counts as an emergency on a given date. */
export function inHeatingSeason(at: Date = new Date()): boolean {
  return HEATING_SEASON.has(at.getUTCMonth() + 1);
}

/**
 * Whether this is an emergency in the strict, statutory sense: water,
 * electricity, or heating-season heat off, or something life-threatening.
 *
 * Kept separate from `slaTier` because the two answer different questions. The
 * tier is a promise about response time, and a landlord marking something urgent
 * moves it. This decides whether the tenant is handed the emergency service
 * number, and nothing but the four conditions below should do that — a line that
 * rings for a stuck window is a line that goes unanswered for a gas leak.
 */
export function isStatutoryEmergency(input: {
  category?: string | null;
  text?: string | null;
  at?: Date;
}): boolean {
  const text = normalize(input.text ?? "");
  const category = String(input.category ?? "other").toLowerCase();
  if (matches(text, DANGER_TO_LIFE)) return true;
  if (matches(text, NO_WATER) || matches(text, NO_POWER)) return true;
  // Heat only counts during the heating season.
  return inHeatingSeason(input.at ?? new Date())
    && (matches(text, NO_HEAT) || (category === "hvac" && /\bcold\b|\bfreezing\b/.test(text)));
}

/**
 * Which target applies. `at` is when the request was raised, which decides
 * whether heat counts as a winter problem.
 */
export function slaTier(input: {
  category?: string | null;
  priority?: string | null;
  text?: string | null;
  at?: Date;
}): SlaTier {
  const text = normalize(input.text ?? "");
  const category = String(input.category ?? "other").toLowerCase();

  // The bot and the landlord both get a say: something marked urgent is treated
  // as urgent even when none of the patterns below match. This is a response
  // time, not a legal finding — which is why the emergency call-out line is
  // gated on isStatutoryEmergency below rather than on this tier.
  if (input.priority === "urgent") return "emergency";
  // The wider list here: a home that cannot be secured gets the same response
  // time as a gas leak, even though only one of them gets the call-out number.
  if (matches(text, LIFE_THREATENING)) return "emergency";
  if (isStatutoryEmergency(input)) return "emergency";
  if (matches(text, APPLIANCE) || category === "appliance") return "major";
  if (matches(text, MAJOR_PLUMBING)) return "major";
  return "standard";
}

/**
 * The policy as something to show people, served to the app so the page every
 * tenant, landlord and vendor reads is generated from the same constants the
 * scheduling uses. A page maintained separately would eventually describe rules
 * the code no longer follows.
 */
export const SLA_POLICY = [
  {
    tier: "emergency" as SlaTier,
    label: SLA_LABEL.emergency,
    hours: SLA_HOURS.emergency,
    summary: "Anything that makes the home unsafe or unlivable right now.",
    examples: [
      "No water, or the water has been shut off",
      "No electricity",
      "No heat during the winter months (October to April)",
      "Anything life-threatening — a gas leak, fire or smoke, carbon monoxide, "
        + "sparking or exposed wiring, flooding or sewage, or a door that will not lock",
    ],
  },
  {
    tier: "major" as SlaTier,
    label: SLA_LABEL.major,
    hours: SLA_HOURS.major,
    summary: "The fixtures and appliances a home does not really work without.",
    examples: [
      "A broken refrigerator or freezer",
      "A broken oven, stove or cooktop",
      "Major plumbing — a sink, bathtub, shower or toilet that is unusable, "
        + "or a drain that is backing up",
    ],
  },
  {
    tier: "standard" as SlaTier,
    label: SLA_LABEL.standard,
    hours: SLA_HOURS.standard,
    summary: "Everything else.",
    examples: [
      "Repairs that are a nuisance rather than an emergency",
      "Wear and tear, fittings, decoration and general upkeep",
    ],
  },
];

/** SQLite-shaped UTC timestamp, matching datetime('now'). */
function stamp(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** When a request raised at `createdAt` is due, given its tier. */
export function dueAt(createdAt: string | Date, tier: SlaTier): string {
  const start = createdAt instanceof Date
    ? createdAt
    // SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
    : new Date(String(createdAt).replace(" ", "T") + "Z");
  const at = Number.isNaN(start.getTime()) ? new Date() : start;
  return stamp(new Date(at.getTime() + SLA_HOURS[tier] * 3600_000));
}
