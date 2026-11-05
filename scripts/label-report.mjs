// Builds the CI comment: the labeled chart plus the label scores.
import { existsSync, readFileSync } from 'node:fs'

const fixture = process.env.FIXTURE ?? 'fixtures/slack-notify'
const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
const out = ['## Vantle label check', '']

const generate = read('generate.txt')
if (generate) out.push('```', generate.trim(), '```', '')

const score = read('score.json')
if (score) {
  const { behavior, labels } = JSON.parse(score)
  out.push(`**Behavior:** ${behavior.equivalent ? 'matches the reference for every input' : 'differs from the reference'}`)
  if (labels) {
    out.push(`**Label score:** ${labels.average.toFixed(2)} / 5 across ${labels.verdicts.length} boxes`, '')
    out.push('| Score | Reference | Generated | Note |', '|---|---|---|---|')
    const cell = (t) => String(t).replace(/\|/g, '\\|')
    for (const v of [...labels.verdicts].sort((a, b) => a.score - b.score)) {
      out.push(`| ${v.score} | ${cell(v.expected)} | ${cell(v.generated)} | ${v.score < 5 ? cell(v.note) : ''} |`)
    }
  }
  out.push('')
} else {
  out.push('Grading did not run. Check the workflow log.', '')
}

const chart = read(`${fixture}/.vantle/flows/should-notify.md`)
if (chart) out.push('<details open><summary>Chart</summary>', '', chart.replace(/^# /, '### '), '', '</details>')
process.stdout.write(out.join('\n') + '\n')
