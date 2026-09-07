/**
 * Maintenance triage bot.
 *
 * Runs on Claude (Opus 5) when ANTHROPIC_API_KEY is set. Without a key it falls
 * back to a deterministic diagnostic script so the app is fully usable offline —
 * same interface, same three possible actions.
 */
import type { Message, Priority } from "./db";

export const CATEGORIES = [
  "plumbing",
  "electrical",
  "hvac",
  "appliance",
  "pest",
  "structural",
  "locks_security",
  "common_area",
  // Planned upkeep rather than something breaking. These arrive mostly from
  // recurring schedules, but a tenant can report against them too.
  "landscaping",
  "roofing",
  "cleaning",
  "sewer",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface TriageResult {
  /** What the bot says back to the tenant. */
  reply: string;
  /** ask = keep diagnosing, resolved = fixed without maintenance, escalate = needs the landlord. */
  action: "ask" | "resolved" | "escalate";
  category: Category;
  priority: Priority;
  /** One-line description for the landlord's to-do list. */
  summary: string;
  /** Which engine produced this result. */
  engine: "claude" | "rules";
}

/**
 * What the tenant already told us by tapping buttons, before the assistant was
 * involved. Passed in rather than left in the message history so the assistant's
 * "by your third reply" pacing counts real exchanges, not intake taps.
 */
export interface IntakeContext {
  category: Category;
  /** The category button they tapped, as written on it. */
  categoryLabel: string;
  /** The follow-up button they tapped, as written on it. */
  severityLabel: string;
}

/** How the intake is described to the model: as answers already given, not as a verdict. */
function intakeNote(intake: IntakeContext): string {
  return `Before this conversation started, the tenant answered two multiple-choice questions. They `
    + `chose "${intake.categoryLabel}" for the kind of problem, and "${intake.severityLabel}" for `
    + `what is happening. Take those as given and do not ask them again — start from what they `
    + `narrow it to. They are the tenant's own reading of the problem, so if what they go on to `
    + `describe does not fit, trust the description.`;
}

export const usingClaude = Boolean(process.env.ANTHROPIC_API_KEY);

const SYSTEM_PROMPT = `You are the maintenance triage assistant for a residential property
management app. A tenant has reported a problem in their home, and they are reading your reply on
a phone, probably standing in front of the thing that is broken.

Most of what gets reported has a cause the tenant can find and often fix. Your job is to help them
work out which one it is — not to collect a symptom and pass it on. Think about what could produce
exactly what they described, and what would distinguish those causes from each other. A tenant who
understands what is happening can act on it; one who is asked twenty questions gives up and waits.

WHAT A GOOD REPLY LOOKS LIKE

Open with what is most likely going on and why that fits what they told you. One or two sentences,
in plain language — "a slow drain in one basin with everything else fine is nearly always the trap
under that sink, not the main line" beats "this could be a plumbing issue".

Then give what to check, in the order that eliminates the most possibilities soonest. For each one,
say what the result would mean, so the tenant learns something whichever way it goes rather than
just following orders:

- Check the other taps in the flat. All slow means it is the main; only this one means it is local.
- Look under the sink for the U-shaped pipe. Damp or dripping means the trap, and that is a bucket
  and two hand-tight nuts away from being fixed.

Two to four of those. Number them if the order matters, and write them as things a person can do
without tools they do not own.

If part of it is genuinely not theirs to touch, say so and say why in the same breath — "the panel
itself is an electrician's job, but the breaker handles on the front are yours". Being told the
boundary is more useful than being told to stop.

Close with the single question whose answer decides what happens next. One question, at the end.

Aim for about 150 words. Go longer only when the extra words genuinely save a visit.

WHAT NOT TO DO

- Never send anyone inside an electrical panel, onto a gas line or appliance, into a water heater,
  onto a roof, or up a ladder above shoulder height. Escalate those.
- Never guess at a diagnosis you have no basis for. If what they said fits several causes and you
  cannot narrow it, say which ones and ask the question that separates them.
- No markdown headers, no bold. Plain sentences and simple dashes or numbers.
- Do not stall. By your third reply you are either resolved or escalating.

WHEN TO STOP TROUBLESHOOTING IMMEDIATELY

Escalate with priority "urgent", and troubleshoot nothing, for: a gas smell, smoke or fire, carbon
monoxide, flooding or an uncontrolled leak, sewage backing up, no heat in cold weather, no water,
sparking or a burning smell from an outlet, a door or window that no longer locks, or anyone in
danger. Say plainly what to do in the meantime — which valve, which breaker, or leave and call
emergency services.

Also escalate, without arguing, if the tenant asks for a person or says they would rather not
troubleshoot. Some people are at work, or holding a baby, or simply do not want to.

FIELDS

"action":
  "ask"      - you gave them something to check and the conversation continues.
  "resolved" - they confirmed it is fixed; no visit needed.
  "escalate" - it needs the landlord or a contractor.

"summary" is one line on the landlord's to-do list, written so they arrive with the right part:
"Kitchen sink drains slowly; plunger and trap clean-out did not clear it, other taps fine" beats
"sink problem". Include what was already ruled out.

"priority": urgent = unsafe or unlivable now, high = getting worse or badly disrupting daily life,
normal = should be fixed soon, low = cosmetic or convenience.`;

/* ------------------------------------------------------------------ Claude */

async function triageWithClaude(
  title: string,
  history: Message[],
  intake: IntakeContext | null,
): Promise<TriageResult> {
  const [{ default: Anthropic }, { z }, { zodOutputFormat }] = await Promise.all([
    import("@anthropic-ai/sdk"),
    import("zod"),
    import("@anthropic-ai/sdk/helpers/zod"),
  ]);

  const TriageSchema = z.object({
    reply: z.string(),
    action: z.enum(["ask", "resolved", "escalate"]),
    category: z.enum(CATEGORIES),
    priority: z.enum(["low", "normal", "high", "urgent"]),
    summary: z.string(),
  });

  const client = new Anthropic();

  const messages = history
    .filter((m) => m.author === "tenant" || m.author === "bot")
    .map((m) => ({
      role: (m.author === "tenant" ? "user" : "assistant") as "user" | "assistant",
      content: m.body,
    }));

  // The stored history always starts with the tenant's description, so messages
  // is non-empty and begins with a user turn.
  messages[0] = {
    role: "user",
    content: `Request title: ${title}\n\n${messages[0]!.content}`
      + (intake ? `\n\n${intakeNote(intake)}` : ""),
  };

  const response = await client.messages.parse({
    model: "claude-opus-5",
    // Room for the model to reason before answering. The reply itself is a few
    // hundred words; the headroom is for thinking.
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages,
    // Working out which of several causes fits the symptoms is the whole job
    // here, and it is what decides whether the tenant fixes it themselves or
    // waits a week for someone to come and look. Worth thinking about properly.
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: zodOutputFormat(TriageSchema),
    },
  });

  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`unusable triage response (stop_reason=${response.stop_reason})`);
  }
  return { ...response.parsed_output, engine: "claude" };
}

