import crypto from "node:crypto";

import catalogDocument from "../../native/cursor-packs/curated-family-catalog.json";

import { CURATED_FAMILY_IDS } from "./curated-source-acquisition.js";

const THEME_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_LABEL_LENGTH = 256;

function fail(message) {
  const error = new Error(message);
  error.code = "INVALID_CURATED_CATALOG";
  throw error;
}

function boundedLabel(value) {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= MAX_LABEL_LENGTH
  );
}

export function validateCuratedFamilyCatalog(document) {
  if (
    document?.schemaVersion !== 1 ||
    document?.themeCount !== 240 ||
    !Array.isArray(document?.families) ||
    document.families.length !== CURATED_FAMILY_IDS.length
  ) {
    fail("The curated family catalog has an unsupported schema.");
  }

  const familyIds = document.families.map((family) => family?.id);
  if (
    familyIds.some((familyId, index) => familyId !== CURATED_FAMILY_IDS[index])
  ) {
    fail("The curated family catalog does not match the onboarding families.");
  }

  const identifiers = new Set();
  const digestLines = [];
  const families = document.families.map((family) => {
    if (!boundedLabel(family.name) || !Array.isArray(family.variants)) {
      fail(`The curated family ${family.id} is invalid.`);
    }
    const variants = family.variants.map((variant) => {
      if (
        !THEME_ID.test(String(variant?.identifier ?? "")) ||
        identifiers.has(variant.identifier) ||
        !boundedLabel(variant.displayName) ||
        !boundedLabel(variant.variant)
      ) {
        fail(`The curated family ${family.id} has an invalid variant.`);
      }
      identifiers.add(variant.identifier);
      digestLines.push(
        `${family.id}\0${variant.identifier}\0${variant.displayName}\0${variant.variant}\n`,
      );
      return Object.freeze({
        identifier: variant.identifier,
        displayName: variant.displayName,
        variant: variant.variant,
      });
    });
    if (variants.length === 0) {
      fail(`The curated family ${family.id} has no variants.`);
    }
    return Object.freeze({
      id: family.id,
      name: family.name,
      variants: Object.freeze(variants),
    });
  });

  const digest = crypto
    .createHash("sha256")
    .update(digestLines.join(""))
    .digest("hex");
  if (identifiers.size !== document.themeCount || digest !== document.sha256) {
    fail("The curated family catalog failed its integrity check.");
  }

  return Object.freeze({
    schemaVersion: 1,
    themeCount: document.themeCount,
    sha256: digest,
    families: Object.freeze(families),
  });
}

export const CURATED_FAMILY_CATALOG =
  validateCuratedFamilyCatalog(catalogDocument);

export const CURATED_VARIANTS_BY_FAMILY = new Map(
  CURATED_FAMILY_CATALOG.families.map((family) => [
    family.id,
    Object.freeze(family.variants.map((variant) => variant.identifier)),
  ]),
);
