/**
 * Table-driven tests for the deterministic rules layer (src/rules/*): every
 * scam and positive signal with triggering inputs and false-positive guards,
 * the geography / work-mode / employment-type / compensation parsers, and the
 * end-to-end evaluateRules scoring. Pure functions, synthetic text only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectPositiveSignals,
  detectScamSignals,
  evaluateRules,
  missingInformation,
  parseCompensation,
  parseEmploymentType,
  parseGeographicEligibility,
  parseTimezoneRequirement,
  parseWorkMode,
  POSITIVE_WEIGHTS,
  remoteEligibilityScore,
  SCAM_WEIGHTS,
} from "../src/rules/index.ts";
import type { RuleInput } from "../src/rules/types.ts";
import type { Compensation, EmploymentType, GeographicEligibility, WorkMode } from "../src/types/entities.ts";
import { SAMPLE_LISTING, SCAM_LISTING } from "./helpers/harness.ts";

type ScamCode = keyof typeof SCAM_WEIGHTS;
type PositiveCode = keyof typeof POSITIVE_WEIGHTS;

const NO_COMP: Compensation = { text: null, min: null, max: null, currency: null, period: "UNKNOWN" };

/** A RuleInput with neutral defaults; tests override only what they exercise. */
function ruleInput(overrides: Partial<RuleInput> = {}): RuleInput {
  return {
    title: "Software Engineer",
    companyName: "Example Corp",
    companyDomain: null,
    companyWebsite: null,
    officialCareerUrl: null,
    sourceUrl: null,
    applicationUrl: null,
    canonicalUrl: null,
    sourceType: "MANUAL_URL",
    sourceName: "manual",
    description: "",
    locationText: null,
    workMode: "UNKNOWN",
    geographicEligibility: "UNKNOWN",
    compensation: { ...NO_COMP },
    postedAt: null,
    ...overrides,
  };
}

const scamCodes = (o: Partial<RuleInput>) => detectScamSignals(ruleInput(o)).map((s) => s.code);
const positiveCodes = (o: Partial<RuleInput>) => detectPositiveSignals(ruleInput(o)).map((s) => s.code);
const comp = (o: Partial<Compensation>): Compensation => ({ ...NO_COMP, ...o });

/** A long, well-formed description that trips none of the scam detectors. */
const CLEAN_DESCRIPTION = [
  "About the role",
  "Example Corp builds scheduling software for regional clinics. You will join a small product engineering team.",
  "Responsibilities",
  "- Design and ship TypeScript services on Node.js with PostgreSQL",
  "- Review code and mentor engineers across the team",
  "- Improve observability and reliability of production systems",
  "- Partner with product to plan quarterly roadmaps and write design documents",
  "Requirements",
  "- 5+ years building production web services",
  "- Strong TypeScript and Node.js experience",
  "- Experience with PostgreSQL and SQL performance tuning",
  "- Experience with AWS and Docker",
  "Nice to have",
  "- Kubernetes experience",
  "- Familiarity with React and modern front-end tooling",
  "Benefits: health insurance, a learning stipend and 25 days of paid leave each year.",
  "Our interview process has three stages: a recruiter screen, a technical interview, and a team conversation.",
  "Example Corp is an equal opportunity employer.",
].join("\n");

