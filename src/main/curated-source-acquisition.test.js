import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import zlib from "node:zlib";

import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireCuratedFamilySources,
  computeCuratedTreeDigest,
  CURATED_FAMILY_IDS,
  CURATED_SOURCE_CATALOG,
  reconcileCuratedSourceTransactions,
  removeCuratedFamilySources,
  validateCuratedSourceCatalog,
} from "./curated-source-acquisition.js";

const temporaryRoots = [];

async function temporaryRoot() {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "cursor-curated-source-test-"),
  );
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.promises.rm(root, { recursive: true, force: true })),
  );
});

function repositoryCatalog({
  digest,
  archiveUrl = "https://example.test/source.tar.gz",
}) {
  return {
    schemaVersion: 1,
    cacheVersion: 1,
    families: [
      {
        id: "fixture",
        name: "Fixture",
        variantCount: 1,
        sourceIds: ["fixture"],
      },
    ],
    sources: [
      {
        id: "fixture",
        type: "repository",
        directory: "fixture-source",
        revision: "1".repeat(40),
        archiveUrl,
        inputRoots: ["assets", "LICENSE"],
        treeSha256: digest.sha256,
        treeEntries: digest.entries,
      },
    ],
  };
}

async function reconciliationFixture(root) {
  const cache = path.join(root, "cache");
  const seed = path.join(root, "seed");
  await fs.promises.mkdir(path.join(seed, "assets"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.promises.writeFile(path.join(seed, "assets/cursor.svg"), "pinned");
  await fs.promises.writeFile(path.join(seed, "LICENSE"), "license");
  const digest = await computeCuratedTreeDigest(seed, ["assets", "LICENSE"]);
  const catalog = repositoryCatalog({ digest });
  const destination = path.join(cache, "fixture-source");
  await fs.promises.mkdir(cache, { recursive: true, mode: 0o700 });
  await fs.promises.cp(seed, destination, { recursive: true });
  await fs.promises.chmod(destination, 0o700);
  await fs.promises.writeFile(
    path.join(destination, ".cursor-atelier-source.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      cacheVersion: 1,
      sourceId: "fixture",
      sourceType: "repository",
      revision: "1".repeat(40),
    })}\n`,
    { mode: 0o600 },
  );
  return { cache, catalog, destination };
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function rawTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write(octal(entry.mode ?? 0o644, 8), 100, 8, "ascii");
    header.write(octal(0, 8), 108, 8, "ascii");
    header.write(octal(0, 8), 116, 8, "ascii");
    header.write(octal(data.length, 12), 124, 12, "ascii");
    header.write(octal(0, 12), 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    header.write(entry.linkName ?? "", 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(
      `${checksum.toString(8).padStart(6, "0")}\0 `,
      148,
      8,
      "ascii",
    );
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1_024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipArchive(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? "");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(
      ((entry.name.endsWith("/") ? 0o040755 : 0o100644) << 16) >>> 0,
      38,
    );
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

async function gnomeFixture() {
  const root = await temporaryRoot();
  const local = path.join(root, "local", "fixture");
  await fs.promises.mkdir(local, { recursive: true });
  const zipBytes = zipArchive([
    { name: "Theme/" },
    { name: "Theme/cursors/" },
    { name: "Theme/cursors/default", data: "cursor" },
    { name: "Theme/windows/" },
    { name: "Theme/windows/default.cur", data: "ignored" },
  ]);
  const archivePath = path.join(local, "Theme.zip");
  await fs.promises.writeFile(archivePath, zipBytes);
  const expected = path.join(root, "expected");
  await fs.promises.mkdir(path.join(expected, "Theme/cursors"), {
    recursive: true,
  });
  await fs.promises.writeFile(
    path.join(expected, "Theme/cursors/default"),
    "cursor",
  );
  const tree = await computeCuratedTreeDigest(expected, ["."]);
  const catalog = {
    schemaVersion: 1,
    cacheVersion: 1,
    families: [
      {
        id: "fixture",
        name: "Fixture",
        variantCount: 1,
        sourceIds: ["fixture"],
      },
    ],
    sources: [
      {
        id: "fixture",
        type: "gnome-look",
        directory: "fixture",
        productId: 1,
        metadataUrl: "https://example.test/metadata.json",
        archives: [
          {
            name: "Theme.zip",
            upstreamMd5: crypto
              .createHash("md5")
              .update(zipBytes)
              .digest("hex"),
            sha256: crypto.createHash("sha256").update(zipBytes).digest("hex"),
            treeSha256: tree.sha256,
            treeEntries: tree.entries,
          },
        ],
      },
    ],
  };
  return { root, local, zipBytes, catalog };
}

describe("curated source catalog", () => {
  it("pins every canonical family and the existing provenance locks", async () => {
    expect(CURATED_SOURCE_CATALOG.families.map((row) => row.id)).toEqual(
      CURATED_FAMILY_IDS,
    );
    expect(CURATED_SOURCE_CATALOG.sources).toHaveLength(19);
    expect(
      Object.fromEntries(
        CURATED_SOURCE_CATALOG.families.map((family) => [
          family.id,
          [family.name, family.variantCount],
        ]),
      ),
    ).toEqual({
      oreo: ["Oreo", 19],
      remus: ["Remus", 3],
      drop: ["Drop", 4],
      moga: ["Moga", 16],
      volantes: ["Volantes", 2],
      vimix: ["Vimix", 2],
      qogir: ["Qogir", 6],
      "bibata-extra": ["Bibata Extra", 8],
      google: ["Google", 4],
      simp1e: ["Simp1e", 25],
      capitaine: ["Capitaine", 2],
      future: ["Future", 2],
      nordzy: ["Nordzy", 133],
      colloid: ["Colloid", 2],
      bibata: ["Bibata", 12],
    });
    expect(
      CURATED_SOURCE_CATALOG.families.reduce(
        (total, family) => total + family.variantCount,
        0,
      ),
    ).toBe(240);
    expect(
      CURATED_SOURCE_CATALOG.sources.find((source) => source.id === "simp1e")
        .archiveUrl,
    ).toBe(
      "https://gitlab.com/api/v4/projects/cursors%2Fsimp1e/repository/archive.tar.gz?sha=f8f8f3c09dd0aa31cc9bc5499c683aad025984be",
    );
    expect(
      CURATED_SOURCE_CATALOG.sources.every((source) =>
        source.type === "repository"
          ? source.treeEntries > 0 && !/^0+$/.test(source.treeSha256)
          : source.archives.every(
              (archive) =>
                archive.treeEntries > 0 && !/^0+$/.test(archive.treeSha256),
            ),
      ),
    ).toBe(true);

    const locks = JSON.parse(
      await fs.promises.readFile(
        path.resolve("native/cursor-packs/sources/pinned-sources.json"),
        "utf8",
      ),
    );
    const provenance = JSON.parse(
      await fs.promises.readFile(
        path.resolve("native/cursor-packs/sources/github-pack-provenance.json"),
        "utf8",
      ),
    );
    const expectedRevisions = new Set(
      [...locks.sources, ...provenance.entries].map((row) => row.revision),
    );
    const actualRevisions = new Set(
      CURATED_SOURCE_CATALOG.sources
        .filter(
          (source) => source.type === "repository" && source.id !== "oreo",
        )
        .map((source) => source.revision),
    );
    expect(actualRevisions).toEqual(expectedRevisions);

    const gnomeLocks = JSON.parse(
      await fs.promises.readFile(
        path.resolve("native/cursor-packs/sources/gnome-look-sources.json"),
        "utf8",
      ),
    );
    const expectedArchives = Object.fromEntries(
      gnomeLocks.products.flatMap((product) =>
        Object.entries(product.archives),
      ),
    );
    const actualArchives = Object.fromEntries(
      CURATED_SOURCE_CATALOG.sources
        .filter((source) => source.type === "gnome-look")
        .flatMap((source) =>
          source.archives.map((archive) => [archive.name, archive.sha256]),
        ),
    );
    expect(actualArchives).toEqual(expectedArchives);
  });

  it("rejects placeholder locks", () => {
    const document = structuredClone(CURATED_SOURCE_CATALOG);
    document.sources[0].treeSha256 = "0".repeat(64);
    expect(() => validateCuratedSourceCatalog(document)).toThrowError(
      expect.objectContaining({ code: "INVALID_CATALOG" }),
    );
  });

  it.runIf(process.env.CURSOR_ATELIER_TEST_CURATED_CHECKOUT_ROOT)(
    "matches every pinned repository input checkout",
    async () => {
      const sourceRoot = process.env.CURSOR_ATELIER_TEST_CURATED_CHECKOUT_ROOT;
      for (const source of CURATED_SOURCE_CATALOG.sources) {
        if (source.type !== "repository" || source.id === "oreo") {
          continue;
        }
        const digest = await computeCuratedTreeDigest(
          path.join(sourceRoot, source.directory),
          source.inputRoots,
        );
        expect(digest, source.id).toEqual({
          sha256: source.treeSha256,
          entries: source.treeEntries,
        });
      }
    },
  );
});

describe("curated source acquisition", () => {
  it.runIf(process.env.CURSOR_ATELIER_TEST_CURATED_SOURCE_ROOT)(
    "accepts an injected pinned production upstream archive",
    async () => {
      const root = await temporaryRoot();
      const familyId = process.env.CURSOR_ATELIER_TEST_CURATED_FAMILY ?? "oreo";
      const family = CURATED_SOURCE_CATALOG.families.find(
        (candidate) => candidate.id === familyId,
      );
      const result = await acquireCuratedFamilySources({
        familyIds: [familyId],
        cacheRoot: path.join(root, "cache"),
        localArchiveRoot: process.env.CURSOR_ATELIER_TEST_CURATED_SOURCE_ROOT,
      });
      expect(result.sources.map((source) => source.sourceId)).toEqual(
        family.sourceIds,
      );
      for (const source of result.sources) {
        await expect(fs.promises.access(source.root)).resolves.toBeUndefined();
      }
    },
  );

  it("selectively acquires, verifies, reuses, repairs, and removes a repository source", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source", "fixture-wrapper");
    await fs.promises.mkdir(path.join(source, "assets"), { recursive: true });
    await fs.promises.writeFile(
      path.join(source, "assets", "cursor.svg"),
      "pinned",
    );
    await fs.promises.writeFile(
      path.join(source, "ignored.txt"),
      "not materialized",
    );
    await fs.promises.writeFile(path.join(source, "LICENSE"), "license");
    const digest = await computeCuratedTreeDigest(source, [
      "assets",
      "LICENSE",
    ]);
    const local = path.join(root, "local");
    await fs.promises.mkdir(local);
    await tar.create(
      {
        cwd: path.dirname(source),
        gzip: true,
        file: path.join(local, "fixture.tar.gz"),
      },
      [path.basename(source)],
    );
    const cache = path.join(root, "cache");
    const catalog = repositoryCatalog({ digest });
    const phases = [];
    const first = await acquireCuratedFamilySources({
      familyIds: ["fixture"],
      cacheRoot: cache,
      catalog,
      localArchiveRoot: local,
      onProgress: (event) => phases.push(event.phase),
    });
    expect(first.sourceRoot).toBe(await fs.promises.realpath(cache));
    expect(
      await fs.promises.readFile(
        path.join(cache, "fixture-source/assets/cursor.svg"),
        "utf8",
      ),
    ).toBe("pinned");
    await expect(
      fs.promises.access(path.join(cache, "fixture-source/ignored.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(phases).toContain("complete");

    phases.length = 0;
    await acquireCuratedFamilySources({
      familyIds: ["fixture"],
      cacheRoot: cache,
      catalog,
      localArchiveRoot: local,
      onProgress: (event) => phases.push(event.phase),
    });
    expect(phases).toEqual(["cached"]);

    await fs.promises.writeFile(
      path.join(cache, "fixture-source/assets/cursor.svg"),
      "tampered",
    );
    await acquireCuratedFamilySources({
      familyIds: ["fixture"],
      cacheRoot: cache,
      catalog,
      localArchiveRoot: local,
    });
    expect(
      await fs.promises.readFile(
        path.join(cache, "fixture-source/assets/cursor.svg"),
        "utf8",
      ),
    ).toBe("pinned");

    expect(
      await removeCuratedFamilySources({
        familyIds: ["fixture"],
        cacheRoot: cache,
        catalog,
      }),
    ).toEqual(["fixture"]);
    await expect(
      fs.promises.access(path.join(cache, "fixture-source")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("streams a repository archive when Content-Length is absent", async () => {
    const root = await temporaryRoot();
    const seed = path.join(root, "seed");
    await fs.promises.mkdir(path.join(seed, "assets"), { recursive: true });
    await fs.promises.writeFile(path.join(seed, "assets/cursor.svg"), "pinned");
    await fs.promises.writeFile(path.join(seed, "LICENSE"), "license");
    const digest = await computeCuratedTreeDigest(seed, ["assets", "LICENSE"]);
    const archive = rawTar([
      { name: "wrapper/", type: "5" },
      { name: "wrapper/assets/", type: "5" },
      { name: "wrapper/assets/cursor.svg", data: "pinned" },
      { name: "wrapper/LICENSE", data: "license" },
    ]);

    const result = await acquireCuratedFamilySources({
      familyIds: ["fixture"],
      cacheRoot: path.join(root, "cache"),
      catalog: repositoryCatalog({ digest }),
      fetchImpl: async () =>
        new Response(archive, {
          status: 200,
          headers: { "content-type": "application/gzip" },
        }),
    });

    await expect(
      fs.promises.readFile(
        path.join(result.sources[0].root, "assets/cursor.svg"),
        "utf8",
      ),
    ).resolves.toBe("pinned");
  });

  it("streams repository archives through the dedicated request transport", async () => {
    const root = await temporaryRoot();
    const seed = path.join(root, "seed");
    await fs.promises.mkdir(path.join(seed, "assets"), { recursive: true });
    await fs.promises.writeFile(path.join(seed, "assets/cursor.svg"), "pinned");
    await fs.promises.writeFile(path.join(seed, "LICENSE"), "license");
    const digest = await computeCuratedTreeDigest(seed, ["assets", "LICENSE"]);
    const archive = rawTar([
      { name: "wrapper/assets/", type: "5" },
      { name: "wrapper/assets/cursor.svg", data: "pinned" },
      { name: "wrapper/LICENSE", data: "license" },
    ]);

    const result = await acquireCuratedFamilySources({
      familyIds: ["fixture"],
      cacheRoot: path.join(root, "cache"),
      catalog: repositoryCatalog({ digest }),
      fetchImpl: async () => {
        throw new Error("metadata fetch should not be used");
      },
      archiveRequestImpl: async (url, options) => {
        expect(url).toBe("https://example.test/source.tar.gz");
        expect(options).toMatchObject({
          method: "GET",
          headers: { Accept: "application/octet-stream" },
        });
        return {
          statusCode: 200,
          headers: { "content-length": String(archive.length) },
          body: Readable.from([archive]),
        };
      },
    });

    await expect(
      fs.promises.readFile(
        path.join(result.sources[0].root, "assets/cursor.svg"),
        "utf8",
      ),
    ).resolves.toBe("pinned");
  });

  it("discards redirect bodies through the request transport before following", async () => {
    const root = await temporaryRoot();
    const seed = path.join(root, "seed");
    await fs.promises.mkdir(path.join(seed, "assets"), { recursive: true });
    await fs.promises.writeFile(path.join(seed, "assets/cursor.svg"), "pinned");
    await fs.promises.writeFile(path.join(seed, "LICENSE"), "license");
    const digest = await computeCuratedTreeDigest(seed, ["assets", "LICENSE"]);
    const archive = rawTar([
      { name: "wrapper/assets/", type: "5" },
      { name: "wrapper/assets/cursor.svg", data: "pinned" },
      { name: "wrapper/LICENSE", data: "license" },
    ]);
    const redirectBody = {
      destroy: vi.fn(),
      dump: vi.fn(async () => null),
    };
    const requests = [];

    await acquireCuratedFamilySources({
      familyIds: ["fixture"],
      cacheRoot: path.join(root, "cache"),
      catalog: repositoryCatalog({ digest }),
      fetchImpl: async () => {
        throw new Error("metadata fetch should not be used");
      },
      archiveRequestImpl: async (url) => {
        requests.push(url);
        if (requests.length === 1) {
          return {
            statusCode: 302,
            headers: {
              location: "https://cdn.example.test/source.tar.gz",
            },
            body: redirectBody,
          };
        }
        return {
          statusCode: 200,
          headers: { "content-length": String(archive.length) },
          body: Readable.from([archive]),
        };
      },
    });

    expect(requests).toEqual([
      "https://example.test/source.tar.gz",
      "https://cdn.example.test/source.tar.gz",
    ]);
    expect(redirectBody.dump).toHaveBeenCalledOnce();
    expect(redirectBody.destroy).not.toHaveBeenCalled();
  });

  it("normalizes cancellation while discarding a redirect body", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const cancellation = new Error("test cancellation");
    const requests = [];

    await expect(
      acquireCuratedFamilySources({
        familyIds: ["fixture"],
        cacheRoot: path.join(root, "cache"),
        catalog: repositoryCatalog({
          digest: { sha256: "a".repeat(64), entries: 2 },
        }),
        fetchImpl: async () => {
          throw new Error("metadata fetch should not be used");
        },
        archiveRequestImpl: async (url) => {
          requests.push(url);
          return {
            statusCode: 302,
            headers: {
              location: "https://cdn.example.test/source.tar.gz",
            },
            body: {
              async dump({ signal }) {
                controller.abort(cancellation);
                throw signal.reason;
              },
            },
          };
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: "CuratedSourceError",
      code: "ABORTED",
      cause: cancellation,
    });

    expect(requests).toEqual(["https://example.test/source.tar.gz"]);
  });

  it("disposes a request body rejected by its declared archive size", async () => {
    const root = await temporaryRoot();
    const body = Readable.from([]);
    const destroy = vi.spyOn(body, "destroy");

    await expect(
      acquireCuratedFamilySources({
        familyIds: ["fixture"],
        cacheRoot: path.join(root, "cache"),
        catalog: repositoryCatalog({
          digest: { sha256: "a".repeat(64), entries: 2 },
        }),
        fetchImpl: async () => {
          throw new Error("metadata fetch should not be used");
        },
        archiveRequestImpl: async () => ({
          statusCode: 200,
          headers: { "content-length": String(513 * 1024 * 1024) },
          body,
        }),
      }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });

    expect(destroy).toHaveBeenCalledOnce();
  });

  it("ignores case-colliding repository paths outside the pinned inputs", async () => {
    const root = await temporaryRoot();
    const seed = path.join(root, "seed");
    await fs.promises.mkdir(path.join(seed, "assets"), { recursive: true });
    await fs.promises.writeFile(path.join(seed, "assets/cursor.svg"), "pinned");
    await fs.promises.writeFile(path.join(seed, "LICENSE"), "license");
    const digest = await computeCuratedTreeDigest(seed, ["assets", "LICENSE"]);
    const archive = rawTar([
      { name: "wrapper/assets/", type: "5" },
      { name: "wrapper/assets/cursor.svg", data: "pinned" },
      { name: "wrapper/LICENSE", data: "license" },
      { name: "wrapper/ignored/Example.svg", data: "first" },
      { name: "wrapper/ignored/example.svg", data: "second" },
    ]);

    const result = await acquireCuratedFamilySources({
      familyIds: ["fixture"],
      cacheRoot: path.join(root, "cache"),
      catalog: repositoryCatalog({ digest }),
      fetchImpl: async () => new Response(archive, { status: 200 }),
    });

    await expect(
      fs.promises.readFile(
        path.join(result.sources[0].root, "assets/cursor.svg"),
        "utf8",
      ),
    ).resolves.toBe("pinned");
    await expect(
      fs.promises.access(path.join(result.sources[0].root, "ignored")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to replace or remove an unowned cache directory", async () => {
    const root = await temporaryRoot();
    const cache = path.join(root, "cache");
    const destination = path.join(cache, "fixture-source");
    await fs.promises.mkdir(destination, { recursive: true });
    await fs.promises.writeFile(
      path.join(destination, "unrelated.txt"),
      "user-owned",
    );
    const catalog = repositoryCatalog({
      digest: { sha256: "a".repeat(64), entries: 1 },
    });
    let fetchCalls = 0;

    await expect(
      acquireCuratedFamilySources({
        familyIds: ["fixture"],
        cacheRoot: cache,
        catalog,
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("should not download");
        },
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_CACHE" });
    await expect(
      removeCuratedFamilySources({
        familyIds: ["fixture"],
        cacheRoot: cache,
        catalog,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_CACHE" });

    expect(fetchCalls).toBe(0);
    await expect(
      fs.promises.readFile(path.join(destination, "unrelated.txt"), "utf8"),
    ).resolves.toBe("user-owned");
  });

  it("cancels before extraction and removes partial staging", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source", "fixture-wrapper");
    await fs.promises.mkdir(path.join(source, "assets"), { recursive: true });
    await fs.promises.writeFile(
      path.join(source, "assets/cursor.svg"),
      "pinned",
    );
    await fs.promises.writeFile(path.join(source, "LICENSE"), "license");
    const digest = await computeCuratedTreeDigest(source, [
      "assets",
      "LICENSE",
    ]);
    const local = path.join(root, "local");
    await fs.promises.mkdir(local);
    await tar.create(
      {
        cwd: path.dirname(source),
        gzip: true,
        file: path.join(local, "fixture.tar.gz"),
      },
      [path.basename(source)],
    );
    const cache = path.join(root, "cache");
    const controller = new AbortController();
    await expect(
      acquireCuratedFamilySources({
        familyIds: ["fixture"],
        cacheRoot: cache,
        catalog: repositoryCatalog({ digest }),
        localArchiveRoot: local,
        signal: controller.signal,
        onProgress(event) {
          if (event.phase === "extracting") {
            controller.abort(new Error("test cancellation"));
          }
        },
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(await fs.promises.readdir(cache)).toEqual([]);
  });

  it("acquires a pinned GNOME-Look ZIP from an injected archive root", async () => {
    const { root, local, catalog } = await gnomeFixture();
    await acquireCuratedFamilySources({
      familyIds: ["fixture"],
      cacheRoot: path.join(root, "cache"),
      catalog,
      localArchiveRoot: path.dirname(local),
    });
    await expect(
      fs.promises.readFile(
        path.join(root, "cache/fixture/expanded/Theme/Theme/cursors/default"),
        "utf8",
      ),
    ).resolves.toBe("cursor");
    await expect(
      fs.promises.access(
        path.join(
          root,
          "cache/fixture/expanded/Theme/Theme/windows/default.cur",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("selects the pinned GNOME-Look revision when current and archived names collide", async () => {
    const { root, catalog, zipBytes } = await gnomeFixture();
    const pinned = catalog.sources[0].archives[0];
    const fetchImpl = vi.fn(async (url) => {
      if (url === catalog.sources[0].metadataUrl) {
        return Response.json({
          data: [
            {
              id: 1,
              downloadname101: pinned.name,
              downloadmd5sum101: pinned.upstreamMd5,
              downloadlink101: "https://example.test/pinned.zip",
              downloadname102: pinned.name,
              downloadmd5sum102: "f".repeat(32),
              downloadlink102: "https://example.test/replacement.zip",
            },
          ],
        });
      }
      expect(url).toBe("https://example.test/pinned.zip");
      return new Response(zipBytes);
    });
    await acquireCuratedFamilySources({
      familyIds: ["fixture"],
      cacheRoot: path.join(root, "cache"),
      catalog,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(
      fs.promises.readFile(
        path.join(root, "cache/fixture/expanded/Theme/Theme/cursors/default"),
        "utf8",
      ),
    ).resolves.toBe("cursor");
  });

  it.each([
    ["SOURCE_CHANGED", "Theme.zip"],
    ["SOURCE_UNAVAILABLE", "Another.zip"],
  ])(
    "reports %s before downloading an unavailable pinned revision",
    async (code, name) => {
      const { root, catalog } = await gnomeFixture();
      const fetchImpl = vi.fn(async () =>
        Response.json({
          data: [
            {
              id: 1,
              downloadname1: name,
              downloadmd5sum1: "f".repeat(32),
              downloadlink1: "https://example.test/replacement.zip",
            },
          ],
        }),
      );
      await expect(
        acquireCuratedFamilySources({
          familyIds: ["fixture"],
          cacheRoot: path.join(root, "cache"),
          catalog,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await fs.promises.readdir(path.join(root, "cache"))).toEqual([]);
    },
  );

  it("still rejects changed archive bytes when GNOME-Look reports the pinned MD5", async () => {
    const { root, catalog } = await gnomeFixture();
    const pinned = catalog.sources[0].archives[0];
    const fetchImpl = vi.fn(async (url) => {
      if (url === catalog.sources[0].metadataUrl) {
        return Response.json({
          data: [
            {
              id: 1,
              downloadname1: pinned.name,
              downloadmd5sum1: pinned.upstreamMd5,
              downloadlink1: "https://example.test/tampered.zip",
            },
          ],
        });
      }
      return new Response(
        zipArchive([
          { name: "Theme/" },
          { name: "Theme/cursors/" },
          { name: "Theme/cursors/default", data: "changed cursor" },
        ]),
      );
    });
    await expect(
      acquireCuratedFamilySources({
        familyIds: ["fixture"],
        cacheRoot: path.join(root, "cache"),
        catalog,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    expect(await fs.promises.readdir(path.join(root, "cache"))).toEqual([]);
  });

  it.each([
    ["traversal", [{ name: "wrapper/../escape", data: "bad" }]],
    [
      "escaping symlink",
      [
        { name: "wrapper/assets/", type: "5" },
        { name: "wrapper/assets/cursor.svg", data: "ok" },
        {
          name: "wrapper/assets/escape",
          type: "2",
          linkName: "../../../outside",
        },
        { name: "wrapper/LICENSE", data: "license" },
      ],
    ],
    [
      "device entry",
      [
        { name: "wrapper/assets/", type: "5" },
        { name: "wrapper/assets/device", type: "3" },
        { name: "wrapper/LICENSE", data: "license" },
      ],
    ],
    [
      "case-colliding selected path",
      [
        { name: "wrapper/assets/cursor.svg", data: "first" },
        { name: "wrapper/assets/Cursor.svg", data: "second" },
        { name: "wrapper/LICENSE", data: "license" },
      ],
    ],
  ])(
    "rejects a %s without leaving a cache payload",
    async (_label, entries) => {
      const root = await temporaryRoot();
      const local = path.join(root, "local");
      const cache = path.join(root, "cache");
      await fs.promises.mkdir(local);
      await fs.promises.writeFile(
        path.join(local, "fixture.tar.gz"),
        rawTar(entries),
      );
      const catalog = repositoryCatalog({
        digest: { sha256: "a".repeat(64), entries: 2 },
      });
      await expect(
        acquireCuratedFamilySources({
          familyIds: ["fixture"],
          cacheRoot: cache,
          catalog,
          localArchiveRoot: local,
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^(UNSAFE_ARCHIVE|INVALID_ARCHIVE)$/),
      });
      await expect(
        fs.promises.access(path.join(cache, "fixture-source")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

describe("curated source transaction reconciliation", () => {
  it("restores one valid interrupted replacement and removes stale acquisition data", async () => {
    const root = await temporaryRoot();
    const { cache, catalog, destination } = await reconciliationFixture(root);
    const replacement =
      ".fixture-source-replaced-123e4567-e89b-42d3-a456-426614174000";
    const acquiring = ".fixture-source-acquiring-Ab12Cd";
    await fs.promises.rename(destination, path.join(cache, replacement));
    await fs.promises.mkdir(path.join(cache, acquiring), { mode: 0o700 });
    await fs.promises.writeFile(
      path.join(cache, acquiring, ".partial"),
      "partial",
    );

    await expect(
      reconcileCuratedSourceTransactions({ cacheRoot: cache, catalog }),
    ).resolves.toEqual({
      restored: ["fixture"],
      removed: [acquiring],
      pending: [],
      cleanupPending: false,
    });
    await expect(
      fs.promises.readFile(path.join(destination, "assets/cursor.svg"), "utf8"),
    ).resolves.toBe("pinned");
    await expect(
      fs.promises.access(path.join(cache, replacement)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a valid cache while removing only validated stale transactions", async () => {
    const root = await temporaryRoot();
    const { cache, catalog, destination } = await reconciliationFixture(root);
    const replacement =
      ".fixture-source-replaced-123e4567-e89b-42d3-a456-426614174000";
    const acquiring = ".fixture-source-acquiring-Ab12Cd";
    const unsafe = ".fixture-source-acquiring-Zy98Xw";
    const malformed = ".fixture-source-replaced-not-a-uuid";
    const outside = path.join(root, "outside");
    await fs.promises.cp(destination, path.join(cache, replacement), {
      recursive: true,
    });
    await fs.promises.chmod(path.join(cache, replacement), 0o700);
    await fs.promises.mkdir(path.join(cache, acquiring), { mode: 0o700 });
    await fs.promises.writeFile(path.join(cache, acquiring, "partial"), "data");
    await fs.promises.mkdir(outside);
    await fs.promises.writeFile(path.join(outside, "preserved"), "yes");
    await fs.promises.symlink(outside, path.join(cache, unsafe));
    await fs.promises.mkdir(path.join(cache, malformed), { mode: 0o700 });

    const result = await reconcileCuratedSourceTransactions({
      cacheRoot: cache,
      catalog,
    });
    expect(result.restored).toEqual([]);
    expect(result.removed).toEqual([replacement, acquiring]);
    expect(result.pending).toEqual([unsafe, malformed].sort());
    expect(result.cleanupPending).toBe(true);
    await expect(
      fs.promises.readFile(path.join(destination, "assets/cursor.svg"), "utf8"),
    ).resolves.toBe("pinned");
    await expect(
      fs.promises.readFile(path.join(outside, "preserved"), "utf8"),
    ).resolves.toBe("yes");
    await expect(
      fs.promises.lstat(path.join(cache, unsafe)),
    ).resolves.toSatisfy((stat) => stat.isSymbolicLink());
    await expect(
      fs.promises.access(path.join(cache, malformed)),
    ).resolves.toBeUndefined();
  });

  it("preserves ambiguous replacement backups when no destination exists", async () => {
    const root = await temporaryRoot();
    const { cache, catalog, destination } = await reconciliationFixture(root);
    const replacements = [
      ".fixture-source-replaced-123e4567-e89b-42d3-a456-426614174000",
      ".fixture-source-replaced-223e4567-e89b-42d3-a456-426614174000",
    ];
    for (const replacement of replacements) {
      await fs.promises.cp(destination, path.join(cache, replacement), {
        recursive: true,
      });
      await fs.promises.chmod(path.join(cache, replacement), 0o700);
    }
    await fs.promises.rm(destination, { recursive: true });

    await expect(
      reconcileCuratedSourceTransactions({ cacheRoot: cache, catalog }),
    ).resolves.toEqual({
      restored: [],
      removed: [],
      pending: replacements,
      cleanupPending: true,
    });
    for (const replacement of replacements) {
      await expect(
        fs.promises.access(path.join(cache, replacement)),
      ).resolves.toBeUndefined();
    }
    await expect(fs.promises.access(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
