# Segment 6: Safety, Privacy, and Reliability

## Product boundary

VoiceCare records caregiver-reported information. It does not verify medical truth, diagnose a condition, recommend treatment, or replace professional care.

The interface and exported summary shall use language such as:

> Caregiver-reported observations. Review before making medical decisions.

## Urgent statements

The hackathon prototype does not attempt clinical triage. If the caregiver describes an emergency or asks for urgent medical advice, the agent should state that it cannot assess emergencies and direct the user to local emergency services or an appropriate healthcare professional. The report may still capture the caregiver's wording if they continue.

## Confirmation safeguards

- Only a backend-confirmed revision can be saved.
- Confirmation is explicit and bound to the displayed and spoken revision.
- Every change produces a new revision.
- Unresolved required fields prevent confirmation.
- Retries use idempotency protection.
- A disconnect before saving leaves, at most, an unconfirmed draft.

### Correction and deletion of saved reports

- Saved reports are append-only. No application path edits or deletes one.
- A correction is expressed as a new revision and a new report that becomes current; the earlier report is retained as the
  superseded record so the change stays auditable.
- Deleting a patient or a draft that has a saved report fails by design.
- The hackathon does not implement individual report deletion because it accepts fictional information only. Production deletion
  and retention behavior must be designed before any use with real patient information.

## Data minimization

- Demonstrations and formal tests use fictional patient information.
- The unattended hosted demo is not intended for real patient information and says so on the interface.
- The prototype collects only the patient label and settings needed for the workflow.
- Original audio is not copied into the VoiceCare database unless a later requirement explicitly justifies it.
- Logs exclude transcripts, measurements, personal expressions, and access tokens by default.

## AssemblyAI session data

Voice Agent sessions may include recordings and conversation timelines. Before any use with real patient information, the team must document:

- Whether session recording can be disabled for the chosen integration.
- How long session artifacts remain available.
- Who can retrieve or delete them.
- Which region processes and stores the data.
- The deletion workflow for test and user-requested removal.
- Whether the service terms and account configuration fit the intended health-data use.

## Access and secrets

- API keys remain on the server.
- Temporary client tokens have a short redemption window and limited session duration.
- Registration and login are not part of the hackathon build.
- The backend issues a random anonymous-session token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie and stores only its hash.
- Every patient, draft, report, summary, and expression query is scoped to the caregiver resolved from that cookie.
- Caregiver or session identifiers supplied by the browser or voice agent never establish ownership.
- Printable summaries are generated on demand and are not publicly addressable.
- Development and production credentials are separated.

## Demo retention and reset

- A demo session and its fictional records may expire 72 hours after creation or last use.
- **Reset demo** abandons the current fictional workspace and issues a new isolated session; the new session cannot access the old data.
- Expired sessions become inaccessible. The team may purge the entire fictional demo environment after the judging period.
- Personal expressions and unconfirmed drafts expire with the demo session.
- The production retention, legal deletion, backup erasure, and account-recovery policies are explicitly deferred because the
  prototype neither accepts real patient data nor provides registered accounts.

## Failure handling

### Connection loss

- Stop accepting audio.
- Inform the user that the session was interrupted.
- Preserve the latest server-side draft when possible.
- Never mark the report confirmed or saved because of the disconnect.
- Offer recovery or discard after reconnection.

### Microphone unavailable

- Explain how to grant microphone permission and offer a retry.
- Provide a typed-observation fallback that enters the same validation and confirmation flow.
- Do not claim that audio is being captured when permission or browser support is absent.

### Tool-call failure

- Keep the draft unchanged.
- Tell the agent that the update failed.
- Allow a safe retry with the same operation identifier.
- Surface a manual correction path.

### Save uncertainty

If the client does not receive a save response, it retries using the same idempotency key and retrieves the resulting report before offering another save action.

### Stale update

If the expected draft revision no longer matches, the backend changes nothing, returns `409 Conflict` with the latest draft, and
asks the client to reload before the caregiver continues.

### Unsupported speech or fields

The agent preserves the statement as a free-text observation and explains when it cannot structure a field. It must not invent the nearest supported category.

## Prototype limitation statement

The demo shall state that it is an experimental prototype evaluated on a limited fictional dataset. Passing prototype tests does not establish clinical reliability or suitability for real patient care.

## Deferred production concerns

Registered accounts, real patient information, formal healthcare compliance, enterprise access roles, breach response, legal
retention, backup-erasure guarantees, and disaster-recovery objectives are not part of the hackathon build. They must be designed
before the product boundary changes beyond an anonymous fictional-data demonstration.