/* ------------------------------------------------------- Rule-based fallback */

/**
 * What the offline engine knows about one kind of problem.
 *
 * `likely` is the diagnosis — the thing that is usually actually wrong when
 * someone reports this. `checks` are what distinguishes the possibilities, each
 * paired with what its result would mean, because a tenant who learns something
 * from a check can carry on thinking; one who is just given orders cannot.
 */
interface Playbook {
  category: Category;
  /** Matched as whole words, so "ac" never fires inside "attached". */
  keywords: string[];
  /** What is usually going on, and why that fits. */
  likely: string;
  /** Each: what to do, and what the outcome tells them. */
  checks: { do: string; means?: string }[];
  /** The line between what is theirs and what is not, when there is one. */
  boundary?: string;
  /** The one question whose answer decides what happens next. */
  question: string;
  priority: Priority;
}

const PLAYBOOKS: Playbook[] = [
  {
    category: "plumbing",
    keywords: ["disposal", "garbage disposal", "insinkerator"],
    likely: "A disposal that has stopped almost always tripped its own overload — there is a reset "
      + "button on the unit itself, separate from the wall switch and the breaker.",
    checks: [
      { do: "Switch it off at the wall, reach under the sink, and press the small red button on "
          + "the underside of the disposal until it clicks. Switch back on.",
        means: "If it runs, that was it — the overload trips when something jams it briefly." },
      { do: "If it hums but does not turn, switch it off and turn the blades by hand from below "
          + "with the hex key that came with it (a 1/4\" allen key fits).",
        means: "Humming means the motor has power and something is physically stuck." },
    ],
    boundary: "Never put your hand down the drain, even with the switch off.",
    question: "Does it hum when you flip the switch, or is it completely silent?",
    priority: "normal",
  },
  {
    category: "plumbing",
    keywords: ["drain", "clog", "clogged", "slow drain", "backed up", "standing water", "won't drain"],
    likely: "One slow basin with everything else draining fine is nearly always the trap directly "
      + "under that sink, not the main line. If several fixtures are slow at once, it is the line "
      + "they share, and that is not a tenant job.",
    checks: [
      { do: "Run the other taps and the bath.",
        means: "All slow means the shared line — stop there and I will pass it on. Only this one "
          + "means the blockage is within arm's reach." },
      { do: "Plunge it properly: an inch of standing water so the cup seals, a wet rag held over "
          + "the overflow hole, then 15-20 hard strokes.",
        means: "Most hair and grease clogs give way here. No change after a proper attempt "
          + "usually means it is further down than a plunger reaches." },
      { do: "Put a bucket under the U-bend and undo the two slip nuts by hand.",
        means: "They are meant to be hand-tight. What comes out is usually the answer." },
    ],
    boundary: "Skip the trap if the pipes are corroded or the nuts will not move by hand — "
      + "old fittings shear, and then it is a bigger job than the clog.",
    question: "Are the other taps in the flat draining normally?",
    priority: "normal",
  },
  {
    category: "plumbing",
    keywords: ["toilet", "running toilet", "flush"],
    likely: "A toilet that runs constantly is nearly always the flapper — the rubber seal at the "
      + "bottom of the tank — not sitting flat, so water leaks past it and the tank keeps refilling.",
    checks: [
      { do: "Lift the tank lid and look at the flapper. It should sit flat over the hole, with a "
          + "little slack in its chain rather than being pulled taut.",
        means: "A taut chain holds the flapper open a fraction. Shortening the slack fixes it." },
      { do: "Press the flapper down with a finger and see if the running stops.",
        means: "If it stops, the flapper is the problem and it is a cheap part." },
    ],
    question: "Is it running constantly, or failing to flush properly?",
    priority: "high",
  },
  {
    category: "plumbing",
    keywords: ["hot water", "water heater", "lukewarm"],
    likely: "No hot water anywhere points at the heater. No hot water at one tap, with the rest "
      + "fine, points at that fixture instead — usually its mixing cartridge.",
    checks: [
      { do: "Try the hot tap in the kitchen and the bath.",
        means: "Every tap cold means the heater. One tap cold means the tap." },
    ],
    boundary: "Whatever the answer, do not open the water heater or relight anything on it. "
      + "That is a job for someone with the right kit.",
    question: "Is it every hot tap in the flat, or only one?",
    priority: "high",
  },
  {
    category: "plumbing",
    keywords: ["faucet", "tap", "low pressure", "water pressure", "trickle", "aerator"],
    likely: "Weak flow at a single tap is almost always the aerator — the little screen in the "
      + "spout tip — silted up. It takes two minutes and no tools.",
    checks: [
      { do: "Unscrew the screen at the tip of the spout counter-clockwise (a rag gives grip), "
          + "rinse the grit out, and screw it back on.",
        means: "If flow returns, that was it. If the flow is just as weak with the aerator off "
          + "entirely, the restriction is further back and it is not yours to chase." },
    ],
    question: "Is it only this tap, or is the pressure low throughout the flat?",
    priority: "low",
  },
  {
    category: "structural",
    keywords: ["stain", "water stain", "damp patch", "brown ring", "ceiling stain", "leak above",
               "dripping from ceiling"],
    likely: "A brown ring on a ceiling is water that has been sitting in the structure for a "
      + "while — the stain is always older and wider than the leak that made it. What matters is "
      + "whether it is still wet, because that decides whether this is urgent.",
    checks: [
      { do: "Press the middle of the stain gently with a fingertip.",
        means: "Damp, soft or bulging means water is still arriving and this needs someone today. "
          + "Dry and firm means it is a record of something that has already stopped." },
      { do: "Work out what is directly above it — a bathroom, a kitchen, a flat roof.",
        means: "That is where the source is, and it tells whoever comes what to open up." },
    ],
    boundary: "Do not pierce a bulging ceiling to drain it, and keep out from under it. "
      + "Saturated plaster comes down all at once.",
    question: "Is the stain damp to the touch, and what is directly above that spot?",
    priority: "high",
  },
  {
    category: "electrical",
    keywords: ["outlet", "socket", "plug", "dead outlet", "gfci", "no power", "power out"],
    likely: "A dead outlet with the rest of the flat working is usually a tripped GFCI. One GFCI "
      + "protects several ordinary outlets downstream of it, so the dead one is often nowhere near "
      + "the one that tripped.",
    checks: [
      { do: "Find outlets with RESET and TEST buttons — kitchen, bathroom, garage, outside, "
          + "sometimes a hallway — and press RESET firmly on each until it clicks.",
        means: "A click and the outlet coming back means you found it. GFCIs trip for a reason, "
          + "so if it goes again immediately, something plugged in downstream is at fault." },
      { do: "If that finds nothing, look at the breaker panel for a switch sitting between ON and "
          + "OFF. Push it fully OFF, then back ON.",
        means: "A breaker that trips again straight away is telling you something real." },
    ],
    boundary: "The breaker handles on the front of the panel are yours. The cover comes off for "
      + "an electrician and nobody else.",
    question: "Are other outlets in the same room working?",
    priority: "normal",
  },
  {
    category: "electrical",
    keywords: ["light", "bulb", "flicker", "flickering", "lamp", "fixture"],
    likely: "One flickering fixture is usually the bulb or its seating. Several at once, or "
      + "flickering that tracks an appliance switching on, is a connection problem and is not a "
      + "tenant job.",
    checks: [
      { do: "With the switch off, check the bulb is screwed in snugly, then try a bulb you know "
          + "works.",
        means: "Fixed by a new bulb means it was the bulb. Same flicker with a known-good bulb "
          + "means the fixture or its wiring." },
      { do: "Watch whether other lights dim at the same moment.",
        means: "If they do, this is a supply problem and I will pass it straight on." },
    ],
    question: "Is it one fixture, or do several flicker together?",
    priority: "low",
  },
  {
    category: "hvac",
    keywords: ["heat", "heating", "heater", "furnace", "boiler", "radiator", "thermostat", "no heat"],
    likely: "When heating stops entirely, it is far more often the thermostat or a switched-off "
      + "furnace switch than the furnace itself — those two account for most no-heat calls that "
      + "turn out to need no parts.",
    checks: [
      { do: "At the thermostat: set it to HEAT, put the target several degrees above the current "
          + "room temperature, and if it has a battery door, put fresh batteries in.",
        means: "A blank screen is nearly always dead batteries. A lit screen with nothing "
          + "happening moves suspicion to the furnace." },
      { do: "Find the furnace switch — it looks like an ordinary light switch, on or beside the "
          + "unit — and check it is on. Check its breaker too.",
        means: "These get knocked off by accident more often than anyone expects." },
      { do: "Pull the air filter out and hold it to the light.",
        means: "If you cannot see light through it, a blocked filter can shut the system down on "
          + "its own safety cut-out." },
    ],
    boundary: "Do not open the furnace or try to light anything on it.",
    question: "Does the thermostat screen light up, and does the system make any sound when you "
      + "raise the target temperature?",
    priority: "high",
  },
  {
    category: "hvac",
    keywords: ["air conditioning", "air conditioner", "a/c", "aircon", "not cooling", "cooling"],
    likely: "Weak cooling is a blocked filter far more often than it is refrigerant. A filter "
      + "packed with dust starves the system of airflow, and it ices up and blows nothing.",
    checks: [
      { do: "Set the thermostat to COOL, target well below the room, then pull the filter and "
          + "hold it to the light.",
        means: "Grey and opaque means replace it — that alone fixes a lot of weak-cooling calls." },
      { do: "Put a hand at a vent, and check the outdoor unit is running.",
        means: "No air at all points at the fan or the filter. Room-temperature air with the "
          + "outdoor unit silent points at the compressor, which is not a tenant job." },
    ],
    question: "Is air coming out of the vents at all, and is it cool or room temperature?",
    priority: "high",
  },
  {
    category: "appliance",
    keywords: ["dishwasher", "washer", "dryer", "washing machine", "fridge", "refrigerator",
               "freezer", "oven", "stove", "cooktop", "microwave", "appliance"],
    likely: "Most appliance faults that clear themselves are either a control board that needs "
      + "power-cycling or something blocking airflow or drainage that is designed to be cleaned.",
    checks: [
      { do: "Unplug it, or switch off its breaker, for a full minute, then restore power.",
        means: "A full minute matters — the boards hold charge, and a quick off-on does nothing." },
      { do: "Check the part meant to be cleaned: the dryer lint trap, the filter in the floor of "
          + "the dishwasher, the fridge vents at the back of the compartment.",
        means: "A fridge that is not cold with vents blocked by food is doing exactly what it "
          + "should. Clearing them is often the whole fix." },
    ],
    boundary: "If it is gas, or if you would have to move it to reach anything, leave it.",
    question: "Does it power on at all, and is there an error code on the display?",
    priority: "normal",
  },
  {
    category: "pest",
    keywords: ["pest", "roach", "cockroach", "mice", "mouse", "rat", "ants", "bugs", "bedbug",
               "bed bug", "wasp", "termite", "infestation"],
    likely: "Pests are a building problem rather than a unit one — treating one flat while the "
      + "neighbours go untreated just moves them. This goes to your landlord either way.",
    checks: [
      { do: "Note where and when you see them, and whether it is near water, food, or a gap "
          + "around pipework.",
        means: "It tells whoever treats it where to bait and what is getting them in." },
    ],
    question: "Roughly how many have you seen, and whereabouts in the flat?",
    priority: "high",
  },
  {
    category: "structural",
    keywords: ["window", "door", "wall", "floor", "crack", "mold", "mould", "damp", "paint",
               "tile", "railing", "stair", "draught", "draft", "ceiling"],
    likely: "This is a building fault rather than something with a reset button, so it is going "
      + "to your landlord. One or two details now mean they arrive with the right thing.",
    checks: [
      { do: "Note how big the affected area is and whether it has changed recently.",
        means: "Something spreading is treated differently from something that has been there "
          + "since you moved in." },
    ],
    question: "Where exactly is it, roughly how large, and has it been getting worse?",
    priority: "normal",
  },
  {
    category: "locks_security",
    keywords: ["lock", "key", "deadbolt", "buzzer", "intercom", "keypad", "latch"],
    likely: "A lock that has become stiff is usually the door dropping slightly on its hinges, so "
      + "the bolt no longer lines up with the hole in the frame — not the lock failing.",
    checks: [
      { do: "With the door open, throw the bolt. Then close the door and try again.",
        means: "Smooth with the door open but stiff when closed means alignment, which is a "
          + "hinge or a strike plate — a small job, not a new lock." },
    ],
    boundary: "If the door cannot be locked at all right now, say so and I will treat it as "
      + "urgent rather than have you fiddle with it.",
    question: "Can you currently lock the door, or not at all?",
    priority: "high",
  },
  {
    category: "common_area",
    keywords: ["hallway", "lobby", "elevator", "lift", "laundry room", "parking", "garage",
               "trash", "garbage room", "mailbox", "stairwell"],
    likely: "Shared areas are the landlord's to fix, so this goes straight on their list.",
    checks: [
      { do: "Note exactly where it is and whether it is stopping people getting in or out.",
        means: "Anything blocking access or a fire route gets treated as urgent." },
    ],
    question: "Whereabouts in the building is it, and is it blocking access to anything?",
    priority: "normal",
  },
];

