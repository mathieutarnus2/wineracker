// Assemble public/index.html (coquille + application) et regroupe le code Firebase dans public/js/firebase.js.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const coquille = await readFile("src/shell.html", "utf8");
const appli = await readFile("src/app.html", "utf8");
if (!coquille.includes("<!--APP-->")) throw new Error("Repère <!--APP--> absent de src/shell.html");
await writeFile("public/index.html", coquille.replace("<!--APP-->", () => appli));
await mkdir("public/js", { recursive: true });
await build({ entryPoints: ["src/firebase.js"], bundle: true, format: "esm", target: "es2022", minify: true, sourcemap: false, outfile: "public/js/firebase.js", legalComments: "none" });
console.log("Construit : public/index.html et public/js/firebase.js");
