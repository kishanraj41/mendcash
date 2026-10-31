import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDemoReference } from "./demo-ref";

describe("demo reference", () => {
  it("accepts ids this demo creates and rejects loose prefixes", () => {
    assert.equal(isDemoReference("mendcash-seed-k3jd-01"), true);
    assert.equal(isDemoReference("mendcash-seed-01"), true);
    assert.equal(isDemoReference("mendcash-1730412345678"), true);
    assert.equal(isDemoReference("sim-0001"), true);
    assert.equal(isDemoReference("mc-12"), true);
    assert.equal(isDemoReference("mc-test-1"), false);
    assert.equal(isDemoReference("foreign-shop-1"), false);
    assert.equal(isDemoReference("mendcash"), false);
  });
});
