// Chiffre le site complet (landing-src/accueil.html) pour la page d'attente : seul le mot de passe permet de l'afficher.
// Usage : VITRINE_MDP='…' node scripts/chiffrer-vitrine.mjs   (le mot de passe n'est jamais enregistré dans le dépôt)
import { readFile, writeFile } from "node:fs/promises";
import { webcrypto as C } from "node:crypto";

const mdp = process.env.VITRINE_MDP;
if (!mdp) { console.error("Indiquez le mot de passe : VITRINE_MDP='…' node scripts/chiffrer-vitrine.mjs"); process.exit(1); }
const html = await readFile("landing-src/accueil.html", "utf8");
const sel = C.getRandomValues(new Uint8Array(16)), iv = C.getRandomValues(new Uint8Array(12)), TOURS = 250000;
const base = await C.subtle.importKey("raw", new TextEncoder().encode(mdp), "PBKDF2", false, ["deriveKey"]);
const cle = await C.subtle.deriveKey({ name: "PBKDF2", salt: sel, iterations: TOURS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
const data = new Uint8Array(await C.subtle.encrypt({ name: "AES-GCM", iv }, cle, new TextEncoder().encode(html)));
const b64 = u => Buffer.from(u).toString("base64");
await writeFile("landing/accueil.enc.json", JSON.stringify({ v: 1, tours: TOURS, sel: b64(sel), iv: b64(iv), data: b64(data) }));
console.log("Chiffré : landing/accueil.enc.json");
