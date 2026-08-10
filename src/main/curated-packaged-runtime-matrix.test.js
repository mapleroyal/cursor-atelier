import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as plist from "plist";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  acquireCuratedFamilySources,
  computeCuratedTreeDigest,
  CURATED_SOURCE_CATALOG,
} from "./curated-source-acquisition.js";
import { convertCuratedFamily } from "./curated-converter-client.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const converterExecutable = path.join(
  projectRoot,
  "out.noindex",
  `Cursor Atelier-darwin-${process.arch}`,
  "Cursor Atelier.app",
  "Contents",
  "Resources",
  "curated-cursor-converter",
  "curated-cursor-converter",
);
const familyCatalog = JSON.parse(
  fs.readFileSync(
    path.join(
      projectRoot,
      "native",
      "cursor-packs",
      "curated-family-catalog.json",
    ),
    "utf8",
  ),
);
const developerSourceRoot = path.join(
  projectRoot,
  "native",
  "cursor-packs",
  "sources",
);
const localOreoSourceRoot = path.join(
  projectRoot,
  "native",
  "oreo",
  "ArtworkSource",
);
const enabled = process.env.CURSOR_ATELIER_PACKAGED_MATRIX === "1";
const fullFamilies =
  process.env.CURSOR_ATELIER_PACKAGED_MATRIX_VARIANTS === "all";
