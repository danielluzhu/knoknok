/**
 * Maintenance triage bot.
 *
 * Runs on Claude (Opus 5) when ANTHROPIC_API_KEY is set. Without a key it falls
 * back to a deterministic diagnostic script so the app is fully usable offline —
 * same interface, same three possible actions.
 */
import type { Message, Priority } from "./db";
import {
  findIssue, intakeGaps, tipGuide, tipText, whenText, whereText, type Intake, type Issue,
} from "./intake";
import { GUIDE_IDS, guideMenu, guidesFor, TENANT_FIX_RULE, type GuideId } from "./guides";

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
  /**
   * How-to guides for the fixes suggested in `reply`, from the vetted catalogue
   * in src/guides.ts. Ids only — the links are looked up, never written.
   */
  guides: GuideId[];
  /** Which engine produced this result. */
  engine: "claude" | "rules";
}

export const usingClaude = Boolean(process.env.ANTHROPIC_API_KEY);

const systemPrompt = () => `You are the maintenance triage assistant for a residential property
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

WHAT IS THE TENANT'S TO FIX

${TENANT_FIX_RULE}

If part of it is genuinely not theirs to touch, say so and say why in the same breath — "the panel
itself is an electrician's job, but the breaker handles on the front are yours". Being told the
boundary is more useful than being told to stop.

Close with the single question whose answer decides what happens next. One question, at the end.

Aim for about 150 words. Go longer only when the extra words genuinely save a visit.

BEFORE YOU DECIDE

You may not resolve or escalate until you know all four of these: WHAT is broken (the specific
fixture or appliance), WHERE it is (enough to walk to it), WHEN it started and whether it is
constant or intermittent (skip this only when timing clearly cannot change the diagnosis), and
OTHER relevant facts — what the tenant has already tried, whether it is getting worse, any damage.

Knowing something and being told it in so many words are not the same thing. A kitchen sink is
the kitchen sink: "sink" plus "kitchen" is a location, and asking which part of the kitchen it is
in reads as not having listened. Ask where in the room only when it would change what someone
brings or where they look — an outlet among several, a stain on one wall, a radiator in a room
with two. Treat the other three the same way: if what the tenant wrote already answers an item,
it is answered.

Most requests arrive with a structured intake that covers some or all of these; it is quoted at
the top of the first message along with which items are still missing. If any are genuinely
missing or too vague to act on, ask for those first — one item per reply, folded into your
closing question — before any diagnostic check. Never re-ask something the tenant has already
given, or already made plain.

WHAT NOT TO DO

- Never send anyone inside an electrical panel, onto a gas line or appliance, into a water heater,
  onto a roof, or up a ladder above shoulder height. Escalate those.
- Never guess at a diagnosis you have no basis for. If what they said fits several causes and you
  cannot narrow it, say which ones and ask the question that separates them.
- No markdown headers, no bold. Plain sentences and simple dashes or numbers.
- Do not stall. By your third reply after the basics below are covered, you are either resolved
  or escalating.

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
normal = should be fixed soon, low = cosmetic or convenience.

"guides": how-to guides for the checks in THIS reply, by id, from the list below and nowhere
else — at most three, in the order of the checks, and only where the guide walks through the same
step you suggested. Never put a URL in the reply text; the app shows the guides you pick as links
under your message. Leave it empty when you are asking a question, escalating, or suggested
nothing a guide covers. Several guides go further than a tenant should (replacing the part, not
just cleaning it); your reply is what says which part is theirs.
${guideMenu() || "(no guides are available)"}`;

/* ------------------------------------------------------------------ Claude */

/**
 * The structured intake, written out for the model: what was picked, what was
 * filled in, and — the part that matters — what is still missing.
 */
