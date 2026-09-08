/**
 * Structured intake: what a tenant tells us before the assistant is allowed to
 * decide anything.
 *
 * A request is not one free-text box any more. The tenant picks a category,
 * narrows it to an issue, and then fills in the four things every diagnosis
 * needs — WHAT is broken, WHERE it is, WHEN it started, and anything else
 * (what they tried, is it getting worse). The bot asks for whichever of those
 * the form left open before it troubleshoots, and reaches a decision only once
 * all four are covered.
 *
 * The tree lives here, once, and is served to the front end from
 * `GET /api/intake`, so the form the tenant fills in and the bot that reads it
 * can never disagree about what an issue is called.
 */
import type { Category } from "./bot";
import type { Priority } from "./db";

export interface Issue {
  id: string;
  name: string;
  /** Examples shown under the name, so the tenant picks the right one. */
  eg: string;
  /** Which knoknok category a request for this issue is filed under. */
  category: Category;
  priority: Priority;
  /** Skip troubleshooting and escalate as urgent on the first message. */
  urgent?: boolean;
  /** What to do right now, shown before anything else for an urgent issue. */
  emergency?: { title: string; steps: string[] };
  /** Whether "when did it start" changes the diagnosis. Optional otherwise. */
  whenMatters: boolean;
  /** Issue-specific follow-ups, asked after the four basics are covered. */
  questions: string[];
  /** Safe things the tenant can try themselves. Empty means it needs a person. */
  tips: string[];
}

export interface IssueGroup {
  id: string;
  name: string;
  eg: string;
  issues: Issue[];
}

/** Where in the home. Free text is accepted too; these are the one-tap options. */
export const ROOMS = [
  "Kitchen", "Bathroom", "Bedroom", "Living room", "Hallway or entry",
  "Laundry", "Balcony or patio", "Whole unit", "Common area",
];

/** When it started. */
export const WHENS = ["Just now", "Today", "A few days", "Over a week", "Comes and goes"];

const EMERGENCY_LINE = "your landlord's emergency line";

