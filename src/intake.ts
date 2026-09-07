/**
 * Button-led intake, which runs before the assistant sees anything.
 *
 * A tenant who has just reported a problem is asked two questions with buttons
 * rather than a text box: what kind of thing is broken, and which of a few
 * shapes it takes. It costs two taps and it buys three things — the category is
 * right rather than inferred from wording, an emergency is caught before anyone
 * spends a paragraph troubleshooting it, and the assistant starts its first
 * reply already knowing what it is looking at.
 *
 * Free text still works at any point. Typing instead of tapping skips the rest
 * of the intake and hands the whole thing to the assistant, because a tenant who
 * is describing the problem is already past the point these buttons help with.
 */
import type { Category } from "./bot";
import type { Priority } from "./db";
import { inHeatingSeason } from "./sla";

export type IntakeStage = "category" | "severity" | "done";

export interface Choice {
  /** Sent back by the client. Prefixed so a stale button cannot answer the wrong question. */
  value: string;
  /** What the button says, and what goes into the thread as the tenant's answer. */
  label: string;
}

/** A stored prompt: which question it asks, and the buttons offered for it. */
export interface ChoicePrompt {
  stage: Exclude<IntakeStage, "done">;
  options: Choice[];
}

interface CategoryOption {
  key: string;
  emoji: string;
  label: string;
  category: Category;
}

/**
 * The first question. Nine buttons is the most that stays scannable on a phone,
 * and the last of them is the escape hatch for everything not listed.
 */
const CATEGORY_OPTIONS: CategoryOption[] = [
  { key: "plumbing", emoji: "💦", label: "Plumbing", category: "plumbing" },
  { key: "electrical", emoji: "⚡", label: "Electrical", category: "electrical" },
  { key: "hvac", emoji: "🔥", label: "Heating / AC", category: "hvac" },
  { key: "locks", emoji: "🔑", label: "Locks / lockout", category: "locks_security" },
  { key: "appliance", emoji: "🧊", label: "Appliance", category: "appliance" },
  { key: "pest", emoji: "🐜", label: "Pests", category: "pest" },
  { key: "structural", emoji: "🧱", label: "Walls / ceiling / floor", category: "structural" },
  { key: "common", emoji: "🚪", label: "Shared areas", category: "common_area" },
  { key: "other", emoji: "❓", label: "Something else", category: "other" },
];

interface SeverityOption {
  key: string;
  emoji: string;
  label: string;
  /**
   * What happens when it is tapped.
   *
   * `emergency` is the narrow, statutory sense: water, electricity, or winter
   * heat off, or a repair issue that is life-threatening. Only those get the
   * emergency service number, because that is what the number is for and a line
   * that rings for a dripping tap stops being trusted for the rest.
   *
   * `escalate` is everything else that should not be troubleshooted over chat —
   * a burst pipe, a door that will not lock. It goes straight to the landlord,
   * urgently, without the call-out line.
   *
   * `standard` hands over to the assistant.
   */
  severity: "emergency" | "escalate" | "standard";
  /** Where the ticket starts. The assistant may still move it. */
  priority: Priority;
  /**
   * Set on the one option whose emergency status depends on the season: heat
   * being off is statutory between October and April and an ordinary urgent
   * repair the rest of the year.
   */
  winterOnly?: boolean;
}

/**
 * The second question, per category. Each list leads with whatever must not be
 * troubleshooted and ends with a way out for anything that does not fit.
 *
 * The options are worded as what the tenant would see or smell, not as severity
 * labels — nobody standing in front of a burst pipe classifies it as "priority:
 * urgent", but they do recognise "water I cannot stop".
 */
