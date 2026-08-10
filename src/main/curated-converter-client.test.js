import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { convertCuratedFamily } from "./curated-converter-client.js";

const temporaryRoots = [];

async function fixture() {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "curated-client-"),
  );
  temporaryRoots.push(root);
  const sources = path.join(root, "sources");
  const output = path.join(root, "output");
  await fs.promises.mkdir(sources);
  await fs.promises.mkdir(output);
  await fs.promises.writeFile(
    path.join(sources, "cursor.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="12" fill="red"/></svg>',
  );
  return { sources, output };
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

const SUCCESS_CHILD = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(1);
const value = (name) => args[args.indexOf(name) + 1];
const sources = value("--source-root");
const output = value("--output-root");
const artifact = path.join(output, "Future");
console.log(JSON.stringify({type:"catalog",families:["future"]}));
console.log(JSON.stringify({type:"render-svg",requestId:"one",sourcePath:path.join(sources,"cursor.svg"),size:96,width:96,height:96,outputPath:path.join(output,"render.png")}));
readline.createInterface({input:process.stdin}).once("line", (line) => {
  const response = JSON.parse(line);
  if (!response.ok) process.exit(2);
  fs.mkdirSync(artifact);
  console.log(JSON.stringify({type:"variant-started",familyId:"future",identifier:"Future",displayName:"Future",progress:0}));
  console.log(JSON.stringify({type:"variant-complete",familyId:"future",identifier:"Future",displayName:"Future",artifactDirectory:artifact,progress:1}));
  console.log(JSON.stringify({type:"done"}));
  process.exit(0);
});
`;

describe("curated converter client", () => {
  it("serves SVG renders and validates completed artifact events", async () => {
    const { sources, output } = await fixture();
    const events = [];

    await convertCuratedFamily({
      command: process.execPath,
      commandArguments: ["-e", SUCCESS_CHILD],
      familyId: "future",
      sourceRoot: sources,
      outputRoot: output,
      onEvent: async (event) => events.push(event),
    });

    expect(events.some((event) => event.type === "variant-start")).toBe(true);
    expect(
      events.find((event) => event.type === "variant-complete"),
    ).toMatchObject({
      identifier: "Future",
      artifactDirectory: await fs.promises.realpath(
        path.join(output, "Future"),
      ),
    });
    const rendered = await import("sharp").then(({ default: sharp }) =>
      sharp(path.join(output, "render.png")).metadata(),
    );
    expect([rendered.width, rendered.height]).toEqual([96, 96]);
  });

  it("rejects a completed artifact outside the output root", async () => {
    const { sources, output } = await fixture();
    const outside = path.join(path.dirname(output), "Outside");
    await fs.promises.mkdir(outside);
    const child = `console.log(JSON.stringify({type:"variant-complete",identifier:"Future",artifactDirectory:${JSON.stringify(outside)},progress:1})); setTimeout(()=>{},10000);`;

    await expect(
      convertCuratedFamily({
        command: process.execPath,
        commandArguments: ["-e", child],
        familyId: "future",
        sourceRoot: sources,
        outputRoot: output,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONVERTER_EVENT" });
  });
});
