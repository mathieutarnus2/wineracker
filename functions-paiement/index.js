/* Paiement par abonnement annuel, avec Stripe.
   - creerPaiement : ouvre la page de paiement Stripe pour une formule.
   - portailAbonnement : ouvre l'espace client Stripe (changer de formule, résilier, factures).
   - stripeWebhook : Stripe prévient ici de chaque paiement, renouvellement ou résiliation ; on note l'état dans abonnements/{uid}.
   Les clés Stripe sont des secrets : STRIPE_SECRET_KEY et STRIPE_WEBHOOK_SECRET. */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const Stripe = require("stripe");
const { PLANS } = require("./plans");

if (!getApps().length) initializeApp();
const CLE = defineSecret("STRIPE_SECRET_KEY");
const SIGNATURE = defineSecret("STRIPE_WEBHOOK_SECRET");
const SITES = defineString("SITES_AUTORISES", { default: "", description: "Domaines personnalisés de l'app, séparés par des virgules (facultatif)" });
const REGION = "europe-west1";
const stripe = () => new Stripe(CLE.value());
const db = () => getFirestore();

// Catégorie fiscale Stripe : logiciel en ligne (SaaS) à usage personnel. Exigée quand Stripe gère la TVA (« Managed Payments »).
const CODE_FISCAL = "txcd_10103000";
/* Le prix Stripe de chaque formule est créé tout seul la première fois, puis retrouvé par sa « lookup key ». */
async function prixDe(s, plan) {
  const P = PLANS[plan];
  const L = await s.prices.list({ lookup_keys: [P.cle], active: true, limit: 1, expand: ["data.product"] });
  if (L.data.length) {
    const pr = L.data[0], prod = pr.product;   // produits créés avant l'ajout du code fiscal : on le complète
    if (prod && typeof prod === "object" && !prod.tax_code) await s.products.update(prod.id, { tax_code: CODE_FISCAL });
    if (pr.unit_amount === P.centimes) return pr;
    // le tarif a changé : nouveau prix sur le même produit ; la « lookup key » passe au nouveau prix, les abonnés actuels gardent l'ancien
    return s.prices.create({ product: typeof prod === "object" ? prod.id : prod, currency: "eur", unit_amount: P.centimes, recurring: { interval: "year" }, lookup_key: P.cle, transfer_lookup_key: true, tax_behavior: "inclusive", nickname: P.nom, metadata: { plan } });
  }
  const produit = await s.products.create({ name: `Wineracker · ${P.nom}`, tax_code: CODE_FISCAL, metadata: { plan }, description: P.limite < 1e9 ? `Jusqu'à ${P.limite} bouteilles, un an` : "Bouteilles illimitées, un an" });
  return s.prices.create({ product: produit.id, currency: "eur", unit_amount: P.centimes, recurring: { interval: "year" }, lookup_key: P.cle, tax_behavior: "inclusive", nickname: P.nom, metadata: { plan } });
}
function origine(req) {   // l'adresse de retour après paiement : uniquement nos propres sites
  const o = req.rawRequest && req.rawRequest.headers.origin, projet = process.env.GCLOUD_PROJECT;
  const ok = [`https://${projet}.web.app`, `https://${projet}.firebaseapp.com`, ...SITES.value().split(",").map(x => x.trim()).filter(Boolean).map(x => (x.startsWith("http") ? x : `https://${x}`))];
  return ok.includes(o) ? o : ok[0];
}
async function client(s, req) {   // un client Stripe par compte, créé au premier paiement
  const ref = db().doc(`abonnements/${req.auth.uid}`), snap = await ref.get(), d = snap.exists ? snap.data() : {};
  if (d.customerId) return { id: d.customerId, d };
  const c = await s.customers.create({ email: req.auth.token.email || undefined, metadata: { uid: req.auth.uid } });
  await ref.set({ customerId: c.id }, { merge: true });
  return { id: c.id, d };
}
const ACTIFS = ["active", "trialing", "past_due"];