export const INTAKE: IssueGroup[] = [
  { id: "plumbing", name: "Plumbing", eg: "Leaks, clogs, toilets, hot water", issues: [
    { id: "leak", name: "Leak or dripping water", eg: "Under a sink, a faucet, a ceiling",
      category: "plumbing", priority: "normal", whenMatters: true,
      questions: [
        "Is it a steady drip, or only when something is running?",
        "Is anything below it getting damaged, like a cabinet floor or drywall?",
      ],
      tips: [
        "Turn the small shut-off valve under the fixture clockwise to stop the supply.",
        "Put a bucket or towel under the drip and move anything that could be damaged.",
      ] },
    { id: "clog", name: "Drain clogged or slow", eg: "Sink, tub, or shower",
      category: "plumbing", priority: "normal", whenMatters: true,
      questions: [
        "Completely blocked, or just slow?",
        "Are the other drains in the unit draining normally?",
      ],
      tips: [
        "Try a plunger with an inch of standing water so the cup seals. A cup plunger works best on sinks and tubs.",
        "Skip chemical drain cleaners. They damage pipes and make the plumber's job unsafe.",
      ] },
    { id: "toilet", name: "Toilet problem", eg: "Won't flush, runs constantly, overflows",
      category: "plumbing", priority: "high", whenMatters: false,
      questions: [
        "Which is it: won't flush, runs constantly, or overflows?",
        "Has a plunger helped at all?",
      ],
      tips: [
        "If it's overflowing, turn the valve behind the toilet clockwise to shut off the water right away.",
        "For a weak flush, plunge with a flange plunger. For constant running, lift the tank lid and check that the flapper is seated flat.",
      ] },
    { id: "nohot", name: "No hot water", eg: "Cold or lukewarm at every tap",
      category: "plumbing", priority: "high", whenMatters: true,
      questions: [
        "Is it no hot water at all, or just lukewarm?",
        "Is it every tap, or one fixture?",
      ],
      tips: [
        "Check two different taps to confirm it's the whole unit.",
        "If you have a gas water heater and the pilot is out, do not relight it yourself. Report it and someone will come.",
      ] },
    { id: "pressure", name: "Low pressure or no water", eg: "One fixture or the whole unit",
      category: "plumbing", priority: "normal", whenMatters: true,
      questions: [
        "Is it one fixture or the whole unit?",
        "Hot, cold, or both?",
      ],
      tips: [
        "For one faucet, unscrew the aerator at the tip and rinse out the grit.",
        "If it's the whole unit, check whether a neighbour has the same issue. It may be a building shut-off.",
      ] },
    { id: "flood", name: "Flooding or burst pipe", eg: "Water you can't stop",
      category: "plumbing", priority: "urgent", urgent: true, whenMatters: false,
      emergency: { title: "Shut off the water first", steps: [
        "Turn the shut-off valve under the nearest fixture, or the main valve for the unit, clockwise until it stops.",
        "Move belongings and electronics off the floor. Keep away from outlets near the water.",
        `Call ${EMERGENCY_LINE}. This request is flagged as an emergency.`,
      ] },
      questions: ["Were you able to stop the water?", "Is water reaching another unit or the hallway?"],
      tips: [] },
  ]},
  { id: "electrical", name: "Electrical", eg: "Outlets, breakers, lights", issues: [
    { id: "outlet", name: "Outlet or switch not working", eg: "Dead outlet, switch does nothing",
      category: "electrical", priority: "normal", whenMatters: false,
      questions: [
        "Is it just one, or several in the same area?",
        "Did something trip when you plugged in a hair dryer, space heater, or similar?",
      ],
      tips: [
        "Kitchen, bathroom, and outdoor outlets are usually on a GFCI. Find the outlet with RESET and TEST buttons nearby and press RESET firmly.",
        "Open the breaker panel and look for a switch sitting between ON and OFF. Push it fully OFF, then back ON.",
      ] },
    { id: "breaker", name: "Breaker keeps tripping", eg: "Resets, then trips again",
      category: "electrical", priority: "high", whenMatters: true,
      questions: [
        "What was running when it tripped: a space heater, microwave, AC unit, or something else?",
        "Does it trip immediately after you reset it, even with everything unplugged?",
      ],
      tips: [
        "Unplug everything on that circuit, reset the breaker once, then plug things back in one at a time to find the load that trips it.",
        "If it trips with nothing plugged in, leave it off and report it. Don't keep resetting it.",
      ] },
    { id: "lights", name: "Lights flickering or out", eg: "One fixture or several",
      category: "electrical", priority: "low", whenMatters: true,
      questions: [
        "One fixture, or several rooms?",
        "Have you tried a new bulb in that fixture?",
      ],
      tips: [
        "Try a new bulb first. If the fixture uses a bulb you don't have, say which base type it takes.",
        "If several rooms flicker at once, that's a circuit issue. Avoid running high-draw appliances until it's checked.",
      ] },
    { id: "sparks", name: "Sparks, burning smell, or hot outlet", eg: "Any sign of overheating",
      category: "electrical", priority: "urgent", urgent: true, whenMatters: false,
      emergency: { title: "Stop using that outlet or fixture", steps: [
        "Unplug whatever is connected, if it is safe to touch.",
        "Switch off the breaker for that room if you can identify it.",
        `If you see smoke or flames, get out and call emergency services. Otherwise call ${EMERGENCY_LINE}.`,
      ] },
      questions: ["Is the outlet or fixture switched off now?", "Is the smell gone, or still present?"],
      tips: [] },
    { id: "nopower", name: "No power in the whole unit", eg: "Everything off at once",
      category: "electrical", priority: "urgent", whenMatters: true,
      questions: [
        "Do your neighbours or the hallway have power?",
        "Is the main breaker at the top of the panel in the ON position?",
      ],
      tips: [
        "Check the main breaker, the large one at the top of the panel. Push it fully OFF and back ON.",
        "If the hallway is also dark, it's likely a utility outage. Check the utility's outage map.",
      ] },
  ]},
  { id: "hvac", name: "Heating & cooling", eg: "No heat, no AC, thermostat", issues: [
    { id: "noheat", name: "No heat", eg: "Radiator or vents cold",
      category: "hvac", priority: "high", whenMatters: true,
      questions: [
        "Is the thermostat display on?",
        "Do you get any warm air or a warm radiator at all, or nothing?",
      ],
      tips: [
        "Set the thermostat to HEAT and at least 5 degrees above the current room temperature, then wait 10 minutes.",
        "If the display is blank, replace the thermostat batteries. Most take two AA.",
        "Check the furnace breaker in the panel. It's often labelled FURNACE or AIR HANDLER.",
      ] },
    { id: "noac", name: "No cooling", eg: "AC blows warm or not at all",
      category: "hvac", priority: "high", whenMatters: true,
      questions: [
        "Is air coming out of the vents at all?",
        "When was the filter last changed?",
      ],
      tips: [
        "Set the thermostat to COOL and at least 5 degrees below the room temperature.",
        "A clogged filter can freeze the coil. If you can see the filter, check whether it's grey with dust.",
        "Check the AC or CONDENSER breaker in the panel.",
      ] },
    { id: "thermostat", name: "Thermostat blank or unresponsive", eg: "Screen off, buttons do nothing",
      category: "hvac", priority: "normal", whenMatters: false,
      questions: ["Is the screen completely blank, or on but not responding?"],
      tips: [
        "Pull the thermostat off its base and replace the batteries. Most use two AA.",
        "If there are no batteries, check the FURNACE or AIR HANDLER breaker. The thermostat is powered from there.",
      ] },
    { id: "noise", name: "Noise or smell from vents", eg: "Banging, rattling, musty or burning",
      category: "hvac", priority: "normal", whenMatters: true,
      questions: [
        "What does it sound or smell like?",
        "Does it happen when the system starts, runs, or shuts off?",
      ],
      tips: [
        "A dusty burning smell for the first hour of the heating season is normal. It should clear on its own.",
        "If it's a sharp electrical or plastic burning smell, switch the system OFF at the thermostat and report it.",
      ] },
    { id: "gas", name: "Gas smell", eg: "Rotten-egg odour anywhere",
      category: "hvac", priority: "urgent", urgent: true, whenMatters: false,
      emergency: { title: "Leave the unit now", steps: [
        "Do not flip any switches, light anything, or use your phone inside.",
        "Open a window on your way out if it's right there, then leave.",
        `From outside, call the gas utility's emergency line, then ${EMERGENCY_LINE}.`,
      ] },
      questions: ["Are you outside the unit now?", "Have you called the gas utility?"],
      tips: [] },
  ]},
  { id: "appliance", name: "Appliance", eg: "Fridge, stove, dishwasher, laundry", issues: [
    { id: "fridge", name: "Refrigerator or freezer", eg: "Not cold, noisy, leaking",
      category: "appliance", priority: "high", whenMatters: true,
      questions: [
        "Is it not cooling, too cold, noisy, or leaking?",
        "Is the light on inside when you open the door?",
      ],
      tips: [
        "Check the temperature dial. It should be near the middle setting.",
        "Make sure the plug is seated and the outlet works. Try a lamp in it.",
        "Clear items away from the vents at the back inside, and check the door seal closes fully.",
      ] },
    { id: "stove", name: "Stove or oven", eg: "Burner, oven, igniter",
      category: "appliance", priority: "high", whenMatters: false,
      questions: [
        "Is it gas or electric?",
        "Is it one burner, all burners, or the oven?",
      ],
      tips: [
        "Electric: check the RANGE breaker. It's a double-wide one in the panel.",
        "Gas: if a burner clicks but won't light, dry the burner cap and make sure it's seated correctly. Never leave a gas burner turned on if it isn't lit.",
      ] },
    { id: "dishwasher", name: "Dishwasher", eg: "Won't start, drain, or clean",
      category: "appliance", priority: "normal", whenMatters: false,
      questions: [
        "Won't start, won't drain, or not cleaning well?",
        "Does the door latch click closed?",
      ],
      tips: [
        "Run the garbage disposal first. The dishwasher drains through it.",
        "Pull out the bottom rack and clean the filter at the base of the tub.",
      ] },
    { id: "laundry", name: "Washer or dryer", eg: "Won't start, drain, spin, or heat",
      category: "appliance", priority: "normal", whenMatters: false,
      questions: [
        "Washer or dryer, and is it won't start, won't drain or spin, or no heat?",
        "Any error code on the display?",
      ],
      tips: [
        "Dryer not heating: clean the lint trap and check the DRYER breaker, which is a double-wide one.",
        "Washer not spinning: the load may be unbalanced. Redistribute it and restart.",
      ] },
    { id: "disposal", name: "Garbage disposal", eg: "Hums, jammed, dead",
      category: "appliance", priority: "normal", whenMatters: false,
      questions: [
        "Does it hum when you flip the switch, or is it silent?",
        "Did something hard go down it, like a bone, a spoon, or a bottle cap?",
      ],
      tips: [
        "Silent: press the red RESET button on the bottom of the disposal under the sink.",
        "Humming: it's jammed. Turn it off, never put your hand in, and turn the hex socket on the bottom with an allen key to free it.",
      ] },
    { id: "otherappl", name: "Microwave or other appliance", eg: "Anything else that came with the unit",
      category: "appliance", priority: "normal", whenMatters: false,
      questions: ["What does it do, or not do, when you try it?"],
      tips: [
        "Check that it's plugged in and the outlet works.",
        "Unplug it for a full minute, then plug it back in. A quick off-on does nothing.",
      ] },
  ]},
  { id: "doors", name: "Doors, windows & locks", eg: "Locks, latches, glass, screens", issues: [
    { id: "nolock", name: "Door won't lock", eg: "Deadbolt or latch won't engage",
      category: "locks_security", priority: "urgent", urgent: true, whenMatters: false,
      emergency: { title: "The unit needs to be secured today", steps: [
        "If the door can be held shut, keep it shut and stay in.",
        `Call ${EMERGENCY_LINE}. A door that cannot lock is treated as an emergency.`,
      ] },
      questions: ["Is this the entry door?", "Does the bolt move at all?"],
      tips: [] },
    { id: "lockout", name: "Locked out or key won't turn", eg: "Can't get in",
      category: "locks_security", priority: "high", whenMatters: false,
      questions: ["Does the key go in but not turn, or not go in at all?"],
      tips: [
        "If the key goes in but sticks, a little graphite or dry lubricant helps. Don't force it.",
        `For a lockout, call the office during hours or ${EMERGENCY_LINE}.`,
      ] },
    { id: "lock", name: "Lock loose or stiff", eg: "Deadbolt, knob, latch",
      category: "locks_security", priority: "normal", whenMatters: false,
      questions: ["Does it still lock, just poorly?"],
      tips: [
        "If a knob or deadbolt is loose, the two screws on the inside plate can usually be snugged with a screwdriver.",
        "With the door open, throw the bolt. Smooth open but stiff when closed means alignment, which is a hinge or strike plate, not the lock.",
      ] },
    { id: "door", name: "Door won't close or latch", eg: "Sticks, rubs, swings open",
      category: "locks_security", priority: "normal", whenMatters: false,
      questions: ["Does it rub at the top, bottom, or side?"],
      tips: ["Tighten the hinge screws. A sagging door is often just a loose top hinge."] },
    { id: "window", name: "Window won't open, close, or is broken", eg: "Stuck, cracked, or off track",
      category: "structural", priority: "normal", whenMatters: false,
      questions: ["Is the glass cracked or broken?", "Is it stuck, or does it fall down when you open it?"],
      tips: [
        "If glass is broken, tape cardboard over it from the inside and keep pets and kids away.",
        "For a stuck window, check the locks are open on both sides before pushing.",
      ] },
    { id: "screen", name: "Screen torn or missing", eg: "Window or patio screen",
      category: "structural", priority: "low", whenMatters: false,
      questions: ["Torn, or missing entirely?"],
      tips: [] },
  ]},
  { id: "pests", name: "Pests", eg: "Mice, roaches, ants, bed bugs", issues: [
    { id: "rodents", name: "Mice or rats", eg: "Seen, heard, or droppings",
      category: "pest", priority: "high", whenMatters: true,
      questions: [
        "Have you seen one, or found droppings or gnaw marks?",
        "Can you see any gaps or holes where they might get in?",
      ],
      tips: [
        "Store food, including pet food, in sealed containers.",
        "Note where you find droppings. That tells the exterminator where to look.",
      ] },
    { id: "roaches", name: "Cockroaches", eg: "Any number",
      category: "pest", priority: "high", whenMatters: true,
      questions: ["Roughly how many have you seen?", "Day or night?"],
      tips: [
        "Wipe counters, empty the bin nightly, and dry the sink. Roaches need water most of all.",
        "Don't bomb or fog the unit. It scatters them into the neighbours.",
      ] },
    { id: "ants", name: "Ants or other insects", eg: "Ants, flies, spiders, silverfish",
      category: "pest", priority: "normal", whenMatters: true,
      questions: ["What kind of insect?", "Is there a food source nearby?"],
      tips: [
        "Follow the trail to the entry point and say where it is.",
        "Wipe the trail with soapy water to remove the scent path.",
      ] },
    { id: "bedbugs", name: "Bed bugs", eg: "Bites, spots on bedding",
      category: "pest", priority: "high", whenMatters: true,
      questions: [
        "Have you seen the bugs themselves, or bites and dark spots on sheets?",
        "Any recent travel or secondhand furniture?",
      ],
      tips: [
        "Don't move furniture or bedding to other rooms. It spreads them.",
        "Bag and wash bedding on hot, and dry on high heat.",
      ] },
    { id: "wasps", name: "Wasps, bees, or a nest", eg: "On a balcony, eave, or vent",
      category: "pest", priority: "high", whenMatters: false,
      questions: ["Is anyone in the unit allergic?"],
      tips: ["Keep the area clear and don't try to remove the nest yourself."] },
  ]},
  { id: "structure", name: "Walls, ceiling & floors", eg: "Stains, mold, cracks, tiles", issues: [
    { id: "stain", name: "Water stain or ceiling drip", eg: "Brown spot, bubbling paint",
      category: "structural", priority: "high", whenMatters: true,
      questions: [
        "Is it actively dripping, or just a stain?",
        "Is the spot damp or soft to the touch, and what is directly above it?",
      ],
      tips: [
        "If it's dripping, put a bucket under it and move anything below.",
        "If the ceiling is bulging, don't poke it. Keep out from under it.",
      ] },
    { id: "mold", name: "Mold or mildew", eg: "Black or green spots, musty smell",
      category: "structural", priority: "high", whenMatters: true,
      questions: [
        "Roughly how big an area?",
        "Is there an exhaust fan in that room, and does it work?",
      ],
      tips: [
        "Run the bathroom fan during and after showers and keep the door open afterwards.",
        "Small surface spots on tile or paint can be wiped with diluted white vinegar.",
      ] },
    { id: "crack", name: "Crack or hole", eg: "Drywall, plaster, tile",
      category: "structural", priority: "normal", whenMatters: false,
      questions: ["How big is it, and did something cause it or did it appear on its own?"],
      tips: [] },
    { id: "floor", name: "Floor damage", eg: "Loose tile, lifting laminate, soft spot",
      category: "structural", priority: "normal", whenMatters: true,
      questions: ["Loose, lifting, cracked, or soft underfoot?", "Is there any water nearby?"],
      tips: ["Cover a lifted edge with a mat so no one trips on it."] },
  ]},
  { id: "other", name: "Something else", eg: "Detectors, common areas, anything unlisted", issues: [
    { id: "detector", name: "Smoke or CO detector beeping", eg: "Chirping or alarming",
      category: "other", priority: "high", whenMatters: false,
      questions: ["A chirp every 30 to 60 seconds, or a continuous alarm?"],
      tips: [
        "A single chirp every minute is a low battery. Twist the detector off its base and replace the 9V or AA battery.",
        "A continuous alarm with no smoke: press and hold the TEST button to silence it, then open windows. If it keeps alarming, leave and call the emergency line.",
      ] },
    { id: "common", name: "Common area or building exterior", eg: "Hallway, laundry room, lobby, stairs",
      category: "common_area", priority: "normal", whenMatters: false,
      questions: ["Is it blocking access to anything, or a fire route?"],
      tips: [] },
    { id: "unlisted", name: "Not listed here", eg: "Tell us on the next step",
      category: "other", priority: "normal", whenMatters: true,
      questions: ["What does it do, or not do?"],
      tips: [] },
  ]},
];

