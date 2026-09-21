-- VoiceCare prototype schema (PostgreSQL, hosted on Neon).
-- Implements the entities and invariants in spec/05-data-and-architecture.md.
-- Identifiers are text with an application-generated prefix (for example patient_123, sess_abc123).
-- Apply with: psql "$DATABASE_URL_UNPOOLED" -f db/schema.sql

-- Anonymous browser sessions isolate judges without registration or login. The browser holds the
-- random opaque token; only its SHA-256 (or stronger) hash is stored here.
create table if not exists demo_sessions (
  id             text primary key,
  token_hash     text not null unique,
  expires_at     timestamptz not null,
  invalidated_at timestamptz,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);

create index if not exists demo_sessions_expiry_idx on demo_sessions (expires_at);

create table if not exists caregivers (
  id               text primary key,
  demo_session_id  text not null,
  display_name     text not null,
  timezone         text not null,
  created_at       timestamptz not null default now(),
  constraint caregivers_demo_session_fk foreign key (demo_session_id)
    references demo_sessions (id) on delete restrict
);

-- Upgrade support for a database created from the earlier shared-demo schema. Existing legacy rows
-- may remain null, but the NOT VALID check still requires every new caregiver to have a session.
alter table caregivers add column if not exists demo_session_id text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'caregivers_demo_session_fk' and conrelid = 'caregivers'::regclass) then
    alter table caregivers add constraint caregivers_demo_session_fk
      foreign key (demo_session_id) references demo_sessions (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'caregivers_demo_session_required' and conrelid = 'caregivers'::regclass) then
    alter table caregivers add constraint caregivers_demo_session_required
      check (demo_session_id is not null) not valid;
  end if;
end $$;
create unique index if not exists caregivers_demo_session_uidx
  on caregivers (demo_session_id) where demo_session_id is not null;

create table if not exists patients (
  id               text primary key,
  caregiver_id     text not null references caregivers (id) on delete restrict,
  display_name     text not null,
  -- measurement type -> confirmed device unit, for example {"blood_glucose":"mmol/L"}
  preferred_units  jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  unique (id, caregiver_id)
);

create index if not exists patients_caregiver_idx on patients (caregiver_id);
create unique index if not exists patients_owner_uidx on patients (id, caregiver_id);

-- Draft lifecycle (spec/04). Only the backend may set CONFIRMED or SAVED.
-- Status is text plus a check constraint rather than an enum so the prototype can evolve without ALTER TYPE.
create table if not exists drafts (
  id                         text primary key,
  patient_id                 text not null,
  caregiver_id               text not null references caregivers (id) on delete restrict,
  session_id                 text,                 -- AssemblyAI Voice Agent session id, for troubleshooting
  revision                   integer not null default 1,
  status                     text not null default 'CAPTURING' check (status in (
                               'CAPTURING','DRAFT','NEEDS_CLARIFICATION','REVIEWABLE','CORRECTING','CONFIRMED','SAVED')),
  original_transcript        text not null default '',
  observation_time           timestamptz,
  observation_time_precision text check (observation_time_precision is null or observation_time_precision in (
                               'exact','morning','afternoon','evening','day','period','assumed','unknown')),
  observation_time_source    text,                 -- the caregiver's original phrase, for example "this morning"
  entry_time                 timestamptz not null default now(),
  measurements               jsonb not null default '[]'::jsonb,
  observations               jsonb not null default '[]'::jsonb,
  unresolved_issues          jsonb not null default '[]'::jsonb,
  -- Clarification audit: every question the agent or the backend asked, with the caregiver's answer
  -- when one was given. The open questions also live in unresolved_issues; this list is the trail.
  clarification_log          jsonb not null default '[]'::jsonb,
  -- Confirmation is stored on the draft and bound to the current revision; the save path copies the
  -- confirmed snapshot into reports, so the draft never needs an interactive transaction.
  confirmed_revision         integer,
  confirmation_method        text check (confirmation_method is null or confirmation_method in ('button','voice')),
  confirmed_at               timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint drafts_confirmation_shape check (
    (confirmation_method is null and confirmed_at is null and confirmed_revision is null)
    or (confirmation_method is not null and confirmed_at is not null and confirmed_revision is not null)
  ),
  -- A confirmation is bound to the revision the caregiver actually heard and saw (spec/06), so bumping
  -- the revision without clearing the confirmation fails instead of drifting out of sync.
  constraint drafts_confirmed_revision_current check (confirmed_revision is null or confirmed_revision = revision),
  -- The patient must belong to the same caregiver as the draft. This is defense in depth for the
  -- server-side demo-session checks.
  constraint drafts_patient_owner_fk foreign key (patient_id, caregiver_id)
    references patients (id, caregiver_id) on delete restrict,
  constraint drafts_owner_unique unique (id, patient_id, caregiver_id)
);

create unique index if not exists drafts_owner_uidx on drafts (id, patient_id, caregiver_id);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'drafts_patient_owner_fk' and conrelid = 'drafts'::regclass) then
    alter table drafts add constraint drafts_patient_owner_fk
      foreign key (patient_id, caregiver_id) references patients (id, caregiver_id) on delete restrict;
  end if;
end $$;

-- One live draft per voice session, so a reconnect resumes instead of duplicating.
create unique index if not exists drafts_session_idx on drafts (session_id) where session_id is not null;
create index if not exists drafts_patient_status_idx on drafts (patient_id, status);