exports.creerPaiement = onCall({ region: REGION, invoker: "public", secrets: [CLE] }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Connexion requise.");
  const plan = req.data && req.data.plan;
  if (!PLANS[plan]) throw new HttpsError("invalid-argument", "Formule inconnue.");
  const s = stripe(), site = origine(req), { id, d } = await client(s, req);
  // le profil de l'utilisateur sert au nom et à l'adresse des factures
  try {
    const pf = (await db().doc(`users/${req.auth.uid}/config/profil`).get()).data() || {};
    const nom = [pf.prenom, pf.nom].filter(Boolean).join(" ");
    if (nom) await s.customers.update(id, { name: nom, ...(pf.pays && pf.pays !== "AUTRE" ? { address: { line1: pf.adresse || undefined, postal_code: pf.cp || undefined, city: pf.ville || undefined, country: pf.pays } } : {}), ...(pf.tel ? { phone: pf.tel } : {}) });
  } catch (e) { logger.warn("Profil non repris dans Stripe", e.message); }
  // déjà abonné : on change de formule depuis l'espace client plutôt que de payer deux fois
  if (d.subscriptionId && ACTIFS.includes(d.statut)) return { url: (await portail(s, id, site)).url };
  const prix = await prixDe(s, plan);
  const session = await s.checkout.sessions.create({
    mode: "subscription", customer: id, client_reference_id: req.auth.uid, locale: "fr",
    line_items: [{ price: prix.id, quantity: 1 }],
    subscription_data: { metadata: { uid: req.auth.uid, plan } },
    allow_promotion_codes: true,
    success_url: `${site}/?abonnement=merci`, cancel_url: `${site}/?abonnement=annule`,
  });
  return { url: session.url };
});

async function portail(s, customer, site) {
  // une configuration de l'espace client, créée une fois : changer de formule, résilier, moyens de paiement, factures
  const ref = db().doc("systeme/stripe"), snap = await ref.get();
  const prix = await Promise.all(Object.keys(PLANS).map(p => prixDe(s, p))), sig = prix.map(p => p.id).join(",");
  let conf = snap.exists && snap.data().prixPortail === sig && snap.data().portail;   // refaite quand les tarifs changent
  if (!conf) {
    const c = await s.billingPortal.configurations.create({
      business_profile: { headline: "Wineracker : gérez votre abonnement" },
      features: {
        customer_update: { enabled: true, allowed_updates: ["email", "address"] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        subscription_update: { enabled: true, default_allowed_updates: ["price"], proration_behavior: "create_prorations", products: prix.map(p => ({ product: typeof p.product === "string" ? p.product : p.product.id, prices: [p.id] })) },
      },
    });
    conf = c.id; await ref.set({ portail: conf, prixPortail: sig }, { merge: true });
  }
  return s.billingPortal.sessions.create({ customer, return_url: site, configuration: conf, locale: "fr" });
}

exports.portailAbonnement = onCall({ region: REGION, invoker: "public", secrets: [CLE] }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Connexion requise.");
  const snap = await db().doc(`abonnements/${req.auth.uid}`).get(), d = snap.exists ? snap.data() : {};
  if (!d.customerId) throw new HttpsError("failed-precondition", "Aucun abonnement.");
  return { url: (await portail(stripe(), d.customerId, origine(req))).url };
});

/* Ce que l'on retient d'un abonnement Stripe */
function etatDe(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0], cle = item && item.price && item.price.lookup_key;
  const plan = Object.keys(PLANS).find(p => PLANS[p].cle === cle) || (item && item.price && item.price.metadata && PLANS[item.price.metadata.plan] ? item.price.metadata.plan : null) || (sub.metadata && sub.metadata.plan) || null;
  const fin = sub.current_period_end || (item && item.current_period_end) || null;   // l'emplacement dépend de la version de l'API Stripe
  return { plan, statut: sub.status, fin: fin ? fin * 1000 : null, annule: !!sub.cancel_at_period_end, subscriptionId: sub.id, customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id, maj: Date.now() };
}
async function noter(s, sub) {
  let uid = sub.metadata && sub.metadata.uid;
  if (!uid) { const c = await s.customers.retrieve(typeof sub.customer === "string" ? sub.customer : sub.customer.id); uid = c.metadata && c.metadata.uid; }
  if (!uid) { logger.warn("Abonnement sans utilisateur", sub.id); return; }
  await db().doc(`abonnements/${uid}`).set(etatDe(sub), { merge: true });
}

exports.stripeWebhook = onRequest({ region: REGION, invoker: "public", secrets: [CLE, SIGNATURE] }, async (req, res) => {
  const s = stripe();
  let ev;
  try { ev = s.webhooks.constructEvent(req.rawBody, req.headers["stripe-signature"], SIGNATURE.value()); }
  catch (e) { logger.warn("Signature Stripe invalide", e.message); res.status(400).send("Signature invalide"); return; }
  try {
    const o = ev.data.object;
    if (ev.type === "checkout.session.completed" && o.subscription) await noter(s, await s.subscriptions.retrieve(o.subscription));
    else if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed"].includes(ev.type)) await noter(s, o);
    res.json({ recu: true });
  } catch (e) { logger.error("Webhook Stripe", ev.type, e); res.status(500).send("Erreur"); }
});

exports._test = { etatDe };
