/* Back-office : réservé aux adresses listées dans ADMINS (e-mail vérifié).
   Les « offres » (offres/{uid}) donnent une formule sans payer, pour une durée ou sans limite,
   et peuvent relever le nombre d'appels à Claude par jour (scans, conseils, estimations). */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { PLANS } = require("./plans");

const ADMINS = defineString("ADMINS", { description: "E-mails autorisés à ouvrir le back-office, séparés par des virgules" });
const OPTS = { region: "europe-west1", invoker: "public", timeoutSeconds: 120 };
const ACTIFS = ["active", "trialing", "past_due"];

function verifier(req) {
  const t = req.auth && req.auth.token, mail = String((t && t.email) || "").toLowerCase();
  const liste = ADMINS.value().toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
  if (!t || !mail || t.email_verified !== true || !liste.includes(mail)) throw new HttpsError("permission-denied", "Accès réservé.");
  return mail;
}
const uidValide = u => typeof u === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(u);
const toutLire = async col => { const m = new Map(); (await getFirestore().collection(col).get()).forEach(d => m.set(d.id, d.data())); return m; };

/* Tous les comptes, avec leur formule, leurs bouteilles et leur usage de Claude. */
exports.adminComptes = onCall(OPTS, async req => {
  verifier(req);
  const db = getFirestore(), jour = new Date().toISOString().slice(0, 10);
  const users = [];
  let page;
  do { const r = await getAuth().listUsers(1000, page); users.push(...r.users); page = r.pageToken; } while (page && users.length < 20000);
  const [abos, offres, quotas] = await Promise.all([toutLire("abonnements"), toutLire("offres"), toutLire("quotas")]);
  // bouteilles : toutes les fiches de vin, toutes caves confondues (seulement les champs utiles)
  const bt = new Map(), vins = new Map();
  (await db.collectionGroup("vins").select("places", "vrac").get()).forEach(d => {
    const u = d.ref.path.split("/")[1], v = d.data();
    const n = (Array.isArray(v.places) ? v.places.length : 0) + (typeof v.vrac === "number" && v.vrac > 0 ? v.vrac : 0);
    bt.set(u, (bt.get(u) || 0) + n); if (n) vins.set(u, (vins.get(u) || 0) + 1);
  });
  const profils = new Map();
  const refs = users.map(u => db.doc(`users/${u.uid}/config/profil`));
  for (let i = 0; i < refs.length; i += 300) (await db.getAll(...refs.slice(i, i + 300))).forEach(s => { if (s.exists) profils.set(s.ref.path.split("/")[1], s.data()); });
  const comptes = users.map(u => {
    const a = abos.get(u.uid) || {}, o = offres.get(u.uid) || null, q = quotas.get(u.uid) || {}, p = profils.get(u.uid) || {};
    return {
      uid: u.uid, email: u.email || "", nom: [p.prenom, p.nom].filter(Boolean).join(" ") || u.displayName || "",
      cree: Date.parse(u.metadata.creationTime) || null, vu: Date.parse(u.metadata.lastRefreshTime || u.metadata.lastSignInTime) || null,
      via: u.providerData.map(x => x.providerId), desactive: !!u.disabled, verifie: !!u.emailVerified,
      pays: p.pays || "", langue: p.langue || "", amateur: p.amateur || "", nouvelles: !!p.nouvelles,
      bouteilles: bt.get(u.uid) || 0, vins: vins.get(u.uid) || 0,
      abo: a.plan ? { plan: a.plan, statut: a.statut || "", fin: a.fin || null, annule: !!a.annule } : null,
      offre: o ? { plan: o.plan || null, fin: o.fin || null, scansJour: o.scansJour || null, note: o.note || "", le: o.le || null, par: o.par || "" } : null,
      scans: { jour: q.jour === jour ? q.n || 0 : 0, total: q.total || 0 },
    };
  });
  const attente = (await db.collection("attente").get()).docs.map(d => d.data()).sort((x, y) => (y.le || 0) - (x.le || 0));
  return { attente, comptes, plans: Object.fromEntries(Object.entries(PLANS).map(([k, P]) => [k, { nom: P.nom, limite: P.limite, centimes: P.centimes }])), maintenant: Date.now() };
});

