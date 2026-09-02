/**
 * Human-approved application workflow.
 *
 * The one hard gate lives here: `markApplied` refuses unless the application
 * was explicitly approved. Nothing in this file (or anywhere else) submits an
 * application, uploads a file, or sends a message; it records what the user
 * did outside the system and schedules reminders.
 */
import type { AppDeps } from "../deps.ts";
import type { Application, FollowUpTask, Opportunity } from "../types/entities.ts";
import type { z } from "zod";
import type {
  ApproveInputSchema,
  CompleteFollowUpInputSchema,
  MarkAppliedInputSchema,
  ScheduleFollowUpInputSchema,
} from "../schemas/application.ts";
import { conflict, notFound, unprocessable } from "../utils/errors.ts";
import { newId } from "../utils/ids.ts";
import { addDays, isPastOrNow } from "../utils/time.ts";
import { recordAudit } from "./audit.ts";

type Deps = Pick<AppDeps, "repos" | "now" | "config">;

export function requireOpportunity(deps: Pick<AppDeps, "repos">, id: string): Opportunity {
  const o = deps.repos.opportunities.findById(id);
  if (!o) throw notFound("No such opportunity.");
  return o;
}

export function getOrCreateApplication(deps: Deps, opportunityId: string, resumeId: string | null = null): Application {
  const existing = deps.repos.applications.findByOpportunity(opportunityId);
  if (existing) return existing;
  const now = deps.now();
  const created = deps.repos.applications.insert({
    id: newId(),
    opportunityId,
    resumeId,
    status: "DRAFTING",
    currentDraftVersion: 0,
    approvedAt: null,
    approvedDraftVersion: null,
    appliedAt: null,
    confirmationReference: null,
    followUpDueAt: null,
    followUpSentAt: null,
    notes: "",
    createdAt: now,
    updatedAt: now,
  });
  recordAudit(deps.repos, deps.now, "application", created.id, "application.created", { opportunityId });
  return created;
}

/** Effective default follow-up interval: settings override, then env/config. */
export function defaultFollowUpDays(deps: Deps): number {
  const override = deps.repos.settings.get<number>("followUpDays");
  return typeof override === "number" && override >= 0 ? override : deps.config.followUpDays;
}

export const APPLICATION_CHECKLIST = [
  "Open the official application page below and confirm the domain matches the employer.",
  "Attach the résumé you approved (check the file name and date).",
  "Paste the approved summary, cover letter and answers; re-read them once more on the form.",
  "Never pay a fee, buy equipment, or share ID/bank details to apply.",
  "After submitting, come back and record the date and any confirmation reference.",
];

export function approveApplication(
  deps: Deps,
  opportunityId: string,
  input: z.infer<typeof ApproveInputSchema>,
): { application: Application; opportunity: Opportunity; checklist: string[]; applicationUrl: string | null } {
  const opportunity = requireOpportunity(deps, opportunityId);
  const application = getOrCreateApplication(deps, opportunityId, input.resumeId ?? opportunity.recommendedResumeId);
  let approvedVersion: number | null = null;
  if (input.draftVersion !== undefined) {
    const draft = deps.repos.drafts.findVersion(application.id, "APPLICATION_PACKAGE", input.draftVersion);
    if (!draft) throw unprocessable("That draft version does not exist.");
    approvedVersion = draft.version;
  } else {
    approvedVersion = deps.repos.drafts.latest(application.id, "APPLICATION_PACKAGE")?.version ?? null;
  }
  const resumeId = input.resumeId ?? application.resumeId ?? opportunity.recommendedResumeId;
  if (resumeId && !deps.repos.resumes.findById(resumeId)) throw unprocessable("That résumé profile does not exist.");
  const now = deps.now();
  const updated = deps.repos.applications.update(application.id, {
    status: "APPROVED",
    approvedAt: now,
    approvedDraftVersion: approvedVersion,
    resumeId,
  })!;
  const updatedOpportunity = deps.repos.opportunities.update(opportunityId, {
    status: "READY_TO_APPLY",
    nextAction: "Submit on the official application page, then record it here.",
    recommendedResumeId: resumeId ?? opportunity.recommendedResumeId,
  })!;
  recordAudit(deps.repos, deps.now, "application", application.id, "application.approved", {
    opportunityId,
    draftVersion: approvedVersion,
    resumeId,
  });
  recordAudit(deps.repos, deps.now, "opportunity", opportunityId, "status.changed", { from: opportunity.status, to: "READY_TO_APPLY" });
  return { application: updated, opportunity: updatedOpportunity, checklist: APPLICATION_CHECKLIST, applicationUrl: opportunity.applicationUrl ?? opportunity.sourceUrl };
}