function intakeBrief(intake: Intake): string {
  const issue = findIssue(intake.issue);
  if (!issue) return "";
  const gaps = intakeGaps(intake);
  const lines = [
    "Structured intake (what the tenant filled in before this conversation):",
    `Issue: ${issue.name} (filed under ${issue.category}).`
      + (issue.urgent
        ? " EMERGENCY: the tenant has already been shown what to do right now. "
          + "Confirm they are safe, escalate as urgent, do not troubleshoot."
        : ""),
    `What: ${intake.what}`,
    `Where: ${whereText(intake)}`,
    `When: ${whenText(intake)
      || `not given${issue.whenMatters ? "" : " (timing does not matter for this issue)"}`}`,
    `Other: ${intake.notes || "not given"}`,
    gaps.length
      ? `Still missing before you may decide: ${gaps.map((g) => g.key.toUpperCase()).join(", ")}. `
        + "Ask for these first, one per reply."
      : "All four basics are covered. Go straight to working out what it is.",
  ];
  if (issue.questions.length) {
    lines.push(`Issue-specific follow-ups worth asking: ${issue.questions.join(" | ")}`);
  }
  lines.push(
    issue.tips.length
      ? `Safe fixes you may suggest for this issue: ${issue.tips
        .map((t) => `${tipText(t)}${tipGuide(t) ? ` [guide: ${tipGuide(t)}]` : ""}`)
        .join(" | ")}`
      : "There is no safe self-fix for this issue; once the basics are covered it needs a person.",
  );
  return lines.join("\n");
}

