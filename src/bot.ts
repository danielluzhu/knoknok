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

export const usingClaude = Boolean(process.env.ANTHROPIC_API_KEY);

const SYSTEM_PROMPT = `You are the maintenance triage assistant for a residential property management app.
A tenant has reported a problem in their home. Your job, in order of preference:

1. Solve it. Many reported issues have a safe fix the tenant can do in under five minutes
   (tripped GFCI outlet, garbage disposal reset button, thermostat batteries, breaker,
   clogged aerator, dryer lint trap, water shutoff valve, dishwasher filter). Walk them
   through one concrete step at a time and ask whether it worked.
2. If it is not something they can safely fix, or the fix did not work, hand it to the landlord
   with a clear, specific summary.

Rules:
- Ask ONE question at a time. Keep replies under 90 words, plain language, no markdown headers.
- Never ask a tenant to work inside an electrical panel, on gas lines, on a water heater, or on
  anything requiring a ladder above shoulder height. Escalate those immediately.
- Escalate IMMEDIATELY with priority "urgent" for: gas smell, smoke or fire, carbon monoxide,
  flooding or an uncontrolled leak, sewage backup, no heat in cold weather, sparking or burning
  smell from an outlet, a door or window that no longer locks, or anyone in danger.
- Do not stall. By your third reply you should either be resolved or escalating.
- If the tenant says the problem is fixed, or that a step you suggested worked, set action to "resolved".
- If the tenant asks for a person, or declines to troubleshoot, escalate without pushing back.

Set "action":
  "ask"      - you asked a diagnostic question or gave a step to try; the conversation continues.
  "resolved" - the tenant confirmed it is fixed, no maintenance visit needed.
  "escalate" - it needs the landlord or a contractor.

"summary" is one line for the landlord's to-do list. Be specific and useful:
"Kitchen sink drains slowly; plunger and drain cleaner did not clear it" beats "sink problem".

"priority": urgent = safety or habitability now, high = will get worse or badly disrupts daily life,
normal = should be fixed soon, low = cosmetic or convenience.`;

/* ------------------------------------------------------------------ Claude */

async function triageWithClaude(
  title: string,
  history: Message[],
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
    content: `Request title: ${title}\n\n${messages[0]!.content}`,
  };

  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages,
    output_config: {
      effort: "low",
      format: zodOutputFormat(TriageSchema),
    },
  });

  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`unusable triage response (stop_reason=${response.stop_reason})`);
  }
  return { ...response.parsed_output, engine: "claude" };
}

/* ------------------------------------------------------- Rule-based fallback */

interface Playbook {
  category: Category;
  keywords: string[];
  /** Safe self-help steps, offered one per turn. */
  steps: string[];
  /** Asked alongside the first step. */
  question: string;
  priority: Priority;
}