describe("detectScamSignals", () => {
  interface ScamCase {
    code: ScamCode;
    triggers: { name: string; input: Partial<RuleInput> }[];
    guards: { name: string; input: Partial<RuleInput> }[];
  }

  const CASES: ScamCase[] = [
    {
      code: "REQUESTS_PAYMENT",
      triggers: [
        { name: "gift cards for a starter kit", input: { description: "To get started you must purchase a starter kit with gift cards and send the codes to HR." } },
        { name: "processing fee", input: { description: "Candidates pay a processing fee of $50 before onboarding begins." } },
        { name: "wire transfer for equipment", input: { description: "We will send an equipment check; deposit it and wire transfer the balance to our vendor." } },
      ],
      guards: [
        { name: "bank holidays", input: { description: "We observe all bank holidays and pay overtime for weekend shifts." } },
        { name: "First National Bank as the employer", input: { description: "First National Bank is hiring tellers. We pay competitively and offer training." } },
        { name: "negated fee", input: { description: "We will never ask you to pay a fee or buy equipment as part of hiring." } },
      ],
    },
    {
      code: "SENSITIVE_DATA_REQUEST",
      triggers: [
        { name: "SSN and bank details to start", input: { description: "Send your SSN and bank account details to process your first payment." } },
        { name: "passport scan and date of birth to apply", input: { description: "Upload a passport scan and your date of birth to apply." } },
      ],
      guards: [
        { name: "SSN after an offer for I-9", input: { description: "After an offer, you will provide your SSN for I-9 verification with HR." } },
        { name: "negated", input: { description: "We will not ask for your social security number during the interview process." } },
        { name: "no request verb", input: { description: "Our payroll team protects your bank account details with encryption." } },
      ],
    },
    {
      code: "MESSAGING_APP_ONLY",
      triggers: [
        { name: "Telegram handle", input: { description: "Message our HR on Telegram @gps_hr to start." } },
        { name: "WhatsApp interviews", input: { description: "Interviews are conducted on WhatsApp only." } },
      ],
      guards: [
        { name: "Telegram mention but hosted ATS trail", input: { description: "Message our HR on Telegram to start.", applicationUrl: "https://boards.greenhouse.io/example/jobs/1" } },
        { name: "official ATS source", input: { description: "Questions? Ping us on WhatsApp.", sourceType: "OFFICIAL_ATS" } },
        { name: "no messaging app", input: { description: "Apply through our careers portal." } },
      ],
    },
    {
      code: "GENERIC_WEBMAIL_CONTACT",
      triggers: [
        { name: "gmail with a corporate domain expected", input: { description: "Contact hiring@gmail.com", companyDomain: "example.com" } },
        { name: "yahoo with no domain known", input: { description: "Contact hiring@yahoo.com" } },
      ],
      guards: [
        { name: "corporate email on the company domain", input: { description: "Contact recruiting@example.com", companyDomain: "example.com" } },
        { name: "no email at all", input: { description: "Apply via the form below.", companyDomain: "example.com" } },
      ],
    },
    {
      code: "URL_DOMAIN_MISMATCH",
      triggers: [
        { name: "application on an unrelated domain", input: { applicationUrl: "https://apply.other-site.net/x", companyDomain: "example.com" } },
        { name: "application on a form host", input: { applicationUrl: "https://forms.shady.example/x", companyDomain: "example.com" } },
      ],
      guards: [
        { name: "greenhouse application with a different company domain", input: { applicationUrl: "https://boards.greenhouse.io/example/jobs/1", companyDomain: "example.com" } },
        { name: "application on the company domain", input: { applicationUrl: "https://jobs.example.com/apply", companyDomain: "example.com" } },
        { name: "no company domain known", input: { applicationUrl: "https://apply.other-site.net/x" } },
      ],
    },
    {
      code: "SUSPICIOUS_REDIRECT",
      triggers: [
        { name: "bit.ly shortener", input: { applicationUrl: "https://bit.ly/3abcdef" } },
        { name: "redirect parameter", input: { sourceUrl: "https://jobs.example.com/go?redirect=https://elsewhere.example" } },
      ],
      guards: [
        { name: "plain job URL", input: { sourceUrl: "https://jobs.example.com/roles/1", applicationUrl: "https://jobs.example.com/roles/1/apply" } },
        { name: "utm-free query string", input: { sourceUrl: "https://jobs.example.com/roles?id=1" } },
      ],
    },
    {
      code: "VAGUE_DESCRIPTION",
      triggers: [
        { name: "very short", input: { description: "Great job. Apply now." } },
        { name: "long but no requirements", input: { description: "We are a great company doing great things every day and we want you to join us and have fun together. ".repeat(6) } },
      ],
      guards: [{ name: "complete description", input: { description: CLEAN_DESCRIPTION } }],
    },
    {
      code: "UNREALISTIC_COMPENSATION",
      triggers: [
        { name: "$500 per day", input: { description: "Earn $500 per day from home." } },
        { name: "$200/hour data entry with no experience", input: { description: "No experience needed. Data entry.", compensation: comp({ text: "$200/hour", min: 200, max: 200, currency: "USD", period: "HOUR" }) } },
      ],
      guards: [
        { name: "realistic hourly for data entry", input: { description: "No experience needed. Data entry.", compensation: comp({ text: "$18/hour", min: 18, max: 18, currency: "USD", period: "HOUR" }) } },
        { name: "high salary for a senior role", input: { description: CLEAN_DESCRIPTION, compensation: comp({ text: "$450,000", min: 400000, max: 450000, currency: "USD", period: "YEAR" }) } },
      ],
    },
    {
      code: "HIRING_PRESSURE",
      triggers: [
        { name: "start today, no interview", input: { description: "Start today, no interview needed." } },
        { name: "two weaker cues", input: { description: "Urgent hiring! Immediate start available." } },
      ],
      guards: [
        { name: "a single hiring now", input: { description: "We are hiring now for a software engineer role." } },
        { name: "no pressure", input: { description: CLEAN_DESCRIPTION } },
      ],
    },
    {
      code: "IDENTITY_INCONSISTENCY",
      triggers: [
        { name: "contact on another organisation", input: { description: "Contact jobs@otherfirm.org", companyDomain: "example.com" } },
        { name: "third-party recruiter domain", input: { description: "Email recruiter@third-party.co", companyDomain: "example.com" } },
      ],
      guards: [
        { name: "email on the company domain", input: { description: "Email hr@example.com", companyDomain: "example.com" } },
        { name: "email on the source domain", input: { description: "Email jobs@board.example", companyDomain: "example.com", sourceUrl: "https://board.example/jobs/1" } },
        { name: "no company domain", input: { description: "Email jobs@otherfirm.org" } },
      ],
    },
    {
      code: "UNCORROBORATED_ROLE",
      triggers: [
        { name: "no URLs at all", input: { description: CLEAN_DESCRIPTION } },
        { name: "only a job-board URL", input: { description: CLEAN_DESCRIPTION, sourceUrl: "https://board.example/jobs/1", sourceType: "JOB_BOARD" } },
      ],
      guards: [
        { name: "company website", input: { description: CLEAN_DESCRIPTION, companyWebsite: "https://example.com" } },
        { name: "hosted ATS", input: { description: CLEAN_DESCRIPTION, sourceUrl: "https://jobs.lever.co/example/1" } },
        { name: "official ATS source", input: { description: CLEAN_DESCRIPTION, sourceType: "OFFICIAL_ATS" } },
      ],
    },
  ];

  it("covers every code in SCAM_WEIGHTS", () => {
    assert.deepEqual(CASES.map((c) => c.code).sort(), Object.keys(SCAM_WEIGHTS).sort());
    for (const c of CASES) {
      assert.ok(c.triggers.length >= 2, `${c.code} needs at least two triggers`);
      assert.ok(c.guards.length >= 1, `${c.code} needs a false-positive guard`);
    }
  });

  for (const c of CASES) {
    describe(c.code, () => {
      for (const t of c.triggers) {
        it(`triggers: ${t.name}`, () => {
          const signals = detectScamSignals(ruleInput(t.input));
          const hit = signals.find((s) => s.code === c.code);
          assert.ok(hit, `expected ${c.code} in ${signals.map((s) => s.code)}`);
          assert.equal(hit.kind, "risk");
          assert.ok(hit.weight > 0 && hit.weight <= SCAM_WEIGHTS[c.code]);
          assert.ok(hit.message.length > 10);
          if (hit.evidence !== null) assert.ok(hit.evidence.length <= 120, "evidence is a short quote");
          assert.equal(signals.filter((s) => s.code === c.code).length, 1, "at most one signal per code");
        });
      }
      for (const g of c.guards) {
        it(`does not trigger: ${g.name}`, () => {
          assert.ok(!scamCodes(g.input).includes(c.code), `unexpected ${c.code}`);
        });
      }
    });
  }

  it("uses the full weight when a corporate domain is expected and half otherwise", () => {
    const full = detectScamSignals(ruleInput({ description: "Contact hiring@gmail.com", companyDomain: "example.com" })).find((s) => s.code === "GENERIC_WEBMAIL_CONTACT");
    const half = detectScamSignals(ruleInput({ description: "Contact hiring@gmail.com" })).find((s) => s.code === "GENERIC_WEBMAIL_CONTACT");
    assert.equal(full?.weight, SCAM_WEIGHTS.GENERIC_WEBMAIL_CONTACT);
    assert.equal(half?.weight, Math.round(SCAM_WEIGHTS.GENERIC_WEBMAIL_CONTACT / 2));
  });
});