const SEVERITY_OPTIONS: Record<string, SeverityOption[]> = {
  plumbing: [
    { key: "nowater", emoji: "🚨", label: "No running water at all", severity: "emergency", priority: "urgent" },
    { key: "burst", emoji: "🚨", label: "Burst pipe or flooding I cannot stop", severity: "escalate", priority: "urgent" },
    { key: "sewage", emoji: "🚨", label: "Toilet overflowing or sewage backing up", severity: "escalate", priority: "urgent" },
    { key: "drip", emoji: "💧", label: "Dripping tap or slow drain", severity: "standard", priority: "normal" },
    { key: "toilet", emoji: "🚽", label: "Toilet running or not flushing properly", severity: "standard", priority: "normal" },
    { key: "hotwater", emoji: "🚿", label: "No hot water", severity: "standard", priority: "high" },
    { key: "other", emoji: "❓", label: "Something else with water", severity: "standard", priority: "normal" },
  ],
  electrical: [
    { key: "nopower", emoji: "🚨", label: "No electricity at all", severity: "emergency", priority: "urgent" },
    { key: "sparks", emoji: "🚨", label: "Sparks, burning smell, or smoke", severity: "emergency", priority: "urgent" },
    { key: "partial", emoji: "🔌", label: "Power out in part of the flat", severity: "escalate", priority: "high" },
    { key: "breaker", emoji: "🔁", label: "A breaker keeps tripping", severity: "standard", priority: "high" },
    { key: "fitting", emoji: "💡", label: "One light, socket, or switch not working", severity: "standard", priority: "normal" },
    { key: "other", emoji: "❓", label: "Something else electrical", severity: "standard", priority: "normal" },
  ],
  hvac: [
    { key: "gas", emoji: "🚨", label: "I can smell gas", severity: "emergency", priority: "urgent" },
    // Statutory in the heating season, an ordinary urgent repair outside it.
    { key: "noheat", emoji: "🚨", label: "No heat at all", severity: "emergency", priority: "urgent", winterOnly: true },
    { key: "weak", emoji: "🌡️", label: "Heating works but is weak or uneven", severity: "standard", priority: "normal" },
    { key: "cooling", emoji: "❄️", label: "Air conditioning not cooling", severity: "standard", priority: "normal" },
    { key: "noise", emoji: "🔊", label: "Noisy, leaking, or smells odd when running", severity: "standard", priority: "normal" },
    { key: "other", emoji: "❓", label: "Something else with heating or AC", severity: "standard", priority: "normal" },
  ],
  locks: [
    { key: "lockedout", emoji: "🚨", label: "I am locked out right now", severity: "escalate", priority: "urgent" },
    { key: "wontlock", emoji: "🚨", label: "The door or window will not lock", severity: "escalate", priority: "urgent" },
    { key: "sticking", emoji: "🔑", label: "Key or lock sticking but still works", severity: "standard", priority: "normal" },
    { key: "buzzer", emoji: "🔔", label: "Buzzer, intercom, or fob not working", severity: "standard", priority: "normal" },
    { key: "other", emoji: "❓", label: "Something else with a door or lock", severity: "standard", priority: "normal" },
  ],
  appliance: [
    { key: "burning", emoji: "🚨", label: "It is smoking, sparking, or smells of burning", severity: "emergency", priority: "urgent" },
    { key: "fridge", emoji: "🧊", label: "Fridge or freezer not getting cold", severity: "standard", priority: "high" },
    { key: "leaking", emoji: "💧", label: "An appliance is leaking water", severity: "standard", priority: "high" },
    { key: "dead", emoji: "🧺", label: "Washer, dryer, dishwasher, or oven not working", severity: "standard", priority: "normal" },
    { key: "other", emoji: "❓", label: "Something else with an appliance", severity: "standard", priority: "normal" },
  ],
  pest: [
    { key: "swarm", emoji: "🚨", label: "A nest indoors, a swarm, or someone being bitten", severity: "escalate", priority: "urgent" },
    { key: "rodent", emoji: "🐭", label: "Droppings, or scratching in the walls", severity: "standard", priority: "high" },
    { key: "insects", emoji: "🐜", label: "Insects turning up regularly", severity: "standard", priority: "normal" },
    { key: "other", emoji: "❓", label: "Something else pest related", severity: "standard", priority: "normal" },
  ],
  structural: [
    { key: "collapse", emoji: "🚨", label: "Something has collapsed, or a ceiling is sagging", severity: "emergency", priority: "urgent" },
    { key: "water", emoji: "🚨", label: "Water coming through a ceiling or wall", severity: "escalate", priority: "urgent" },
    { key: "damp", emoji: "🧱", label: "Damp, mould, or peeling", severity: "standard", priority: "high" },
    { key: "cracks", emoji: "🪟", label: "Cracks, or a door or window out of true", severity: "standard", priority: "normal" },
    { key: "other", emoji: "❓", label: "Something else structural", severity: "standard", priority: "normal" },
  ],
  common: [
    { key: "exit", emoji: "🚨", label: "Fire exit blocked, or a broken stair or handrail", severity: "emergency", priority: "urgent" },
    { key: "entry", emoji: "🚨", label: "The main entrance door will not lock", severity: "escalate", priority: "urgent" },
    { key: "lighting", emoji: "💡", label: "Lighting out in a hall, stairwell, or car park", severity: "standard", priority: "high" },
    { key: "mess", emoji: "🧹", label: "Bins, mess, or cleaning", severity: "standard", priority: "normal" },
    { key: "other", emoji: "❓", label: "Something else in a shared area", severity: "standard", priority: "normal" },
  ],
  other: [
    { key: "lifethreat", emoji: "🚨", label: "It is life-threatening right now", severity: "emergency", priority: "urgent" },
    { key: "unlivable", emoji: "🚨", label: "The flat is unlivable but nobody is in danger", severity: "escalate", priority: "urgent" },
    { key: "broken", emoji: "🔧", label: "Something is broken but I can manage for now", severity: "standard", priority: "normal" },
    { key: "small", emoji: "🧰", label: "A small job or an improvement", severity: "standard", priority: "low" },
    { key: "unsure", emoji: "❓", label: "I am not sure what this counts as", severity: "standard", priority: "normal" },
  ],
};

