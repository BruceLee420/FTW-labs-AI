export const REPAIR_PROMPT_VERSION = "repair-v1";

export function buildRepairPrompt(issues: string[], raw: string): string {
  return [
    "Your previous reply was not valid for the required JSON shape.",
    "Problems:",
    ...issues.slice(0, 20).map((i) => `- ${i}`),
    "",
    "Previous reply (truncated):",
    raw,
    "",
    "Reply again with ONLY a single JSON object that fixes every problem above. No prose, no code fences, no comments.",
  ].join("\n");
}
