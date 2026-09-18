import { NODE_TYPES } from "../functions/graph-schema.js";

// Judgment relations from a session summary's keyDecisions.
//
// The generic extraction prompt reads a summary like any observation, and
// what it returns is mostly structure (`x uses y`). Measured 2026-09-18:
// judgment relations were 357 of 61,506 edges, and a relations-effect spike
// found them to be the one kind that changed an agent's plan. This prompt
// asks for that kind only. Its wording is the second of two spike rounds,
// graded by hand on the same 50 decisions: good 27% -> 60%, bad 38% -> 13%
// (records/core-recovery/work/judgment-extraction-20260918).

export const JUDGMENT_EDGE_TYPES = [
  "prefers",
  "rejected",
  "avoids",
  "blocked_by",
  "optimizes_for",
  "succeeded_by",
] as const;

export const JUDGMENT_EXTRACTION_SYSTEM = `You turn decisions recorded at the end of a coding session into judgment relations for a knowledge graph.

First ask of each decision: would it change what a future session on this project does? A rule, a chosen approach, a turned-down alternative, a standing constraint -- yes. A one-off action or its result (left a file unchanged, created a scratch script, fixed a typo, translated a string, ran tests) -- no: extract nothing for it.

For a decision that passes, extract what was chosen, what was turned down, what stood in the way, and what it aimed at. Relation types and direction (source --type--> target):
- prefers: the topic --prefers--> the option chosen
- rejected: the topic --rejected--> the alternative turned down
- avoids: the topic --avoids--> a harm or practice it stays away from
- blocked_by: a task or step --blocked_by--> what stops it
- optimizes_for: the topic --optimizes_for--> a goal it serves (a good outcome; never a bug, error or accident -- those go to avoids)
- succeeded_by: an old approach --succeeded_by--> the approach that replaced it

Names:
- The source of prefers/rejected/avoids/optimizes_for is the TOPIC the decision is about -- the question it answers, not its answer: "branch sync method", "Python path separator", "project license". Never repeat the chosen option in the topic's name.
- Every other name must be taken from the decision text itself: copy the words as they appear there, in the same language and spelling. Do not translate, abbreviate, or respell.
- Never use option labels (A, B, "option 2", AK, AL, AC2) or generic words ("the plan", "the fix", "the issue").

Output format (XML only):
<entities>
  <entity type="${[...NODE_TYPES].join("|")}" name="exact name"/>
</entities>
<relationships>
  <relationship type="${JUDGMENT_EDGE_TYPES.join("|")}" source="entity name" target="entity name" decision="the number of the decision it came from"/>
</relationships>`;

export function buildJudgmentExtractionPrompt(title: string, decisions: string[]): string {
  const numbered = decisions.map((decision, i) => `${i + 1}. ${decision}`).join("\n");
  const noThink = process.env.AGENTMEMORY_LLM_NOTHINK === "1" ? "\n/no_think" : "";
  return `Session: ${title}\n\nDecisions:\n${numbered}${noThink}`;
}