const requestedFamilies = (
  process.env.CURSOR_ATELIER_PACKAGED_MATRIX_FAMILIES ?? ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const selectedFamilies = requestedFamilies.length
  ? familyCatalog.families.filter((family) =>
      requestedFamilies.includes(family.id),
    )
  : familyCatalog.families;
const svgRecipeFamilies = new Set([
  "oreo",
  "volantes",
  "vimix",
  "qogir",
  "bibata-extra",
  "simp1e",
  "capitaine",
  "future",
  "colloid",
  "bibata",
]);
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

let temporaryRoot;
const verifiedSources = new Set();
const resolvedSourceRoots = new Map();
const results = [];

async function removeTemporaryRoot() {
  if (!temporaryRoot) {
    return;
  }
  const canonicalTemporaryRoot = await fs.promises.realpath(temporaryRoot);
  const canonicalSystemTemporaryRoot = await fs.promises.realpath(os.tmpdir());
  const stat = await fs.promises.lstat(canonicalTemporaryRoot);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    path.dirname(canonicalTemporaryRoot) !== canonicalSystemTemporaryRoot ||
    !path
      .basename(canonicalTemporaryRoot)
      .startsWith("cursor-atelier-curated-matrix-")
  ) {
    throw new Error(
      `Refusing to remove unexpected matrix path: ${canonicalTemporaryRoot}`,
    );
  }
  await fs.promises.rm(canonicalTemporaryRoot, { recursive: true });
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function verifySource(source, sourceRoot) {
  if (verifiedSources.has(source.id)) {
    return;
  }
  const root = path.join(sourceRoot, source.directory);
  if (source.type === "repository") {
    const actual = await computeCuratedTreeDigest(root, source.inputRoots);
    if (
      actual.sha256 !== source.treeSha256 ||
      actual.entries !== source.treeEntries
    ) {
      throw new Error(`${source.id}: local source differs from its tree lock`);
    }
  } else {
    for (const archive of source.archives) {
      const archivePath = path.join(root, "archives", archive.name);
      if (
        fs.existsSync(archivePath) &&
        (await sha256File(archivePath)) !== archive.sha256
      ) {
        throw new Error(
          `${source.id}/${archive.name}: archive digest mismatch`,
        );
      }
      const expanded = path.join(
        root,
        "expanded",
        path.parse(archive.name).name,
      );
      const actual = await computeCuratedTreeDigest(expanded, ["."]);
      if (
        actual.sha256 !== archive.treeSha256 ||
        actual.entries !== archive.treeEntries
      ) {
        throw new Error(
          `${source.id}/${archive.name}: expanded source differs from its tree lock`,
        );
      }
    }
  }
  verifiedSources.add(source.id);
}

async function verifyFamilySources(familyId, sourceRoot) {
  const family = CURATED_SOURCE_CATALOG.families.find(
    (candidate) => candidate.id === familyId,
  );
  for (const sourceId of family.sourceIds) {
    const source = CURATED_SOURCE_CATALOG.sources.find(
      (candidate) => candidate.id === sourceId,
    );
    await verifySource(source, sourceRoot);
  }
}

async function stageLocalGnomeArchives(familyId) {
  const family = CURATED_SOURCE_CATALOG.families.find(
    (candidate) => candidate.id === familyId,
  );
  const localArchiveRoot = path.join(temporaryRoot, "local-archives");
  await fs.promises.mkdir(localArchiveRoot, { recursive: true, mode: 0o700 });
  for (const sourceId of family.sourceIds) {
    const source = CURATED_SOURCE_CATALOG.sources.find(
      (candidate) => candidate.id === sourceId,
    );
    if (source.type !== "gnome-look") {
      continue;
    }
    const destinationRoot = path.join(localArchiveRoot, source.id);
    await fs.promises.mkdir(destinationRoot, {
      recursive: true,
      mode: 0o700,
    });
    for (const archive of source.archives) {
      const sourcePath = path.join(
        developerSourceRoot,
        source.directory,
        "archives",
        archive.name,
      );
      const destination = path.join(destinationRoot, archive.name);
      try {
        await fs.promises.copyFile(
          sourcePath,
          destination,
          fs.constants.COPYFILE_EXCL,
        );
        await fs.promises.chmod(destination, 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
      }
    }
  }
  return localArchiveRoot;
}

async function resolveFamilySourceRoot(familyId) {
  if (resolvedSourceRoots.has(familyId)) {
    return resolvedSourceRoots.get(familyId);
  }
  const localRoot =
    familyId === "oreo" ? localOreoSourceRoot : developerSourceRoot;
  try {
    await verifyFamilySources(familyId, localRoot);
    resolvedSourceRoots.set(familyId, localRoot);
    return localRoot;
  } catch {
    const family = CURATED_SOURCE_CATALOG.families.find(
      (candidate) => candidate.id === familyId,
    );
    for (const sourceId of family.sourceIds) {
      verifiedSources.delete(sourceId);
    }
    const hasGnomeSources = family.sourceIds.some(
      (sourceId) =>
        CURATED_SOURCE_CATALOG.sources.find(
          (candidate) => candidate.id === sourceId,
        ).type === "gnome-look",
    );
    const acquired = await acquireCuratedFamilySources({
      familyIds: [familyId],
      cacheRoot: path.join(temporaryRoot, "pinned-sources"),
      localArchiveRoot: hasGnomeSources
        ? await stageLocalGnomeArchives(familyId)
        : undefined,
    });
    await verifyFamilySources(familyId, acquired.sourceRoot);
    resolvedSourceRoots.set(familyId, acquired.sourceRoot);
    return acquired.sourceRoot;
  }
}

async function validateArtifact({ artifactDirectory, expected, familyId }) {
  const manifestPath = path.join(artifactDirectory, "manifest.json");
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
  expect(manifest).toMatchObject({
    schemaVersion: 2,
    roleCount: 47,
  });
  expect(manifest.themes).toHaveLength(1);
  const entry = manifest.themes[0];
  expect(entry).toMatchObject({
    Identifier: expected.identifier,
    DisplayName: expected.displayName,
    Variant: expected.variant,
    VariantLabel: expected.variant,
    CuratedFamilyId: familyId,
    CuratedCatalogSHA256: familyCatalog.sha256,
    SourceFormat: "curated-source",
  });
  expect(entry.rolePreviews).toHaveLength(47);
  expect(new Set(entry.rolePreviews.map((row) => row.macIdentifier)).size).toBe(
    47,
  );

  const resourcePath = path.join(artifactDirectory, entry.Resource);
  const resourceBytes = await fs.promises.readFile(resourcePath);
  expect(digest(resourceBytes)).toBe(entry.SHA256);
  const theme = plist.parseBinary(resourceBytes);
  expect(theme.Identifier).toBe(expected.identifier);
  expect(Object.keys(theme.Cursors)).toHaveLength(47);

  const previewAssets = [
    ...new Set(entry.rolePreviews.map((row) => row.asset)),
  ];
  for (const relative of previewAssets) {
    const asset = path.resolve(artifactDirectory, relative);
    expect(path.relative(artifactDirectory, asset)).not.toMatch(
      /^\.\.(?:\/|$)/,
    );
    const metadata = await sharp(asset).metadata();
    expect([metadata.width, metadata.height, metadata.format]).toEqual([
      96,
      96,
      "png",
    ]);
  }
  return {
    previewAssets: previewAssets.length,
    resourceBytes: resourceBytes.length,
  };
}

const describeMatrix = enabled ? describe : describe.skip;

describeMatrix("packaged curated converter matrix", () => {
  beforeAll(async () => {
    if (
      requestedFamilies.some(
        (familyId) =>
          !familyCatalog.families.some((row) => row.id === familyId),
      )
    ) {
      throw new Error("The packaged matrix includes an unknown family ID.");
    }
    if (!fs.existsSync(converterExecutable)) {
      throw new Error(
        "The packaged converter is missing. Run `npm run package` first.",
      );
    }
    temporaryRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "cursor-atelier-curated-matrix-"),
    );
  }, 1_200_000);

  afterAll(async () => {
    if (results.length) {
      process.stdout.write(
        `\n${JSON.stringify({ packagedCuratedMatrix: results }, null, 2)}\n`,
      );
    }
    await removeTemporaryRoot();
  }, 120_000);

  test.each(selectedFamilies)(
    "$id converts pinned source through the packaged executable",
    async (family) => {
      const sourceRoot = await resolveFamilySourceRoot(family.id);
      const outputRoot = path.join(temporaryRoot, `output-${family.id}`);
      await fs.promises.mkdir(outputRoot, { mode: 0o700 });
      const selected = fullFamilies ? family.variants : [family.variants[0]];
      const selectedIds = new Set(
        selected.map((variant) => variant.identifier),
      );
      const skipIdentifiers = family.variants
        .filter((variant) => !selectedIds.has(variant.identifier))
        .map((variant) => variant.identifier);
      const events = [];
      let svgSourceCalls = 0;
      const instrumentedSharp = (input, ...options) => {
        if (
          typeof input === "string" &&
          [".svg", ".svgz"].includes(path.extname(input).toLowerCase())
        ) {
          svgSourceCalls += 1;
        }
        return sharp(input, ...options);
      };
      const startedAt = performance.now();
      await convertCuratedFamily({
        command: converterExecutable,
        familyId: family.id,
        sourceRoot,
        outputRoot,
        skipIdentifiers,
        sharpImpl: instrumentedSharp,
        onEvent: async (event) => events.push(event),
        idleTimeoutMs: 10 * 60 * 1_000,
        totalTimeoutMs: 30 * 60 * 1_000,
      });
      const elapsedMs = Math.round(performance.now() - startedAt);
      const completed = events.filter(
        (event) => event.type === "variant-complete",
      );
      expect(completed.map((event) => event.identifier)).toEqual(
        selected.map((variant) => variant.identifier),
      );
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "catalog",
          "conversion-started",
          "variant-start",
          "variant-complete",
          "family-complete",
          "done",
        ]),
      );
      if (svgRecipeFamilies.has(family.id)) {
        expect(svgSourceCalls).toBeGreaterThan(0);
        expect(svgSourceCalls % 2).toBe(0);
      } else {
        expect(svgSourceCalls).toBe(0);
      }

      let resourceBytes = 0;
      let previewAssets = 0;
      for (const variant of selected) {
        const event = completed.find(
          (candidate) => candidate.identifier === variant.identifier,
        );
        const validated = await validateArtifact({
          artifactDirectory: event.artifactDirectory,
          expected: variant,
          familyId: family.id,
        });
        resourceBytes += validated.resourceBytes;
        previewAssets += validated.previewAssets;
      }
      results.push({
        familyId: family.id,
        identifiers: selected.map((variant) => variant.identifier),
        elapsedMs,
        resourceBytes,
        previewAssets,
        svgRenderRequests: svgSourceCalls / 2,
      });
    },
    30 * 60 * 1_000,
  );
});