/* Offrir une formule (pour N mois, ou sans limite), et/ou des appels à Claude en plus par jour. */
exports.adminOffrir = onCall(OPTS, async req => {
  const par = verifier(req), { uid, plan, mois, scansJour, note } = req.data || {};
  if (!uidValide(uid)) throw new HttpsError("invalid-argument", "Compte inconnu.");
  if (plan != null && !PLANS[plan]) throw new HttpsError("invalid-argument", "Formule inconnue.");
  if (mois != null && !(Number.isInteger(mois) && mois >= 1 && mois <= 120)) throw new HttpsError("invalid-argument", "Durée invalide (1 à 120 mois).");
  if (scansJour != null && !(Number.isInteger(scansJour) && scansJour >= 1 && scansJour <= 2000)) throw new HttpsError("invalid-argument", "Nombre d'appels invalide (1 à 2000).");
  await getAuth().getUser(uid).catch(() => { throw new HttpsError("not-found", "Compte inconnu."); });
  if (req.data.seulementScans) {   // ne touche pas à la formule offerte
    await getFirestore().doc(`offres/${uid}`).set({ scansJour: scansJour || null, le: Date.now(), par, historique: FieldValue.arrayUnion({ le: Date.now(), par, scansJour: scansJour || null }) }, { merge: true });
    return { ok: true };
  }
  const fin = plan && mois ? (() => { const d = new Date(); d.setMonth(d.getMonth() + mois); return d.getTime(); })() : null;
  await getFirestore().doc(`offres/${uid}`).set({
    plan: plan || null, fin, scansJour: scansJour || null, note: typeof note === "string" ? note.slice(0, 300) : "", le: Date.now(), par,
    historique: FieldValue.arrayUnion({ le: Date.now(), par, plan: plan || null, mois: mois || null, scansJour: scansJour || null }),
  }, { merge: true });
  return { ok: true, fin };
});

exports.adminRetirerOffre = onCall(OPTS, async req => {
  verifier(req); const { uid } = req.data || {};
  if (!uidValide(uid)) throw new HttpsError("invalid-argument", "Compte inconnu.");
  await getFirestore().doc(`offres/${uid}`).set({ plan: null, fin: null, le: Date.now() }, { merge: true });   // garde les appels à Claude en plus
  return { ok: true };
});

/* Suspendre ou réactiver un compte (il ne peut plus se connecter ; ses données restent). */
exports.adminActiver = onCall(OPTS, async req => {
  const moi = verifier(req), { uid, actif } = req.data || {};
  if (!uidValide(uid) || typeof actif !== "boolean") throw new HttpsError("invalid-argument", "Demande invalide.");
  const u = await getAuth().getUser(uid).catch(() => { throw new HttpsError("not-found", "Compte inconnu."); });
  if (!actif && String(u.email || "").toLowerCase() === moi) throw new HttpsError("failed-precondition", "Vous ne pouvez pas suspendre votre propre compte.");
  await getAuth().updateUser(uid, { disabled: !actif });
  if (!actif) await getAuth().revokeRefreshTokens(uid);
  return { ok: true };
});

/* Un lien de choix de mot de passe, à transmettre soi-même à l'utilisateur qui n'y arrive pas. */
exports.adminLienMotDePasse = onCall(OPTS, async req => {
  verifier(req); const { uid } = req.data || {};
  if (!uidValide(uid)) throw new HttpsError("invalid-argument", "Compte inconnu.");
  const u = await getAuth().getUser(uid).catch(() => { throw new HttpsError("not-found", "Compte inconnu."); });
  if (!u.email) throw new HttpsError("failed-precondition", "Ce compte n'a pas d'adresse e-mail.");
  if (!u.providerData.some(p => p.providerId === "password")) throw new HttpsError("failed-precondition", "Ce compte se connecte avec Google ou Apple : il n'a pas de mot de passe Wineracker.");
  return { lien: await getAuth().generatePasswordResetLink(u.email) };
});
