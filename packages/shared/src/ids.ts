// Application-generated identifiers. The database stores text ids with a readable prefix
// (spec/05: for example patient_123, sess_abc123) so demo records can be inspected by eye.

export const ID_PREFIXES = {
  demoSession: "sess",
  caregiver: "cg",
  patient: "pat",
  draft: "draft",
  revision: "rev",
  report: "rep",
  expression: "expr",
  measurement: "m",
  observation: "o",
  issue: "iss",
  clarification: "clar",
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

export type IdFactory = (prefix: string) => string;

// Deterministic, dependency-free id generation for tests and for the extractor when it runs in a
// unit test. Production callers pass a factory that uses crypto.randomUUID / randomBytes.
export function sequenceIdFactory(): IdFactory {
  let counter = 0;
  return (prefix: string) => `${prefix}_${(counter += 1).toString(36).padStart(4, "0")}`;
}
