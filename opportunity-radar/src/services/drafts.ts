/**
 * Draft application packages and follow-up emails. Drafts are grounded in ONE
 * selected résumé profile: the model gets that profile's facts and a bounded
 * excerpt, and every claim must cite a source fact. A deterministic grounding
 * check verifies each cited fact against the résumé text and flags the rest.
 * When no model is available (or on request) a template package is built
 * from résumé facts only, which is grounded by construction.
 *
 * Nothing here sends anything. Drafts are stored and displayed.
 */
import type { AppDeps } from "../deps.ts";
import type { GenerateDraftInput, DraftEdit } from "../schemas/application.ts";
import type {
  Application,
  ApplicationDraft,
  DraftEvidence,
  DraftPackage,
  FollowUpEmailDraft,
  Opportunity,
  ResumeProfile,
} from "../types/entities.ts";
import { AiInvalidOutputError, AiUnavailableError } from "../ai/provider.ts";
import { generateStructured } from "../ai/structured.ts";
import { DraftPackageOutputSchema, FollowUpEmailOutputSchema } from "../schemas/ai.ts";
import { buildDraftPrompt, DRAFT_PROMPT_VERSION } from "../prompts/draft.ts";
import { buildFollowUpPrompt, FOLLOW_UP_PROMPT_VERSION } from "../prompts/followUp.ts";
import { conflict, notFound, unprocessable } from "../utils/errors.ts";
import { newId } from "../utils/ids.ts";
import { collapseWhitespace, truncate } from "../utils/text.ts";
import { recordAudit } from "./audit.ts";
import { getOrCreateApplication, requireOpportunity } from "./applications.ts";

type Deps = Pick<AppDeps, "repos" | "now" | "ai" | "logger">;

/** Normalise for substring grounding: lowercase, collapse whitespace, strip punctuation. */
function groundingKey(s: string): string {
  return collapseWhitespace(s.toLowerCase().replace(/[^a-z0-9\s]/g, " "));
}

/** A fact is grounded when it (or all of its 4+-word chunks) appears in the résumé text. */
export function isGrounded(sourceFact: string, resume: Pick<ResumeProfile, "extractedText" | "verifiedFacts" | "skills" | "experienceSummary" | "educationSummary">): boolean {
  const fact = groundingKey(sourceFact);
  if (fact.length < 3) return false;
  const haystack = groundingKey(
    [resume.extractedText, resume.experienceSummary, resume.educationSummary, ...resume.skills, ...resume.verifiedFacts.map((f) => f.text)].join("\n"),
  );
  if (haystack.includes(fact)) return true;
  const words = fact.split(" ").filter((w) => w.length > 2);
  if (words.length < 4) return false;
  // Allow light paraphrase: at least 80% of content words present in order-insensitive form.
  const present = words.filter((w) => haystack.includes(w)).length;
  return present / words.length >= 0.8;
}

export function checkGrounding(evidence: { claim: string; sourceFact: string }[], resume: ResumeProfile): { evidence: DraftEvidence[]; warnings: string[] } {
  const warnings: string[] = [];
  const out = evidence.map((e) => {
    const grounded = isGrounded(e.sourceFact, resume);
    if (!grounded) warnings.push(`Could not find this fact in the résumé: "${truncate(e.sourceFact, 120)}" (claim: "${truncate(e.claim, 120)}")`);
    return { claim: e.claim, sourceFact: e.sourceFact, resumeId: resume.id, grounded };
  });
  if (!evidence.length) warnings.push("The draft cites no résumé evidence; review every statement against your résumé before using it.");
  return { evidence: out, warnings };
}

function candidateName(resume: ResumeProfile): string | null {
  const first = resume.extractedText.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 1 && l.length < 60 && !/@|http|\d{3}/.test(l));
  return first && /^[A-Za-z][A-Za-z .'-]+$/.test(first) ? first : null;
}

