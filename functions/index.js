/* Fonctions serveur : la clé API Anthropic reste ici, jamais dans le navigateur. */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString, defineInt } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp();
const CLE = defineSecret("ANTHROPIC_API_KEY");
const MODELE = defineString("CLAUDE_MODEL", { default: "claude-sonnet-5-5" });
const QUOTA = defineInt("QUOTA_JOUR", { default: 150 });   // appels à Claude par utilisateur et par jour
const OFFERTS = defineString("COMPTES_OFFERTS", { default: "", description: "E-mails qui ont la version complète sans payer, séparés par des virgules" });
const REGION = "europe-west1";
const { GRATUIT, PLANS } = require("./plans");
const TYPES = ["image/jpeg", "image/png", "image/webp"];

/* claude({ prompt, images: [{ type, data (base64) }] }) -> { text } */
exports.claude = onCall({ region: REGION, invoker: "public", secrets: [CLE], timeoutSeconds: 180, memory: "512MiB", maxInstances: 20 }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Connexion requise.");
  const { prompt, images = [] } = req.data || {};
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 60000) throw new HttpsError("invalid-argument", "Demande invalide.");
  if (!Array.isArray(images) || images.length > 4 || images.some(i => !i || !TYPES.includes(i.type) || typeof i.data !== "string" || i.data.length > 5e6)) throw new HttpsError("invalid-argument", "Image refusée.");

  // quota quotidien par utilisateur, pour maîtriser les coûts
  const db = getFirestore(), jour = new Date().toISOString().slice(0, 10), ref = db.doc(`quotas/${req.auth.uid}`);
  const offre = await db.doc(`offres/${req.auth.uid}`).get(), max = Math.max(QUOTA.value(), (offre.exists && offre.data().scansJour) || 0);   // le back-office peut en offrir plus
  await db.runTransaction(async t => {
    const s = await t.get(ref), d = s.exists ? s.data() : {}, n = d.jour === jour ? d.n || 0 : 0;
    if (n >= max) throw new HttpsError("resource-exhausted", "Limite quotidienne atteinte.");
    t.set(ref, { jour, n: n + 1, total: (d.total || 0) + 1 });
  });

  const content = [...images.map(i => ({ type: "image", source: { type: "base64", media_type: i.type, data: i.data } })), { type: "text", text: prompt }];
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": CLE.value(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODELE.value(), max_tokens: 4096, system: "Tu réponds uniquement avec le JSON demandé, sans texte autour ni balises de code.", messages: [{ role: "user", content }] }),
    });
  } catch (e) { logger.error("Anthropic injoignable", e); throw new HttpsError("unavailable", "Service momentanément indisponible."); }
  if (r.status === 429 || r.status === 529) throw new HttpsError("unavailable", "Service occupé, réessayez.");
  if (r.status === 400 && /image/i.test(await r.clone().text())) throw new HttpsError("invalid-argument", "Image refusée.");
  if (!r.ok) { logger.error("Anthropic", r.status, await r.text()); throw new HttpsError("internal", "L'appel a échoué."); }
  const j = await r.json(), text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  if (!text) throw new HttpsError("internal", "Réponse vide.");
  return { text };
});

/* Supprime le compte et toutes ses données (droit à l'effacement). */
exports.supprimerCompte = onCall({ region: REGION, invoker: "public", timeoutSeconds: 120 }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Connexion requise.");
  const uid = req.auth.uid, db = getFirestore();
  await db.recursiveDelete(db.doc(`users/${uid}`));
  await db.doc(`quotas/${uid}`).delete().catch(() => {});
  await getAuth().deleteUser(uid);
  return { ok: true };
});

/* L'état de l'abonnement, tel que Stripe l'a confirmé (abonnements/{uid}), ou un accès offert. */
exports.etatAbonnement = onCall({ region: REGION, invoker: "public" }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Connexion requise.");
  const mail = String(req.auth.token.email || "").toLowerCase();
  if (mail && req.auth.token.email_verified !== false && OFFERTS.value().toLowerCase().split(",").map(x => x.trim()).includes(mail)) return { plan: "illimite", statut: "offert", gratuit: GRATUIT };
  const db = getFirestore();
  const [s, so] = await Promise.all([db.doc(`abonnements/${req.auth.uid}`).get(), db.doc(`offres/${req.auth.uid}`).get()]);
  const d = s.exists ? s.data() : {}, o = so.exists ? so.data() : {};
  const paye = { plan: PLANS[d.plan] ? d.plan : null, statut: d.statut || "aucun", fin: d.fin || null, annule: !!d.annule, client: !!d.customerId, gratuit: GRATUIT };
  // une formule offerte depuis le back-office, encore valable et plus grande que celle payée, passe devant
  const actifPaye = paye.plan && ["active", "trialing", "past_due"].includes(paye.statut);
  if (PLANS[o.plan] && (!o.fin || o.fin > Date.now()) && (!actifPaye || PLANS[o.plan].limite > PLANS[paye.plan].limite)) return { plan: o.plan, statut: "offert", fin: o.fin || null, client: paye.client, gratuit: GRATUIT };
  return paye;
});

Object.assign(exports, require("./admin"));

/* Liste d'attente de la page d'accueil : on garde l'e-mail, la langue et la date. */
const { onRequest } = require("firebase-functions/v2/https");
const ORIGINES = ["https://wineracker.com", "https://www.wineracker.com", "https://wineracker-com.web.app", "https://wineracker-com.firebaseapp.com"];
exports.listeAttente = onRequest({ region: REGION, invoker: "public", cors: ORIGINES, maxInstances: 5, memory: "256MiB" }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ ok: false }); return; }
  const b = typeof req.body === "object" && req.body ? req.body : {};
  if (b.site) { res.json({ ok: true }); return; }   // champ piège : rempli seulement par les robots
  const email = String(b.email || "").trim().toLowerCase();
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { res.status(400).json({ ok: false, erreur: "email" }); return; }
  const langue = ["fr", "en", "de", "it", "es"].includes(b.langue) ? b.langue : "";
  const id = email.replace(/[^a-z0-9@._+-]/g, "_").replace(/\//g, "_");
  const ref = getFirestore().doc(`attente/${id}`);
  const s = await ref.get();
  if (!s.exists) await ref.set({ email, langue, le: Date.now() });
  res.json({ ok: true });
});
