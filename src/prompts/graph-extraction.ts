import { NODE_TYPES, EDGE_TYPES } from "../functions/graph-schema.js";

// The type lists come from the closed vocabulary in graph-schema.ts so the prompt and the
// persist seam can never disagree about what is allowed.
export const GRAPH_EXTRACTION_SYSTEM = `You are a knowledge graph extraction engine. Given a compressed observation from a coding session, extract entities and relationships.

Output format (XML):
<entities>
  <entity type="${[...NODE_TYPES].join("|")}" name="exact name">
    <property key="key">value</property>
  </entity>
</entities>
<relationships>
  <relationship type="${[...EDGE_TYPES].join("|")}" source="entity name" target="entity name" weight="0.1-1.0"/>
</relationships>

Rules:
- Extract concrete entities only (real file paths, function names, library names)
- Use the most specific type available
- Only these types are valid; anything else is discarded. modifies/imports must target a file or function; fixes must target an error, file or function
- Weight relationships by how strong/direct the connection is
- If no entities found, output empty tags`;

export function buildGraphExtractionPrompt(
  observations: Array<{
    title: string;
    narrative: string;
    concepts: string[];
    files: string[];
    type: string;
  }>,
): string {
  const items = observations
    .map(
      (o, i) =>
        `[${i + 1}] Type: ${o.type}\nTitle: ${o.title}\nNarrative: ${o.narrative}\nConcepts: ${(o.concepts ?? []).join(", ")}\nFiles: ${(o.files ?? []).join(", ")}`,
    )
    .join("\n\n");
  // Some local models default to a hidden reasoning pass that consumes
  // most of the token budget before any output. The suffix is their
  // documented soft switch to skip it; other models ignore the token.
  const noThink = process.env.AGENTMEMORY_LLM_NOTHINK === "1" ? "\n/no_think" : "";
  return `Extract entities and relationships from these observations:\n\n${items}${noThink}`;
}
