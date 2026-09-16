export type SlotStatus = "OPEN" | "FULL" | "CLOSED" | "UNKNOWN";

export interface Slot {
  slug: string;
  title: string;
  url: string;
  date: string; // "19/09/2026 09:00 - 10:00"
  deadline?: Date;
  placesLeft?: number;
  status: SlotStatus;
}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 oca-watcher";

const FULL_RE =
  /event is now full|could not accept more registration|\bcomplet\b|n['’]acceptons plus|plus de places/i;
const REGISTER_RE =
  /individual-registration|group-registration|task=register|s['’]inscrire|r[ée]server\b|inscription individuelle|>\s*register\s*</i;
const PLACES_RE = /places?\s+(?:disponibles?|restantes?)\s*:?\s*(\d+)/i;

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

const toText = (html: string) =>
  decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();

function parseFrDate(s: string): Date | undefined {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [, d, mo, y, h, mi] = m;
  // Heure de Paris (CEST en septembre = UTC+2)
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:00+02:00`);
}

/** Parse une page de liste Joomla Event Booking. */
export function parseListPage(html: string, pageUrl: string): Slot[] {
  const category = new URL(pageUrl).pathname.split("/").filter(Boolean).pop()!;
  const esc = category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const titleRe = new RegExp(
    `<h[1-4][^>]*>\\s*(?:<[^>]+>\\s*)*<a[^>]+href="([^"]*\\/${esc}\\/([^"/?#]+))"[^>]*>([\\s\\S]*?)<\\/a>`,
    "gi",
  );

  const hits = [...html.matchAll(titleRe)];
  const slots: Slot[] = [];

  hits.forEach((m, i) => {
    const start = m.index!;
    let end = i + 1 < hits.length ? hits[i + 1].index! : html.length;
    if (i + 1 === hits.length) {
      // dernier bloc : on coupe avant la pagination / le footer
      const cut = html.slice(start).search(/class="[^"]*pagination|<footer/i);
      end = cut > 0 ? start + cut : Math.min(html.length, start + 8000);
    }
    const block = html.slice(start, end);
    const text = toText(block);

    const date =
      text.match(/Date de l['’][ée]v[ée]nement\s*:?\s*(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(?:\s*-\s*\d{2}:\d{2})?)/i)?.[1] ??
      text.match(/\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(?:\s*-\s*\d{2}:\d{2})?/)?.[0] ??
      "?";
    const deadlineStr = text.match(/Date butoir\s*:?\s*(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/i)?.[1];
    const deadline = deadlineStr ? parseFrDate(deadlineStr) : undefined;
    const placesMatch = text.match(PLACES_RE);
    const placesLeft = placesMatch ? Number(placesMatch[1]) : undefined;

    let status: SlotStatus;
    const startDate = parseFrDate(date);
    if ((deadline && deadline < new Date()) || (startDate && startDate < new Date())) status = "CLOSED";
    else if (FULL_RE.test(text) || placesLeft === 0) status = "FULL";
    else if (REGISTER_RE.test(block) || (placesLeft ?? 0) > 0) status = "OPEN";
    else status = "UNKNOWN";

    slots.push({
      slug: m[2],
      title: toText(m[3]),
      url: new URL(decode(m[1]), pageUrl).href,
      date,
      deadline,
      placesLeft,
      status,
    });
  });

  return slots;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "fr-FR,fr;q=0.9", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.text();
}

/** Récupère toutes les pages (?start=0, 10, 20…). */
export async function fetchAllSlots(baseUrl: string, pageSize = 10, maxPages = 10): Promise<Slot[]> {
  const all = new Map<string, Slot>();
  for (let p = 0; p < maxPages; p++) {
    const u = new URL(baseUrl);
    u.searchParams.set("start", String(p * pageSize));
    const slots = parseListPage(await fetchHtml(u.href), u.href);
    const fresh = slots.filter((s) => !all.has(s.slug));
    if (fresh.length === 0) break; // plus de page (Joomla renvoie la dernière en boucle)
    fresh.forEach((s) => all.set(s.slug, s));
    if (slots.length < pageSize) break;
  }
  return [...all.values()];
}