describe("detectPositiveSignals", () => {
  interface PositiveCase {
    code: PositiveCode;
    triggers: { name: string; input: Partial<RuleInput> }[];
    guards: { name: string; input: Partial<RuleInput> }[];
  }

  const CASES: PositiveCase[] = [
    {
      code: "OFFICIAL_CAREER_PAGE",
      triggers: [{ name: "career page on the company domain", input: { officialCareerUrl: "https://example.com/careers", companyDomain: "example.com" } }],
      guards: [
        { name: "career page on another domain", input: { officialCareerUrl: "https://other.example/careers", companyDomain: "example.com" } },
        { name: "no company domain", input: { officialCareerUrl: "https://example.com/careers" } },
      ],
    },
    {
      code: "OFFICIAL_ATS_SOURCE",
      triggers: [{ name: "OFFICIAL_ATS source type", input: { sourceType: "OFFICIAL_ATS" } }],
      guards: [{ name: "job board source", input: { sourceType: "JOB_BOARD" } }],
    },
    {
      code: "HOSTED_ATS_LISTING",
      triggers: [
        { name: "lever source URL", input: { sourceUrl: "https://jobs.lever.co/example/1" } },
        { name: "greenhouse application URL", input: { applicationUrl: "https://boards.greenhouse.io/example/jobs/1" } },
      ],
      guards: [{ name: "company-hosted URL", input: { sourceUrl: "https://jobs.example.com/1" } }],
    },
    {
      code: "CONSISTENT_DOMAIN",
      triggers: [
        { name: "website, domain and application agree", input: { companyWebsite: "https://example.com", companyDomain: "example.com", applicationUrl: "https://example.com/apply" } },
        { name: "application on a hosted ATS", input: { companyWebsite: "https://example.com", companyDomain: "example.com", applicationUrl: "https://boards.greenhouse.io/example/jobs/1" } },
      ],
      guards: [
        { name: "application on an unrelated domain", input: { companyWebsite: "https://example.com", companyDomain: "example.com", applicationUrl: "https://other.net/apply" } },
        { name: "no application URL", input: { companyWebsite: "https://example.com", companyDomain: "example.com" } },
      ],
    },
    {
      code: "COMPLETE_DESCRIPTION",
      triggers: [{ name: "long description with a role section and requirements", input: { description: CLEAN_DESCRIPTION } }],
      guards: [
        { name: "short description", input: { description: "Short." } },
        { name: "long but no requirement lines", input: { description: "About the role\n" + "We do great things and you will too. ".repeat(40) } },
      ],
    },
    {
      code: "TRANSPARENT_PROCESS",
      triggers: [
        { name: "interview process described", input: { description: "Our interview process has three stages." } },
        { name: "contact on the corporate domain", input: { description: "Contact recruiting@example.com", companyDomain: "example.com" } },
      ],
      guards: [
        { name: "webmail contact only", input: { description: "Contact recruiting@gmail.com", companyDomain: "example.com" } },
        { name: "nothing about the process", input: { description: "We build software." } },
      ],
    },
    {
      code: "VERIFIABLE_FOOTPRINT",
      triggers: [{ name: "company website on record", input: { companyWebsite: "https://example.com" } }],
      guards: [{ name: "no website", input: { officialCareerUrl: "https://example.com/careers" } }],
    },
  ];

  it("covers every code in POSITIVE_WEIGHTS", () => {
    assert.deepEqual(CASES.map((c) => c.code).sort(), Object.keys(POSITIVE_WEIGHTS).sort());
  });

  for (const c of CASES) {
    describe(c.code, () => {
      for (const t of c.triggers) {
        it(`triggers: ${t.name}`, () => {
          const hit = detectPositiveSignals(ruleInput(t.input)).find((s) => s.code === c.code);
          assert.ok(hit, `expected ${c.code}`);
          assert.equal(hit.kind, "positive");
          assert.equal(hit.weight, POSITIVE_WEIGHTS[c.code]);
          assert.ok(hit.message.length > 10);
        });
      }
      for (const g of c.guards) {
        it(`does not trigger: ${g.name}`, () => {
          assert.ok(!positiveCodes(g.input).includes(c.code), `unexpected ${c.code}`);
        });
      }
    });
  }
});

