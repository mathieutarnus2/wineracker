/* Back-office : la liste des comptes et les actions d'administration.
   Tout passe par des fonctions serveur qui vérifient que l'adresse connectée figure dans ADMINS. */
import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";

const $ = id => document.getElementById(id);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v; else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
const eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const dt = t => (t ? new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "—");
const depuis = t => { if (!t) return "jamais"; const j = Math.floor((Date.now() - t) / 864e5); return j <= 0 ? "aujourd'hui" : j === 1 ? "hier" : j < 30 ? `il y a ${j} j` : dt(t); };
let tt; function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => { t.hidden = true; }, 3200); }
const MSG = { "functions/permission-denied": "Ce compte n'a pas accès au back-office.", "auth/invalid-credential": "E-mail ou mot de passe incorrect.", "auth/popup-closed-by-user": "Connexion annulée." };
const msg = e => MSG[e && e.code] || (e && e.message) || "Erreur inattendue.";

const cfg = await (await fetch("/__/firebase/init.json")).json();
const app = initializeApp(cfg), auth = getAuth(app), fns = getFunctions(app, "europe-west1");
auth.languageCode = "fr";
const appel = n => async d => (await httpsCallable(fns, n, { timeout: 120000 })(d || {})).data;
const api = { comptes: appel("adminComptes"), offrir: appel("adminOffrir"), retirer: appel("adminRetirerOffre"), activer: appel("adminActiver"), lien: appel("adminLienMotDePasse") };

/* ---------- connexion ---------- */
$("lGoogle").addEventListener("click", () => signInWithPopup(auth, new GoogleAuthProvider()).catch(e => montrerErr(e)));
$("lForm").addEventListener("submit", e => { e.preventDefault(); signInWithEmailAndPassword(auth, $("lMail").value.trim(), $("lMdp").value).catch(montrerErr); });
$("sortir").addEventListener("click", () => signOut(auth));
$("rafraichir").addEventListener("click", () => charger());
function montrerErr(e) { $("lErr").textContent = msg(e); $("lErr").hidden = false; }
onAuthStateChanged(auth, u => {
  $("login").hidden = !!u; $("bo").hidden = !u;
  if (u) { $("moi").textContent = u.email || ""; charger(); }
});

/* ---------- données ---------- */
let D = null, tri = { k: "cree", asc: false };
const etat = c => {
  if (c.desactive) return "susp";
  if (c.offre && c.offre.plan && (!c.offre.fin || c.offre.fin > Date.now())) return "offert";
  if (c.abo && ["active", "trialing", "past_due"].includes(c.abo.statut)) return "paye";
  return c.bouteilles >= 50 ? "limite" : "gratuit";
};
const planNom = p => (D && D.plans[p] ? D.plans[p].nom : p || "");
function badge(c) {
  const e = etat(c);
  if (e === "susp") return h("span", { class: "badge b-susp" }, "Suspendu");
  if (e === "offert") return h("span", { class: "badge b-offert" }, `${planNom(c.offre.plan)} offerte`);
  if (e === "paye") return h("span", { class: "badge b-paye" }, planNom(c.abo.plan) + (c.abo.annule ? " · résiliée" : c.abo.statut === "past_due" ? " · impayé" : ""));
  return h("span", { class: "badge " + (e === "limite" ? "b-alerte" : "b-gratuit") }, e === "limite" ? "Gratuit · limite" : "Gratuit");
}

