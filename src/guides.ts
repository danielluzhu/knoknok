/**
 * What a tenant may fix themselves, and where to read how.
 *
 * Two things live here, and they belong together.
 *
 * THE RULE. "Easy" on a DIY site means easy for a homeowner. A tenant is not
 * one: the fixtures are the landlord's, the lease usually reserves repairs to
 * them, and a repair that goes wrong comes out of a deposit — or worse. So the
 * test for suggesting a fix is not how hard it is but whose it is, and it is
 * written out once below and handed to both triage engines.
 *
 * THE GUIDES. Where one of those fixes has a good walkthrough, the assistant
 * attaches a link to it. The links come only from this list — the model picks
 * an id, never writes a URL — so every link a tenant is shown is one somebody
 * opened, read, and checked covers the step being suggested. A guide that also
 * goes further (replacing the part, say) is noted as such; the assistant's own
 * words say which part is the tenant's.
 */

export const TENANT_FIX_RULE = `A tenant may be walked through a fix only if ALL of these hold:
- It resets, cleans, clears or adjusts something (a GFCI or breaker handle, a trap, a lint
  screen, an aerator, a setting), or swaps a consumable (a battery, a bulb, an air filter). It
  never replaces a fixture or a part that is plumbed or wired in.
- It needs no tools beyond what a renter plausibly owns: hands, a bucket, a plunger, a towel, a
  screwdriver, household vinegar.
- Nothing is opened that has a cover screwed over live parts, gas, or a heating element: no panel
  covers, no outlet or switch plates, no water heater, no furnace cabinet beyond its filter slot.
- If it does not work, nothing is worse than before. Anything where a mistake floods, shocks,
  or voids something is the landlord's.
How easy a DIY site rates a job is not the test. Swapping a faucet or a light switch is rated
beginner-level and is still not a tenant's job.`;

export interface Guide {
  id: GuideId;
  /** The page's own title, so the tenant knows what they are opening. */
  title: string;
  /** Who wrote it, shown beside the link. */
  source: string;
  url: string;
}

/**
 * Hosts a guide may link to. Anything else fails the tests.
 *
 * Mostly manufacturers — they wrote the manual for the thing in the flat — then
 * a safety regulator and three long-running DIY publishers for the jobs no
 * manufacturer covers. Home Depot, Lowe's and wikiHow would be welcome, but
 * none of their pages could be opened to check (all three refuse automated
 * requests), and an unchecked link is exactly what this list exists to avoid.
 * They stay allowed so a page someone checks by hand can be added.
 */
export const GUIDE_HOSTS = [
  // Manufacturers and utilities
  "leviton.com", "energized.edison.com", "fluidmaster.com", "www.korky.com",
  "www.insinkerator.com", "docs.honeywellhome.com", "www.carrier.com", "www.kidde.com",
  "producthelp.whirlpool.com", "producthelp.maytag.com", "products.geappliances.com",
  "reveal.kohler.com",
  // Safety regulators
  "www.cpsc.gov",
  // DIY publishers
  "www.bobvila.com", "www.familyhandyman.com", "www.thisoldhouse.com",
  "www.homedepot.com", "www.wikihow.com", "www.lowes.com",
];

export const GUIDE_IDS = [
  "gfci-reset", "breaker-reset", "plunge-sink", "clean-p-trap", "toilet-flapper",
  "plunge-toilet", "clean-aerator", "disposal-reset", "thermostat-batteries", "hvac-filter",
  "smoke-alarm-chirp", "dishwasher-filter", "dryer-lint", "washer-wont-start",
  "fridge-not-cooling", "showerhead-soak", "sticky-window", "co-alarm",
] as const;

export type GuideId = (typeof GUIDE_IDS)[number];

const g = (id: GuideId, source: string, title: string, url: string): Guide =>
  ({ id, source, title, url });

/**
 * Every guide, checked by hand. To add one: open it, read it, make sure the
 * step the assistant suggests is the one the page walks through, and note it
 * here if the page goes further than a tenant should.
 */