describe("parseGeographicEligibility", () => {
  const EU_SAMPLE = ["DE", "FR", "IE", "NL", "ES"];
  const cases: {
    name: string;
    description: string;
    location?: string | null;
    eligibility: GeographicEligibility;
    contains?: string[];
    exact?: string[];
  }[] = [
    { name: "must reside in the United States", description: "Candidates must reside in the United States.", eligibility: "US_ONLY", exact: ["US"] },
    { name: "location Remote - US", description: "Fully remote role.", location: "Remote - US", eligibility: "US_ONLY", exact: ["US"] },
    { name: "named states", description: "We can hire in California, Texas and New York only.", eligibility: "US_SPECIFIC_STATES", exact: ["US-CA", "US-TX", "US-NY"] },
    { name: "abbreviation list after a colon", description: "Open to candidates residing in the following states: CA, WA, OR.", eligibility: "US_SPECIFIC_STATES", exact: ["US-CA", "US-WA", "US-OR"] },
    { name: "exclusions", description: "This role is not available in CA, CO, NY.", eligibility: "US_SPECIFIC_STATES", exact: ["US-CA", "US-CO", "US-NY"] },
    { name: "anywhere in the world", description: "You can work from anywhere in the world.", eligibility: "GLOBAL", exact: [] },
    { name: "location Remote - Global", description: "Remote role.", location: "Remote - Global", eligibility: "GLOBAL", exact: [] },
    { name: "Canada or the UK", description: "Open to candidates in Canada or the UK.", eligibility: "COUNTRY_RESTRICTED", contains: ["CA", "GB"] },
    { name: "EU only", description: "EU only.", eligibility: "COUNTRY_RESTRICTED", contains: EU_SAMPLE },
    { name: "based in the EU", description: "Candidates must be based in the EU.", eligibility: "COUNTRY_RESTRICTED", contains: EU_SAMPLE },
    { name: "plain text", description: "We build software for happy customers. Great team.", eligibility: "UNKNOWN", exact: [] },
    { name: "office locations do not restrict a global role", description: "Our offices are in London and Berlin. Work from anywhere.", eligibility: "GLOBAL", exact: [] },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const r = parseGeographicEligibility(c.description, c.location ?? null);
      assert.equal(r.eligibility, c.eligibility, `countries: ${r.eligibleCountries}`);
      if (c.exact) assert.deepEqual(r.eligibleCountries, c.exact);
      if (c.contains) for (const code of c.contains) assert.ok(r.eligibleCountries.includes(code), `expected ${code} in ${r.eligibleCountries}`);
      if (c.eligibility !== "UNKNOWN") assert.ok(r.evidence && r.evidence.length > 0, "evidence quoted");
    });
  }

  it("EU only expands to several member states", () => {
    assert.ok(parseGeographicEligibility("EU only.", null).eligibleCountries.length >= 20);
  });

  it("returns US-prefixed codes for states and bare alpha-2 codes for countries", () => {
    for (const code of parseGeographicEligibility("Only residents of Texas or Ohio.", null).eligibleCountries) assert.match(code, /^US-[A-Z]{2}$/);
    for (const code of parseGeographicEligibility("Open to candidates in Canada or the UK.", null).eligibleCountries) assert.match(code, /^[A-Z]{2}$/);
  });
});

