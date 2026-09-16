import type { Slot } from "./scraper.js";

export interface Mail {
  subject: string;
  html: string;
  text: string;
}

export function buildMail(slots: Slot[], listUrl: string): Mail {
  const lines = slots.map(
    (s) => `• ${s.date}${s.placesLeft != null ? ` (${s.placesLeft} place(s))` : ""} → ${s.url}`,
  );
  const subject = `🔭 OCA : ${slots.length} créneau(x) disponible(s) – ${slots.map((s) => s.date).join(", ")}`;
  const text = `Place(s) disponible(s) !\n\n${lines.join("\n")}\n\nListe : ${listUrl}`;
  const html = `<h2>Place(s) disponible(s) 🎉</h2><ul>${slots
    .map(
      (s) =>
        `<li><b>${s.date}</b>${s.placesLeft != null ? ` – ${s.placesLeft} place(s)` : ""}${
          s.status === "UNKNOWN" ? " <i>(statut incertain, à vérifier)</i>" : ""
        } – <a href="${s.url}">Réserver</a></li>`,
    )
    .join("")}</ul><p><a href="${listUrl}">Voir la liste complète</a></p>`;
  return { subject, html, text };
}

const encodeHeader = (v: string) =>
  /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;

/**
 * Envoie l'email via une commande locale compatible sendmail (lit le message complet sur stdin).
 * Par défaut : `sendmail -t -oi` (fourni par postfix, exim, msmtp-mta, ssmtp…).
 */
export async function sendMail(mail: Mail, to: string[], cmd = "sendmail -t -oi"): Promise<void> {
  if (!to.length) throw new Error("Aucun destinataire (--mail-to)");
  const { spawn } = await import("node:child_process");
  const boundary = `oca-${Date.now().toString(36)}`;
  const message = [
    `To: ${to.join(", ")}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(mail.text, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(mail.html, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", cmd], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`« ${cmd} » a échoué (code ${code}) ${stderr.trim()}`)),
    );
    child.stdin.end(message);
  });
}

/** Notification Android via Termux:API (tap = ouvre la page de réservation). */
export async function notifyTermux(mail: Mail, url: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const run = (cmd: string, args: string[]) =>
    new Promise<void>((resolve, reject) =>
      execFile(cmd, args, (err) => (err ? reject(err) : resolve())),
    );
  await run("termux-notification", [
    "--id", "oca-watcher",
    "--title", "🔭 Place OCA disponible !",
    "--content", mail.text,
    "--priority", "high",
    "--sound",
    "--vibrate", "500,300,500,300,800",
    "--action", `termux-open-url ${url}`,
  ]);
}

/** Push vers l'app ntfy (https://ntfy.sh) : arrive même téléphone en veille. */
export async function notifyNtfy(mail: Mail, url: string): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) throw new Error("NTFY_TOPIC manquant");
  const server = process.env.NTFY_SERVER || "https://ntfy.sh";
  const res = await fetch(server, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic,
      title: "Place OCA disponible !",
      message: mail.text,
      priority: 5, // urgent : sonne même en mode silencieux si autorisé dans l'app
      tags: ["telescope", "rotating_light"],
      click: url,
      actions: [{ action: "view", label: "Réserver", url }],
    }),
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text()}`);
}

/**
 * Ouvre une issue GitHub qui mentionne le propriétaire du dépôt :
 * GitHub envoie alors un email + une notification dans l'app GitHub.
 * Variables fournies automatiquement par GitHub Actions (GITHUB_TOKEN à passer dans le workflow).
 */
export async function notifyGithubIssue(mail: Mail, slots: { date: string; url: string }[]): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  if (!token || !repo) throw new Error("GITHUB_TOKEN / GITHUB_REPOSITORY absents (hors GitHub Actions ?)");
  const api = process.env.GITHUB_API_URL || "https://api.github.com";

  const body = [
    owner ? `@${owner} une place vient de se libérer 🎉` : "Une place vient de se libérer 🎉",
    "",
    ...slots.map((s) => `- **${s.date}** → [Réserver](${s.url})`),
  ].join("\n");

  const res = await fetch(`${api}/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: mail.subject, body }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
}