const BY_ID = new Map<string, Issue>();
for (const g of INTAKE) for (const i of g.issues) BY_ID.set(i.id, i);

export function findIssue(id: unknown): Issue | null {
  return typeof id === "string" ? BY_ID.get(id) ?? null : null;
}

/** The four basics, as the tenant gave them. Stored on the ticket as JSON. */
export interface Intake {
  issue: string;
  what: string;
  room: string;
  spot: string;
  when: string;
  trigger: string;
  notes: string;
}

const clip = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

/**
 * Read an intake off a request body. Returns a message rather than throwing
 * when it is unusable, so the caller can tell the tenant which part was.
 * `null` means no intake was sent at all — the free-text path.
 */
export function parseIntake(raw: unknown): Intake | string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") return "That request could not be read.";
  const b = raw as Record<string, unknown>;
  const issue = findIssue(b.issue);
  if (!issue) return "Pick what kind of problem it is first.";
  const intake: Intake = {
    issue: issue.id,
    what: clip(b.what, 120),
    room: clip(b.room, 60),
    spot: clip(b.spot, 160),
    when: clip(b.when, 60),
    trigger: clip(b.trigger, 200),
    notes: clip(b.notes, 2000),
  };
  if (intake.what.length < 2) return "Say what is broken — the fixture or appliance.";
  if (!intake.room) return "Say where it is.";
  return intake;
}

