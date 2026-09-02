/**
 * Turns raw listing text into the structured fields an Opportunity carries:
 * sections (responsibilities, qualifications), skills, work mode, geography,
 * employment type and compensation. Deterministic; the rules modules do the
 * pattern work, this file does the sectioning and assembly.
 */
import type {
  Compensation,
  EmploymentType,
  GeographicEligibility,
  WorkMode,
} from "../types/entities.ts";
import { parseCompensation, parseEmploymentType, parseGeographicEligibility, parseWorkMode } from "../rules/index.ts";
import { findSkills } from "./resumes/skillsDictionary.ts";
import { sha256Hex } from "../utils/hash.ts";
import { collapseWhitespace, lines, uniqueStrings } from "../utils/text.ts";

export interface NormalizedFields {
  normalizedDescription: string;
  descriptionHash: string;
  responsibilities: string[];
  qualifications: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  workMode: WorkMode;
  workModeEvidence: string | null;
  geographicEligibility: GeographicEligibility;
  eligibleCountries: string[];
  timezoneRequirements: string | null;
  geographyEvidence: string | null;
  employmentType: EmploymentType;
  compensation: Compensation;
}

const RESPONSIBILITY_HEADINGS =
  /^(responsibilities|what you(?:'|’)ll do|what you will do|key responsibilities|duties|in this role(?: you will)?|what you(?:'|’)ll be doing|day to day|your responsibilities|the work)$/i;
const QUALIFICATION_HEADINGS =
  /^(requirements|qualifications|what we(?:'|’)re looking for|what you(?:'|’)ll bring|what you bring|about you|who you are|minimum qualifications|basic qualifications|required qualifications|must have|you have|skills( and experience)?|experience( required)?|required skills|what you need)$/i;
const PREFERRED_HEADINGS = /^(nice to have|preferred( qualifications| skills)?|bonus( points)?|plus(es)?|good to have|it(?:'|’)s a plus|nice-to-haves?)$/i;
const OTHER_HEADINGS = /^(benefits|perks|compensation|salary|about (us|the company|the team|the role)|the role|role overview|your role|our (mission|values)|how to apply|equal opportunity|eeo|diversity|interview process|what we offer|why join)$/i;

type Section = "responsibilities" | "qualifications" | "preferred" | "other" | "none";

function headingFor(line: string): Section | null {
  const trimmed = line.replace(/[:\-–—]+$/, "").trim();
  if (trimmed.length > 40) return null;
  if (RESPONSIBILITY_HEADINGS.test(trimmed)) return "responsibilities";
  if (PREFERRED_HEADINGS.test(trimmed)) return "preferred";
  if (QUALIFICATION_HEADINGS.test(trimmed)) return "qualifications";
  if (OTHER_HEADINGS.test(trimmed)) return "other";
  return null;
}

/** Split description into responsibility / qualification / preferred lines. */
export function sectionize(description: string): {
  responsibilities: string[];
  qualifications: string[];
  preferred: string[];
} {
  const out = { responsibilities: [] as string[], qualifications: [] as string[], preferred: [] as string[] };
  let current: Section = "none";
  for (const raw of lines(description)) {
    const heading = headingFor(raw);
    if (heading) {
      current = heading;
      continue;
    }
    if (raw.length < 12 || raw.length > 400) continue;
    if (current === "responsibilities") out.responsibilities.push(raw);
    else if (current === "qualifications") out.qualifications.push(raw);
    else if (current === "preferred") out.preferred.push(raw);
  }
  return {
    responsibilities: uniqueStrings(out.responsibilities).slice(0, 40),
    qualifications: uniqueStrings(out.qualifications).slice(0, 40),
    preferred: uniqueStrings(out.preferred).slice(0, 40),
  };
}

/** Collapse whitespace but keep paragraph/line structure for display. */
export function normalizeDescription(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .split("\n")
    .map((l) => collapseWhitespace(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface NormalizeInput {
  rawDescription: string;
  title: string;
  locationText: string | null;
  /** User-supplied overrides win over inference. */
  workMode?: WorkMode;
  geographicEligibility?: GeographicEligibility;
  eligibleCountries?: string[];
  timezoneRequirements?: string | null;
  employmentType?: EmploymentType;
  compensation?: Partial<Compensation>;
  requiredSkills?: string[];
  preferredSkills?: string[];
}

export function normalizeOpportunity(input: NormalizeInput): NormalizedFields {
  const normalizedDescription = normalizeDescription(input.rawDescription);
  const combined = `${input.title}\n${input.locationText ?? ""}\n${normalizedDescription}`;
  const sections = sectionize(normalizedDescription);

  const requiredFromText = findSkills(
    sections.qualifications.length ? sections.qualifications.join("\n") : normalizedDescription,
  );
  const preferredFromText = findSkills(sections.preferred.join("\n"));
  const requiredSkills = uniqueStrings([...(input.requiredSkills ?? []), ...requiredFromText]).slice(0, 60);
  const requiredKeys = new Set(requiredSkills.map((s) => s.toLowerCase()));
  const preferredSkills = uniqueStrings([...(input.preferredSkills ?? []), ...preferredFromText])
    .filter((s) => !requiredKeys.has(s.toLowerCase()))
    .slice(0, 40);

  const wm = parseWorkMode(combined, input.locationText);
  const geo = parseGeographicEligibility(combined, input.locationText);
  const workMode = input.workMode && input.workMode !== "UNKNOWN" ? input.workMode : wm.workMode;
  const geographicEligibility =
    input.geographicEligibility && input.geographicEligibility !== "UNKNOWN" ? input.geographicEligibility : geo.eligibility;
  const eligibleCountries = input.eligibleCountries?.length ? uniqueStrings(input.eligibleCountries) : geo.eligibleCountries;
  const timezoneRequirements = input.timezoneRequirements ?? geo.timezoneRequirements;
  const employmentType = input.employmentType && input.employmentType !== "UNKNOWN" ? input.employmentType : parseEmploymentType(combined);
  const parsedComp = parseCompensation(combined);
  const compensation: Compensation = {
    text: input.compensation?.text ?? parsedComp.text,
    min: input.compensation?.min ?? parsedComp.min,
    max: input.compensation?.max ?? parsedComp.max,
    currency: input.compensation?.currency ?? parsedComp.currency,
    period: input.compensation?.period ?? parsedComp.period,
  };

  return {
    normalizedDescription,
    descriptionHash: sha256Hex(normalizedDescription.toLowerCase().replace(/\s+/g, " ")),
    responsibilities: sections.responsibilities,
    qualifications: sections.qualifications,
    requiredSkills,
    preferredSkills,
    workMode,
    workModeEvidence: wm.evidence,
    geographicEligibility,
    eligibleCountries,
    timezoneRequirements,
    geographyEvidence: geo.evidence,
    employmentType,
    compensation,
  };
}