/** Deterministic package built only from résumé facts. */
export function buildTemplatePackage(opportunity: Opportunity, resume: ResumeProfile, questions: string[], includeOutreach: boolean): DraftPackage {
  const skillsInCommon = opportunity.requiredSkills.filter((s) => resume.skills.some((r) => r.toLowerCase() === s.toLowerCase()));
  const topSkills = (skillsInCommon.length ? skillsInCommon : resume.skills).slice(0, 6);
  const roles = resume.targetRoles.slice(0, 2).join(" / ") || "professional";
  const employers = resume.verifiedFacts.filter((f) => f.kind === "employer" || f.kind === "role").slice(0, 3).map((f) => f.text);
  const degrees = resume.verifiedFacts.filter((f) => f.kind === "degree").slice(0, 1).map((f) => f.text);
  const certs = resume.verifiedFacts.filter((f) => f.kind === "certification").slice(0, 2).map((f) => f.text);
  const missing = opportunity.requiredSkills.filter((s) => !resume.skills.some((r) => r.toLowerCase() === s.toLowerCase()));

  const evidence: DraftEvidence[] = [];
  const cite = (claim: string, sourceFact: string) => evidence.push({ claim, sourceFact, resumeId: resume.id, grounded: isGrounded(sourceFact, resume) });

  const summary = `${roles} with hands-on experience in ${topSkills.join(", ") || "the areas this role calls for"}${employers.length ? `, most recently at ${employers[0]}` : ""}. Interested in the ${opportunity.title} role at ${opportunity.companyName}.`;
  topSkills.forEach((s) => cite(`Experience in ${s}`, s));
  if (employers[0]) cite(`Most recently at ${employers[0]}`, employers[0]);

  const coverLetter = [
    `Dear ${opportunity.companyName} hiring team,`,
    "",
    `I am applying for the ${opportunity.title} position. My background as a ${roles} maps directly onto the role: ${topSkills.length ? `I have worked with ${topSkills.join(", ")}` : "my experience covers the core responsibilities listed"}${employers.length ? `, including in my work at ${employers.join(" and ")}` : ""}.`,
    "",
    degrees.length || certs.length
      ? `My qualifications include ${[...degrees, ...certs].join(" and ")}.`
      : "I have attached my résumé with the details of my experience.",
    "",
    "I would welcome the chance to discuss how I can contribute. Thank you for your consideration.",
    "",
    "Sincerely,",
    candidateName(resume) ?? "[Your name]",
  ].join("\n");
  degrees.forEach((d) => cite(`Holds ${d}`, d));
  certs.forEach((c) => cite(`Holds ${c}`, c));

  const tailoring = [
    ...(skillsInCommon.length ? [`Move these skills to the top of your skills section: ${skillsInCommon.slice(0, 8).join(", ")}.`] : []),
    ...(missing.length ? [`The listing asks for ${missing.slice(0, 6).join(", ")} which are not in this résumé. Add them only if you genuinely have them; otherwise address the gap honestly.`] : []),
    `Mirror the job title "${opportunity.title}" in your headline if it matches your experience.`,
    ...(opportunity.responsibilities.length ? [`Lead your most recent role's bullets with outcomes related to: ${opportunity.responsibilities.slice(0, 2).map((r) => truncate(r, 80)).join("; ")}`] : []),
  ];

  const applicationAnswers = questions.map((q) => ({
    question: q,
    answer: `[Draft] Based on my experience as a ${roles}${topSkills.length ? ` with ${topSkills.slice(0, 3).join(", ")}` : ""}, I would approach this by … (complete with a specific example from your résumé; do not add anything that is not on it).`,
  }));

  const recruiterOutreach = includeOutreach
    ? `Hello,\n\nI just applied for the ${opportunity.title} role at ${opportunity.companyName}. My background as a ${roles}${topSkills.length ? ` (${topSkills.slice(0, 3).join(", ")})` : ""} seems a close fit and I would appreciate a short conversation about the team's priorities.\n\nThank you,\n${candidateName(resume) ?? "[Your name]"}`
    : null;

  return { professionalSummary: summary, coverLetter, resumeTailoringSuggestions: tailoring, applicationAnswers, recruiterOutreach, evidence };
}