describe("parseTimezoneRequirement", () => {
  it("captures an overlap requirement", () => {
    assert.match(parseTimezoneRequirement("You must overlap 4 hours with PST.") ?? "", /overlap 4 hours with PST/);
  });
  it("captures a named time zone requirement", () => {
    assert.match(parseTimezoneRequirement("Must be located in the EST time zone.") ?? "", /EST time zone/);
  });
  it("returns null when no time zone is mentioned", () => {
    assert.equal(parseTimezoneRequirement("We ship software daily."), null);
  });
  it("is carried through parseGeographicEligibility", () => {
    const r = parseGeographicEligibility("Remote in the US. You must overlap 4 hours with PST.", null);
    assert.match(r.timezoneRequirements ?? "", /PST/);
  });
});

describe("parseWorkMode", () => {
  const cases: { name: string; description: string; location?: string | null; mode: WorkMode }[] = [
    { name: "fully remote", description: "This is a fully remote role.", mode: "REMOTE" },
    { name: "hybrid", description: "Hybrid: two days per week in our Austin office.", mode: "HYBRID" },
    { name: "onsite", description: "This position is onsite at our Denver office.", mode: "ONSITE" },
    { name: "remote + hybrid", description: "Remote-friendly with a hybrid option.", mode: "HYBRID" },
    { name: "remote but onsite 2 days per week", description: "Remote role; you must be onsite 2 days per week.", mode: "HYBRID" },
    { name: "remote work is not available", description: "Remote work is not available for this position.", mode: "ONSITE" },
    { name: "remote sensing engineer is not remote", description: "We are hiring a remote sensing engineer to analyse satellite imagery.", mode: "UNKNOWN" },
    { name: "no cue", description: "Great job at a great company.", mode: "UNKNOWN" },
    { name: "location Remote", description: "Work from home.", location: "Remote", mode: "REMOTE" },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const r = parseWorkMode(c.description, c.location ?? null);
      assert.equal(r.workMode, c.mode, `evidence: ${r.evidence}`);
      if (c.mode === "UNKNOWN") assert.equal(r.evidence, null);
      else assert.ok(r.evidence && r.evidence.length > 0, "evidence is non-empty when a mode is found");
    });
  }
});

