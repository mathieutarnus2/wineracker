/* Version hébergée : comptes, base de données et appels à Claude passent par Firebase.
   L'application (src/app.html) attend un objet window.claude.use("db" | "user" | "sample") :
   ce fichier le fournit, une fois l'utilisateur connecté. Chaque utilisateur a ses données sous users/{uid}/. */
import { initializeApp } from "firebase/app";
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, sendEmailVerification, GoogleAuthProvider, OAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut,
} from "firebase/auth";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot, writeBatch,
} from "firebase/firestore";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "firebase/functions";

const $ = id => document.getElementById(id);
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const REGION = "europe-west1";

/* ---------- configuration : fournie par Firebase Hosting, plus nos réglages ---------- */
async function lireConfig() {
  const r = await fetch("/__/firebase/init.json");
  if (!r.ok) throw new Error("Configuration Firebase introuvable : la page doit être servie par Firebase Hosting (ou son émulateur).");
  const cfg = await r.json();
  let reglages = {};
  try { const x = await fetch("/reglages.json", { cache: "no-store" }); if (x.ok) reglages = await x.json(); } catch (e) {}
  // Connexion Google/Apple sur le même domaine que l'app : indispensable en mode « écran d'accueil » sur iPhone.
  if (reglages.authSurLeDomaine && !LOCAL) cfg.authDomain = location.host;
  return { cfg, reglages };
}

const { cfg, reglages } = await lireConfig();
const app = initializeApp(cfg);
const auth = getAuth(app);
auth.languageCode = "fr";
const fs = initializeFirestore(app, LOCAL ? {} : { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const fns = getFunctions(app, REGION);
if (LOCAL) {
  connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(fs, location.hostname, 8080);
  connectFunctionsEmulator(fns, location.hostname, 5001);
}

/* ---------- la base : mêmes appels que dans l'artifact, rangés sous users/{uid} ---------- */
let uid = null;
const base = () => `users/${uid}`;
const CODES = { "permission-denied": "not_granted", "resource-exhausted": "quota_exceeded", "unauthenticated": "session_expired" };
const err = e => { const x = new Error(e && e.message || "Erreur"); x.code = CODES[e && e.code] || (e && e.code) || "unknown"; x.cause = e; return x; };
const sur = p => p.catch(e => { throw err(e); });
const snap = s => ({ exists: s.exists(), id: s.id, data: () => s.data() });
function docApi(path) {
  const ref = doc(fs, `${base()}/${path}`);
  return {
    id: ref.id,
    get: () => sur(getDoc(ref)).then(snap),
    set: d => sur(setDoc(ref, d)),
    update: d => sur(updateDoc(ref, d)),
    delete: () => sur(deleteDoc(ref)),
    onSnapshot: (cb, ko) => onSnapshot(ref, s => cb(snap(s)), e => ko && ko(err(e))),
  };
}
function colApi(path) {
  const ref = collection(fs, `${base()}/${path}`);
  return {
    doc: id => docApi(`${path}/${id || doc(ref).id}`),
    add: d => sur(addDoc(ref, d)).then(r => ({ id: r.id })),
    onSnapshot: (cb, ko) => onSnapshot(ref, s => cb({ docs: s.docs.map(snap) }), e => ko && ko(err(e))),
  };
}
const db = { doc: docApi, collection: colApi };

/* ---------- l'utilisateur ---------- */
const VIA = { password: "e-mail et mot de passe", "google.com": "compte Google", "apple.com": "compte Apple" };
const user = {
  me: async () => {
    const u = auth.currentUser; if (!u) return null;
    const p = u.providerData.map(x => x.providerId);
    return { name: u.displayName || "", email: u.email || "", via: p.map(x => VIA[x]).filter(Boolean).join(", ") };
  },
  can: async () => true,
};

/* ---------- Claude, via la fonction serveur (la clé API ne quitte jamais le serveur) ---------- */
const appelClaude = httpsCallable(fns, "claude", { timeout: 170000 });
const TYPES_IMG = ["image/jpeg", "image/png", "image/webp"];
function enJpeg(blob, max = 1568) {   // photo réduite avant l'envoi : plus rapide, moins chère, aussi lisible
  return createImageBitmap(blob).then(bmp => {
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height)), cv = document.createElement("canvas");
    cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    return { type: "image/jpeg", data: cv.toDataURL("image/jpeg", .85).split(",")[1] };
  });
}
function lireJson(t) {
  const s = String(t || "").replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(s); } catch (e) {}
  const a = Math.min(...["[", "{"].map(c => s.indexOf(c)).filter(i => i >= 0)), b = Math.max(s.lastIndexOf("]"), s.lastIndexOf("}"));
  if (isFinite(a) && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  const x = new Error("Réponse illisible"); x.code = "invalid_json"; throw x;
}
const CODES_CLAUDE = { "functions/resource-exhausted": "rate_limited", "functions/unavailable": "rate_limited", "functions/unauthenticated": "session_expired", "functions/invalid-argument": "image_rejected", "functions/failed-precondition": "sampling_disabled" };
const sample = {
  limits: async () => ({ images: { maxCount: 4, mediaTypes: TYPES_IMG } }),
  json: async (prompt, o = {}) => {
    const brut = !o.images ? [] : o.images instanceof Blob ? [o.images] : Array.from(o.images);
    if (o.signal && o.signal.aborted) { const x = new Error("Arrêté"); x.code = "cancelled"; throw x; }
    const images = await Promise.all(brut.slice(0, 4).map(b => enJpeg(b)));
    const arret = new Promise((_, ko) => o.signal && o.signal.addEventListener("abort", () => { const x = new Error("Arrêté"); x.code = "cancelled"; ko(x); }, { once: true }));
    let r;
    try { r = await Promise.race([appelClaude({ prompt: String(prompt), images }), arret]); }
    catch (e) { if (e.code === "cancelled") throw e; const x = new Error(e.message); x.code = CODES_CLAUDE[e.code] || "upstream_error"; throw x; }
    return lireJson(r && r.data && r.data.text);
  },
};