const EMERGENCY = [
  { kw: ["gas", "smell gas", "propane"], why: "possible gas leak" },
  { kw: ["smoke", "fire", "burning smell", "sparks", "sparking"], why: "fire or electrical hazard" },
  { kw: ["carbon monoxide", "co detector"], why: "possible carbon monoxide" },
  { kw: ["flood", "flooding", "burst", "gushing", "pouring", "water everywhere"], why: "active flooding" },
  { kw: ["sewage", "sewer backup", "raw sewage"], why: "sewage backup" },
  { kw: ["ceiling collapse", "collapsed", "falling"], why: "structural failure" },
  { kw: ["break in", "broke in", "broken window", "can't lock", "cant lock", "won't lock", "wont lock"], why: "unit cannot be secured" },
  { kw: ["no water"], why: "no running water" },
];

const YES = ["yes", "yep", "yeah", "it worked", "that worked", "fixed", "solved", "all good", "working now", "it's working", "its working", "sorted", "resolved", "no longer", "thanks that did it", "did it"];
const NO = ["no", "nope", "didn't work", "didnt work", "still", "not working", "same", "no luck", "nothing", "worse"];
const WANTS_HUMAN = ["someone", "come out", "send a", "plumber", "electrician", "technician", "landlord", "maintenance", "person", "repair guy", "just fix"];

