// Lancé toutes les 5 minutes par GitHub Actions. Se connecte à Firebase avec un compte "worker" (aucune clé de service).
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");
const { getFirestore, collection, doc, getDocs, setDoc, updateDoc, deleteField, serverTimestamp } = require("firebase/firestore");
const webpush = require("web-push");

const P = process.env.FIREBASE_PROJECT_ID;
const app = initializeApp({ apiKey: process.env.FIREBASE_API_KEY, authDomain: `${P}.firebaseapp.com`, projectId: P });
webpush.setVapidDetails("mailto:" + process.env.VAPID_EMAIL, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

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

// Gemini choisit un nom court pour la veille (une seule fois, sans recherche web).
async function titleFor(topic) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: `Donne un titre très court (2 à 5 mots, en français, sans guillemets ni point final) à cette veille : « ${topic} ». Réponds uniquement par le titre.` }] }] }),
  });
  if (!r.ok) throw new Error("Gemini " + r.status);
  const d = await r.json();
  const t = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim().replace(/^["«\s]+|["»\s.]+$/g, "");
  return (t || String(topic)).slice(0, 60);
}

async function push(userRef, sub, res, name) {
  const body = (res.verdict ? res.verdict + " : " : "") + (res.summary || "").split(/(?<=[.!?])\s/)[0];
  try { await webpush.sendNotification(sub, JSON.stringify({ title: name || "Veille", body })); }
  catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) await updateDoc(userRef, { pushSubscription: deleteField() });
    else console.error("push:", e.message);
  }
}

(async () => {
  await signInWithEmailAndPassword(getAuth(app), process.env.WORKER_EMAIL, process.env.WORKER_PASSWORD);
  console.log("Connecté en tant que worker.");
  const db = getFirestore(app);
  const usersSnap = await getDocs(collection(db, "users"));
  console.log(`${usersSnap.size} compte(s) trouvé(s).`);
  for (const u of usersSnap.docs) {
    const user = u.data(), tz = user.timeZone || "Europe/Zurich";
    const tasksSnap = await getDocs(collection(u.ref, "tasks"));
    console.log(`Compte ${u.id.slice(0, 6)}… : fuseau ${tz}, ${tasksSnap.size} veille(s), notifications ${user.pushSubscription ? "activées" : "NON activées"}.`);
    for (const t of tasksSnap.docs) {
      const task = t.data();
      if (task.hour == null) { console.log("  veille sans heure, ignorée."); continue; }
      let title = task.title;
      if (!title) {
        try { title = await titleFor(task.topic); await updateDoc(t.ref, { title }); console.log(`  nom donné : ${title}`); }
        catch (e) { console.error("    nom impossible :", e.message); }
      }
      const now = local(tz);
      let diff = task.hour * 60 + task.minute - now.min, key = now.key;
      if (diff < -30) { diff += 1440; key = now.tomorrow; }
      console.log(`  « ${String(task.topic).slice(0, 40)} » : ${task.hour}:${task.minute}, dans ${diff} min (il est ${now.label} chez toi), passe 1 faite : ${task.prepKey === key}, envoi fait : ${task.sentKey === key}.`);
      try {
        if (diff <= 130 && diff > 5 && task.prepKey !== key) {
          console.log("    -> passe 1 : résumé de secours.");
          // Passe 1 : environ 2 h avant, résumé de secours.
          const res = await research(task.topic, tz, user.location);
          await updateDoc(t.ref, { result: { ...res, at: now.label }, prepKey: key });
          await setDoc(doc(collection(t.ref, "summaries"), key), { ...res, at: now.label, createdAt: serverTimestamp() });
        } else if (diff <= 5 && task.sentKey !== key) {
          console.log("    -> passe 2 : résumé frais et notification.");
          // Passe 2 : environ 5 min avant, résumé frais + notification. Repli sur la passe 1 si ça échoue.
          let res;
          try { res = { ...(await research(task.topic, tz, user.location)), at: now.label }; }
          catch { res = task.result || { verdict: "Indisponible", tone: "unk", summary: "La recherche a échoué ce matin.", at: now.label }; }
          await updateDoc(t.ref, { result: res, sentKey: key });
          await setDoc(doc(collection(t.ref, "summaries"), key), { ...res, createdAt: serverTimestamp() });
          if (user.pushSubscription) await push(u.ref, user.pushSubscription, res, title);
          else console.log("    (pas d’envoi : notifications non activées)");
        } else console.log("    -> rien à faire maintenant.");
      } catch (e) { console.error("    erreur :", e.message); }
    }
  }
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