/* ---------- écran de connexion ---------- */
let creation = false;
const MSG = {
  "auth/invalid-email": "Cette adresse e-mail n'est pas valide.",
  "auth/missing-password": "Saisissez votre mot de passe.",
  "auth/invalid-credential": "E-mail ou mot de passe incorrect.",
  "auth/wrong-password": "E-mail ou mot de passe incorrect.",
  "auth/user-not-found": "E-mail ou mot de passe incorrect.",
  "auth/email-already-in-use": "Un compte existe déjà avec cette adresse. Connectez-vous, ou utilisez « Mot de passe oublié ».",
  "auth/weak-password": "Mot de passe trop faible : 8 caractères au moins.",
  "auth/too-many-requests": "Trop de tentatives. Patientez quelques minutes avant de réessayer.",
  "auth/network-request-failed": "Pas de connexion internet. Réessayez une fois en ligne.",
  "auth/popup-closed-by-user": "",
  "auth/cancelled-popup-request": "",
  "auth/user-cancelled": "",
  "auth/account-exists-with-different-credential": "Un compte existe déjà avec cette adresse, créé autrement (e-mail, Google ou Apple). Connectez-vous de la même façon que la première fois.",
  "auth/operation-not-allowed": "Ce mode de connexion n'est pas encore activé.",
  "auth/unauthorized-domain": "Ce site n'est pas autorisé pour la connexion : ajoutez son domaine dans Firebase, Authentication, Paramètres.",
};
const montrer = (id, t) => { const el = $(id); el.textContent = t || ""; el.hidden = !t; };
const erreur = e => { const m = e && MSG[e.code]; if (m === "") return; montrer("aInfo", ""); montrer("aErr", m || "La connexion a échoué. Réessayez."); console.warn(e); };
function modeCreation(on) {
  creation = on;
  $("aOk").textContent = on ? "Créer mon compte" : "Se connecter";
  $("aMode").textContent = on ? "J'ai déjà un compte" : "Créer un compte";
  $("aMdp2L").hidden = !on; $("aAide").hidden = !on; $("aOubli").hidden = on;
  $("aMdp").autocomplete = on ? "new-password" : "current-password";
  montrer("aErr", ""); montrer("aInfo", "");
}
const autonome = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
async function viaFournisseur(p) {
  montrer("aErr", "");
  try {
    if (autonome() && reglages.authSurLeDomaine) await signInWithRedirect(auth, p);
    else await signInWithPopup(auth, p);
  } catch (e) {
    if (e.code === "auth/popup-blocked") { try { await signInWithRedirect(auth, p); } catch (e2) { erreur(e2); } }
    else erreur(e);
  }
}
function brancherConnexion() {
  const google = reglages.google !== false, apple = reglages.apple === true;
  $("aGoogle").hidden = !google; $("aApple").hidden = !apple; $("aOu").hidden = !google && !apple;
  $("aGoogle").addEventListener("click", () => viaFournisseur(new GoogleAuthProvider()));
  $("aApple").addEventListener("click", () => { const p = new OAuthProvider("apple.com"); p.addScope("email"); p.addScope("name"); p.setCustomParameters({ locale: "fr_FR" }); viaFournisseur(p); });
  $("aMode").addEventListener("click", () => modeCreation(!creation));
  $("aOubli").addEventListener("click", async () => {
    const mail = $("aMail").value.trim();
    if (!mail) { montrer("aErr", "Saisissez d'abord votre adresse e-mail, puis touchez « Mot de passe oublié »."); $("aMail").focus(); return; }
    try { await sendPasswordResetEmail(auth, mail); montrer("aErr", ""); montrer("aInfo", `Si un compte existe pour ${mail}, un e-mail vient d'y être envoyé pour choisir un nouveau mot de passe.`); }
    catch (e) { erreur(e); }
  });
  $("aForm").addEventListener("submit", async e => {
    e.preventDefault();
    const mail = $("aMail").value.trim(), mdp = $("aMdp").value;
    if (!mail || !mdp) return montrer("aErr", "Saisissez votre e-mail et votre mot de passe.");
    if (creation && mdp.length < 8) return montrer("aErr", "Choisissez un mot de passe de 8 caractères au moins.");
    if (creation && mdp !== $("aMdp2").value) return montrer("aErr", "Les deux mots de passe ne sont pas identiques.");
    $("aOk").disabled = true;
    try {
      if (creation) { const c = await createUserWithEmailAndPassword(auth, mail, mdp); sendEmailVerification(c.user).catch(() => {}); }
      else await signInWithEmailAndPassword(auth, mail, mdp);
    } catch (er) { erreur(er); }
    $("aOk").disabled = false;
  });
  getRedirectResult(auth).catch(erreur);
}

