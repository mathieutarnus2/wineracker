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

/* claude({ modele, donnees, images, langue }) -> { text }
   Le serveur construit lui-même la demande à partir des modèles de l'app (modeles.gen.js) : aucune demande libre n'est acceptée. */
const MODELES_CLAUDE = require("./modeles.gen.js");
const QUOTA_GLOBAL = defineInt("QUOTA_GLOBAL", { default: 3000 });   // appels à Claude par jour, tous comptes confondus
const APPCHECK = defineString("APPCHECK", { default: "non", description: "« oui » pour n'accepter que les appels venant de l'app (Firebase App Check)" });
const LANGUES_CLAUDE = { en: "anglais", de: "allemand", it: "italien", es: "espagnol" };
const txt = (x, n) => (typeof x === "string" ? x.slice(0, n) : x == null ? null : String(x).slice(0, n));
const nb = (x, mn, mx) => { const v = Number(x); return isFinite(v) && v >= mn && v <= mx ? v : null; };
const ID = x => (typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x) ? x : null);
function lotPrix(l, max, ancien) {   // liste de vins pour les estimations de prix
  if (!Array.isArray(l) || !l.length || l.length > max) throw new HttpsError("invalid-argument", "Demande invalide.");
  return l.map(v => {
    if (!v || !ID(v.id)) throw new HttpsError("invalid-argument", "Demande invalide.");
    const o = { id: v.id, vin: txt(v.vin, 300) || "", millesime: nb(v.millesime, 1800, 2200), couleur: txt(v.couleur, 20), contenance: nb(v.contenance, 1, 3000) };
    if (ancien) o.ancien = nb(v.ancien, 0, 1e6);
    return o;
  });
}
function construire(modele, d, nImages) {
  const P = MODELES_CLAUDE(new Date().getFullYear());
  switch (modele) {
    case "etiquette": if (nImages !== 1) break; return P.etiquette();
    case "cave": if (nImages < 1 || nImages > 4) break; return P.cave(nImages);
    case "conseils": {
      if (nImages || !d || typeof d !== "object") break;
      return P.conseils({ nom: txt(d.nom, 200), domaine: txt(d.domaine, 200), appellation: txt(d.appellation, 200), region: txt(d.region, 120), pays: txt(d.pays, 80), couleur: txt(d.couleur, 40), millesime: nb(d.millesime, 1800, 2200), cepages: txt(d.cepages, 300), contenance_cl: nb(d.contenance_cl, 1, 3000) });
    }
    case "prix": if (nImages) break; return P.prix(lotPrix(d, 40, false));
    case "valeurs": if (nImages) break; return P.valeurs(lotPrix(d, 30, true));
  }
  throw new HttpsError("invalid-argument", "Demande invalide.");
}
exports.claude = onCall({ region: REGION, invoker: "public", secrets: [CLE], timeoutSeconds: 180, memory: "512MiB", maxInstances: 20, enforceAppCheck: APPCHECK.value() === "oui" }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Connexion requise.");
  const t = req.auth.token;
  if (t.firebase && t.firebase.sign_in_provider === "password" && t.email_verified !== true) throw new HttpsError("failed-precondition", "Adresse e-mail à confirmer.", { raison: "email_non_verifie" });
  const { modele, donnees, images = [], langue } = req.data || {};
  if (!Array.isArray(images) || images.length > 4 || images.some(i => !i || !TYPES.includes(i.type) || typeof i.data !== "string" || i.data.length > 5e6)) throw new HttpsError("invalid-argument", "Image refusée.");
  let prompt = construire(modele, donnees, images.length);
  if (LANGUES_CLAUDE[langue]) prompt += `\n\nIMPORTANT : rédige tous les textes libres destinés à l'utilisateur (goût, service, apogée, plats, recettes, conseils, raisons, remarques, descriptions) en ${LANGUES_CLAUDE[langue]}. Ne traduis pas les valeurs imposées par le format demandé (identifiants, couleurs comme « rouge » ou « blanc », types, mots-clés), ni les noms propres de vins, domaines, appellations et régions.`;

  // quotas : par utilisateur (relevable depuis le back-office) et pour tout le service, pour maîtriser les coûts
  const db = getFirestore(), jour = new Date().toISOString().slice(0, 10), ref = db.doc(`quotas/${req.auth.uid}`), refG = db.doc("quotas/_service");
  const offre = await db.doc(`offres/${req.auth.uid}`).get(), max = Math.max(QUOTA.value(), (offre.exists && offre.data().scansJour) || 0);
  await db.runTransaction(async tr => {
    const [s, g] = await Promise.all([tr.get(ref), tr.get(refG)]);
    const d = s.exists ? s.data() : {}, n = d.jour === jour ? d.n || 0 : 0, G = g.exists ? g.data() : {}, ng = G.jour === jour ? G.n || 0 : 0;
    if (n >= max) throw new HttpsError("resource-exhausted", "Limite quotidienne atteinte.");
    if (ng >= QUOTA_GLOBAL.value()) { logger.error("Plafond quotidien du service atteint", ng); throw new HttpsError("resource-exhausted", "Service saturé pour aujourd'hui."); }
    tr.set(ref, { jour, n: n + 1, total: (d.total || 0) + 1 });
    tr.set(refG, { jour, n: ng + 1 });
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

/* Supprime le compte et toutes ses données (droit à l'effacement).
   L'abonnement Stripe est résilié d'abord : si Stripe ne répond pas, rien n'est effacé, pour ne jamais laisser un prélèvement sans compte. */
const STRIPE_CLE = defineSecret("STRIPE_SECRET_KEY");
exports.supprimerCompte = onCall({ region: REGION, invoker: "public", timeoutSeconds: 120, secrets: [STRIPE_CLE] }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Connexion requise.");
  const uid = req.auth.uid, db = getFirestore();
  const abo = await db.doc(`abonnements/${uid}`).get(), customer = abo.exists && abo.data().customerId;
  if (customer) {
    try {
      const s = new (require("stripe"))(STRIPE_CLE.value());
      const subs = await s.subscriptions.list({ customer, status: "all", limit: 100 });
      for (const sub of subs.data) if (!["canceled", "incomplete_expired"].includes(sub.status)) await s.subscriptions.cancel(sub.id, { invoice_now: false, prorate: false });
      logger.info("Abonnements résiliés à la suppression du compte", uid, subs.data.length);
    } catch (e) { logger.error("Résiliation Stripe impossible", uid, e.message); throw new HttpsError("unavailable", "La résiliation de l'abonnement a échoué. Réessayez dans un moment."); }
  }
  await db.recursiveDelete(db.doc(`users/${uid}`));
  for (const p of [`quotas/${uid}`, `abonnements/${uid}`, `offres/${uid}`]) await db.doc(p).delete().catch(() => {});
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
exports._test = { construire };
