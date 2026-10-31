import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it } from "node:test";
import { loadLocalEnv } from "./runtime";

describe("env file", () => {
  it("loads .env without overriding variables that are already set", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mendcash-env-"));
    const keep = "MENDCASH_TEST_KEEP";
    const fresh = "MENDCASH_TEST_NEW";
    const previousKeep = process.env[keep];
    const previousFresh = process.env[fresh];
    try {
      fs.writeFileSync(path.join(dir, ".env"), `${keep}=from-file\n${fresh}=from-file\n`);
      process.env[keep] = "already";
      delete process.env[fresh];
      loadLocalEnv(dir);
      assert.equal(process.env[keep], "already");
      assert.equal(process.env[fresh], "from-file");
      loadLocalEnv(path.join(dir, "missing"));
      assert.equal(process.env[keep], "already");
    } finally {
      if (previousKeep === undefined) delete process.env[keep];
      else process.env[keep] = previousKeep;
      if (previousFresh === undefined) delete process.env[fresh];
      else process.env[fresh] = previousFresh;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
