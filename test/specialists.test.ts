import { describe, expect, it } from "vitest";
import { GENERAL_DOMAIN, MAX_DOMAIN_LENGTH } from "../src/contracts/orchestration.js";
import { SPECIALIST_PROFILES, resolveSpecialist, domainInstructionsFor, listSpecialists, getSpecialist } from "../src/storage/specialists.js";

describe("specialist registry", () => {
  it("has a general fallback and every profile is fully populated", () => {
    const profiles = listSpecialists();
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

  it("resolves exact domain match", () => {
    const { profile, match } = resolveSpecialist("frontend");
    expect(profile.domain).toBe("frontend");
    expect(match).toBe("exact");
  });

  it("resolves prefix match for sub-domains", () => {
    const { profile, match } = resolveSpecialist("frontend/forms");
    expect(profile.domain).toBe("frontend");
    expect(match).toBe("prefix");
  });

  it("falls back to general for unknown domains (never blocks)", () => {
    const { profile, match } = resolveSpecialist("quantum-physics");
    expect(profile.domain).toBe(GENERAL_DOMAIN);
    expect(match).toBe("general");
  });

  it("injects domain instructions: specialist header, instructions, checklist, negative rules", () => {
    const instructions = domainInstructionsFor("compliance");
    expect(instructions[0]).toContain("合规");
    expect(instructions.some((i) => i.startsWith("验收："))).toBe(true);
    expect(instructions.some((i) => i.startsWith("禁止："))).toBe(true);
    expect(instructions.length).toBeLessThanOrEqual(30);
  });

  it("shows the resolved specialist with match kind", () => {
    expect(getSpecialist("data").match).toBe("exact");
    expect(getSpecialist("data/etl").match).toBe("prefix");
    expect(getSpecialist("unknown-xyz").match).toBe("general");
  });

  it("every profile domain is unique", () => {
    const domains = SPECIALIST_PROFILES.map((p) => p.domain);
    expect(new Set(domains).size).toBe(domains.length);
  });
});
