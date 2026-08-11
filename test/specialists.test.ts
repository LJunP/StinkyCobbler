import { describe, expect, it } from "vitest";
import { GENERAL_DOMAIN, MAX_DOMAIN_LENGTH } from "../src/contracts/orchestration.js";
import { listSpecialists, resolveSpecialist, domainInstructionsFor, getSpecialist } from "../src/storage/specialists.js";

describe("specialist registry", () => {
  it("has a general fallback and every profile is fully populated", async () => {
    const profiles = await listSpecialists(null);
    const general = profiles.find((p) => p.domain === GENERAL_DOMAIN);
    expect(general).toBeDefined();
    for (const p of profiles) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.instructions.length).toBeGreaterThan(0);
      expect(p.acceptanceChecklist.length).toBeGreaterThan(0);
      expect(p.negativeRules.length).toBeGreaterThan(0);
      expect(p.suggestedCapabilities.length).toBeGreaterThan(0);
      expect(p.domain.length).toBeLessThanOrEqual(MAX_DOMAIN_LENGTH);
    }
  });

  it("resolves exact domain match", async () => {
    const { profile, match } = await resolveSpecialist(null, "frontend");
    expect(profile.domain).toBe("frontend");
    expect(match).toBe("exact");
  });

  it("resolves prefix match for sub-domains", async () => {
    const { profile, match } = await resolveSpecialist(null, "frontend/forms");
    expect(profile.domain).toBe("frontend");
    expect(match).toBe("prefix");
  });

  it("falls back to general for unknown domains (never blocks)", async () => {
    const { profile, match } = await resolveSpecialist(null, "quantum-physics");
    expect(profile.domain).toBe(GENERAL_DOMAIN);
    expect(match).toBe("general");
  });

  it("injects domain instructions: specialist header, instructions, checklist, negative rules", async () => {
    const instructions = await domainInstructionsFor(null, "compliance");
    expect(instructions[0]).toContain("合规");
    expect(instructions.some((i) => i.startsWith("验收："))).toBe(true);
    expect(instructions.some((i) => i.startsWith("禁止："))).toBe(true);
    expect(instructions.length).toBeLessThanOrEqual(30);
  });

  it("shows the resolved specialist with match kind", async () => {
    expect((await getSpecialist(null, "data")).match).toBe("exact");
    expect((await getSpecialist(null, "data/etl")).match).toBe("prefix");
    expect((await getSpecialist(null, "unknown-xyz")).match).toBe("general");
  });

  it("every profile domain is unique", async () => {
    const domains = (await listSpecialists(null)).map((p) => p.domain);
    expect(new Set(domains).size).toBe(domains.length);
  });
});
