// Builds the CI comment for the M4 run on GrowthBook.
import { existsSync, readFileSync } from 'node:fs'

const target = process.env.TARGET ?? 'target/growthbook/packages/sdk-js'
const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined)
const block = (title, file) => {
  const text = read(file)
  return [`### ${title}`, '', text ? '```\n' + text + '\n```' : 'Did not run. Check the workflow log.', '']
}
const out = ['## Vantle on GrowthBook (M4)', '', 'GrowthBook JS SDK at `de93c5d`, function `runExperiment` in `packages/sdk-js/src/core.ts`.', '']
out.push(...block('Scan', 'scan.txt'), ...block('Extract and label', 'generate.txt'), ...block('Verify', 'verify.txt'))
const chart = read(`${target}/.vantle/flows/run-experiment.md`)
if (chart) out.push('<details open><summary>Chart</summary>', '', chart.replace(/^# /, '### '), '', '</details>')
const raw = read(`${target}/.vantle/flows/run-experiment.json`)
if (raw) {
  // The labeled flow, trimmed, so the run can be inspected without the artifact.
  const flow = JSON.parse(raw)
  const boxes = flow.nodes.filter((n) => n.kind === 'decision').map((n) => `| ${n.label} | \`${n.rawLabel.replace(/\|/g, '\\|').slice(0, 120)}\` | ${n.category} | ${n.source.file}:${n.source.line} |`)
  out.push('', '<details><summary>Boxes and their code</summary>', '', '| Label | Code | Category | Source |', '|---|---|---|---|', ...boxes, '', '</details>')
}
if (raw) {
  const flow = JSON.parse(raw)
  const failed = flow.paths.filter((p) => p.status === 'failed')
  if (failed.length) {
    out.push('', '<details><summary>Failure details</summary>', '')
    for (const p of failed) out.push(`**${p.id}**`, '```', (p.note ?? '').slice(0, 900), '```')
    for (const p of failed.slice(0, 3)) {
      const code = p.test && read(`${target}/${p.test}`)
      if (code) out.push(`Test for ${p.id}:`, '```ts', code.slice(0, 4000), '```')
    }
    out.push('', '</details>')
  }
}
if (raw) {
  const flow = JSON.parse(raw)
  const missing = (flow.verification?.completeness?.gaps ?? []).filter((g) => g.status === 'missing')
  if (missing.length) {
    out.push('', '<details><summary>Branches missing from the chart</summary>', '')
    for (const g of missing) out.push(`**${g.id}** \`${g.file}:${g.line}\` \`${g.code}\``, '```', (g.note ?? '').slice(0, 900), '```')
    for (const g of missing.slice(0, 3)) {
      const code = g.test && read(`${target}/${g.test}`)
      if (code) out.push(`Test for ${g.id}:`, '```ts', code.slice(0, 4000), '```')
    }
    out.push('', '</details>')
  }
}
const body = out.join('\n')
process.stdout.write(body.length > 60000 ? body.slice(0, 60000) + '\n\n(truncated)\n' : body + '\n')