describe("parseEmploymentType", () => {
  const cases: [string, EmploymentType][] = [
    ["This is a full-time position.", "FULL_TIME"],
    ["Part-time role, 20 hours per week.", "PART_TIME"],
    ["You will be hired as an independent contractor.", "CONTRACT"],
    ["6-month contract with possible extension.", "CONTRACT"],
    ["Summer internship for students.", "INTERNSHIP"],
    ["Freelance writers wanted.", "FREELANCE"],
    ["Full-time internship", "INTERNSHIP"],
    ["Permanent role. Duties include contract negotiation skills with vendors.", "FULL_TIME"],
    ["Nothing here", "UNKNOWN"],
    ["", "UNKNOWN"],
  ];
  for (const [text, expected] of cases) {
    it(`${JSON.stringify(text)} → ${expected}`, () => {
      assert.equal(parseEmploymentType(text), expected);
    });
  }
});

describe("parseCompensation", () => {
  const cases: { text: string; expect: Partial<Compensation> }[] = [
    { text: "Salary: $120,000 - $150,000 per year", expect: { min: 120000, max: 150000, currency: "USD", period: "YEAR" } },
    { text: "$120k–150k", expect: { min: 120000, max: 150000, currency: "USD", period: "YEAR" } },
    { text: "120-150K USD", expect: { min: 120000, max: 150000, currency: "USD", period: "YEAR" } },
    { text: "€60.000 per year", expect: { min: 60000, max: 60000, currency: "EUR", period: "YEAR" } },
    { text: "£45,000 per annum", expect: { min: 45000, max: 45000, currency: "GBP", period: "YEAR" } },
    { text: "$45/hour", expect: { min: 45, max: 45, currency: "USD", period: "HOUR" } },
    { text: "$40 - $55 per hour", expect: { min: 40, max: 55, currency: "USD", period: "HOUR" } },
    { text: "USD 100,000", expect: { min: 100000, max: 100000, currency: "USD", period: "YEAR" } },
    { text: "Salary up to $90,000", expect: { min: null, max: 90000, currency: "USD", period: "YEAR" } },
    {
      text: "We offer a 401(k) match and a $500 sign-on bonus. Base salary $110,000 - $130,000 per year.",
      expect: { min: 110000, max: 130000, currency: "USD", period: "YEAR", text: "$110,000 - $130,000 per year" },
    },
    { text: "We are a team of 12 people who love dogs.", expect: { text: null, min: null, max: null, currency: null, period: "UNKNOWN" } },
    { text: "", expect: { text: null, min: null, max: null, currency: null, period: "UNKNOWN" } },
  ];
  for (const c of cases) {
    it(JSON.stringify(c.text), () => {
      const r = parseCompensation(c.text);
      for (const [k, v] of Object.entries(c.expect)) assert.equal(r[k as keyof Compensation], v, `${k} in ${JSON.stringify(r)}`);
      if (r.min !== null || r.max !== null) assert.ok(r.text && r.text.length > 0, "matched snippet is quoted");
    });
  }
});

