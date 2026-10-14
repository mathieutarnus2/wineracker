// Les demandes envoyées à Claude sont écrites dans src/app.html ; le serveur en garde une copie exacte
// (functions/modeles.gen.js) et n'accepte que celles-ci : impossible d'utiliser la fonction pour autre chose.
import { readFile, writeFile } from "node:fs/promises";

function fin(src, i) {   // fin d'un gabarit `…` qui commence à i (gère les ${ … } et les gabarits imbriqués)
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "`") return j + 1;
    if (c === "$" && src[j + 1] === "{") { j = finAcc(src, j + 1); continue; }
    j++;
  }
  throw new Error("gabarit non fermé");
}
function finAcc(src, i) {   // fin d'un bloc { … } qui commence à i
  let n = 0, j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "`") { j = fin(src, j); continue; }
    if (c === '"' || c === "'") { const q = c; j++; while (src[j] !== q) j += src[j] === "\\" ? 2 : 1; j++; continue; }
    if (c === "{") n++;
    if (c === "}") { n--; if (!n) return j + 1; }
    j++;
  }
  throw new Error("bloc non fermé");
}
const prendre = (src, debut, type) => {
  const i = src.indexOf(debut); if (i < 0) throw new Error("introuvable : " + debut);
  const k = type === "gabarit" ? src.indexOf("`", i) : src.indexOf("{", i);
  return src.slice(i, type === "gabarit" ? fin(src, k) : finAcc(src, k)) + ";";
};

export async function genererModeles() {
  const src = await readFile("src/app.html", "utf8");
  const lit = prendre(src, "const MODELES = {", "bloc").replace(/^const MODELES = /, "").replace(/;$/, "");
  const M = new Function("cases_", "etag_", "bacs_", `return (${lit})`)(() => 0, () => 0, () => 0);
  const catalogue = Object.fromEntries(Object.entries(M).map(([id, m]) => [id, { nom: m.nom, desc: m.desc, f: m.f.map(x => [x[0], x[1]]) }]));
  const morceaux = [
    prendre(src, "const REGLES_CONSEILS = `", "gabarit"),
    prendre(src, "const promptConseils = fiche => `", "gabarit"),
    prendre(src, "const PROMPT = `", "gabarit"),
    prendre(src, "const PROMPT_PRIX = `", "gabarit"),
    prendre(src, "const PROMPT_MAJ = `", "gabarit"),
    prendre(src, "function promptCave(n) {", "bloc"),
  ];
  const code = `/* Fichier généré par scripts/modeles-claude.mjs depuis src/app.html : ne pas modifier à la main. */
const MODELES = ${JSON.stringify(catalogue)};
module.exports = AN => {
${morceaux.join("\n")}
  return { etiquette: () => PROMPT, conseils: f => promptConseils(f), prix: l => PROMPT_PRIX + JSON.stringify(l), valeurs: l => PROMPT_MAJ + JSON.stringify(l), cave: n => promptCave(n) };
};
`;
  await writeFile("functions/modeles.gen.js", code);
}