const PLAYBOOKS: Playbook[] = [
  {
    category: "plumbing",
    keywords: ["disposal", "garbage disposal", "insinkerator"],
    steps: [
      "Most disposals just trip a breaker inside the unit. Turn the switch off, then reach under the sink and press the small red reset button on the bottom of the disposal. Switch it back on.",
      "If it hums but does not turn, switch it off at the wall, then use the hex wrench that came with it (or a 1/4\" allen key) in the socket underneath to work the blades free by hand. Never put your hand in the drain.",
    ],
    question: "Does it hum when you flip the switch, or is it completely silent?",
    priority: "normal",
  },
  {
    category: "plumbing",
    keywords: ["drain", "clog", "clogged", "slow drain", "backed up", "sink won't drain", "standing water"],
    steps: [
      "Try a plunger first: fill the basin with an inch or two of water so the cup seals, cover the overflow hole with a wet rag, and plunge hard 15-20 times.",
      "If the sink has a P-trap you can reach, put a bucket underneath and unscrew the two slip nuts by hand to clear the trap. Skip this if the pipes look corroded.",
    ],
    question: "Is it draining slowly, or not at all?",
    priority: "normal",
  },
  {
    category: "plumbing",
    keywords: ["toilet", "running toilet", "won't flush", "wont flush"],
    steps: [
      "For a toilet that keeps running, lift the tank lid and check that the flapper is sitting flat over the drain hole, and that the chain has a little slack rather than being pulled tight.",
      "For a weak flush, try a plunger with a flange (the extended rubber lip) and 15-20 firm strokes.",
    ],
    question: "Is it running constantly, or not flushing properly?",
    priority: "high",
  },
  {
    category: "plumbing",
    keywords: ["hot water", "no hot water", "water heater", "lukewarm"],
    steps: [
      "First check whether it is every faucet or just one. If it is one faucet, the fixture may be the problem rather than the heater.",
    ],
    question: "Is there no hot water anywhere, or just at one fixture?",
    priority: "high",
  },
  {
    category: "plumbing",
    keywords: ["faucet", "low pressure", "water pressure", "trickle", "aerator"],
    steps: [
      "Low pressure at one faucet is usually a clogged aerator. Unscrew the small screen at the tip of the spout (counter-clockwise, a rag helps for grip), rinse out the grit, and screw it back on.",
    ],
    question: "Is it just this one faucet, or the whole unit?",
    priority: "low",
  },
  {
    category: "electrical",
    keywords: ["outlet", "no power", "socket", "plug", "dead outlet", "gfci"],
    steps: [
      "A dead outlet is usually a tripped GFCI. Look for an outlet with RESET/TEST buttons in the kitchen, bathroom, garage, or outside, and press RESET firmly until it clicks.",
      "If that did not do it, check the breaker panel for a switch sitting between ON and OFF. Push it fully OFF, then back ON. Only touch the breaker handles.",
    ],
    question: "Are other outlets in the same room working?",
    priority: "normal",
  },
  {
    category: "electrical",
    keywords: ["light", "bulb", "flicker", "lamp", "fixture"],
    steps: [
      "If it is a single fixture, try a known-good bulb first, and make sure the existing one is screwed in snugly.",
    ],
    question: "Is it one fixture, or several lights at once?",
    priority: "low",
  },
  {
    category: "hvac",
    keywords: ["heat", "heater", "furnace", "no heat", "cold", "radiator", "thermostat"],
    steps: [
      "Start at the thermostat: set it to HEAT, put the target several degrees above the room temperature, and if it has a battery door, swap in fresh batteries.",
      "Then check the furnace breaker and the furnace switch (it looks like a light switch, usually on or near the unit) are both on, and that the filter is not packed with dust.",
    ],
    question: "Does the thermostat screen light up, and does the system make any sound when you raise the temperature?",
    priority: "high",
  },
  {
    category: "hvac",
    keywords: ["ac", "a/c", "air conditioning", "air conditioner", "not cooling", "hot in here"],
    steps: [
      "Set the thermostat to COOL with the target well below room temperature, and replace the air filter if it is grey with dust — a blocked filter is the most common cause of weak cooling.",
      "Check that the outdoor unit is running and that nothing is blocking the vents inside.",
    ],
    question: "Is air coming out of the vents at all, and is it cool or room temperature?",
    priority: "high",
  },
  {
    category: "appliance",
    keywords: ["dishwasher", "washer", "dryer", "washing machine", "fridge", "refrigerator", "freezer", "oven", "stove", "microwave", "appliance"],
    steps: [
      "Try a reset first: unplug the appliance (or switch off its breaker) for a full 60 seconds, then restore power and run it again.",
      "Then check the obvious blockers — the dryer lint trap, the dishwasher filter in the floor of the tub, or the fridge vents being blocked by food.",
    ],
    question: "Does it power on at all, and is there any error code on the display?",
    priority: "normal",
  },
  {
    category: "pest",
    keywords: ["pest", "roach", "cockroach", "mice", "mouse", "rat", "ants", "bugs", "bedbug", "bed bug", "wasp", "termite"],
    steps: [],
    question: "Roughly how many have you seen, and where in the unit?",
    priority: "high",
  },
  {
    category: "structural",
    keywords: ["window", "door", "wall", "ceiling", "floor", "crack", "mold", "mould", "damp", "paint", "tile", "railing", "stair"],
    steps: [],
    question: "Where exactly is it, and roughly how big is the affected area?",
    priority: "normal",
  },
  {
    category: "locks_security",
    keywords: ["lock", "key", "deadbolt", "buzzer", "intercom", "keypad", "door won't lock", "wont lock"],
    steps: [],
    question: "Can you currently secure the door, or is it not locking at all?",
    priority: "high",
  },
  {
    category: "common_area",
    keywords: ["hallway", "lobby", "elevator", "laundry room", "parking", "garage", "trash", "garbage room", "mailbox", "stairwell"],
    steps: [],
    question: "Which part of the building is it in?",
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
const hits = (text: string, words: string[]) => words.some((w) => text.includes(w));

function pickPlaybook(text: string): Playbook | null {
  let best: Playbook | null = null;
  let bestScore = 0;
  for (const p of PLAYBOOKS) {
    const score = p.keywords.filter((k) => text.includes(k)).length;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

function triageWithRules(title: string, history: Message[]): TriageResult {
  const tenantTurns = history.filter((m) => m.author === "tenant");
  const botTurns = history.filter((m) => m.author === "bot");
  const latest = norm(tenantTurns.at(-1)?.body ?? "");
  const all = norm([title, ...tenantTurns.map((m) => m.body)].join(" \n "));

  const book = pickPlaybook(all);
  const category: Category = book?.category ?? "other";
  const label = title.trim() || "Maintenance request";

  // 1. Emergencies short-circuit everything.
  const emergency = EMERGENCY.find((e) => hits(all, e.kw));
  if (emergency) {
    return {
      reply:
        `This sounds like ${emergency.why}, so I am not going to have you troubleshoot it — ` +
        `I have flagged it as urgent and put it at the top of your landlord's list. ` +
        `If anyone is in immediate danger, leave the unit and call emergency services first. ` +
        `If you can do so safely, shut off the relevant valve or breaker.`,
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
        `Great — I will close this one out. If it comes back, reopen this request and I will ` +
        `pass it straight to your landlord with everything we tried here.`,
      action: "resolved",
      category,
      priority: book?.priority ?? "normal",
      summary: `${label} — resolved by tenant during triage`,
      engine: "rules",
    };
  }

  const botReplies = botTurns.length;
  const wantsHuman = hits(latest, WANTS_HUMAN);
  const nextStep = book?.steps[botReplies];
  const genericQuestion =
    "Where in the unit is it, when did it start, and does it happen every time or only sometimes?";

  // 3. First reply — always get one diagnostic exchange in, even for categories
  //    with no safe self-help step. The answer is what the landlord shows up with.
  if (botReplies === 0 && !wantsHuman) {
    if (nextStep) {
      return {
        reply: `Thanks — let me see if we can save you a maintenance visit. ${nextStep} ${book!.question}`,
        action: "ask",
        category,
        priority: book!.priority,
        summary: label,
        engine: "rules",
      };
    }
    return {
      reply:
        "Thanks for flagging that. There's nothing here I'd ask you to fix yourself, so this is going " +
        "to your landlord — one question first, so they turn up with the right part. " +
        (book?.question ?? genericQuestion),
      action: "ask",
      category,
      priority: book?.priority ?? "normal",
      summary: label,
      engine: "rules",
    };
  }

  // 4. Another safe step worth trying?
  if (nextStep && !wantsHuman && botReplies < 3) {
    return {
      reply: `Okay, one more thing worth trying. ${nextStep} Let me know whether that changes anything.`,
      action: "ask",
      category,
      priority: book!.priority,
      summary: label,
      engine: "rules",
    };
  }

  // 5. Out of road — hand it over with whatever we learned.
  const stepsTried = Math.min(botReplies, book?.steps.length ?? 0);
  const tried = stepsTried > 0
    ? ` We already tried ${stepsTried === 1 ? "one basic fix" : `${stepsTried} basic fixes`} without luck.`
    : "";
  return {
    reply:
      `Understood — this one needs your landlord.${tried} I've added it to their to-do list ` +
      "with everything from this conversation attached, so you won't have to repeat yourself. " +
      "You'll see their replies right here in this thread.",
    action: "escalate",
    category,
    priority: book?.priority ?? "normal",
    summary: stepsTried > 0
      ? `${label} — tenant tried ${stepsTried} self-help step${stepsTried === 1 ? "" : "s"}, still unresolved`
      : label,
    engine: "rules",
  };
}

/* ------------------------------------------------------------------ Public */

export async function triage(title: string, history: Message[]): Promise<TriageResult> {
  if (usingClaude) {
    try {
      return await triageWithClaude(title, history);
    } catch (err) {
      console.error("[bot] Claude triage failed, falling back to rules:", err);
    }
  }
  return triageWithRules(title, history);
}