/**
 * The emergency service line, given out only for a statutory emergency.
 *
 * One string, used verbatim, because this is operating text rather than
 * something for the assistant to paraphrase — a number that comes back slightly
 * different each time is a number nobody trusts.
 */
export const EMERGENCY_CONTACT = "Call Dan at (510) 396-1242 for emergency service.";

/**
 * What to do in the first minute, per category.
 *
 * A reply that only says "someone is coming" wastes the one moment where the
 * tenant can still limit the damage, so each of these names the specific thing
 * to shut off or get away from.
 */
const EMERGENCY_ADVICE: Record<string, string> = {
  plumbing:
    "If you can reach it safely, turn off the stopcock — usually under the kitchen sink or near the "
    + "front door — and put a bucket and towels under the worst of it.",
  electrical:
    "Do not touch the socket or the panel. If you can reach the consumer unit safely, switch off the "
    + "main breaker. If there is smoke or a burning smell, leave and call emergency services.",
  hvac:
    "If you can smell gas: do not touch any switch, open the windows, leave, and call the gas "
    + "emergency line from outside. Otherwise keep one room warm and shut the doors to it.",
  locks:
    "Stay somewhere safe rather than waiting in a doorway. If the flat cannot be locked at all, do "
    + "not leave it unattended with your belongings inside.",
  appliance:
    "Switch it off at the wall and unplug it if you can do that without reaching past the damage. Do "
    + "not use it again. If there is smoke or flame, leave and call emergency services.",
  pest: "Keep the room shut and stay out of it. Do not try to remove a nest yourself.",
  structural:
    "Get out from underneath it and keep everyone out of that room. Do not try to prop anything up.",
  common:
    "Do not move anything blocking a fire exit yourself if it is heavy or unstable — report where it "
    + "is and keep clear of it.",
  other:
    "If anyone is in danger, leave and call emergency services. That comes before anything in this app.",
};