describe("remoteEligibilityScore and missingInformation", () => {
  it("maps work mode and geography onto a 0–100 score", () => {
    assert.equal(remoteEligibilityScore({ workMode: "REMOTE", geographicEligibility: "GLOBAL" }), 100);
    assert.equal(remoteEligibilityScore({ workMode: "ONSITE", geographicEligibility: "COUNTRY_RESTRICTED" }), 0);
    assert.equal(remoteEligibilityScore({ workMode: "HYBRID", geographicEligibility: "US_ONLY" }), 45);
    assert.equal(remoteEligibilityScore({ workMode: "REMOTE", geographicEligibility: "US_ONLY" }), 90);
  });

  it("lists absent fields", () => {
    const missing = missingInformation(ruleInput());
    for (const item of ["company website", "official career page URL", "application URL", "compensation", "posting date", "location or geographic eligibility", "work mode (remote/hybrid/onsite)"]) {
      assert.ok(missing.includes(item), `expected "${item}" in ${missing}`);
    }
    const complete = missingInformation(
      ruleInput({
        companyWebsite: "https://example.com",
        officialCareerUrl: "https://example.com/careers",
        applicationUrl: "https://example.com/apply",
        compensation: comp({ min: 1, max: 2 }),
        postedAt: "2026-09-01T00:00:00.000Z",
        locationText: "Remote",
        workMode: "REMOTE",
      }),
    );
    assert.deepEqual(complete, []);
  });
});