export const GUIDES: Partial<Record<GuideId, Guide>> = {
  "gfci-reset": g("gfci-reset", "Leviton",
    "How to reset a GFCI outlet",
    "https://leviton.com/support/literature/blogs/how-to-reset-a-gfci-outlet-after-lockout--a-step-by-step-guide"),
    // Also covers rewiring and replacing the outlet. Only the RESET part is the tenant's.
  "breaker-reset": g("breaker-reset", "Southern California Edison",
    "A step-by-step guide to safely resetting your breakers",
    "https://energized.edison.com/stories/a-step-by-step-guide-to-safely-resetting-your-breakers"),
    // Says "open the cover" meaning the panel door; our own wording says door, never the cover.
  "plunge-sink": g("plunge-sink", "Bob Vila",
    "How to use a plunger the right way",
    "https://www.bobvila.com/articles/how-to-use-a-plunger/"),
    // Also covers snakes and baking soda; the cup-plunger section is the step.
  "clean-p-trap": g("clean-p-trap", "Family Handyman",
    "Everything you need to know about P-traps",
    "https://www.familyhandyman.com/article/what-is-a-p-trap/"),
    // Mentions pliers for stuck nuts; our wording says stop if they won't turn by hand.
  "toilet-flapper": g("toilet-flapper", "Fluidmaster",
    "How to identify and fix toilet flapper leaks",
    "https://fluidmaster.com/toilet-problems/identify-fix-toilet-flapper-leaks/"),
    // Also suggests replacing an old flapper; the check-and-adjust part is the tenant's.
  "plunge-toilet": g("plunge-toilet", "Korky",
    "How to plunge a toilet",
    "https://www.korky.com/toilet-repair-help/how-to-plunge-a-toilet"),
  "clean-aerator": g("clean-aerator", "This Old House",
    "How to clean a clogged faucet aerator",
    "https://www.thisoldhouse.com/plumbing/21124360/how-to-clean-clogged-faucet-aerator"),
  "disposal-reset": g("disposal-reset", "InSinkErator",
    "Fixing a jammed garbage disposal",
    // The double slash is the site's own.
    "https://www.insinkerator.com/en-us/support//fixing-a-jammed-garbage-disposal"),
  "thermostat-batteries": g("thermostat-batteries", "Honeywell Home",
    "Thermostat battery replacement (FocusPRO)",
    "https://docs.honeywellhome.com/focuspro-n100-im/en-us/Content/Installation-Manual/Battery%20Replacement.htm"),
    // One model's manual — the most common layout, and no general page exists.
  "hvac-filter": g("hvac-filter", "Carrier",
    "Furnace filter replacement: the how and why",
    "https://www.carrier.com/us/en/residential/hvac-resources/furnaces/changing-furnace-filters/"),
    // Assumes the filter is behind the blower door; many rentals use a return grille.
  "smoke-alarm-chirp": g("smoke-alarm-chirp", "Kidde",
    "How do I replace my smoke alarm's battery?",
    "https://www.kidde.com/support/smoke-alarms/battery-replacement"),
  "dishwasher-filter": g("dishwasher-filter", "Whirlpool",
    "How to clean the dishwasher filters",
    "https://producthelp.whirlpool.com/Dishwashers/Product_Info/Dishwasher_Cleaning_and_Care/How_to_Clean_the_Dishwasher_Filters"),
  "dryer-lint": g("dryer-lint", "Whirlpool",
    "How to check dryer venting",
    "https://producthelp.whirlpool.com/Laundry/Dryers/Product_Info/Dryer_Product_Assistance/How_to_Check_Venting"),
  "washer-wont-start": g("washer-wont-start", "Maytag",
    "Washer not starting",
    "https://producthelp.maytag.com/Laundry/Washers/Top_Load_Washer/Operation/Not_Operating/Not_Starting_-_Washer"),
  "fridge-not-cooling": g("fridge-not-cooling", "GE Appliances",
    "Refrigerator not cooling enough",
    "https://products.geappliances.com/appliance/gea-support-search-content?contentId=21185"),
  "showerhead-soak": g("showerhead-soak", "Kohler",
    "Common showerhead problems and how to fix them",
    "https://reveal.kohler.com/en/articles/common-showerhead-problems-and-how-to-fix-them"),
    // The vinegar-bag method is the step; it also suggests replacement.
  "sticky-window": g("sticky-window", "Bob Vila",
    "How to clean window tracks",
    "https://www.bobvila.com/articles/how-to-clean-window-tracks/"),
  "co-alarm": g("co-alarm", "U.S. Consumer Product Safety Commission",
    "Carbon monoxide fact sheet",
    "https://www.cpsc.gov/safety-education/safety-guides/carbon-monoxide/carbon-monoxide-fact-sheet"),
};

export function guide(id: string): Guide | null {
  return (GUIDES as Record<string, Guide | undefined>)[id] ?? null;
}

/** Known guides only, de-duplicated, in the order given. */
export function guidesFor(ids: readonly string[]): Guide[] {
  const seen = new Set<string>();
  const out: Guide[] = [];
  for (const id of ids) {
    const found = guide(id);
    if (found && !seen.has(id)) {
      seen.add(id);
      out.push(found);
    }
  }
  return out;
}

/** The catalogue, as the model sees it: ids it may pick, and what each covers. */
export function guideMenu(): string {
  return Object.values(GUIDES)
    .filter((x): x is Guide => Boolean(x))
    .map((x) => `- ${x.id}: ${x.title} (${x.source})`)
    .join("\n");
}