async function triageWithClaude(
  title: string,
  history: Message[],
  intake: Intake | null,
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
    guides: z.array(z.enum(GUIDE_IDS)),
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
  const brief = intake ? intakeBrief(intake) : "";
  messages[0] = {
    role: "user",
    content: `Request title: ${title}\n\n${brief ? `${brief}\n\nTenant's message:\n` : ""}${messages[0]!.content}`,
  };

  const response = await client.messages.parse({
    model: "claude-opus-5",
    // Room for the model to reason before answering. The reply itself is a few
    // hundred words; the headroom is for thinking.
    max_tokens: 16000,
    system: systemPrompt(),
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
  const out = response.parsed_output;
  // Only ids that are actually in the catalogue, and not on a reply that asks
  // a question or hands over — there is nothing there to follow.
  const guides = out.action === "ask" ? guidesFor(out.guides).slice(0, 3).map((x) => x.id) : [];
  return { ...out, guides, engine: "claude" };
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
  /** Each: what to do, what the outcome tells them, and a guide to doing it. */
  checks: { do: string; means?: string; guide?: GuideId }[];
  /** The line between what is theirs and what is not, when there is one. */
  boundary?: string;
  /** The one question whose answer decides what happens next. */
  question: string;
  priority: Priority;
}

export const PLAYBOOKS: Playbook[] = [
  {
    category: "plumbing",
    keywords: ["disposal", "garbage disposal", "insinkerator"],
    likely: "A disposal that has stopped almost always tripped its own overload — there is a reset "
      + "button on the unit itself, separate from the wall switch and the breaker.",
    checks: [
      { do: "Switch it off at the wall, reach under the sink, and press the small red button on "
          + "the underside of the disposal until it clicks. Switch back on.",
        guide: "disposal-reset",
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
        guide: "plunge-sink",
        means: "Most hair and grease clogs give way here. No change after a proper attempt "
          + "usually means it is further down than a plunger reaches." },
      { do: "Put a bucket under the U-bend and undo the two slip nuts by hand.",
        guide: "clean-p-trap",
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
        guide: "toilet-flapper",
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
        guide: "clean-aerator",
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
        guide: "gfci-reset",
        means: "A click and the outlet coming back means you found it. GFCIs trip for a reason, "
          + "so if it goes again immediately, something plugged in downstream is at fault." },
      { do: "If that finds nothing, look at the breaker panel for a switch sitting between ON and "
          + "OFF. Push it fully OFF, then back ON.",
        guide: "breaker-reset",
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
        guide: "thermostat-batteries",
        means: "A blank screen is nearly always dead batteries. A lit screen with nothing "
          + "happening moves suspicion to the furnace." },
      { do: "Find the furnace switch — it looks like an ordinary light switch, on or beside the "
          + "unit — and check it is on. Check its breaker too.",
        means: "These get knocked off by accident more often than anyone expects." },
      { do: "Pull the air filter out and hold it to the light.",
        guide: "hvac-filter",
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
        guide: "hvac-filter",
        means: "Grey and opaque means replace it — that alone fixes a lot of weak-cooling calls." },
      { do: "Put a hand at a vent, and check the outdoor unit is running.",
        means: "No air at all points at the fan or the filter. Room-temperature air with the "
          + "outdoor unit silent points at the compressor, which is not a tenant job." },
    ],
    question: "Is air coming out of the vents at all, and is it cool or room temperature?",
    priority: "high",
  },
  {
    category: "other",
    keywords: ["smoke alarm", "smoke detector", "chirp", "chirping", "beeping", "low battery"],
    likely: "A single chirp every minute or so is the alarm asking for a new battery. Hard-wired "
      + "alarms do it too — the battery inside is the backup, and it still runs down.",
    checks: [
      { do: "Twist the alarm anticlockwise off its base, swap the 9V or AA battery, and press "
          + "TEST until it sounds. If it's wired in and you'd have to unplug wires to reach the "
          + "battery, or the back says it has a sealed 10-year battery, stop — that one is the "
          + "landlord's.",
        guide: "smoke-alarm-chirp",
        means: "Chirping stops, alarm tests loud: that was it. Still chirping with a fresh battery "
          + "usually means the alarm itself has reached the end of its life (they last about ten "
          + "years), which is the landlord's to replace." },
    ],
    boundary: "If it is labelled CO or carbon monoxide and it is sounding continuously rather "
      + "than chirping, stop here, get everyone outside, and call 911 — do not silence it.",
    question: "Is it a short chirp every minute or so, or a continuous alarm?",
    priority: "high",
  },
  {
    category: "appliance",
    keywords: ["dishwasher not draining", "dishwasher won't drain", "water in the dishwasher",
               "dishwasher", "dishes dirty"],
    likely: "A dishwasher that leaves water in the bottom or dirty dishes is almost always its own "
      + "filter, which is designed to be lifted out and rinsed, or the garbage disposal it drains "
      + "through.",
    checks: [
      { do: "Run the garbage disposal for a few seconds, if there is one.",
        means: "The dishwasher drains through it. A disposal full of food blocks the dishwasher too." },
      { do: "Pull out the bottom rack, twist out the filter in the floor of the tub, and rinse it "
          + "under the tap.",
        guide: "dishwasher-filter",
        means: "A filter matted with food is the usual cause of both standing water and gritty "
          + "dishes. Run an empty cycle afterwards." },
    ],
    question: "Is there water left in the bottom, or does it drain but leave the dishes dirty?",
    priority: "normal",
  },
  {
    category: "appliance",
    keywords: ["dryer", "not drying", "clothes still wet", "takes forever to dry", "lint"],
    likely: "A dryer that runs but takes two cycles to dry is nearly always airflow — a packed "
      + "lint screen or a crushed vent hose behind it — not the heater.",
    checks: [
      { do: "Pull out the lint screen, clear it, and rinse it if it looks waxy from dryer sheets.",
        guide: "dryer-lint",
        means: "Water sitting on the mesh instead of running through means it is coated, and air "
          + "is not getting through either." },
      { do: "Look behind the dryer at the flexible silver hose. It should run fairly straight to "
          + "the wall, not squashed flat or kinked.",
        means: "A crushed hose starves the dryer of air. Straighten it if you can do that without "
          + "moving the dryer; if it has come off or is torn, leave it for the landlord." },
    ],
    boundary: "Don't move a gas dryer or disconnect anything at the wall. A blocked vent is a fire "
      + "risk, so if the dryer or the room gets unusually hot, stop using it.",
    question: "Does it get warm inside at all, or is it tumbling cold?",
    priority: "normal",
  },
  {
    category: "appliance",
    keywords: ["washer won't start", "washing machine won't start", "washer", "washing machine",
               "won't spin", "not spinning"],
    likely: "A washer that does nothing is usually refusing to start rather than broken: the door "
      + "or lid is not latched, a child lock or delay-start is on, or it has lost power.",
    checks: [
      { do: "Push the door or lid firmly shut until it clicks, and look on the panel for a lock "
          + "symbol or a delay timer.",
        guide: "washer-wont-start",
        means: "Most machines hold a child lock by pressing and holding one or two buttons for three "
          + "seconds — the symbol or the manual says which." },
      { do: "For a washer that fills but will not spin, spread the load out evenly and run a "
          + "spin-only cycle.",
        means: "One heavy towel wrapped round the drum is enough to make it refuse to spin." },
    ],
    question: "Does the display light up at all, and is there an error code?",
    priority: "normal",
  },
  {
    category: "appliance",
    keywords: ["fridge not cold", "fridge warm", "refrigerator not cooling", "not cooling",
               "fridge", "refrigerator", "freezer"],
    likely: "A fridge that has gone warm while its light still works is more often airflow than a "
      + "fault: the dial has been knocked, food is blocking the vents inside, or the door is not "
      + "sealing.",
    checks: [
      { do: "Check the temperature dial is near the middle, and clear anything pressed against "
          + "the vents at the back of the fridge and freezer.",
        guide: "fridge-not-cooling",
        means: "Blocked vents keep the cold in the freezer. It takes up to a day to settle after "
          + "a change, so give it that before deciding." },
      { do: "Shut the door on a sheet of paper and pull it out.",
        means: "Slides out easily means the seal is not gripping there, and warm air is getting in." },
    ],
    boundary: "Don't pull the fridge out from the wall or unscrew any panels to reach the coils. "
      + "Move food at risk to a cooler or a neighbour's fridge in the meantime.",
    question: "Is the light on inside, and can you hear it running?",
    priority: "high",
  },
  {
    category: "plumbing",
    keywords: ["shower", "shower head", "showerhead", "weak shower", "low pressure shower"],
    likely: "A shower that has gone weak while the taps are fine is nearly always limescale in the "
      + "shower head's nozzles.",
    checks: [
      { do: "Fill a plastic bag with white vinegar, tie it over the head so the nozzles sit in it, "
          + "and leave it a few hours or overnight. Run the water to flush it.",
        guide: "showerhead-soak",
        means: "Flow back to normal means scale. No better afterwards means the restriction is in "
          + "the valve, which is the landlord's." },
    ],
    question: "Is it only the shower, or are the bathroom taps weak too?",
    priority: "low",
  },
  {
    category: "structural",
    keywords: ["window sticks", "window stuck", "sticking window", "window won't open",
               "window hard to open", "cabinet", "drawer"],
    likely: "A window that drags is usually dirt in the tracks; a cabinet door that sags is usually "
      + "loose hinge screws. Neither needs parts.",
    checks: [
      { do: "Window: vacuum and wipe the tracks, then a little silicone spray (not oil, which "
          + "gathers grit) along them.",
        guide: "sticky-window",
        means: "Slides again means it was grime. Still jammed with clean tracks usually means the "
          + "frame has swollen or a balance has gone, which is the landlord's." },
      { do: "Cabinet: tighten the hinge screws with a screwdriver — snug, not hard.",
        means: "If the screws spin without tightening, the holes have torn out and it needs a repair." },
    ],
    boundary: "If window glass is cracked, don't force it — tape cardboard over it and report it.",
    question: "Is it a window or a cabinet, and does it move at all?",
    priority: "low",
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
  { kw: ["co alarm", "co detector"], why: "possible carbon monoxide" },
  { kw: ["carbon monoxide"], why: "possible carbon monoxide" },
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
 * A smoke alarm chirping for a battery is not a fire. Without this, "the smoke
 * alarm keeps chirping" matched "smoke" and was handled as an emergency, and
 * the tenant was never told the fix was a nine-volt. Mirrors the same
 * exception in src/sla.ts. A carbon monoxide alarm gets no such exception.
 */
function emergencyText(text: string): string {
  if (/\bchirp|\bbeep|\bbattery\b/.test(text) && !/\b(co|carbon monoxide)\b/.test(text)) {
    return text.replace(/\bsmoke (alarm|detector)s?\b/g, "alarm");
  }
  return text;
}

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

/**
 * A playbook built from the issue the tenant picked, so the offline engine
 * answers about the thing they chose rather than guessing from keywords.
 */
function issuePlaybook(issue: Issue): Playbook {
  return {
    category: issue.category,
    keywords: [],
    likely: "",
    checks: issue.tips.map((t) => ({ do: tipText(t), guide: tipGuide(t) ?? undefined })),
    question: issue.questions[0]
      ?? "Is there anything else worth knowing before this goes on the list?",
    priority: issue.priority,
  };
}

/** The catalogued guides for these checks, in order, skipping any not in the catalogue. */
const guidesOf = (checks: Playbook["checks"]) =>
  guidesFor(checks.map((c) => c.guide ?? "")).map((x) => x.id);

/** Never more than this many basics asked in the chat; the form covers the rest. */
const MAX_GAP_QUESTIONS = 2;

/**
 * The landlord's one-liner, from the intake plus whatever the gap questions
 * drew out. The tenant's answer to gap question k is their (k+1)th message —
 * the first one is the intake itself.
 */
function intakeSummary(
  intake: Intake,
  issue: Issue,
  gaps: { key: string; ask: string }[],
  tenantTurns: Message[],
  ruledOut: number,
): string {
  const answer = (k: number) => tenantTurns[k + 1]?.body?.trim().replace(/\s+/g, " ") ?? "";
  const extra: Record<string, string> = {};
  gaps.forEach((g, k) => { if (answer(k)) extra[g.key] = answer(k); });

  const parts = [`${issue.name}: ${intake.what}`];
  parts.push([whereText(intake), extra.where].filter(Boolean).join(", "));
  const when = [whenText(intake), extra.when].filter(Boolean).join("; ");
  if (when) parts.push(`since: ${when}`);
  const other = [intake.notes, extra.other].filter(Boolean).join("; ");
  if (other) parts.push(`tenant notes: ${other}`);
  if (ruledOut > 0) {
    parts.push(`ruled out ${ruledOut} common cause${ruledOut === 1 ? "" : "s"} in triage`);
  }
  return parts.join(" — ").slice(0, 400);
}

function triageWithRules(title: string, history: Message[], intake: Intake | null): TriageResult {
  const tenantTurns = history.filter((m) => m.author === "tenant");
  const botTurns = history.filter((m) => m.author === "bot");
  const latest = norm(tenantTurns.at(-1)?.body ?? "");
  const titleText = norm(title);
  const all = norm([title, ...tenantTurns.map((m) => m.body)].join(" \n "));

  // With a structured intake the tenant has told us which issue this is, so
  // the answer comes from that issue rather than from keyword matching. The
  // one exception is "not listed here", where the keywords are all we have.
  const issue = intake ? findIssue(intake.issue) : null;
  const book = issue && issue.id !== "unlisted"
    ? issuePlaybook(issue)
    : pickPlaybook(all, titleText);
  const category: Category = book?.category ?? issue?.category ?? "other";
  const label = title.trim() || "Maintenance request";

  // 1. Emergencies short-circuit everything.
  const emergency = issue?.urgent
    ? { why: issue.name.toLowerCase(), steps: issue.emergency?.steps ?? [] }
    : EMERGENCY.find((e) => hits(emergencyText(all), e.kw));
  if (emergency) {
    const steps = "steps" in emergency && emergency.steps.length
      ? emergency.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : `If anyone is in danger, leave and call emergency services — that comes before anything `
        + `here. If you can do it safely on your way out, shut off the valve or breaker feeding `
        + `whatever is causing it.`;
    return {
      reply: [
        `This reads like ${emergency.why}, so I am not going to have you troubleshoot it. `
        + `I have marked it urgent and put it at the top of your landlord's list.`,
        steps,
        `Tell me what is happening now and I will pass it straight on.`,
      ].join("\n\n"),
      action: "escalate",
      category: category === "other" ? "structural" : category,
      priority: "urgent",
      summary: `URGENT (${emergency.why}): ${
        intake && issue ? intakeSummary(intake, issue, [], tenantTurns, 0) : label
      }`,
    guides: [],
    engine: "rules",
    };
  }

  // The basics the form left open. These are asked before any troubleshooting,
  // and they are always the first replies on the thread — so how many have been
  // asked is simply how many replies there have been, capped at the gap count.
  const gaps = intake ? intakeGaps(intake).slice(0, MAX_GAP_QUESTIONS) : [];
  const botReplies = botTurns.length;
  const wantsHuman = hits(latest, WANTS_HUMAN);
  const summarize = (ruledOut: number) =>
    intake && issue ? intakeSummary(intake, issue, gaps, tenantTurns, ruledOut) : label;

  // 2. Tenant confirmed a fix worked. Only once a fix has actually been offered
  //    — "yes" in answer to "is it getting worse?" means the opposite.
  if (botReplies > gaps.length && hits(latest, YES) && !hits(latest, NO)) {
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
    guides: [],
    engine: "rules",
    };
  }

  // 3. Fill the gaps first: no decision until what, where, when and what was
  //    tried are all known.
  if (botReplies < gaps.length && !wantsHuman) {
    // "A couple of things" when there is one thing left is the same failure as
    // asking something already answered: it tells the tenant the reply was
    // assembled rather than written to them.
    const opening = botReplies === 0
      ? (gaps.length > 1
          ? "Thanks — a couple of quick things before we work out what this is.\n\n"
          : "Thanks — one thing before we work out what this is.\n\n")
      : "Got it. ";
    return {
      reply: opening + gaps[botReplies]!.ask,
      action: "ask",
      category,
      priority: book?.priority ?? issue?.priority ?? "normal",
      summary: summarize(0),
    guides: [],
    engine: "rules",
    };
  }
  // How far into the troubleshooting we are, gap questions aside.
  const phase = botReplies - gaps.length;

  // 4. First real reply: say what is probably going on and what would confirm it.
  if (phase === 0 && !wantsHuman) {
    if (book && book.checks.length) {
      return {
        reply: explain(
          book,
          gaps.length
            ? "That is everything I need. Let me see if we can work this out before anyone has to come out."
            : "Thanks — let me see if we can work out what this is before anyone has to come out.",
        ),
        action: "ask",
        category,
        priority: book.priority,
        summary: summarize(0),
        guides: guidesOf(book.checks),
    engine: "rules",
      };
    }
    // The basics are covered and there is nothing safe to try — straight on the list.
    if (intake) {
      return {
        reply:
          "That is everything I need, and this is not one with a reset button — it needs your "
          + "landlord.\n\nIt is on their list with these details attached, so you will not have to "
          + "explain it again. Their replies come back in this same thread.",
        action: "escalate",
        category,
        priority: book?.priority ?? issue?.priority ?? "normal",
        summary: summarize(0),
    guides: [],
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
    guides: [],
    engine: "rules",
    };
  }

  // 5. They answered but it is not fixed — give the reasoning behind what is left.
  if (book && !wantsHuman && phase === 1 && book.checks.length > 1) {
    const rest = book.checks.slice(1)
      .map((c, i) => `${i + 1}. ${c.do}${c.means ? `\n   ${c.means}` : ""}`)
      .join("\n");
    // The issue's second follow-up, when the intake gave us one.
    const followUp = issue?.questions[1] ? `\n\n${issue.questions[1]}` : "";
    return {
      reply:
        `Right — that rules out the easy one. What is left before this needs someone:\n\n${rest}`
        + `\n\nIf neither changes anything, say so and I will hand it over with everything we have `
        + `ruled out, so nobody starts from scratch.${followUp}`,
      action: "ask",
      category,
      priority: book.priority,
      summary: summarize(1),
      guides: guidesOf(book.checks.slice(1)),
    engine: "rules",
    };
  }

  // 6. Out of road — hand it over with what was learned.
  const ruledOut = Math.min(Math.max(phase, 0), book?.checks.length ?? 0);
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
    priority: book?.priority ?? issue?.priority ?? "normal",
    summary: intake
      ? summarize(ruledOut)
      : ruledOut > 0
        ? `${label} — tenant ruled out ${ruledOut} common cause${ruledOut === 1 ? "" : "s"}, still unresolved`
        : label,
    guides: [],
    engine: "rules",
  };
}

/* ------------------------------------------------------------------ Public */

/**
 * Triage one turn of a request.
 *
 * `intake` is the structured form the tenant filled in when they raised it, if
 * they raised it that way. Both engines use it the same way: the four basics it
 * covers are not asked again, the ones it left open are asked before anything
 * else, and an issue the tenant flagged as an emergency stays urgent whatever
 * the engine says.
 */
export async function triage(
  title: string,
  history: Message[],
  intake: Intake | null = null,
): Promise<TriageResult> {
  let result: TriageResult | null = null;
  if (usingClaude) {
    try {
      result = await triageWithClaude(title, history, intake);
    } catch (err) {
      console.error("[bot] Claude triage failed, falling back to rules:", err);
    }
  }
  result ??= triageWithRules(title, history, intake);

  const issue = intake ? findIssue(intake.issue) : null;
  if (issue?.urgent && result.action !== "resolved") {
    result = { ...result, priority: "urgent", category: issue.category };
  }
  return result;
}