describe("evaluateRules end to end", () => {
  const official = (): RuleInput =>
    ruleInput({
      title: SAMPLE_LISTING.title,
      companyName: SAMPLE_LISTING.companyName,
      companyDomain: "northwind.example",
      companyWebsite: SAMPLE_LISTING.companyWebsite,
      officialCareerUrl: SAMPLE_LISTING.officialCareerUrl,
      sourceUrl: SAMPLE_LISTING.sourceUrl,
      applicationUrl: SAMPLE_LISTING.applicationUrl,
      canonicalUrl: SAMPLE_LISTING.sourceUrl,
      sourceType: SAMPLE_LISTING.sourceType,
      sourceName: SAMPLE_LISTING.sourceName,
      description: SAMPLE_LISTING.rawDescription,
      locationText: SAMPLE_LISTING.locationText,
      workMode: "REMOTE",
      geographicEligibility: "US_ONLY",
      compensation: parseCompensation(SAMPLE_LISTING.rawDescription),
    });

  it("verifies an official ATS listing without ever calling it safe", () => {
    const r = evaluateRules(official());
    assert.equal(r.verificationStatus, "VERIFIED_OFFICIAL_SOURCE");
    assert.ok(r.legitimacyScore >= 80, `legitimacy ${r.legitimacyScore}`);
    assert.ok(r.scamRiskScore < 25, `scam risk ${r.scamRiskScore}`);
    assert.match(r.reasons[0] ?? "", /official source/i);
    assert.ok(r.reasons.every((line) => !/\bsafe\b/i.test(line)), "never says 'safe'");
    assert.ok(r.signals.every((s) => s.kind !== "risk"), `no risk signals: ${r.signals.map((s) => s.code)}`);
    for (const code of ["OFFICIAL_CAREER_PAGE", "OFFICIAL_ATS_SOURCE", "HOSTED_ATS_LISTING", "CONSISTENT_DOMAIN", "VERIFIABLE_FOOTPRINT"]) {
      assert.ok(r.signals.some((s) => s.code === code), `expected ${code}`);
    }
    assert.equal(r.remoteEligibilityScore, 90);
    assert.equal(r.relevanceScore, null, "rules never score relevance");
    assert.ok(!r.missingInformation.includes("company website"));
    assert.ok(r.missingInformation.includes("posting date"));
  });

  it("flags the scam listing as high risk with explainable signals", () => {
    const r = evaluateRules(
      ruleInput({
        title: SCAM_LISTING.title,
        companyName: SCAM_LISTING.companyName,
        sourceUrl: SCAM_LISTING.sourceUrl,
        applicationUrl: SCAM_LISTING.sourceUrl,
        sourceType: SCAM_LISTING.sourceType,
        sourceName: SCAM_LISTING.sourceName,
        description: SCAM_LISTING.rawDescription,
        locationText: "Remote",
        workMode: "REMOTE",
        compensation: parseCompensation(SCAM_LISTING.rawDescription),
      }),
    );
    assert.equal(r.verificationStatus, "HIGH_RISK");
    assert.ok(r.scamRiskScore >= 70, `scam risk ${r.scamRiskScore}`);
    assert.ok(r.reasons.some((line) => /high risk/i.test(line)));
    assert.ok(r.reasons.every((line) => !/\bsafe\b/i.test(line)));
    const codes = r.signals.map((s) => s.code);
    for (const code of ["REQUESTS_PAYMENT", "SENSITIVE_DATA_REQUEST", "MESSAGING_APP_ONLY", "GENERIC_WEBMAIL_CONTACT", "SUSPICIOUS_REDIRECT", "HIRING_PRESSURE", "UNREALISTIC_COMPENSATION"]) {
      assert.ok(codes.includes(code), `expected ${code} in ${codes}`);
    }
    assert.ok(r.reasons.length === r.signals.length + 1, "one summary line plus one reason per signal");
    assert.ok(r.signals.filter((s) => s.kind === "risk").every((s) => r.reasons.some((line) => line.startsWith("Risk: ") && line.includes(s.message))));
  });

  it("sends a sparse manual listing to manual review", () => {
    const r = evaluateRules(ruleInput({ description: "Engineer wanted. Good pay. Apply by email." }));
    assert.ok(["NEEDS_MANUAL_REVIEW", "UNVERIFIED"].includes(r.verificationStatus), r.verificationStatus);
    const codes = r.signals.map((s) => s.code);
    assert.ok(codes.includes("UNCORROBORATED_ROLE") && codes.includes("VAGUE_DESCRIPTION"), `${codes}`);
    assert.ok(r.scamRiskScore < 70);
    assert.ok(r.missingInformation.includes("company website"));
  });

  it("escalates to HIGH_RISK on a single severe signal even when the total stays moderate", () => {
    const r = evaluateRules(ruleInput({ description: CLEAN_DESCRIPTION + "\nTo get started you must purchase a starter kit with gift cards and send the codes to HR.", companyWebsite: "https://example.com", sourceType: "OFFICIAL_ATS" }));
    assert.equal(r.verificationStatus, "HIGH_RISK");
  });

  it("maps remote eligibility through the combined input", () => {
    assert.equal(evaluateRules(ruleInput({ workMode: "REMOTE", geographicEligibility: "GLOBAL" })).remoteEligibilityScore, 100);
    assert.equal(evaluateRules(ruleInput({ workMode: "ONSITE", geographicEligibility: "COUNTRY_RESTRICTED" })).remoteEligibilityScore, 0);
    assert.equal(evaluateRules(ruleInput({ workMode: "HYBRID", geographicEligibility: "US_ONLY" })).remoteEligibilityScore, 45);
  });

  it("never produces REJECTED_AS_SCAM and keeps scores within 0–100", () => {
    for (const input of [official(), ruleInput(), ruleInput({ description: SCAM_LISTING.rawDescription, sourceUrl: SCAM_LISTING.sourceUrl })]) {
      const r = evaluateRules(input);
      assert.notEqual(r.verificationStatus, "REJECTED_AS_SCAM");
      for (const score of [r.legitimacyScore, r.scamRiskScore, r.remoteEligibilityScore]) {
        assert.ok(Number.isInteger(score) && score >= 0 && score <= 100, `score ${score}`);
      }
    }
  });
});
