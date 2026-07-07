const fs = require("fs");
const path = require("path");

const catalogPath = path.join(__dirname, "..", "public", "vsellmCatalog.ts");
const outputPath = path.join(__dirname, "..", "public", "legacy-models.js");

const src = fs.readFileSync(catalogPath, "utf8");
const match = src.match(/export const VSELLM_TEXT_MODELS[^=]*=\s*(\[[\s\S]*?\]);/);

if (!match) {
  throw new Error("Could not find VSELLM_TEXT_MODELS in vsellmCatalog.ts");
}

const models = eval(match[1]);
const lines = [
  "// Generated from public/vsellmCatalog.ts — ES5 data for /legacy",
  "var LEGACY_TEXT_MODELS = [",
];

for (const entry of models) {
  lines.push(
    `  { id: ${JSON.stringify(entry.id)}, name: ${JSON.stringify(entry.name)}, provider: ${JSON.stringify(entry.provider)} },`
  );
}

lines.push("];", "");
fs.writeFileSync(outputPath, lines.join("\n"));
console.log(`Wrote ${models.length} models to public/legacy-models.js`);
