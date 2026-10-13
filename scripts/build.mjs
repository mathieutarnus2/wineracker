// Assemble public/index.html (coquille + application) et regroupe le code Firebase dans public/js/firebase.js.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const coquille = await readFile("src/shell.html", "utf8");
const appli = await readFile("src/app.html", "utf8");
if (!coquille.includes("<!--APP-->")) throw new Error("Repère <!--APP--> absent de src/shell.html");
const d = new Date(), VERSION = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
await writeFile("public/index.html", coquille.replace("<!--APP-->", () => appli).replaceAll("__VERSION__", VERSION));
await mkdir("public/js", { recursive: true });
await writeFile("public/admin.html", await readFile("src/admin.html", "utf8"));
await build({ entryPoints: ["src/admin.js"], bundle: true, format: "esm", target: "es2022", minify: true, sourcemap: false, outfile: "public/js/admin.js", legalComments: "none" });
await build({ entryPoints: ["src/firebase.js"], bundle: true, format: "esm", target: "es2022", minify: true, sourcemap: false, outfile: "public/js/firebase.js", legalComments: "none" });
console.log("Construit : public/index.html et public/js/firebase.js");
