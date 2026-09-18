/**
 * Openings of the side sessions Codex runs for itself: ambient suggestions, the
 * safety filter over them, and the memory-consolidation agent. They are not
 * the owner's work, and a suggestion run's summary reads like a decision that
 * was taken ("Prioritize lossless recovery of worker 3111"), so what they
 * produce stays out of what a session is told: the session window, and the
 * relations extracted from them. 97 of 666 sessions on 2026-09-18.
 */
const HARNESS_SIDE_SESSION_OPENINGS = [
  /^# Overview\s+Generate 0 to 3 hyperpersonalized suggestions/,
  /^You are an expert at upholding safety and compliance standards for Codex/,
  /^## Memory Writing Agent: Phase 2 \(Consolidation\)/,
];

export function isHarnessSideSession(firstPrompt: string | undefined): boolean {
  return !!firstPrompt && HARNESS_SIDE_SESSION_OPENINGS.some((re) => re.test(firstPrompt));
}