export const whereText = (d: Intake) => [d.room, d.spot].filter(Boolean).join(", ");
export const whenText = (d: Intake) =>
  [d.when, d.trigger && `Happens ${d.trigger}`].filter(Boolean).join(". ");

/** The tenant's first message, as the landlord and the bot both read it. */
export function intakeMessage(d: Intake): string {
  const lines = [`What: ${d.what}`, `Where: ${whereText(d)}`];
  if (whenText(d)) lines.push(`When: ${whenText(d)}`);
  if (d.notes) lines.push(`Other: ${d.notes}`);
  return lines.join("\n");
}

/** A title for the list: "Kitchen faucet: leak or dripping water". */
export function intakeTitle(d: Intake): string {
  const issue = findIssue(d.issue)!;
  const what = d.what.charAt(0).toUpperCase() + d.what.slice(1);
  // "Not listed here" is not a thing to put in a title; the tenant's own words are.
  if (issue.id === "unlisted") return what;
  return `${what}: ${issue.name.charAt(0).toLowerCase()}${issue.name.slice(1)}`;
}

export type GapKey = "what" | "where" | "when" | "other";

/**
 * Which of the four basics the form still left open — the same rule the form
 * enforces, carried into the conversation. The bot asks these, in this order,
 * before it troubleshoots. `what` and `room` are required by the form, so in
 * practice the gaps are the exact spot, the timing, and what was tried.
 */