function resolveResume(deps: Deps, opportunity: Opportunity, resumeId: string | undefined): ResumeProfile {
  const id = resumeId ?? opportunity.recommendedResumeId;
  if (!id) throw unprocessable("Choose a résumé profile first (index your résumé folder, then pick or evaluate).");
  const resume = deps.repos.resumes.findById(id);
  if (!resume) throw notFound("No such résumé profile.");
  if (!resume.isActive) throw unprocessable("That résumé profile is inactive.");
  if (resume.extractionStatus === "NEEDS_OCR" || resume.extractionStatus === "FAILED") {
    throw unprocessable("That résumé has no usable extracted text (needs OCR or failed to parse).");
  }
  return resume;
}

export async function generateDraftPackage(deps: Deps, opportunityId: string, input: GenerateDraftInput, actor = "user"): Promise<{ application: Application; draft: ApplicationDraft; opportunity: Opportunity }> {
  const opportunity = requireOpportunity(deps, opportunityId);
  if (opportunity.verificationStatus === "REJECTED_AS_SCAM") throw conflict("This opportunity was rejected as a scam; drafting is disabled.");
  const resume = resolveResume(deps, opportunity, input.resumeId);
  const application = getOrCreateApplication(deps as never, opportunityId, resume.id);

  let content: DraftPackage;
  let generatedBy: ApplicationDraft["generatedBy"] = "template";
  let model: string | null = null;
  let promptVersion: string | null = null;
  let warnings: string[] = [];
  let aiNote: string | null = null;

  if (!input.templateOnly && deps.ai.id !== "none") {
    try {
      const prompt = buildDraftPrompt({
        opportunity: {
          title: opportunity.title,
          companyName: opportunity.companyName,
          description: truncate(opportunity.normalizedDescription || opportunity.rawDescription, 8000),
          requiredSkills: opportunity.requiredSkills,
          preferredSkills: opportunity.preferredSkills,
          responsibilities: opportunity.responsibilities,
          qualifications: opportunity.qualifications,
        },
        resume: {
          id: resume.id,
          label: resume.label,
          targetRoles: resume.targetRoles,
          skills: resume.skills,
          industries: resume.industries,
          experienceSummary: resume.experienceSummary,
          educationSummary: resume.educationSummary,
          verifiedFacts: resume.verifiedFacts.filter((f) => f.kind !== "contact"),
          excerpt: truncate(resume.extractedText, 6000),
        },
        questions: input.questions,
        includeOutreach: input.includeOutreach,
        candidateName: candidateName(resume),
      });
      const result = await generateStructured(deps.ai, DraftPackageOutputSchema, prompt);
      const grounding = checkGrounding(result.data.evidence, resume);
      content = {
        professionalSummary: result.data.professionalSummary,
        coverLetter: result.data.coverLetter,
        resumeTailoringSuggestions: result.data.resumeTailoringSuggestions,
        applicationAnswers: result.data.applicationAnswers,
        recruiterOutreach: input.includeOutreach ? result.data.recruiterOutreach : null,
        evidence: grounding.evidence,
      };
      warnings = grounding.warnings;
      generatedBy = "ai";
      model = result.model;
      promptVersion = DRAFT_PROMPT_VERSION;
    } catch (err) {
      if (err instanceof AiUnavailableError || err instanceof AiInvalidOutputError) {
        aiNote = `${err.name === "AiUnavailableError" ? "Model unavailable" : "Model output invalid"}; a template draft was produced instead.`;
        content = buildTemplatePackage(opportunity, resume, input.questions, input.includeOutreach);
        warnings = [aiNote, ...content.evidence.filter((e) => !e.grounded).map((e) => `Template fact not found in résumé text: "${truncate(e.sourceFact, 100)}"`)];
      } else throw err;
    }
  } else {
    content = buildTemplatePackage(opportunity, resume, input.questions, input.includeOutreach);
    warnings = content.evidence.filter((e) => !e.grounded).map((e) => `Template fact not found in résumé text: "${truncate(e.sourceFact, 100)}"`);
  }

  const version = (deps.repos.drafts.latest(application.id, "APPLICATION_PACKAGE")?.version ?? 0) + 1;
  const draft: ApplicationDraft = {
    id: newId(),
    applicationId: application.id,
    opportunityId,
    resumeId: resume.id,
    kind: "APPLICATION_PACKAGE",
    version,
    content,
    groundingWarnings: warnings,
    generatedBy,
    provider: generatedBy === "ai" ? deps.ai.id : null,
    model,
    promptVersion,
    createdAt: deps.now(),
    editedAt: null,
  };
  const result = deps.repos.transaction(() => {
    const stored = deps.repos.drafts.insert(draft);
    const app = deps.repos.applications.update(application.id, {
      currentDraftVersion: version,
      resumeId: resume.id,
      status: application.status === "APPROVED" || application.status === "SUBMITTED" ? application.status : "AWAITING_APPROVAL",
    })!;
    const opp = deps.repos.opportunities.update(opportunityId, {
      status: ["NORMALIZED", "REVIEW_NEEDED", "VERIFIED", "READY_TO_APPLY", "DRAFT_PREPARED", "AWAITING_APPROVAL", "DISCOVERED"].includes(opportunity.status) ? "DRAFT_PREPARED" : opportunity.status,
      recommendedResumeId: resume.id,
      nextAction: "Review and edit the draft, then approve it.",
    })!;
    recordAudit(deps.repos, deps.now, "draft", stored.id, "draft.generated", {
      opportunityId,
      applicationId: application.id,
      version,
      generatedBy,
      model,
      promptVersion,
      resumeId: resume.id,
      groundingWarnings: warnings.length,
    }, actor);
    return { application: app, draft: stored, opportunity: opp };
  });
  return result;
}

