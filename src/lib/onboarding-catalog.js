const previewModules = import.meta.glob(
  [
    "../../native/cursor-packs/generated/previews/OreoWhite/{default,pointer,text}.png",
    "../../native/cursor-packs/generated/previews/Remus/{default,pointer,text}.png",
    "../../native/cursor-packs/generated/previews/DropBlue/{default,pointer,text}.png",
    "../../native/cursor-packs/generated/previews/MogaClassic/{default,pointer,text}.png",
    "../../native/cursor-packs/generated/previews/Volantes/{default,pointer,text}.png",
    "../../native/cursor-packs/generated/previews/Vimix/{default,pointer,text}.png",
    "../../native/cursor-packs/generated/previews/Qogir/{default,pointer,text}.png",
    "../../native/cursor-packs/generated/previews/BibataExtraModernDodgerBlue/{default,pointer,text}.png",
    "../../native/cursor-packs/generated/previews/GoogleBlue/{default,pointer,text}.png",
    "../../native/cursor-packs/generated/previews/Simp1e/{default,pointer,text}.png",
    "../../native/cursor-packs/generated/previews/Capitaine/{default,pointer,text}.png",
    "../../native/cursor-packs/generated/previews/Future/{default,pointer,text}.png",
    "../../native/cursor-packs/generated/previews/Nordzy/{default,pointer,text}.png",
    "../../native/cursor-packs/generated/previews/Colloid/{default,pointer,text}.png",
    "../../native/cursor-packs/generated/previews/BibataModernIce/{default,pointer,text}.png",
  ],
  { eager: true, import: "default", query: "?url" },
);

function previewUrl(path) {
  return previewModules[`../../native/cursor-packs/generated/previews/${path}`];
}

function createFamily({ id, family, variant, previewDirectory }) {
  return Object.freeze({
    id,
    family,
    variant,
    previews: Object.freeze([
      previewUrl(`${previewDirectory}/default.png`),
      previewUrl(`${previewDirectory}/pointer.png`),
      previewUrl(`${previewDirectory}/text.png`),
    ]),
  });
}

/**
 * The chooser carries only these three tiny, static previews per family. The
 * installable cursor resources remain entirely on demand.
 */
export const ONBOARDING_FAMILIES = Object.freeze([
  createFamily({
    id: "oreo",
    family: "Oreo",
    variant: "White",
    previewDirectory: "OreoWhite",
  }),
  createFamily({
    id: "remus",
    family: "Remus",
    variant: "Black",
    previewDirectory: "Remus",
  }),
  createFamily({
    id: "drop",
    family: "Drop",
    variant: "Blue",
    previewDirectory: "DropBlue",
  }),
  createFamily({
    id: "moga",
    family: "Moga",
    variant: "Classic Black",
    previewDirectory: "MogaClassic",
  }),
  createFamily({
    id: "volantes",
    family: "Volantes",
    variant: "Default",
    previewDirectory: "Volantes",
  }),
  createFamily({
    id: "vimix",
    family: "Vimix",
    variant: "Default",
    previewDirectory: "Vimix",
  }),
  createFamily({
    id: "qogir",
    family: "Qogir",
    variant: "Default",
    previewDirectory: "Qogir",
  }),
  createFamily({
    id: "bibata-extra",
    family: "Bibata Extra",
    variant: "Modern Dodger Blue",
    previewDirectory: "BibataExtraModernDodgerBlue",
  }),
  createFamily({
    id: "google",
    family: "Google",
    variant: "Blue",
    previewDirectory: "GoogleBlue",
  }),
  createFamily({
    id: "simp1e",
    family: "Simp1e",
    variant: "Default",
    previewDirectory: "Simp1e",
  }),
  createFamily({
    id: "capitaine",
    family: "Capitaine",
    variant: "Default",
    previewDirectory: "Capitaine",
  }),
  createFamily({
    id: "future",
    family: "Future",
    variant: "Default",
    previewDirectory: "Future",
  }),
  createFamily({
    id: "nordzy",
    family: "Nordzy",
    variant: "Default",
    previewDirectory: "Nordzy",
  }),
  createFamily({
    id: "colloid",
    family: "Colloid",
    variant: "Default",
    previewDirectory: "Colloid",
  }),
  createFamily({
    id: "bibata",
    family: "Bibata",
    variant: "Modern Ice",
    previewDirectory: "BibataModernIce",
  }),
]);

export const ONBOARDING_FAMILIES_BY_ID = new Map(
  ONBOARDING_FAMILIES.map((family) => [family.id, family]),
);
