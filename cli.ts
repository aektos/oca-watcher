#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { fetchAllSlots, type Slot } from "./scraper.js";
import { buildMail, sendMail, notifyTermux, notifyNtfy, notifyGithubIssue } from "./notifier.js";

try {
  process.loadEnvFile();
} catch {
  /* pas de .env, on utilise l'environnement */
}

const DEFAULT_URL =
  "https://www.oca.eu/fr/visites-individuels/cat-public-fr/visites/visite-jep-nice";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string", short: "u", default: DEFAULT_URL },
    interval: { type: "string", short: "i", default: "120" },
    once: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "notify-unknown": { type: "boolean", default: false },
    filter: { type: "string", short: "f" },
    state: { type: "string", default: ".oca-state.json" },
    "test-email": { type: "boolean", default: false },
    termux: { type: "boolean", default: false },
    "github-issue": { type: "boolean", default: false },
    "mail-to": { type: "string", short: "m", multiple: true },
    "mail-cmd": { type: "string", default: "sendmail -t -oi" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (opt.help) {
  console.log(`oca-watcher – alerte email quand une place se libère

Options:
  -u, --url <url>          Page liste à surveiller (défaut: JEP Nice)
  -i, --interval <sec>     Intervalle entre deux vérifs (défaut 120, min 30)
  -f, --filter <texte>     Ne garder que les créneaux dont la date contient ce texte (ex: "20/09")
      --once               Une seule vérification puis sortie (pour cron)
      --dry-run            N'envoie pas d'email, affiche seulement
      --notify-unknown     Alerter aussi si le statut n'est pas reconnu
      --state <fichier>    Fichier d'état anti-doublon (défaut .oca-state.json)
  -m, --mail-to <email>    Destinataire email (répétable) ; envoi via la commande locale
      --mail-cmd <cmd>     Commande d'envoi lisant le mail sur stdin (défaut "sendmail -t -oi")
      --github-issue       Ouvre une issue GitHub (email + notif app GitHub) – dans GitHub Actions
      --termux             Notification Android locale (Termux:API)
      --test-email         Envoie une alerte de test sur tous les canaux configurés`);
  process.exit(0);
}

const ts = () => new Date().toLocaleTimeString("fr-FR");
const log = (...a: unknown[]) => console.log(`[${ts()}]`, ...a);
const ICON: Record<Slot["status"], string> = { OPEN: "🟢", FULL: "🔴", CLOSED: "⚫", UNKNOWN: "🟡" };

async function loadState(): Promise<Set<string>> {
  try {
    return new Set(JSON.parse(await readFile(opt.state!, "utf8")));
  } catch {
    return new Set();
  }
}
const saveState = (s: Set<string>) => writeFile(opt.state!, JSON.stringify([...s], null, 2));

async function check(): Promise<void> {
  let slots = await fetchAllSlots(opt.url!);
  if (opt.filter) slots = slots.filter((s) => s.date.includes(opt.filter!));
  if (slots.length === 0) {
    log("⚠️  Aucun créneau trouvé : la structure de la page a peut-être changé.");
    return;
  }

  const counts = slots.reduce<Record<string, number>>((a, s) => ((a[s.status] = (a[s.status] ?? 0) + 1), a), {});
  log(`${slots.length} créneaux –`, Object.entries(counts).map(([k, v]) => `${ICON[k as Slot["status"]]} ${k}:${v}`).join("  "));

  const wanted = (s: Slot) => s.status === "OPEN" || (opt["notify-unknown"] && s.status === "UNKNOWN");
  const notified = await loadState();

  // un créneau redevenu complet pourra re-déclencher une alerte plus tard
  for (const s of slots) if (!wanted(s)) notified.delete(s.slug);

  const toNotify = slots.filter((s) => wanted(s) && !notified.has(s.slug));
  if (toNotify.length) {
    toNotify.forEach((s) => log(`${ICON[s.status]} ${s.date} → ${s.url}`));
    const mail = buildMail(toNotify, opt.url!);
    if (opt["dry-run"]) log("(dry-run) alerte non envoyée :", mail.subject);
    else await alert(mail, toNotify[0].url, toNotify);
    toNotify.forEach((s) => notified.add(s.slug));
  }
  await saveState(notified);
}

async function alert(mail: ReturnType<typeof buildMail>, url: string, slots: Slot[] = []) {
  const channels: [string, () => Promise<void>][] = [];
  if (opt.termux) channels.push(["🔔 Notification Termux", () => notifyTermux(mail, url)]);
  if (process.env.NTFY_TOPIC) channels.push(["📲 Push ntfy", () => notifyNtfy(mail, url)]);
  if (opt["github-issue"])
    channels.push(["🐙 Issue GitHub", () => notifyGithubIssue(mail, slots.length ? slots : [{ date: "test", url }])]);
  const to = opt["mail-to"] ?? [];
  if (to.length) channels.push(["📧 Email", () => sendMail(mail, to, opt["mail-cmd"])]);
  if (!channels.length) throw new Error("Aucun canal d'alerte : utilise --mail-to, --github-issue, --termux ou définis NTFY_TOPIC");

  const results = await Promise.allSettled(channels.map(([, fn]) => fn()));
  results.forEach((r, i) =>
    log(r.status === "fulfilled" ? `${channels[i][0]} envoyé` : `❌ ${channels[i][0]} : ${(r.reason as Error).message}`),
  );
  if (results.every((r) => r.status === "rejected")) throw new Error("Toutes les alertes ont échoué");
}

async function main() {
  if (opt["test-email"]) {
    await alert({ subject: "OCA watcher – test", text: "Ça marche ✅", html: "<p>Ça marche ✅</p>" }, opt.url!);
    return;
  }

  const intervalMs = Math.max(30, Number(opt.interval)) * 1000;
  let running = true;
  process.on("SIGINT", () => {
    running = false;
    log("Arrêt.");
    process.exit(0);
  });

  log(`Surveillance de ${opt.url}${opt.once ? "" : ` toutes les ${intervalMs / 1000}s`}`);
  do {
    try {
      await check();
    } catch (e) {
      log("❌", e instanceof Error ? e.message : e);
      if (opt.once) process.exitCode = 1;
    }
    if (opt.once) break;
    // petit jitter pour ne pas taper le serveur à heure fixe
    await new Promise((r) => setTimeout(r, intervalMs + Math.random() * 10_000));
  } while (running);
}

main().catch((e) => {
  log("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