export function editDraft(deps: Deps, opportunityId: string, draftId: string, edit: DraftEdit, actor = "user"): ApplicationDraft {
  const existing = deps.repos.drafts.findById(draftId);
  if (!existing || existing.opportunityId !== opportunityId) throw notFound("No such draft.");
  if (existing.kind !== "APPLICATION_PACKAGE") throw unprocessable("Only application packages can be edited this way.");
  const resume = existing.resumeId ? deps.repos.resumes.findById(existing.resumeId) : null;
  const prev = existing.content as DraftPackage;
  const evidence = edit.evidence
    ? edit.evidence.map((e) => ({ ...e, grounded: resume ? isGrounded(e.sourceFact, resume) : e.grounded }))
    : prev.evidence;
  const content: DraftPackage = {
    professionalSummary: edit.professionalSummary ?? prev.professionalSummary,
    coverLetter: edit.coverLetter ?? prev.coverLetter,
    resumeTailoringSuggestions: edit.resumeTailoringSuggestions ?? prev.resumeTailoringSuggestions,
    applicationAnswers: edit.applicationAnswers ?? prev.applicationAnswers,
    recruiterOutreach: edit.recruiterOutreach === undefined ? prev.recruiterOutreach : edit.recruiterOutreach,
    evidence,
  };
  const version = (deps.repos.drafts.latest(existing.applicationId, "APPLICATION_PACKAGE")?.version ?? 0) + 1;
  const warnings = evidence.filter((e) => !e.grounded).map((e) => `Not found in résumé: "${truncate(e.sourceFact, 100)}"`);
  const draft = deps.repos.transaction(() => {
    const stored = deps.repos.drafts.insert({
      ...existing,
      id: newId(),
      version,
      content,
      groundingWarnings: warnings,
      generatedBy: "user",
      provider: null,
      model: null,
      promptVersion: null,
      createdAt: deps.now(),
      editedAt: deps.now(),
    });
    deps.repos.applications.update(existing.applicationId, { currentDraftVersion: version });
    recordAudit(deps.repos, deps.now, "draft", stored.id, "draft.edited", { opportunityId, fromVersion: existing.version, version }, actor);
    return stored;
  });
  return draft;
}