export function markApplied(
  deps: Deps,
  opportunityId: string,
  input: z.infer<typeof MarkAppliedInputSchema>,
): { application: Application; opportunity: Opportunity; followUp: FollowUpTask } {
  const opportunity = requireOpportunity(deps, opportunityId);
  const application = deps.repos.applications.findByOpportunity(opportunityId);
  if (!application || application.status !== "APPROVED") {
    throw conflict("Approve the application first. Opportunity Radar records submissions you made yourself, after explicit approval.");
  }
  const appliedAt = input.appliedAt ?? deps.now();
  const days = input.followUpDays ?? defaultFollowUpDays(deps);
  const followUpDueAt = addDays(appliedAt, days);
  const updated = deps.repos.applications.update(application.id, {
    status: "SUBMITTED",
    appliedAt,
    confirmationReference: input.confirmationReference ?? null,
    followUpDueAt,
    notes: input.notes ? appendNote(application.notes, input.notes) : application.notes,
  })!;
  const followUp = upsertPendingFollowUp(deps, opportunityId, application.id, followUpDueAt, "Follow up on your application.");
  const updatedOpportunity = deps.repos.opportunities.update(opportunityId, {
    status: "APPLIED",
    followUpDueAt,
    nextAction: `Follow up on ${followUpDueAt.slice(0, 10)} if you have not heard back.`,
  })!;
  recordAudit(deps.repos, deps.now, "application", application.id, "application.submitted_by_user", {
    opportunityId,
    appliedAt,
    confirmationReference: input.confirmationReference ?? null,
    followUpDueAt,
  });
  recordAudit(deps.repos, deps.now, "opportunity", opportunityId, "status.changed", { from: opportunity.status, to: "APPLIED" });
  return { application: updated, opportunity: updatedOpportunity, followUp };
}

function upsertPendingFollowUp(deps: Deps, opportunityId: string, applicationId: string, dueAt: string, note: string): FollowUpTask {
  const pending = deps.repos.followUps.listByOpportunity(opportunityId).find((t) => t.status === "PENDING");
  const now = deps.now();
  if (pending) {
    const updated = deps.repos.followUps.update(pending.id, { dueAt, note: note || pending.note })!;
    recordAudit(deps.repos, deps.now, "follow_up", pending.id, "follow_up.rescheduled", { opportunityId, dueAt });
    return updated;
  }
  const task = deps.repos.followUps.insert({
    id: newId(),
    opportunityId,
    applicationId,
    dueAt,
    status: "PENDING",
    note,
    draftId: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  recordAudit(deps.repos, deps.now, "follow_up", task.id, "follow_up.scheduled", { opportunityId, dueAt });
  return task;
}

export function scheduleFollowUp(
  deps: Deps,
  opportunityId: string,
  input: z.infer<typeof ScheduleFollowUpInputSchema>,
): { followUp: FollowUpTask; application: Application; opportunity: Opportunity } {
  const opportunity = requireOpportunity(deps, opportunityId);
  const application = getOrCreateApplication(deps, opportunityId, opportunity.recommendedResumeId);
  const base = application.appliedAt ?? deps.now();
  const dueAt = input.dueAt ?? addDays(base, input.days ?? defaultFollowUpDays(deps));
  const followUp = upsertPendingFollowUp(deps, opportunityId, application.id, dueAt, input.note ?? "Follow up on your application.");
  const updatedApplication = deps.repos.applications.update(application.id, { followUpDueAt: dueAt })!;
  const isDue = isPastOrNow(dueAt, deps.now());
  const nextStatus = opportunity.status === "APPLIED" && isDue ? "FOLLOW_UP_DUE" : opportunity.status;
  const updatedOpportunity = deps.repos.opportunities.update(opportunityId, {
    followUpDueAt: dueAt,
    status: nextStatus,
    nextAction: `Follow up on ${dueAt.slice(0, 10)}.`,
  })!;
  return { followUp, application: updatedApplication, opportunity: updatedOpportunity };
}

export function completeFollowUp(
  deps: Deps,
  opportunityId: string,
  input: z.infer<typeof CompleteFollowUpInputSchema>,
): { followUp: FollowUpTask | null; application: Application; opportunity: Opportunity } {
  const opportunity = requireOpportunity(deps, opportunityId);
  const application = getOrCreateApplication(deps, opportunityId, opportunity.recommendedResumeId);
  const sentAt = input.sentAt ?? deps.now();
  const pending = deps.repos.followUps.listByOpportunity(opportunityId).find((t) => t.status === "PENDING") ?? null;
  const followUp = pending
    ? deps.repos.followUps.update(pending.id, { status: "DONE", completedAt: sentAt, note: input.note ?? pending.note })
    : null;
  const updatedApplication = deps.repos.applications.update(application.id, { followUpSentAt: sentAt, followUpDueAt: null })!;
  const updatedOpportunity = deps.repos.opportunities.update(opportunityId, {
    status: opportunity.status === "APPLIED" || opportunity.status === "FOLLOW_UP_DUE" ? "FOLLOWED_UP" : opportunity.status,
    followUpDueAt: null,
    nextAction: "Wait for a reply; update the status when you hear back.",
  })!;
  recordAudit(deps.repos, deps.now, "follow_up", pending?.id ?? application.id, "follow_up.completed_by_user", {
    opportunityId,
    sentAt,
    note: input.note ?? null,
  });
  return { followUp, application: updatedApplication, opportunity: updatedOpportunity };
}

/** Promote APPLIED → FOLLOW_UP_DUE once the due date passes. Idempotent. */
export function refreshFollowUpStatuses(deps: Deps): number {
  const now = deps.now();
  let changed = 0;
  for (const o of deps.repos.opportunities.listFollowUpsDue(now)) {
    if (o.status !== "APPLIED") continue;
    deps.repos.opportunities.update(o.id, { status: "FOLLOW_UP_DUE", nextAction: "Follow-up is due — draft and send it yourself." });
    recordAudit(deps.repos, deps.now, "opportunity", o.id, "status.changed", { from: "APPLIED", to: "FOLLOW_UP_DUE", reason: "follow-up due" }, "system");
    changed++;
  }
  return changed;
}

export function appendNote(existing: string, note: string): string {
  return existing ? `${existing}\n${note}` : note;
}
