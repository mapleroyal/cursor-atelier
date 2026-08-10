import fs from "node:fs";

const documentPath = process.argv[2];
if (!documentPath) {
  throw new Error("An Icon Composer JSON path is required.");
}

const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
let promotedCount = 0;

function promoteDarkSpecializations(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      promoteDarkSpecializations(item);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("-specializations") && Array.isArray(child)) {
      const dark = child.find((entry) => entry?.appearance === "dark");
      if (dark) {
        const promoted = structuredClone(dark);
        delete promoted.appearance;
        value[key] = [promoted];
        promotedCount += 1;
      }
    }
    promoteDarkSpecializations(value[key]);
  }
}

promoteDarkSpecializations(document);
if (promotedCount === 0) {
  throw new Error("The Icon Composer document has no dark specializations.");
}

fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
