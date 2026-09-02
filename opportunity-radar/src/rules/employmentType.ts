/**
 * Deterministic employment-type parser.
 *
 * Why: the type (full-time, contract, internship, …) is almost always stated
 * in plain words, so a pure keyword pass is cheaper and more predictable than
 * asking a model. Precedence resolves mixed wording ("full-time internship" →
 * INTERNSHIP, "part-time contract" → CONTRACT) and the contract/temp patterns
 * require employment context so "contract negotiation" or "temporary
 * relocation" in a duty list do not misclassify a permanent role.
 */
import type { EmploymentType } from "../types/entities.ts";

const INTERNSHIP_RE = /\binterns?\b|\binternships?\b|\bco-?op\b(?!\s*erat)/i;
const FREELANCE_RE = /\bfreelanc\w*\b/i;
const CONTRACT_RE =
  /\bindependent\s+contractor\b|\bas\s+an?\s+contractor\b|\bcontractor\s+(?:role|position|basis|job)\b|\bcontract(?:ual)?\s+(?:role|position|basis|job|work|opportunity|assignment|engagement|hire|employment|only|worker)\b|\b(?:on|as)\s+(?:a\s+)?contract\b|\bcontract[- ]to[- ]hire\b|\b(?:\d+|three|six|nine|twelve|eighteen)[- ]month\s+contract\b|\bc2c\b|\bcorp[- ]to[- ]corp\b|\b1099\b|\bw-?2\s+contract\b|\b(?:employment|job)\s*type\s*:?\s*contract\b|\bcontract\s*\(|^\s*contract\s*$/im;
const TEMPORARY_RE =
  /\btemporary\s+(?:role|position|job|assignment|contract|employment|staff|worker|cover)\b|\btemp\s+(?:role|position|job|assignment|staff|worker)\b|\btemp[- ]to[- ]perm\b|\bseasonal\b|\bfixed[- ]term\b|\b(?:maternity|parental|paternity|sick)\s+(?:leave\s+)?cover\b|\b(?:employment|job)\s*type\s*:?\s*temp(?:orary)?\b/i;
const PART_TIME_RE = /\bpart[- ]time\b/i;
const FULL_TIME_RE = /\bfull[- ]time\b|\bfte\b|\bpermanent\b|\b(?:37\.5|38|40)\s*(?:hours?|hrs)\s*(?:per|a|\/)\s*week\b/i;

export function parseEmploymentType(text: string): EmploymentType {
  if (!text) return "UNKNOWN";
  if (INTERNSHIP_RE.test(text)) return "INTERNSHIP";
  if (FREELANCE_RE.test(text)) return "FREELANCE";
  if (CONTRACT_RE.test(text)) return "CONTRACT";
  if (TEMPORARY_RE.test(text)) return "TEMPORARY";
  if (PART_TIME_RE.test(text)) return "PART_TIME";
  if (FULL_TIME_RE.test(text)) return "FULL_TIME";
  return "UNKNOWN";
}
