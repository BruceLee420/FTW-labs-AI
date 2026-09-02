/**
 * Deterministic résumé profiling on the two synthetic fixtures. Each fixture
 * is run through the same extraction step the indexer uses (Markdown stripped
 * for .md, BOM/line endings normalised for .txt) before profiling, so the
 * assertions describe what the app actually stores for these files.
 *
 * Why: drafts may only cite "verified facts" from here, so the profile must
 * be stable across runs, grounded in the document, and must never carry
 * contact values (e-mail, phone, profile URL) — only their presence.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildResumeProfile, labelFromFilename, type ExtractedProfile } from "../src/services/resumes/profile.ts";
import { findSkills } from "../src/services/resumes/skillsDictionary.ts";
import { extractPlainText } from "../src/parsers/text.ts";

const FIXTURES = new URL("./fixtures/resumes/", import.meta.url);
const SE_FILE = "jordan-example-software-engineer.md";
const PM_FILE = "jordan-example-product-manager.txt";

function profileFixture(name: string, format: "md" | "txt"): ExtractedProfile {
  const raw = new Uint8Array(readFileSync(new URL(name, FIXTURES)));
  return buildResumeProfile(extractPlainText(raw, format), name);
}

const se = profileFixture(SE_FILE, "md");
const pm = profileFixture(PM_FILE, "txt");

const factTexts = (p: ExtractedProfile, kind: string): string[] => p.verifiedFacts.filter((f) => f.kind === kind).map((f) => f.text);
const factKinds = (p: ExtractedProfile): Set<string> => new Set(p.verifiedFacts.map((f) => f.kind));

describe("label", () => {
  test("is derived from the file name", () => {
    assert.equal(se.label, "Jordan Example Software Engineer");
    assert.equal(pm.label, "Jordan Example Product Manager");
  });

  test("labelFromFilename drops directories and extension, and upper-cases known acronyms", () => {
    assert.equal(labelFromFilename("resumes/2026/jordan_example.cv.pdf"), "Jordan Example CV");
    assert.equal(labelFromFilename("jordan-example-ux-designer.docx"), "Jordan Example UX Designer");
    assert.equal(labelFromFilename(".pdf"), "Résumé");
  });
});

describe("target roles, skills and industries", () => {
  test("target roles come from the headline and the file name", () => {
    assert.ok(se.targetRoles.includes("Software Engineer"), se.targetRoles.join(", "));
    assert.ok(se.targetRoles.includes("Senior Software Engineer"), se.targetRoles.join(", "));
    assert.equal(pm.targetRoles[0], "Product Manager");
    assert.ok(!se.targetRoles.includes("Product Manager"));
    assert.ok(!pm.targetRoles.includes("Software Engineer"));
  });

  test("skills are dictionary hits from the whole document", () => {
    for (const s of ["TypeScript", "Node.js", "PostgreSQL", "Kubernetes", "AWS"]) assert.ok(se.skills.includes(s), `software engineer lacks ${s}`);
    for (const s of ["Product Management", "Jira", "Amplitude", "SQL"]) assert.ok(pm.skills.includes(s), `product manager lacks ${s}`);
    assert.ok(!se.skills.includes("Jira"));
    assert.ok(!pm.skills.includes("TypeScript"));
    assert.equal(new Set(se.skills.map((s) => s.toLowerCase())).size, se.skills.length, "skills are unique");
  });

  test("industries are recognised from the body text", () => {
    for (const i of ["Logistics", "Fintech", "SaaS"]) assert.ok(pm.industries.includes(i), `product manager lacks ${i}`);
  });
});

describe("summaries", () => {
  test("experience summary is bounded and names the employers", () => {
    for (const p of [se, pm]) {
      assert.ok(p.experienceSummary.length > 0);
      assert.ok(p.experienceSummary.length <= 1200);
    }
    assert.ok(se.experienceSummary.includes("Northwind Analytics"));
    assert.ok(se.experienceSummary.includes("Contoso Freight"));
    assert.ok(pm.experienceSummary.includes("Contoso Freight"));
    assert.ok(pm.experienceSummary.includes("Fabrikam Payments"));
  });

  test("education summary names the degree", () => {
    assert.ok(se.educationSummary.includes("Computer Science"));
    assert.ok(pm.educationSummary.includes("MBA"));
    assert.ok(pm.educationSummary.length <= 600);
  });
});

describe("verified facts", () => {
  test("cover date ranges, degrees, certifications, employers, roles and skills", () => {
    for (const p of [se, pm]) {
      const kinds = factKinds(p);
      for (const k of ["date-range", "degree", "certification", "employer", "role", "skill", "contact"]) assert.ok(kinds.has(k), `${p.label} lacks ${k}`);
    }
    assert.ok(factTexts(se, "date-range").includes("2020 – Present"));
    assert.ok(factTexts(se, "date-range").includes("2017 – 2020"));
    assert.ok(factTexts(pm, "date-range").includes("Jan 2021 - Present"));
    assert.ok(factTexts(se, "degree").some((t) => t.includes("Computer Science")));
    assert.ok(factTexts(pm, "degree").some((t) => t.includes("MBA")));
    assert.ok(factTexts(se, "certification").some((t) => t.startsWith("AWS Certified")));
    assert.ok(factTexts(pm, "certification").includes("CSPO"));
    assert.ok(factTexts(se, "employer").includes("Northwind Analytics"));
    assert.ok(factTexts(se, "role").includes("Senior Software Engineer"));
    assert.ok(factTexts(pm, "employer").includes("Contoso Freight"));
    assert.ok(factTexts(pm, "role").includes("Senior Product Manager"));
    assert.ok(factTexts(se, "skill").includes("TypeScript"));
    assert.ok(factTexts(pm, "skill").includes("Jira"));
    assert.ok(se.verifiedFacts.length <= 80);
  });

  test("contact facts record presence only, never the value", () => {
    for (const p of [se, pm]) {
      assert.deepEqual(factTexts(p, "contact"), ["email present", "phone present", "profile link present"]);
      const blob = JSON.stringify(p);
      for (const secret of ["jordan@example.com", "555", "@example", "github.com/", "linkedin.com/"]) {
        assert.ok(!blob.includes(secret), `${p.label} profile leaks "${secret}"`);
      }
    }
  });

  test("every fact is short, trimmed and unique per kind", () => {
    for (const p of [se, pm]) {
      const keys = new Set<string>();
      for (const f of p.verifiedFacts) {
        assert.ok(f.text.length >= 2 && f.text.length <= 160, f.text);
        assert.equal(f.text, f.text.trim());
        const key = `${f.kind}:${f.text.toLowerCase()}`;
        assert.ok(!keys.has(key), `duplicate fact ${key}`);
        keys.add(key);
      }
    }
  });
});

describe("determinism", () => {
  test("profiling the same text twice yields deep-equal results", () => {
    assert.deepEqual(profileFixture(SE_FILE, "md"), se);
    assert.deepEqual(profileFixture(PM_FILE, "txt"), pm);
  });
});

describe("findSkills", () => {
  test("resolves aliases to canonical names", () => {
    const found = findSkills("built with nodejs and postgres and c++");
    for (const s of ["Node.js", "PostgreSQL", "C++"]) assert.ok(found.includes(s), found.join(", "));
    assert.ok(!found.includes("C"), "C must not be inferred from C++");
  });

  test("is word-boundary safe", () => {
    const js = findSkills("JavaScript only");
    assert.ok(js.includes("JavaScript"));
    assert.ok(!js.includes("Java"));
    const rg = findSkills("R and Go");
    assert.ok(rg.includes("R"));
    assert.ok(rg.includes("Go"));
    assert.ok(!findSkills("Rust").includes("R"));
    assert.ok(!findSkills("Wrote C# services").includes("C"));
    assert.ok(!findSkills("go-to-market plans").includes("Go"));
    assert.ok(findSkills("React-based UI").includes("React"));
  });

  test("returns nothing for empty input and orders hits by first occurrence", () => {
    assert.deepEqual(findSkills(""), []);
    assert.deepEqual(findSkills("PostgreSQL then TypeScript then Docker"), ["PostgreSQL", "TypeScript", "Docker"]);
    assert.deepEqual(findSkills("Docker Docker docker"), ["Docker"]);
  });
});
