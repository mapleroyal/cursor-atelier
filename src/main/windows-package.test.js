import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import windowsPackage from "../../scripts/windows-package.cjs";
const { verifyPe, packageInventory, runPowerShell } = windowsPackage;
const directories = [];
function temporary() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "cursor-package-test-"),
  );
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    {fs.rmSync(directory, { recursive: true, force: true });}
});
describe("Windows package verification", () => {
  it("rejects native executables for a different architecture or a truncated PE header", () => {
    const file = path.join(temporary(), "converter.exe"),
      bytes = Buffer.alloc(134);
    bytes.write("MZ");
    bytes.writeUInt32LE(128, 60);
    bytes.write("PE\0\0", 128);
    bytes.writeUInt16LE(0x8664, 132);
    fs.writeFileSync(file, bytes);
    expect(() => verifyPe(file, "x64")).not.toThrow();
    expect(() => verifyPe(file, "arm64")).toThrow(/arm64/);
    fs.writeFileSync(file, bytes.subarray(0, 133));
    expect(() => verifyPe(file, "x64")).toThrow();
  });
  it("uses portable manifest names and detects changed packaged bytes", () => {
    const directory = temporary();
    fs.mkdirSync(path.join(directory, "resources"));
    fs.writeFileSync(path.join(directory, "resources", "app.asar"), "before");
    fs.writeFileSync(
      path.join(directory, "resources", "install-manifest.json"),
      "excluded",
    );
    const before = packageInventory(directory);
    expect(Object.keys(before)).toEqual(["resources/app.asar"]);
    fs.writeFileSync(path.join(directory, "resources", "app.asar"), "after");
    expect(packageInventory(directory)).not.toEqual(before);
  });
  it.skipIf(process.platform !== "win32")(
    "runs a large script with Unicode paths and literal JSON payload without command-line expansion",
    () => {
      const data = {
        path: "C:\\A space\\O'Brien\\\u00e9.json",
        literal: "$env:USERPROFILE; 'quoted'",
        large: "x".repeat(20_000),
      };
      expect(
        runPowerShell(
          "#" + "padding".repeat(4000) + "\n$data | ConvertTo-Json -Compress",
          data,
        ),
      ).toEqual(data);
    },
  );
});