export function intakeGaps(d: Intake): { key: GapKey; ask: string }[] {
  const issue = findIssue(d.issue);
  const gaps: { key: GapKey; ask: string }[] = [];
  if (d.what.length < 2) {
    gaps.push({ key: "what", ask: "First, what exactly is broken? Name the fixture or appliance." });
  }
  if (!d.room) {
    gaps.push({ key: "where", ask: "Which room is it in?" });
  } else if (!d.spot) {
    gaps.push({
      key: "where",
      ask: `Where exactly in the ${d.room.toLowerCase()}? Under the sink, by the window, the back-left burner — that sort of thing.`,
    });
  }
  if (!d.when && issue?.whenMatters) {
    gaps.push({ key: "when", ask: "When did this start, and does it happen all the time or only sometimes?" });
  }
  if (!d.notes) {
    gaps.push({ key: "other", ask: "Have you tried anything yet, and is it getting worse?" });
  }
  return gaps;
}

/** Everything the front end needs to draw the form. Nothing the bot keeps to itself. */
export function intakeForClient() {
  return {
    groups: INTAKE.map((g) => ({
      id: g.id, name: g.name, eg: g.eg,
      issues: g.issues.map((i) => ({
        id: i.id, name: i.name, eg: i.eg, category: i.category,
        urgent: Boolean(i.urgent), emergency: i.emergency ?? null,
        whenMatters: i.whenMatters, tips: i.tips,
      })),
    })),
    rooms: ROOMS,
    whens: WHENS,
  };
}
