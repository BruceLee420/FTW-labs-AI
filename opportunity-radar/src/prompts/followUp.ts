export const FOLLOW_UP_PROMPT_VERSION = "follow-up-v1";

export interface FollowUpPromptInput {
  opportunity: { title: string; companyName: string };
  appliedAt: string;
  confirmationReference: string | null;
  candidateName: string | null;
  resumeHighlights: string[];
}

const SYSTEM = `You draft a short, polite follow-up email after a job application. Under 150 words. No invented facts: mention only the role, company, application date, reference number and the highlights provided. The email is a DRAFT the candidate will review; it is never sent automatically.
Output ONLY a JSON object: { "subject": string, "body": string, "evidence": [{ "claim": string, "sourceFact": string }] }.`;

export function buildFollowUpPrompt(input: FollowUpPromptInput): { system: string; user: string } {
  const user = [
    `Role: ${input.opportunity.title} at ${input.opportunity.companyName}`,
    `Applied on: ${input.appliedAt.slice(0, 10)}`,
    `Confirmation reference: ${input.confirmationReference ?? "none"}`,
    `Candidate name: ${input.candidateName ?? "[Your name]"}`,
    `Highlights that may be mentioned: ${input.resumeHighlights.join(", ") || "none"}`,
    "",
    "Write the follow-up email now. Reply with the JSON object only.",
  ].join("\n");
  return { system: SYSTEM, user };
}
