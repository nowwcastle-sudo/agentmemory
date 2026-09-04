export const SUMMARY_SYSTEM = `You are a session summarizer for an AI coding agent's memory system. Given all compressed observations from a coding session, produce a concise session summary.

Output EXACTLY this XML format with no additional text:

<summary>
  <title>Short session title (max 100 chars)</title>
  <narrative>3-5 sentence narrative of what was accomplished</narrative>
  <decisions>
    <decision>Key technical decision made</decision>
  </decisions>
  <files>
    <file>path/to/modified/file</file>
  </files>
  <concepts>
    <concept>key concept from session</concept>
  </concepts>
</summary>

Rules:
- Focus on outcomes, not individual tool calls
- Highlight decisions and their rationale
- List all files that were created or modified
- Concepts should be searchable terms for future context retrieval`

export function buildSummaryPrompt(observations: Array<{
  type: string
  title: string
  facts: string[]
  narrative: string
  files: string[]
  concepts: string[]
}>): string {
  const lines = observations.map((obs, i) => {
    const facts = obs.facts.map((f) => `  - ${f}`).join('\n')
    return `[${i + 1}] ${obs.type}: ${obs.title}\n${obs.narrative}\nFacts:\n${facts}\nFiles: ${obs.files.join(', ')}`
  })
  return `Session observations (${observations.length} total):\n\n${lines.join('\n\n---\n\n')}`
}

export interface BoundedSummaryInput {
  previous?: {
    title: string
    narrative: string
    keyDecisions: string[]
    filesModified: string[]
    concepts: string[]
  }
  observations: Array<{
    id: string
    timestamp: string
    type: string
    title: string
    facts: string[]
    narrative: string
    files: string[]
    concepts: string[]
  }>
  delta: Array<{
    id: string
    timestamp: string
    type: string
    title: string
    facts: string[]
    narrative: string
    files: string[]
    concepts: string[]
  }>
  mode: 'initial' | 'incremental' | 'rebuild'
}

const BOUNDED_SUMMARY_PROMPT_LIMIT = 24_000
const BOUNDED_SUMMARY_EXCERPTS = 40
const HIGH_SIGNAL_TYPES = new Set([
  'error',
  'conversation',
  'subagent',
  'file_write',
  'file_edit',
])

function clipped(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

function selectSummaryExcerpts(
  observations: BoundedSummaryInput['delta'],
): BoundedSummaryInput['delta'] {
  const ordered = [...observations].sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
  )
  if (ordered.length <= BOUNDED_SUMMARY_EXCERPTS) return ordered

  const selected = new Map<string, (typeof ordered)[number]>()
  selected.set(ordered[0].id, ordered[0])
  selected.set(ordered[ordered.length - 1].id, ordered[ordered.length - 1])
  for (const observation of ordered) {
    if (HIGH_SIGNAL_TYPES.has(observation.type)) {
      selected.set(observation.id, observation)
    }
    if (selected.size >= BOUNDED_SUMMARY_EXCERPTS) break
  }
  for (const observation of ordered) {
    if (selected.size >= BOUNDED_SUMMARY_EXCERPTS) break
    selected.set(observation.id, observation)
  }
  return [...selected.values()].sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
  )
}

export function buildBoundedIncrementalSummaryPrompt(
  input: BoundedSummaryInput,
): string {
  const excerpts = selectSummaryExcerpts(input.delta)
  const files = [...new Set(input.observations.flatMap((observation) => observation.files))]
    .sort()
    .slice(0, 200)
  const typeCounts = [...input.observations.reduce((counts, observation) => {
    counts.set(observation.type, (counts.get(observation.type) ?? 0) + 1)
    return counts
  }, new Map<string, number>())]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type}=${count}`)
    .join(', ')
  const previous = input.previous
    ? `Title: ${clipped(input.previous.title, 160)}
Narrative: ${clipped(input.previous.narrative, 1_200)}
Decisions: ${input.previous.keyDecisions.slice(0, 20).map((item) => clipped(item, 240)).join(' | ')}
Files: ${input.previous.filesModified.slice(0, 100).map((item) => clipped(item, 180)).join(', ')}
Concepts: ${input.previous.concepts.slice(0, 100).map((item) => clipped(item, 100)).join(', ')}`
    : '(none)'
  const excerptText = excerpts.map((observation, index) => {
    const facts = observation.facts.slice(0, 3).map((fact) => clipped(fact, 160)).join(' | ')
    return `[${index + 1}] ${observation.type}: ${clipped(observation.title, 160)}
ID: ${observation.id}
Narrative: ${clipped(observation.narrative, 240)}
Facts: ${facts}
Files: ${observation.files.slice(0, 10).map((file) => clipped(file, 180)).join(', ')}
Concepts: ${observation.concepts.slice(0, 10).map((concept) => clipped(concept, 100)).join(', ')}`
  }).join('\n\n---\n\n')
  const prompt = `Mode: ${input.mode}
Session observations (${input.observations.length} total)
Delta observations: ${input.delta.length}
Observation types: ${typeCounts || '(none)'}
Unique files (${files.length}${files.length === 200 ? '+' : ''}): ${files.map((file) => clipped(file, 180)).join(', ')}

Previous successful summary:
${previous}

Selected delta observations (${excerpts.length} shown):
${excerptText || '(none)'}

Omitted observations: ${Math.max(0, input.delta.length - excerpts.length)}`
  if (prompt.length <= BOUNDED_SUMMARY_PROMPT_LIMIT) return prompt
  const suffix = '\n[Prompt truncated to 24000 characters]'
  return `${prompt.slice(0, BOUNDED_SUMMARY_PROMPT_LIMIT - suffix.length)}${suffix}`
}

export const REDUCE_SYSTEM = `You are merging multiple partial summaries of the SAME coding session into one final session summary. The partials are chronological chunks of one continuous session — not separate sessions.

Output EXACTLY this XML format with no additional text:

<summary>
  <title>Short session title (max 100 chars)</title>
  <narrative>3-5 sentence narrative covering the whole session</narrative>
  <decisions>
    <decision>Key technical decision made</decision>
  </decisions>
  <files>
    <file>path/to/modified/file</file>
  </files>
  <concepts>
    <concept>key concept from session</concept>
  </concepts>
</summary>

Rules:
- Synthesize a single narrative that reflects the whole arc, not a chunk-by-chunk recap
- Preserve every distinct decision across chunks
- Union (deduplicate) all files and concepts
- Title should capture the session's overall outcome`

export function buildReducePrompt(partials: Array<{
  title: string
  narrative: string
  keyDecisions: string[]
  filesModified: string[]
  concepts: string[]
  obsRangeStart: number
  obsRangeEnd: number
}>): string {
  const sections = partials.map((p, i) => {
    const decisions = p.keyDecisions.map((d) => `  - ${d}`).join('\n')
    const files = p.filesModified.map((f) => `  - ${f}`).join('\n')
    const concepts = p.concepts.join(', ')
    return `[Chunk ${i + 1} of ${partials.length} — obs ${p.obsRangeStart}-${p.obsRangeEnd}]
Title: ${p.title}
Narrative: ${p.narrative}
Decisions:
${decisions}
Files:
${files}
Concepts: ${concepts}`
  })
  return `Partial summaries (${partials.length} chunks of one session, chronological):\n\n${sections.join('\n\n---\n\n')}`
}