/* ---------- compte et sauvegarde, dans les réglages ---------- */
const fnSuppr = httpsCallable(fns, "supprimerCompte", { timeout: 120000 });
function brancherReglages() {
  const msg = t => { const el = $("cptMsg"); el.textContent = t; el.hidden = !t; };
  const u = auth.currentUser;
  $("cptMdp").hidden = !u.providerData.some(p => p.providerId === "password");
  $("cptMdp").addEventListener("click", async () => {
    try { await sendPasswordResetEmail(auth, auth.currentUser.email); msg(`Un e-mail vient d'être envoyé à ${auth.currentUser.email} pour choisir un nouveau mot de passe.`); }
    catch (e) { msg("L'envoi a échoué. Réessayez dans un moment."); }
  });
  $("cptOut").addEventListener("click", async () => { await signOut(auth); location.reload(); });
  let arme = false;
  $("cptDel").addEventListener("click", async e => {
    const b = e.currentTarget;
    if (!arme) { arme = true; b.textContent = "Confirmer : tout supprimer définitivement"; msg("Vos caves, vins, photos et sorties seront effacés, ainsi que votre compte. Pensez à exporter vos données avant. Touchez de nouveau le bouton pour confirmer."); return; }
    b.disabled = true; msg("Suppression en cours…");
    try { await fnSuppr({}); await signOut(auth).catch(() => {}); location.reload(); }
    catch (er) { b.disabled = false; arme = false; b.textContent = "Supprimer mon compte et mes données…"; msg("La suppression a échoué. Réessayez, ou écrivez-nous si cela persiste."); }
  });
  $("bkExp").addEventListener("click", exporter);
  $("bkImp").addEventListener("click", () => $("bkFile").click());
  $("bkFile").addEventListener("change", e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) importer(f); });
}
const bk = t => { const el = $("bkMsg"); el.textContent = t; el.hidden = !t; };
async function exporter() {
  bk("Préparation du fichier…");
  try {
    const docs = {};
    const lister = async p => (await getDocs(collection(fs, `${base()}/${p}`))).docs.forEach(d => { docs[`${p}/${d.id}`] = d.data(); });
    await lister("config"); await lister("caves");
    const ids = ((docs["config/caves"] || {}).liste || []).map(c => c && c.id).filter(id => typeof id === "string" && id);
    for (const pre of ["", ...ids.map(id => `caves/${id}/`)]) for (const c of ["vins", "sorties", "photos"]) await lister(pre + c);
    const n = Object.keys(docs).length, blob = new Blob([JSON.stringify({ format: "cave-a-vin", version: 1, exporteLe: new Date().toISOString(), docs })], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `sauvegarde-cave-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    bk(`Fichier prêt : ${n} éléments. Gardez-le en lieu sûr.`);
  } catch (e) { bk("L'export a échoué. Vérifiez votre connexion et réessayez."); console.warn(e); }
}
const CHEMIN = /^(config\/(cave|caves)|caves\/[a-z0-9]+|(caves\/[a-z0-9]+\/)?(vins|sorties|photos)\/[A-Za-z0-9_-]{1,64})$/;
async function importer(file) {
  let j;
  try { j = JSON.parse(await file.text()); } catch (e) { return bk("Ce fichier n'est pas une sauvegarde lisible."); }
  if (!j || j.format !== "cave-a-vin" || !j.docs || typeof j.docs !== "object") return bk("Ce fichier n'est pas une sauvegarde de Ma cave à vin.");
  const items = Object.entries(j.docs).filter(([p, d]) => CHEMIN.test(p) && d && typeof d === "object" && !Array.isArray(d));
  if (!items.length) return bk("Cette sauvegarde est vide.");
  const nv = items.filter(([p]) => /(^|\/)vins\//.test(p)).length;
  if (!confirm(`Importer cette sauvegarde (${nv} vin${nv > 1 ? "s" : ""}, ${items.length} éléments en tout) ?\nLes éléments déjà présents avec le même identifiant seront remplacés ; les autres sont conservés.`)) return;
  let fait = 0;
  try {
    // par lots : 400 écritures et 8 Mo au plus par lot, les photos pesant jusqu'à 250 ko
    for (let i = 0; i < items.length;) {
      const b = writeBatch(fs); let n = 0, taille = 0;
      while (i < items.length && n < 400) {
        const [p, d] = items[i], t = JSON.stringify(d).length;
        if (n && taille + t > 8e6) break;
        b.set(doc(fs, `${base()}/${p}`), d); n++; taille += t; i++;
      }
      await b.commit(); fait += n; bk(`Import en cours : ${fait} sur ${items.length}…`);
    }
    bk(`Import terminé : ${fait} éléments, dont ${nv} vin${nv > 1 ? "s" : ""}.`);
  } catch (e) { bk(`L'import s'est arrêté après ${fait} éléments. Relancez-le : les éléments déjà importés seront simplement remplacés.`); console.warn(e); }
}

/* ---------- abonnement : 50 bouteilles gratuites, puis une formule annuelle (Stripe) ---------- */
const PLANS = {
  cave100: { nom: "Cave 100", limite: 100, prix: "5,99 €" },
  cave200: { nom: "Cave 200", limite: 200, prix: "9,90 €" },
  illimite: { nom: "Grande cave", limite: 1e9, prix: "19,90 €" },
};
const GRATUIT = 50;
const fnEtat = httpsCallable(fns, "etatAbonnement"), fnPayer = httpsCallable(fns, "creerPaiement"), fnPortail = httpsCallable(fns, "portailAbonnement");
let abo = null;
const compte = {
  paiement: reglages.paiement === true, PLANS, GRATUIT,
  async etat(frais) {   // l'état confirmé par le serveur ; « inconnu » hors ligne, pour ne jamais bloquer quelqu'un sans réseau
    if (!abo || frais) { try { abo = (await fnEtat({})).data; } catch (e) { console.warn("Abonnement : état illisible", e && e.code, e && e.message); if (!abo) return { statut: "inconnu" }; } }
    return abo;
  },
  actif: a => !!(a && ["active", "trialing", "past_due", "offert"].includes(a.statut) && PLANS[a.plan]),
  limite(a) { return compte.actif(a) ? PLANS[a.plan].limite : GRATUIT; },
  async total() {   // bouteilles en cave, toutes caves confondues
    const lire = async p => (await getDocs(collection(fs, `${base()}/${p}`))).docs;
    const liste = (await getDoc(doc(fs, `${base()}/config/caves`))).data();
    const ids = ((liste && liste.liste) || []).map(c => c && c.id).filter(id => typeof id === "string" && id);
    let n = 0;
    for (const pre of ["", ...ids.map(id => `caves/${id}/`)]) for (const d of await lire(pre + "vins")) { const v = d.data(); n += (Array.isArray(v.places) ? v.places.length : 0) + (typeof v.vrac === "number" && v.vrac > 0 ? v.vrac : 0); }
    return n;
  },
  async payer(plan) { const r = await fnPayer({ plan }); location.href = r.data.url; },
  async portail() { const r = await fnPortail({}); location.href = r.data.url; },
};

/* ---------- démarrage ---------- */
brancherConnexion();
let demarre = false;
onAuthStateChanged(auth, u => {
  $("boot").hidden = true;
  if (!u) { if (demarre) location.reload(); $("auth").hidden = false; $("appRoot").hidden = true; return; }
  uid = u.uid;
  $("auth").hidden = true; $("appRoot").hidden = false;
  if (demarre) return;
  demarre = true;
  brancherReglages();
  window.compte = compte;
  window.claude = { use: async n => (n === "db" ? db : n === "user" ? user : n === "sample" ? sample : null) };
  window.__pretOk();
});
