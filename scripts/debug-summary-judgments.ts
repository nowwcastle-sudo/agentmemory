// Debug aid: send one session's summary through the production judgment
// prompt the way the OpenAI provider does, and print the raw response and
// what the filters keep. Run with: npx tsx scripts/debug-summary-judgments.ts <sessionId>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JUDGMENT_EXTRACTION_SYSTEM, buildJudgmentExtractionPrompt } from "../src/prompts/judgment-extraction.js";
import { buildSummaryJudgmentDelta } from "../src/functions/summary-judgments.js";

const env = readFileSync(join(homedir(), ".agentmemory", ".env"), "utf8");
const pick = (k: string) => env.match(new RegExp(`^${k}=([^#\\r\\n]*)`, "m"))?.[1].trim() ?? "";
const H = { Authorization: `Bearer ${pick("AGENTMEMORY_SECRET")}`, "Content-Type": "application/json" };
const sessionId = process.argv[2];

const sessions = (await (await fetch("http://127.0.0.1:5611/agentmemory/sessions?agentId=*", { headers: H })).json()).sessions;
const session = sessions.find((s: { id: string }) => s.id === sessionId);
if (!session?.summary) throw new Error("no summary for that session");
const summary = session.summary;
console.log("decisions:", summary.keyDecisions.length);
summary.keyDecisions.forEach((d: string, i: number) => console.log(`  ${i + 1}. ${d.slice(0, 110)}`));

const res = await fetch(`${pick("OPENAI_BASE_URL")}/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${pick("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: pick("OPENAI_MODEL") || "auto:reliable",
    max_tokens: Number(pick("MAX_TOKENS") || 4096),
    stream: false,
    messages: [
      { role: "system", content: JUDGMENT_EXTRACTION_SYSTEM },
      { role: "user", content: buildJudgmentExtractionPrompt(summary.title, summary.keyDecisions) },
    ],
  }),
});
const body = await res.json();
const xml = body.choices?.[0]?.message?.content ?? "";
console.log("\n--- raw response (first 1500 chars)\n" + xml.slice(0, 1500));
const { edges, dropped } = buildSummaryJudgmentDelta(summary, session, xml);
console.log("\nkept", edges.length, "dropped", JSON.stringify(dropped));