-- Upgrade support for databases created before the clarification audit existed.
alter table drafts add column if not exists clarification_log jsonb not null default '[]'::jsonb;

-- Revision trail for the correction flow (spec/02): one row per draft-changing event.
create table if not exists draft_revisions (
  id          text primary key,
  draft_id    text not null references drafts (id) on delete cascade,
  revision    integer not null,
  status      text not null,
  snapshot    jsonb not null,
  reason      text not null,   -- agent_update | clarification_answer | caregiver_correction | confirmation | post_review_correction
  created_at  timestamptz not null default now(),
  unique (draft_id, revision)
);

-- Confirmed reports: immutable snapshot of one confirmed draft revision (spec/05).
create table if not exists reports (
  id                         text primary key,
  draft_id                   text not null,
  confirmed_revision         integer not null,
  confirmation_method        text not null check (confirmation_method in ('button','voice')),
  confirmed_at               timestamptz not null,
  idempotency_key            text not null,
  content_hash               text not null,
  patient_id                 text not null,
  caregiver_id               text not null references caregivers (id) on delete restrict,
  observation_time           timestamptz,
  observation_time_precision text,
  observation_time_source    text,
  entry_time                 timestamptz not null,
  original_transcript        text not null,
  measurements               jsonb not null,
  observations               jsonb not null,
  saved_at                   timestamptz not null default now(),
  -- A report references exactly one confirmed revision, and a repeated save cannot duplicate it (FR-044).
  unique (draft_id, confirmed_revision),
  unique (idempotency_key),
  unique (id, draft_id),
  -- The report, draft, patient, and caregiver must all describe the same owned record.
  constraint reports_draft_owner_fk foreign key (draft_id, patient_id, caregiver_id)
    references drafts (id, patient_id, caregiver_id) on delete restrict,
  -- A saved report must correspond to a revision that was actually logged for this draft.
  foreign key (draft_id, confirmed_revision) references draft_revisions (draft_id, revision)
);

-- Upgrade support: old confirmed reports remain readable. New reports must provide the hash used to
-- detect reuse of one idempotency key with different content.
alter table reports add column if not exists content_hash text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reports_content_hash_required' and conrelid = 'reports'::regclass) then
    alter table reports add constraint reports_content_hash_required
      check (content_hash is not null) not valid;
  end if;
end $$;
create unique index if not exists reports_id_draft_uidx on reports (id, draft_id);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reports_draft_owner_fk' and conrelid = 'reports'::regclass) then
    alter table reports add constraint reports_draft_owner_fk
      foreign key (draft_id, patient_id, caregiver_id)
      references drafts (id, patient_id, caregiver_id) on delete restrict;
  end if;
end $$;

create index if not exists reports_patient_observation_idx on reports (patient_id, observation_time desc);
create index if not exists reports_caregiver_idx on reports (caregiver_id);

-- The current report for a draft. Saving a later confirmed revision moves this pointer, so the earlier
-- report stays in place as the superseded record and history never shows one observation twice.
-- Write path is one non-interactive batched transaction, in this order:
--   1. insert into reports ... on conflict (idempotency_key) do nothing   -- snapshot plus content hash
--   2. update drafts set status = 'SAVED', current_report_id = <new report id> where id = <draft id>
-- If the key already exists, the backend compares content_hash: equal returns the existing report;
-- different content returns 409 Conflict. The composite foreign key prevents a draft from pointing
-- at another draft's report.
alter table drafts add column if not exists current_report_id text;
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'drafts_current_report_same_draft_fk'
      and conrelid = 'drafts'::regclass
  ) then
    alter table drafts add constraint drafts_current_report_same_draft_fk
      foreign key (current_report_id, id) references reports (id, draft_id);
  end if;
end $$;
create index if not exists drafts_current_report_idx on drafts (current_report_id);

-- The confirmed snapshot is append-only.
create or replace function reports_immutable() returns trigger as $$
begin
  raise exception 'confirmed reports cannot be deleted or edited; save a new revision instead';
end $$ language plpgsql;

drop trigger if exists reports_no_change on reports;
create trigger reports_no_change before update or delete on reports
  for each row execute function reports_immutable();

-- Personal expressions: stored only after separate, explicit permission to remember (FR-050).
create table if not exists personal_expressions (
  id                  text primary key,
  caregiver_id        text not null references caregivers (id) on delete restrict,
  patient_id          text,   -- null means caregiver-wide
  phrase              text not null,
  -- for example {"measurement_type":"heart_rate","unit":"bpm"}
  normalized_meaning  jsonb not null,
  context_constraints jsonb not null default '{}'::jsonb,
  confirmed_at        timestamptz not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  constraint personal_expressions_patient_owner_fk foreign key (patient_id, caregiver_id)
    references patients (id, caregiver_id) on delete restrict
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'personal_expressions_patient_owner_fk'
      and conrelid = 'personal_expressions'::regclass
  ) then
    alter table personal_expressions add constraint personal_expressions_patient_owner_fk
      foreign key (patient_id, caregiver_id) references patients (id, caregiver_id) on delete restrict;
  end if;
end $$;

create unique index if not exists personal_expressions_active_idx
  on personal_expressions (caregiver_id, coalesce(patient_id, ''), lower(phrase))
  where deleted_at is null;

-- No shared caregiver or patient is seeded. GET /api/bootstrap creates one demo session, fictional
-- caregiver, and fictional patient in a transaction for each new browser.