export const CATEGORY_PROMPT =
  "Before we go further — what sort of thing is this? Tap the closest one and I will narrow it down "
  + "from there.";

export function severityQuestion(key: string): string {
  const option = CATEGORY_OPTIONS.find((c) => c.key === key);
  const what = option ? option.label.toLowerCase() : "this";
  return `Right — ${what}. Which of these is closest to what is happening?`;
}

/** The buttons for question one. */
export function categoryPrompt(): ChoicePrompt {
  return {
    stage: "category",
    options: CATEGORY_OPTIONS.map((c) => ({ value: `cat:${c.key}`, label: `${c.emoji} ${c.label}` })),
  };
}

/** The buttons for question two, given the category the tenant picked. */
export function severityPrompt(key: string): ChoicePrompt {
  const options = SEVERITY_OPTIONS[key] ?? SEVERITY_OPTIONS.other!;
  return {
    stage: "severity",
    options: options.map((s) => ({ value: `sev:${key}:${s.key}`, label: `${s.emoji} ${s.label}` })),
  };
}

export interface CategoryPick {
  key: string;
  label: string;
  category: Category;
}

/** Resolve a `cat:*` value, or null if it is not one we offered. */
export function readCategory(value: string): CategoryPick | null {
  const match = /^cat:([a-z_]+)$/.exec(value);
  const option = match && CATEGORY_OPTIONS.find((c) => c.key === match[1]);
  if (!option) return null;
  return { key: option.key, label: `${option.emoji} ${option.label}`, category: option.category };
}

export interface SeverityPick {
  label: string;
  /** Resolved for today — `winterOnly` has already been applied. */
  severity: "emergency" | "escalate" | "standard";
  priority: Priority;
  /** What to do in the first minute. Set for anything that skips troubleshooting. */
  advice: string;
}

/** Resolve a `sev:*` value, or null if it is not one we offered for that category. */
export function readSeverity(value: string, at: Date = new Date()): SeverityPick | null {
  const match = /^sev:([a-z_]+):([a-z_]+)$/.exec(value);
  if (!match) return null;
  const [, categoryKey, severityKey] = match;
  const option = SEVERITY_OPTIONS[categoryKey!]?.find((s) => s.key === severityKey);
  if (!option) return null;
  // Heat off is a statutory emergency only during the heating season. Outside
  // it, it is still not something to troubleshoot over chat — it just does not
  // get the emergency line.
  const severity = option.winterOnly && !inHeatingSeason(at) ? "escalate" : option.severity;
  return {
    label: `${option.emoji} ${option.label}`,
    severity,
    priority: option.priority,
    advice: EMERGENCY_ADVICE[categoryKey!] ?? EMERGENCY_ADVICE.other!,
  };
}

/**
 * The bot's reply when the tenant has picked a statutory emergency.
 *
 * The call-out line goes first and verbatim. Everything else on the thread can
 * wait; a phone number that is three paragraphs down on a phone screen has not
 * been given to anyone.
 */
export function emergencyReply(pick: SeverityPick): string {
  return [
    `This counts as an emergency repair. ${EMERGENCY_CONTACT}`,
    "Do that now rather than waiting on this thread — I have logged it as urgent either way, and it "
    + "is at the top of your landlord's list.",
    pick.advice,
    "Tell me what is happening while you wait and I will put it straight on the thread.",
  ].join("\n\n");
}

/**
 * The bot's reply to something urgent that is not a statutory emergency.
 *
 * No troubleshooting and no phone number: it goes to the landlord as it is. The
 * distinction matters — the emergency line is for the four things the law names,
 * and giving it out for a stuck lock is how it stops being answered promptly for
 * the ones it is meant for.
 */
export function escalateReply(pick: SeverityPick): string {
  return [
    "That is not something to troubleshoot over chat, so I have not tried. It is marked urgent and "
    + "is at the top of your landlord's list now.",
    pick.advice,
    "Tell me what is happening while you wait and I will put it straight on the thread.",
  ].join("\n\n");
}