const norm = (s: string) => s.toLowerCase();

/**
 * Whole-word match.
 *
 * Plain `includes` was matching keywords inside unrelated words — "ac" fired on
 * "attached", which sent a tenant reporting a ceiling stain a set of
 * instructions about their air conditioning. Keywords can contain spaces,
 * slashes and apostrophes, so the boundary is "not a letter or digit" rather
 * than \b, which would break on "a/c".
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whole-word, but tolerant of the endings people actually type: "drains
 * slowly" and "the drain is draining slowly" both have to match "drain".
 * Only these four suffixes, and only at the end — enough for plurals and
 * tenses, not enough to let "ac" back inside "attached".
 */
const wordRe = (word: string) =>
  new RegExp(`(^|[^a-z0-9])${escapeRe(word)}(s|es|ed|ing)?([^a-z0-9]|$)`, "i");
const hits = (text: string, words: string[]) => words.some((w) => wordRe(w).test(text));

/**
 * The best-matching playbook, or null.
 *
 * Longer keywords count for more: "no hot water" says far more about what is
 * wrong than "water" does, and scoring every keyword equally let a one-word
 * incidental match outvote a specific phrase.
 */
function pickPlaybook(text: string, title: string): Playbook | null {
  let best: Playbook | null = null;
  let bestScore = 0;
  for (const p of PLAYBOOKS) {
    let score = 0;
    for (const k of p.keywords) {
      if (!wordRe(k).test(text)) continue;
      score += 1 + k.split(/\s+/).length;
      // What the tenant chose to call it is worth more than a passing mention.
      if (wordRe(k).test(title)) score += 3;
    }
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

/** Lay a playbook out as something worth reading on a phone. */
function explain(book: Playbook, opening: string): string {
  const checks = book.checks
    .map((c, i) => {
      const numbered = book.checks.length > 1 ? `${i + 1}. ` : "- ";
      return `${numbered}${c.do}${c.means ? `\n   ${c.means}` : ""}`;
    })
    .join("\n");
  return [
    opening,
    book.likely,
    checks && `Worth checking:\n${checks}`,
    book.boundary,
    book.question,
  ].filter(Boolean).join("\n\n");
}

function triageWithRules(
  title: string,
  history: Message[],
  intake: IntakeContext | null,
): TriageResult {
  const tenantTurns = history.filter((m) => m.author === "tenant");
  const botTurns = history.filter((m) => m.author === "bot");
  const latest = norm(tenantTurns.at(-1)?.body ?? "");
  const titleText = norm(title);
  const all = norm(
    [title, intake?.categoryLabel ?? "", intake?.severityLabel ?? "",
      ...tenantTurns.map((m) => m.body)].join(" \n "),
  );

  const book = pickPlaybook(all, titleText);
  // The tenant already told us the category with a button, and that is a better
  // answer than keyword matching. The playbook still supplies the checks, but it
  // no longer gets to overrule what they said it was.
  const category: Category = intake?.category ?? book?.category ?? "other";
  const label = title.trim() || "Maintenance request";

  // 1. Emergencies short-circuit everything.
  const emergency = EMERGENCY.find((e) => hits(all, e.kw));
  if (emergency) {
    return {
      reply: [
        `This reads like ${emergency.why}, so I am not going to have you troubleshoot it. `
        + `I have marked it urgent and put it at the top of your landlord's list.`,
        `If anyone is in danger, leave and call emergency services — that comes before anything `
        + `here. If you can do it safely on your way out, shut off the valve or breaker feeding `
        + `whatever is causing it.`,
        `Tell me what is happening now and I will pass it straight on.`,
      ].join("\n\n"),
      action: "escalate",
      category: category === "other" ? "structural" : category,
      priority: "urgent",
      summary: `URGENT (${emergency.why}): ${label}`,
      engine: "rules",
    };
  }

  // 2. Tenant confirmed a fix worked.
  if (botTurns.length > 0 && hits(latest, YES) && !hits(latest, NO)) {
    return {
      reply:
        "Good — that is one that did not need a visit. I will close it out.\n\n"
        + "If it comes back, reopen this request rather than starting a new one: everything we "
        + "worked through here goes with it, so your landlord can see what has already been ruled "
        + "out.",
      action: "resolved",
      category,
      priority: book?.priority ?? "normal",
      summary: `${label} — resolved by tenant during triage`,
      engine: "rules",
    };
  }

  const botReplies = botTurns.length;
  const wantsHuman = hits(latest, WANTS_HUMAN);

  // 3. First reply: say what is probably going on and what would confirm it.
  if (botReplies === 0 && !wantsHuman) {
    if (book) {
      return {
        reply: explain(
          book,
          "Thanks — let me see if we can work out what this is before anyone has to come out.",
        ),
        action: "ask",
        category,
        priority: book.priority,
        summary: label,
        engine: "rules",
      };
    }
    return {
      reply:
        "Thanks for flagging that. I do not have a safe fix to suggest for this one, so it is "
        + "going to your landlord.\n\nOne thing first, so they arrive knowing what they are "
        + "dealing with: where exactly is it, when did it start, and does it happen every time or "
        + "only sometimes?",
      action: "ask",
      category,
      priority: "normal",
      summary: label,
      engine: "rules",
    };
  }

  // 4. They answered but it is not fixed — give the reasoning behind what is left.
  if (book && !wantsHuman && botReplies === 1 && book.checks.length > 1) {
    const rest = book.checks.slice(1)
      .map((c, i) => `${i + 1}. ${c.do}${c.means ? `\n   ${c.means}` : ""}`)
      .join("\n");
    return {
      reply:
        `Right — that rules out the easy one. What is left before this needs someone:\n\n${rest}`
        + `\n\nIf neither changes anything, say so and I will hand it over with everything we have `
        + `ruled out, so nobody starts from scratch.`,
      action: "ask",
      category,
      priority: book.priority,
      summary: label,
      engine: "rules",
    };
  }

  // 5. Out of road — hand it over with what was learned.
  const ruledOut = Math.min(botReplies, book?.checks.length ?? 0);
  const tried = ruledOut > 0
    ? ` We ruled out ${ruledOut === 1 ? "the usual cause" : `the ${ruledOut} usual causes`} first, `
      + `so nobody will start there.`
    : "";
  return {
    reply:
      `Understood — this one needs your landlord.${tried}\n\n`
      + "It is on their list with this whole conversation attached, so you will not have to "
      + "explain it again. Their replies come back in this same thread.",
    action: "escalate",
    category,
    priority: book?.priority ?? "normal",
    summary: ruledOut > 0
      ? `${label} — tenant ruled out ${ruledOut} common cause${ruledOut === 1 ? "" : "s"}, still unresolved`
      : label,
    engine: "rules",
  };
}

/* ------------------------------------------------------------------ Public */

export async function triage(
  title: string,
  history: Message[],
  intake: IntakeContext | null = null,
): Promise<TriageResult> {
  if (usingClaude) {
    try {
      return await triageWithClaude(title, history, intake);
    } catch (err) {
      console.error("[bot] Claude triage failed, falling back to rules:", err);
    }
  }
  return triageWithRules(title, history, intake);
}
