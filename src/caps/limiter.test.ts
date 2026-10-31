import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Limiter } from "../caps/limiter";
import { loadConfig } from "../config";

describe("caps", () => {
  it("stops analyses past the daily dollar cap and the per-IP limit", () => {
    const config = loadConfig({ MENDCASH_MODE: "replay", MAX_DAILY_USD: "0.01", MAX_ANALYSES_PER_IP: "2" });
    const limiter = new Limiter(config.caps, () => new Date("2026-10-31T18:00:00.000Z"));
    const first = limiter.reserveAnalysis("10.0.0.1", 6000);
    first.commit(6000);
    assert.throws(() => limiter.reserveAnalysis("10.0.0.2", 6000), /cap/i);
    const roomy = new Limiter(
      loadConfig({ MENDCASH_MODE: "replay", MAX_DAILY_USD: "2", MAX_ANALYSES_PER_IP: "1" }).caps,
      () => new Date("2026-10-31T18:00:00.000Z"),
    );
    roomy.reserveAnalysis("10.0.0.9", 1000).commit(1000);
    assert.throws(() => roomy.reserveAnalysis("10.0.0.9", 1000), /analyses/);
    roomy.reserveAnalysis("10.0.0.8", 1000).commit(100);
  });

  it("caps simulated chargebacks per address", () => {
    const limiter = new Limiter(
      loadConfig({ MENDCASH_MODE: "replay", MAX_SIMULATIONS_PER_IP: "1" }).caps,
      () => new Date("2026-10-31T18:00:00.000Z"),
    );
    limiter.takeSimulation("10.1.1.1");
    assert.throws(() => limiter.takeSimulation("10.1.1.1"), /simulated/);
  });

  it("queues work past the concurrency cap", async () => {
    const limiter = new Limiter(loadConfig({ MENDCASH_MODE: "replay", MAX_CONCURRENCY: "1" }).caps);
    let running = 0;
    let peak = 0;
    const task = () =>
      limiter.withSlot(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
      });
    await Promise.all([task(), task(), task()]);
    assert.equal(peak, 1);
  });
});
