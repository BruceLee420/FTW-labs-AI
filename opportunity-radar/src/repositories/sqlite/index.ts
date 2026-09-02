/**
 * Wires every SQLite repository to one database handle.
 *
 * Why: services receive a single `Repositories` object through AppDeps and
 * never see node:sqlite. `transaction` uses the client's BEGIN/COMMIT helper
 * for the outermost call and SAVEPOINTs for nested calls, so a service can
 * compose smaller transactional helpers without "cannot start a transaction
 * within a transaction" errors — a throw anywhere still rolls back cleanly.
 * `now` is injectable for deterministic tests (defaults to the wall clock).
 */
import type { Db } from "../../db/client.ts";
import { transaction } from "../../db/client.ts";
import type { Repositories } from "../interfaces.ts";
import { nowIso } from "../../utils/time.ts";
import { createOpportunityRepository } from "./opportunities.ts";
import { createSourceRepository } from "./sources.ts";
import { createEvaluationRepository } from "./evaluations.ts";
import { createResumeRepository } from "./resumes.ts";
import { createApplicationRepository } from "./applications.ts";
import { createDraftRepository } from "./drafts.ts";
import { createFollowUpRepository } from "./followUps.ts";
import { createSyncRunRepository } from "./syncRuns.ts";
import { createAuditRepository } from "./audit.ts";
import { createSettingsRepository } from "./settings.ts";

export interface SqliteRepositoryOptions {
  /** Clock used for `updated_at` stamps; defaults to `nowIso`. */
  now?: () => string;
}

export function createSqliteRepositories(db: Db, options: SqliteRepositoryOptions = {}): Repositories {
  const now = options.now ?? nowIso;
  let depth = 0;

  const runTransaction = <T>(fn: () => T): T => {
    if (depth === 0) {
      depth = 1;
      try {
        return transaction(db, fn);
      } finally {
        depth = 0;
      }
    }
    const savepoint = `radar_sp_${depth}`;
    depth += 1;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const out = fn();
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return out;
    } catch (err) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw err;
    } finally {
      depth -= 1;
    }
  };

  return {
    opportunities: createOpportunityRepository(db, now),
    sources: createSourceRepository(db),
    evaluations: createEvaluationRepository(db),
    resumes: createResumeRepository(db, now),
    applications: createApplicationRepository(db, now),
    drafts: createDraftRepository(db),
    followUps: createFollowUpRepository(db, now),
    syncRuns: createSyncRunRepository(db),
    audit: createAuditRepository(db),
    settings: createSettingsRepository(db, now),
    transaction: runTransaction,
  };
}
