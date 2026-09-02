-- Opportunity Radar — initial schema.
-- JSON columns hold arrays/objects serialised by the repository layer.

CREATE TABLE IF NOT EXISTS opportunities (
  id                        TEXT PRIMARY KEY,
  source_name               TEXT NOT NULL,
  source_type               TEXT NOT NULL,
  source_url                TEXT,
  canonical_url             TEXT,
  application_url           TEXT,
  external_id               TEXT,

  company_name              TEXT NOT NULL,
  company_name_normalized   TEXT NOT NULL,
  company_domain            TEXT,
  company_website           TEXT,
  official_career_url       TEXT,

  title                     TEXT NOT NULL,
  title_normalized          TEXT NOT NULL,
  employment_type           TEXT NOT NULL DEFAULT 'UNKNOWN',
  work_mode                 TEXT NOT NULL DEFAULT 'UNKNOWN',
  location_text             TEXT,
  geographic_eligibility    TEXT NOT NULL DEFAULT 'UNKNOWN',
  eligible_countries        TEXT NOT NULL DEFAULT '[]',
  timezone_requirements     TEXT,

  raw_description           TEXT NOT NULL DEFAULT '',
  normalized_description    TEXT NOT NULL DEFAULT '',
  description_hash          TEXT NOT NULL,
  responsibilities          TEXT NOT NULL DEFAULT '[]',
  qualifications            TEXT NOT NULL DEFAULT '[]',
  required_skills           TEXT NOT NULL DEFAULT '[]',
  preferred_skills          TEXT NOT NULL DEFAULT '[]',
  compensation              TEXT NOT NULL DEFAULT '{}',

  posted_at                 TEXT,
  discovered_at             TEXT NOT NULL,
  closes_at                 TEXT,

  relevance_score           INTEGER,
  legitimacy_score          INTEGER,
  scam_risk_score           INTEGER,
  remote_eligibility_score  INTEGER,

  verification_status       TEXT NOT NULL DEFAULT 'UNVERIFIED',
  verification_reasons      TEXT NOT NULL DEFAULT '[]',
  scam_signals              TEXT NOT NULL DEFAULT '[]',

  status                    TEXT NOT NULL DEFAULT 'DISCOVERED',
  recommended_resume_id     TEXT,
  match_rationale           TEXT,
  next_action               TEXT,
  follow_up_due_at          TEXT,
  notes                     TEXT NOT NULL DEFAULT '',

  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_opp_canonical ON opportunities (canonical_url);
CREATE INDEX IF NOT EXISTS idx_opp_external ON opportunities (source_name, external_id);
CREATE INDEX IF NOT EXISTS idx_opp_company_title ON opportunities (company_name_normalized, title_normalized);
CREATE INDEX IF NOT EXISTS idx_opp_desc_hash ON opportunities (description_hash);
CREATE INDEX IF NOT EXISTS idx_opp_status ON opportunities (status);
CREATE INDEX IF NOT EXISTS idx_opp_discovered ON opportunities (discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_opp_follow_up ON opportunities (follow_up_due_at);

CREATE TABLE IF NOT EXISTS opportunity_sources (
  id                TEXT PRIMARY KEY,
  opportunity_id    TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  source_name       TEXT NOT NULL,
  source_type       TEXT NOT NULL,
  source_url        TEXT,
  external_id       TEXT,
  seen_at           TEXT NOT NULL,
  description_hash  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sources_opp ON opportunity_sources (opportunity_id, seen_at DESC);

CREATE TABLE IF NOT EXISTS evaluations (
  id                     TEXT PRIMARY KEY,
  opportunity_id         TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  created_at             TEXT NOT NULL,
  prompt_version         TEXT,
  provider               TEXT NOT NULL,
  model                  TEXT,
  ai_status              TEXT NOT NULL,
  ai_error               TEXT,
  rules_json             TEXT NOT NULL,
  ai_json                TEXT,
  candidate_resume_ids   TEXT NOT NULL DEFAULT '[]',
  recommended_resume_id  TEXT,
  match_rationale        TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_opp ON evaluations (opportunity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS resume_profiles (
  id                  TEXT PRIMARY KEY,
  filename            TEXT NOT NULL UNIQUE,
  format              TEXT NOT NULL,
  label               TEXT NOT NULL,
  target_roles        TEXT NOT NULL DEFAULT '[]',
  skills              TEXT NOT NULL DEFAULT '[]',
  industries          TEXT NOT NULL DEFAULT '[]',
  experience_summary  TEXT NOT NULL DEFAULT '',
  education_summary   TEXT NOT NULL DEFAULT '',
  verified_facts      TEXT NOT NULL DEFAULT '[]',
  extracted_text      TEXT NOT NULL DEFAULT '',
  extraction_status   TEXT NOT NULL,
  extraction_quality  INTEGER NOT NULL DEFAULT 0,
  extraction_notes    TEXT NOT NULL DEFAULT '[]',
  content_hash        TEXT NOT NULL,
  file_size           INTEGER NOT NULL DEFAULT 0,
  file_modified_at    TEXT,
  last_indexed_at     TEXT NOT NULL,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id                      TEXT PRIMARY KEY,
  opportunity_id          TEXT NOT NULL UNIQUE REFERENCES opportunities(id) ON DELETE CASCADE,
  resume_id               TEXT,
  status                  TEXT NOT NULL DEFAULT 'DRAFTING',
  current_draft_version   INTEGER NOT NULL DEFAULT 0,
  approved_at             TEXT,
  approved_draft_version  INTEGER,
  applied_at              TEXT,
  confirmation_reference  TEXT,
  follow_up_due_at        TEXT,
  follow_up_sent_at       TEXT,
  notes                   TEXT NOT NULL DEFAULT '',
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_drafts (
  id                  TEXT PRIMARY KEY,
  application_id      TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  opportunity_id      TEXT NOT NULL,
  resume_id           TEXT,
  kind                TEXT NOT NULL,
  version             INTEGER NOT NULL,
  content_json        TEXT NOT NULL,
  grounding_warnings  TEXT NOT NULL DEFAULT '[]',
  generated_by        TEXT NOT NULL,
  provider            TEXT,
  model               TEXT,
  prompt_version      TEXT,
  created_at          TEXT NOT NULL,
  edited_at           TEXT,
  UNIQUE (application_id, kind, version)
);
CREATE INDEX IF NOT EXISTS idx_drafts_app ON application_drafts (application_id, kind, version DESC);

CREATE TABLE IF NOT EXISTS follow_up_tasks (
  id              TEXT PRIMARY KEY,
  opportunity_id  TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  application_id  TEXT,
  due_at          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  note            TEXT NOT NULL DEFAULT '',
  draft_id        TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON follow_up_tasks (status, due_at);

CREATE TABLE IF NOT EXISTS source_sync_runs (
  id           TEXT PRIMARY KEY,
  adapter_id   TEXT NOT NULL,
  source_name  TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,
  fetched      INTEGER NOT NULL DEFAULT 0,
  created      INTEGER NOT NULL DEFAULT 0,
  duplicates   INTEGER NOT NULL DEFAULT 0,
  errors       TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS audit_events (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  event        TEXT NOT NULL,
  detail_json  TEXT NOT NULL DEFAULT '{}',
  actor        TEXT NOT NULL DEFAULT 'user',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events (entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
