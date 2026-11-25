// Lancé toutes les 5 minutes par GitHub Actions. Se connecte à Firebase avec un compte "worker" (aucune clé de service).
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");
const { getFirestore, collection, getDocs, updateDoc, deleteField } = require("firebase/firestore");
const webpush = require("web-push");

const P = process.env.FIREBASE_PROJECT_ID;
const app = initializeApp({ apiKey: process.env.FIREBASE_API_KEY, authDomain: `${P}.firebaseapp.com`, projectId: P });
webpush.setVapidDetails("mailto:" + process.env.VAPID_EMAIL, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

function local(tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  const tomorrow = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + 1)).toISOString().slice(0, 10);
  return { key: `${p.year}-${p.month}-${p.day}`, tomorrow, min: +p.hour * 60 + +p.minute, label: `${p.hour}:${p.minute}` };
}

// Gemini cherche lui-même sur le web (outil Google Search) puis résume.
async function research(topic, tz, loc) {
  const when = new Date().toLocaleString("fr-FR", { timeZone: tz, dateStyle: "full", timeStyle: "short" });
  const prompt =
    `Date et heure locales : ${when} (${tz}).` + (loc ? ` Position approximative de la personne : ${loc.lat}, ${loc.lon}.` : "") +
    `\nDemande : « ${topic} »\nCherche sur le web les informations les plus récentes. Réponds UNIQUEMENT par un JSON : ` +
    `{"verdict":"2 à 4 mots","tone":"ok|warn|bad|unk","summary":"3 à 5 phrases en français, factuelles"}. ` +
    `N’invente rien : si tu ne trouves pas l’information, dis-le et mets tone "unk".`;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
  });
  if (!r.ok) throw new Error("Gemini " + r.status);
  const data = await r.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  try {
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return { verdict: j.verdict, tone: ["ok", "warn", "bad", "unk"].includes(j.tone) ? j.tone : "unk", summary: j.summary };
  } catch {
    return { verdict: "À vérifier", tone: "unk", summary: text.trim().slice(0, 600) || "Pas de réponse exploitable." };
  }
}

async function push(userRef, sub, res) {
  const body = (res.summary || "").split(/(?<=[.!?])\s/)[0];
  try { await webpush.sendNotification(sub, JSON.stringify({ title: res.verdict || "Veille", body })); }
  catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) await updateDoc(userRef, { pushSubscription: deleteField() });
    else console.error("push:", e.message);
  }
}

(async () => {
  await signInWithEmailAndPassword(getAuth(app), process.env.WORKER_EMAIL, process.env.WORKER_PASSWORD);
  const db = getFirestore(app);
  for (const u of (await getDocs(collection(db, "users"))).docs) {
    const user = u.data(), tz = user.timeZone || "Europe/Zurich";
    for (const t of (await getDocs(collection(u.ref, "tasks"))).docs) {
      const task = t.data();
      if (task.hour == null) continue;
      const now = local(tz);
      let diff = task.hour * 60 + task.minute - now.min, key = now.key;
      if (diff < -30) { diff += 1440; key = now.tomorrow; }
      try {
        if (diff <= 130 && diff > 5 && task.prepKey !== key) {
          // Passe 1 : environ 2 h avant, résumé de secours.
          const res = await research(task.topic, tz, user.location);
          await updateDoc(t.ref, { result: { ...res, at: now.label }, prepKey: key });
        } else if (diff <= 5 && task.sentKey !== key) {
          // Passe 2 : environ 5 min avant, résumé frais + notification. Repli sur la passe 1 si ça échoue.
          let res;
          try { res = { ...(await research(task.topic, tz, user.location)), at: now.label }; }
          catch { res = task.result || { verdict: "Indisponible", tone: "unk", summary: "La recherche a échoué ce matin.", at: now.label }; }
          await updateDoc(t.ref, { result: res, sentKey: key });
          if (user.pushSubscription) await push(u.ref, user.pushSubscription, res);
        }
      } catch (e) { console.error(task.topic, e.message); }
    }
  }
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
