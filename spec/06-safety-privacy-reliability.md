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

## Data minimization

- Demonstrations and formal tests use fictional patient information.
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
- Every patient and report query is scoped to the authenticated caregiver.
- Printable summaries are generated on demand and are not publicly addressable.
- Development and production credentials are separated.

## Failure handling

### Connection loss

- Stop accepting audio.
- Inform the user that the session was interrupted.
- Preserve the latest server-side draft when possible.
- Never mark the report confirmed or saved because of the disconnect.
- Offer recovery or discard after reconnection.

### Tool-call failure

- Keep the draft unchanged.
- Tell the agent that the update failed.
- Allow a safe retry with the same operation identifier.
- Surface a manual correction path.

### Save uncertainty

If the client does not receive a save response, it retries using the same idempotency key and retrieves the resulting report before offering another save action.

### Unsupported speech or fields

The agent preserves the statement as a free-text observation and explains when it cannot structure a field. It must not invent the nearest supported category.

## Prototype limitation statement

The demo shall state that it is an experimental prototype evaluated on a limited fictional dataset. Passing prototype tests does not establish clinical reliability or suitability for real patient care.