async function charger() {
  $("liste").replaceChildren(h("div", { class: "spin" }));
  try { D = await api.comptes(); } catch (e) { $("liste").replaceChildren(h("div", { class: "vide" }, msg(e))); $("kpis").replaceChildren(); return; }
  kpis(); liste();
}
function kpis() {
  const C = D.comptes, sem = Date.now() - 7 * 864e5;
  const payes = C.filter(c => etat(c) === "paye"), offerts = C.filter(c => etat(c) === "offert");
  const ca = payes.reduce((s, c) => s + ((D.plans[c.abo.plan] || {}).centimes || 0), 0) / 100;
  const k = (l, v, s) => h("div", { class: "kpi" }, h("span", null, l), h("b", null, v), s ? h("small", null, s) : null);
  $("kpis").replaceChildren(
    k("Comptes", String(C.length), `${C.filter(c => c.cree > sem).length} nouveaux en 7 jours`),
    k("Abonnés payants", String(payes.length), Object.keys(D.plans).map(p => `${payes.filter(c => c.abo.plan === p).length} ${D.plans[p].nom}`).join(" · ")),
    k("Revenus annuels", eur.format(ca), "abonnements en cours, TTC"),
    k("Accès offerts", String(offerts.length)),
    k("Actifs 30 jours", String(C.filter(c => c.vu > Date.now() - 30 * 864e5).length)),
    k("Bouteilles", C.reduce((s, c) => s + c.bouteilles, 0).toLocaleString("fr-FR"), `${C.filter(c => etat(c) === "limite").length} gratuits à la limite`),
    k("Liste d'attente", String((D.attente || []).length), (D.attente || []).length ? `dernier : ${dt(D.attente[0].le)}` : "page d'accueil"),
    k("Appels à Claude", String(C.reduce((s, c) => s + c.scans.jour, 0)), `aujourd'hui · ${C.reduce((s, c) => s + c.scans.total, 0).toLocaleString("fr-FR")} au total`),
  );
}
function filtres() {
  const q = $("q").value.trim().toLowerCase(), f = $("filtre").value, sem = Date.now() - 7 * 864e5;
  return D.comptes.filter(c => (!q || [c.email, c.nom, c.pays, PAYS[c.pays], c.uid].join(" ").toLowerCase().includes(q))
    && (!f || (f === "nouveaux" ? c.cree > sem : f === "nouvelles" ? c.nouvelles : etat(c) === f)));
}
const COLS = [["qui", "Compte"], ["cree", "Inscrit"], ["vu", "Vu"], ["bouteilles", "Bouteilles", "n"], ["etat", "Formule"], ["scans", "Claude (jour / total)", "n"]];
const cle = (c, k) => (k === "qui" ? (c.nom || c.email).toLowerCase() : k === "etat" ? etat(c) : k === "scans" ? c.scans.total : c[k] || 0);
function liste() {
  const L = filtres().sort((a, b) => { const x = cle(a, tri.k), y = cle(b, tri.k); return (x < y ? -1 : x > y ? 1 : 0) * (tri.asc ? 1 : -1); });
  $("nb").textContent = `${L.length} compte${L.length > 1 ? "s" : ""}`;
  if (!L.length) { $("liste").replaceChildren(h("div", { class: "vide" }, "Aucun compte ne correspond.")); return; }
  $("liste").replaceChildren(h("table", null,
    h("thead", null, h("tr", null, COLS.map(([k, l, n]) => h("th", { class: [n, tri.k === k ? "tri" : "", tri.k === k && tri.asc ? "asc" : ""].filter(Boolean).join(" "), onclick: () => { tri = { k, asc: tri.k === k ? !tri.asc : k === "qui" }; liste(); } }, l)))),
    h("tbody", null, L.map(c => h("tr", { onclick: () => fiche(c) },
      h("td", { class: "qui" }, h("b", null, c.nom || c.email || c.uid), h("small", null, c.nom ? c.email : (c.via.includes("google.com") ? "Google" : c.via.includes("apple.com") ? "Apple" : "e-mail"))),
      h("td", { "data-l": "Inscrit" }, dt(c.cree)), h("td", { "data-l": "Vu" }, depuis(c.vu)),
      h("td", { class: "n", "data-l": "Bouteilles" }, String(c.bouteilles)), h("td", null, badge(c)),
      h("td", { class: "n", "data-l": "Claude" }, `${c.scans.jour} / ${c.scans.total}`))))));
}
$("q").addEventListener("input", () => D && liste());
$("filtre").addEventListener("change", () => D && liste());
$("csvAttente").addEventListener("click", () => {
  if (!D) return;
  const lignes = ["email;langue;inscrit", ...(D.attente || []).map(x => [x.email, x.langue || "", dt(x.le)].map(v => `"${String(v).replace(/"/g, '""')}"`).join(";"))];
  const a = h("a", { href: URL.createObjectURL(new Blob(["\ufeff" + lignes.join("\n")], { type: "text/csv" })), download: `wineracker-liste-attente-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a); a.click(); a.remove();
});
$("csv").addEventListener("click", () => {
  if (!D) return;
  const L = filtres(), esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lignes = [["email", "nom", "inscrit", "vu", "bouteilles", "vins", "formule", "pays", "langue", "profil", "nouvelles", "appels_total"].join(";"),
    ...L.map(c => [c.email, c.nom, dt(c.cree), dt(c.vu), c.bouteilles, c.vins, badge(c).textContent, c.pays, c.langue, c.amateur, c.nouvelles ? "oui" : "non", c.scans.total].map(esc).join(";"))];
  const a = h("a", { href: URL.createObjectURL(new Blob(["﻿" + lignes.join("\n")], { type: "text/csv" })), download: `wineracker-comptes-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a); a.click(); a.remove();
});

/* ---------- fiche d'un compte ---------- */
const PAYS = { FR: "France", BE: "Belgique", CH: "Suisse", LU: "Luxembourg", MC: "Monaco", CA: "Canada", DE: "Allemagne", IT: "Italie", ES: "Espagne", PT: "Portugal", NL: "Pays-Bas", GB: "Royaume-Uni", US: "États-Unis", AUTRE: "Autre pays" };
const AMATEUR = { curieux: "Amateur curieux", passionne: "Passionné", collectionneur: "Collectionneur", pro: "Professionnel du vin" };
const LANGUES = { fr: "Français", en: "Anglais", de: "Allemand", it: "Italien", es: "Espagnol" };
const VIA = { password: "E-mail et mot de passe", "google.com": "Google", "apple.com": "Apple" };
async function agir(btn, fn, ok) {
  btn.disabled = true;
  try { await fn(); toast(ok); await charger(); const c = D.comptes.find(x => x.uid === courant); if (c) fiche(c); } catch (e) { toast(msg(e)); btn.disabled = false; }
}
let courant = null;
function fiche(c) {
  courant = c.uid;
  const info = (l, v) => h("div", null, h("span", null, l), h("b", null, v || "—"));
  const offre = c.offre && c.offre.plan && (!c.offre.fin || c.offre.fin > Date.now()) ? c.offre : null;
  // offrir une formule
  const sPlan = h("select", null, Object.entries(D.plans).map(([k, P]) => h("option", { value: k }, P.nom + (P.limite < 1e9 ? ` (${P.limite} bouteilles)` : " (illimitée)"))));
  sPlan.value = offre ? offre.plan : "illimite";
  const sMois = h("select", null, [[1, "1 mois"], [3, "3 mois"], [6, "6 mois"], [12, "1 an"], [24, "2 ans"], [0, "Sans limite"]].map(([v, l]) => h("option", { value: String(v) }, l)));
  sMois.value = "12";
  const iNote = h("input", { class: "note", placeholder: "Note (ex. ami, bêta-testeur, geste commercial)", maxlength: "300", value: (c.offre && c.offre.note) || "" });
  const bOffrir = h("button", { class: "btn primary", onclick: () => agir(bOffrir, () => api.offrir({ uid: c.uid, plan: sPlan.value, mois: +sMois.value || null, scansJour: (c.offre && c.offre.scansJour) || null, note: iNote.value }), "Formule offerte.") }, offre ? "Remplacer l'offre" : "Offrir");
  // appels à Claude en plus
  const iScans = h("input", { type: "number", min: "1", max: "2000", step: "1", placeholder: "150 (normal)", value: (c.offre && c.offre.scansJour) || "" });
  const bScans = h("button", { class: "btn", onclick: () => agir(bScans, () => api.offrir({ uid: c.uid, seulementScans: true, scansJour: iScans.value ? Math.round(+iScans.value) : null }), "Limite d'appels enregistrée.") }, "Enregistrer");
  const zoneLien = h("div", { class: "lien", hidden: true });
  const bLien = h("button", { class: "btn small", onclick: async () => { bLien.disabled = true; try { const r = await api.lien({ uid: c.uid }); const i = h("input", { readonly: true, value: r.lien }); zoneLien.replaceChildren(i, h("button", { class: "btn small", onclick: () => navigator.clipboard.writeText(r.lien).then(() => toast("Lien copié.")) }, "Copier")); zoneLien.hidden = false; } catch (e) { toast(msg(e)); } bLien.disabled = false; } }, "Créer un lien de mot de passe");
  let arme = false;
  const bSusp = h("button", { class: "btn small" + (c.desactive ? "" : " danger"), onclick: () => { if (!c.desactive && !arme) { arme = true; bSusp.textContent = "Confirmer la suspension"; return; } agir(bSusp, () => api.activer({ uid: c.uid, actif: c.desactive }), c.desactive ? "Compte réactivé." : "Compte suspendu."); } }, c.desactive ? "Réactiver le compte" : "Suspendre le compte");
  $("fiche").replaceChildren(
    h("div", null, h("h2", null, c.nom || c.email || c.uid), h("p", { class: "meta" }, [c.nom ? c.email : null, c.verifie ? "e-mail vérifié" : "e-mail non vérifié", c.via.map(v => VIA[v] || v).join(", ")].filter(Boolean).join(" · ")), h("div", { style: "margin-top:8px" }, badge(c))),
    h("div", { class: "grille" },
      info("Inscrit le", dt(c.cree)), info("Dernière visite", depuis(c.vu)), info("Bouteilles", `${c.bouteilles} (${c.vins} vins)`),
      info("Appels à Claude", `${c.scans.jour} aujourd'hui · ${c.scans.total} au total`), info("Pays", PAYS[c.pays] || c.pays), info("Langue", LANGUES[c.langue] || c.langue),
      info("Profil", AMATEUR[c.amateur] || c.amateur), info("Nouvelles par e-mail", c.nouvelles ? "oui" : "non"),
      info("Abonnement Stripe", c.abo ? `${planNom(c.abo.plan)} · ${c.abo.statut}${c.abo.fin ? " · jusqu'au " + dt(c.abo.fin) : ""}${c.abo.annule ? " · résilié" : ""}` : "aucun"),
      info("Identifiant", c.uid)),
    h("div", { class: "bloc" }, h("h3", null, "Offrir une formule"),
      offre ? h("p", { class: "meta", style: "margin-bottom:10px" }, `En cours : ${planNom(offre.plan)}, ${offre.fin ? "jusqu'au " + dt(offre.fin) : "sans limite de durée"}${offre.note ? " · " + offre.note : ""}${offre.par ? " · par " + offre.par : ""}.`) : h("p", { class: "meta", style: "margin-bottom:10px" }, "L'utilisateur profite de la formule sans payer. Si elle est plus grande que celle qu'il paie, elle passe devant ; son abonnement Stripe n'est pas modifié."),
      h("div", { class: "ligne" }, h("label", null, "Formule", sPlan), h("label", null, "Durée", sMois), h("label", { style: "flex:1" }, "Note", iNote), bOffrir,
        offre ? h("button", { class: "btn danger", onclick: e => agir(e.currentTarget, () => api.retirer({ uid: c.uid }), "Offre retirée.") }, "Retirer") : null)),
    h("div", { class: "bloc" }, h("h3", null, "Appels à Claude par jour"),
      h("p", { class: "meta", style: "margin-bottom:10px" }, "Scans d'étiquettes, conseils, estimations de prix et analyses de photos. Laissez vide pour la limite normale."),
      h("div", { class: "ligne" }, h("label", null, "Maximum par jour", iScans), bScans)),
    h("div", { class: "bloc" }, h("h3", null, "Compte"),
      h("div", { class: "ligne" }, bLien, c.email ? h("a", { class: "btn small", href: `https://dashboard.stripe.com/search?query=${encodeURIComponent(c.email)}`, target: "_blank", rel: "noopener" }, "Voir dans Stripe") : null, bSusp),
      zoneLien, h("p", { class: "meta", style: "margin-top:8px" }, "Le lien permet de choisir un nouveau mot de passe ; transmettez-le vous-même. Un compte suspendu ne peut plus se connecter, mais ses données sont conservées.")),
    h("div", { class: "pied" }, h("span"), h("button", { class: "btn", onclick: () => $("dlg").close() }, "Fermer")));
  if (!$("dlg").open) $("dlg").showModal();
}