export async function generateFollowUpDraft(deps: Deps, opportunityId: string, actor = "user"): Promise<ApplicationDraft> {
  const opportunity = requireOpportunity(deps, opportunityId);
  const application = deps.repos.applications.findByOpportunity(opportunityId);
  if (!application || !application.appliedAt) throw conflict("Record the application as submitted before drafting a follow-up.");
  const resume = application.resumeId ? deps.repos.resumes.findById(application.resumeId) : null;
  const highlights = resume ? [...resume.targetRoles.slice(0, 2), ...resume.skills.slice(0, 5)] : [];
  const name = resume ? candidateName(resume) : null;

  let content: FollowUpEmailDraft;
  let generatedBy: ApplicationDraft["generatedBy"] = "template";
  let model: string | null = null;
  let promptVersion: string | null = null;
  let warnings: string[] = [];
  if (deps.ai.id !== "none") {
    try {
      const prompt = buildFollowUpPrompt({
        opportunity: { title: opportunity.title, companyName: opportunity.companyName },
        appliedAt: application.appliedAt,
        confirmationReference: application.confirmationReference,
        candidateName: name,
        resumeHighlights: highlights,
      });
      const result = await generateStructured(deps.ai, FollowUpEmailOutputSchema, prompt);
      const grounding = resume ? checkGrounding(result.data.evidence, resume) : { evidence: result.data.evidence.map((e) => ({ ...e, resumeId: "", grounded: false })), warnings: [] };
      content = { subject: result.data.subject, body: result.data.body, evidence: grounding.evidence };
      warnings = grounding.warnings;
      generatedBy = "ai";
      model = result.model;
      promptVersion = FOLLOW_UP_PROMPT_VERSION;
    } catch (err) {
      if (!(err instanceof AiUnavailableError || err instanceof AiInvalidOutputError)) throw err;
      content = templateFollowUp(opportunity, application, name);
      warnings = ["Model unavailable or invalid; template follow-up produced instead."];
    }
  } else {
    content = templateFollowUp(opportunity, application, name);
  }
  const version = (deps.repos.drafts.latest(application.id, "FOLLOW_UP_EMAIL")?.version ?? 0) + 1;
  const draft = deps.repos.drafts.insert({
    id: newId(),
    applicationId: application.id,
    opportunityId,
    resumeId: resume?.id ?? null,
    kind: "FOLLOW_UP_EMAIL",
    version,
    content,
    groundingWarnings: warnings,
    generatedBy,
    provider: generatedBy === "ai" ? deps.ai.id : null,
    model,
    promptVersion,
    createdAt: deps.now(),
    editedAt: null,
  });
  const pending = deps.repos.followUps.listByOpportunity(opportunityId).find((t) => t.status === "PENDING");
  if (pending) deps.repos.followUps.update(pending.id, { draftId: draft.id });
  recordAudit(deps.repos, deps.now, "draft", draft.id, "follow_up_draft.generated", { opportunityId, version, generatedBy, model }, actor);
  return draft;
}

function templateFollowUp(opportunity: Opportunity, application: Application, name: string | null): FollowUpEmailDraft {
  const date = application.appliedAt ? application.appliedAt.slice(0, 10) : "recently";
  return {
    subject: `Following up on my ${opportunity.title} application`,
    body: `Hello ${opportunity.companyName} hiring team,\n\nI applied for the ${opportunity.title} position on ${date}${application.confirmationReference ? ` (reference ${application.confirmationReference})` : ""} and wanted to follow up. I remain very interested in the role and would be glad to provide anything further that would help your review.\n\nThank you for your time,\n${name ?? "[Your name]"}`,
    evidence: [],
  };
}
