/**
 * Deterministic résumé profiling. Pure text heuristics: label from the file
 * name, target roles from the headline/filename, skills from the dictionary,
 * experience/education summaries from their sections, and "verified facts"
 * (employers, roles, degrees, certifications, date ranges) that drafts may
 * cite. Contact details are recorded only as "present", never their value.
 */
import type { VerifiedFact } from "../../types/entities.ts";
import { collapseWhitespace, truncate, uniqueStrings } from "../../utils/text.ts";
import { findIndustries, findRoleTitles, findSkills } from "./skillsDictionary.ts";

export interface ExtractedProfile {
  label: string;
  targetRoles: string[];
  skills: string[];
  industries: string[];
  experienceSummary: string;
  educationSummary: string;
  verifiedFacts: VerifiedFact[];
}

const EXPERIENCE_HEADING = /^(professional\s+)?(work\s+)?(experience|employment(\s+history)?|work\s+history|career\s+history|relevant\s+experience)\s*:?$/i;
const EDUCATION_HEADING = /^(education(\s+and\s+training)?|academic\s+background|qualifications|training\s+and\s+education)\s*:?$/i;
const OTHER_HEADING = /^(skills|technical\s+skills|core\s+competencies|summary|profile|objective|projects|certifications?|licenses?|awards|publications|volunteer(ing)?|interests|references|languages|contact)\s*:?$/i;
const DATE_RANGE = /\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?((?:19|20)\d{2})\s*[-–—to]+\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?((?:19|20)\d{2}|present|current|now)\b/i;
// Abbreviations are case-sensitive on purpose: a case-insensitive "a.s." would match the word "as".
const DEGREE_ABBREV = /\b(?:B\.?S\.?|B\.?A\.?|B\.?Sc\.?|B\.?Eng\.?|B\.?F\.?A\.?|B\.?B\.?A\.?|M\.?S\.?|M\.?A\.?|M\.?Sc\.?|M\.?Eng\.?|M\.?B\.?A\.?|M\.?F\.?A\.?|M\.?Ed\.?|Ph\.?D\.?|J\.?D\.?|A\.?A\.?|A\.?S\.?|Ed\.?D\.?)(?=[\s,.;:)]|$)/;
const DEGREE_WORDS = /\b(bachelor(?:'s)?(?:\s+of\s+[a-z]+)?|master(?:'s)?(?:\s+of\s+[a-z]+)?|doctorate|doctoral|associate(?:'s)?\s+(?:degree|of\s+[a-z]+)|juris\s+doctor|bootcamp|diploma|certificate\s+in\s+[a-z ]+)\b/i;
const isDegreeLine = (line: string): boolean => DEGREE_ABBREV.test(line) || DEGREE_WORDS.test(line);
const CERT = /\b(aws\s+certified[a-z\s-]*|azure\s+[a-z\s-]*certified|google\s+(?:cloud|professional)[a-z\s-]*(?:certified|engineer|architect)|pmp|csm|psm\s*i{0,3}|cspo|safe\s+agilist|cpa|cfa|cma|cia|comptia\s+[a-z+]+|ccna|ccnp|cissp|ceh|security\+|network\+|a\+|itil(?:\s+v?\d)?|six\s+sigma(?:\s+[a-z]+\s+belt)?|lean\s+six\s+sigma|scrum\s+master|salesforce\s+certified[a-z\s-]*|hubspot\s+certified|google\s+analytics\s+certified|rn|bls|acls|cna|lpn|np|cpr\s+certified|osha\s*\d*|cdl(?:\s+class\s+[a-c])?|series\s+(?:7|63|65|66)|ccie|ckad|cka|terraform\s+associate)\b/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const URL = /\b(?:https?:\/\/|www\.)[^\s]+|\b(?:linkedin\.com|github\.com|behance\.net|dribbble\.com)\/[^\s]+/i;

function isHeading(line: string): "experience" | "education" | "other" | null {
  const t = line.replace(/^[#*\s]+|[#*\s:]+$/g, "").trim();
  if (t.length > 40) return null;
  if (EXPERIENCE_HEADING.test(t)) return "experience";
  if (EDUCATION_HEADING.test(t)) return "education";
  if (OTHER_HEADING.test(t)) return "other";
  return null;
}

export function labelFromFilename(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  const stem = base.replace(/\.[a-z0-9]+$/i, "");
  return collapseWhitespace(stem.replace(/[_\-.]+/g, " "))
    .split(" ")
    .map((w) => (w.length <= 3 && /^[a-z]+$/i.test(w) && /^(cv|pm|ux|ui|qa|hr|it|se|swe|ml|ai)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ") || "Résumé";
}

function sections(text: string): { experience: string[]; education: string[]; head: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^[\s•\-–—*·▪◦]+/, "").trim());
  const out = { experience: [] as string[], education: [] as string[], head: [] as string[] };
  let current: "experience" | "education" | "other" | "head" = "head";
  for (const line of lines) {
    if (!line) continue;
    const h = isHeading(line);
    if (h) {
      current = h;
      continue;
    }
    if (current === "head" && out.head.length < 15) out.head.push(line);
    else if (current === "experience") out.experience.push(line);
    else if (current === "education") out.education.push(line);
  }
  if (!out.experience.length) out.experience = lines.filter((l) => DATE_RANGE.test(l)).slice(0, 8);
  return out;
}

function splitRoleCompany(line: string): { role: string | null; employer: string | null } {
  const cleaned = line.replace(DATE_RANGE, "").replace(/[()|,\s]+$/g, "").trim();
  const parts = cleaned.split(/\s+[—–|@]\s+|\s+-\s+|\s+at\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const [a, b] = parts as [string, string];
    const aIsRole = findRoleTitles(a).length > 0 || /\b(engineer|manager|developer|designer|analyst|lead|director|specialist|coordinator|assistant|consultant|intern|associate|nurse|teacher|writer|editor|representative|technician|architect|scientist|administrator|officer|head|vp|president|founder)\b/i.test(a);
    return aIsRole ? { role: a, employer: b } : { role: b, employer: a };
  }
  return { role: null, employer: null };
}

export function buildResumeProfile(text: string, filename: string): ExtractedProfile {
  const label = labelFromFilename(filename);
  const sec = sections(text);
  const headline = sec.head.join("\n");
  const targetRoles = uniqueStrings([...findRoleTitles(headline, 5), ...findRoleTitles(label, 3)]).slice(0, 5);
  const skills = findSkills(text, 60);
  const industries = findIndustries(text, 10);
  const experienceSummary = truncate(sec.experience.slice(0, 8).map(collapseWhitespace).join("; "), 1200);
  const educationSummary = truncate(sec.education.slice(0, 6).map(collapseWhitespace).join("; "), 600);

  const facts: VerifiedFact[] = [];
  const seen = new Set<string>();
  const add = (kind: string, value: string) => {
    const v = collapseWhitespace(value).replace(/[.,;:]+$/, "");
    const key = `${kind}:${v.toLowerCase()}`;
    if (!v || v.length < 2 || v.length > 160 || seen.has(key)) return;
    seen.add(key);
    facts.push({ kind, text: v });
  };
  for (const line of text.split(/\r?\n/)) {
    const m = DATE_RANGE.exec(line);
    if (m) add("date-range", m[0]);
  }
  for (const line of sec.experience.slice(0, 12)) {
    const { role, employer } = splitRoleCompany(line);
    if (role) add("role", role);
    if (employer) add("employer", employer);
  }
  for (const line of [...sec.education, ...text.split(/\r?\n/)]) {
    if (isDegreeLine(line) && line.length <= 160 && !/\b(experience|responsible|led|managed)\b/i.test(line)) add("degree", line.replace(/^[\s•\-–—*·]+/, ""));
  }
  for (const line of text.split(/\r?\n/)) {
    const m = CERT.exec(line);
    if (m && m[0].length >= 3) add("certification", m[0]);
  }
  if (EMAIL.test(text)) add("contact", "email present");
  if (PHONE.test(text)) add("contact", "phone present");
  if (URL.test(text)) add("contact", "profile link present");
  for (const s of skills.slice(0, 15)) add("skill", s);

  return { label, targetRoles, skills, industries, experienceSummary, educationSummary, verifiedFacts: facts.slice(0, 80) };
}
