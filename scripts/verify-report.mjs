// Builds the CI comment for verify-check.
import { existsSync, readFileSync } from 'node:fs'

const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined)
const out = ['## Vantle verify check', '']
const generate = read('generate.txt')
if (generate) out.push('### Labeling', '', '```\n' + generate + '\n```', '')
const verify = read('verify.txt')
out.push('### Path tests on the real code', '', verify ? '```\n' + verify + '\n```' : 'Did not run. Check the workflow log.', '')
const drift = read('drift.txt')
out.push('### After breaking the code on purpose', '', 'Two bugs were added: global pref "Never" notifies, and Do Not Disturb no longer blocks notifications. The saved tests re-ran without writing new ones.', '')
out.push(drift ? '```\n' + drift + '\n```' : 'Did not run.', '')
const driftChart = read('drift-chart.md')
const failedRows = (driftChart ?? '').split('\n').filter((l) => l.includes('❌ failed'))
if (failedRows.length) out.push('Failed paths:', '', '| Path | Status | Answers | Outcome | Notes |', '|---|---|---|---|---|', ...failedRows, '')
const gap = read('gap.txt')
out.push(
  "### After adding a branch the chart doesn't know about",
  '',
  'The code was restored, then changed so messages over 4,000 characters never notify. The chart was not regenerated. Every saved path test still passes, because none of them sends a long message. The check for code no path test ran should find the new return.',
  '',
)
out.push(gap ? '```\n' + gap + '\n```' : 'Did not run.', '')
const gapChart = read('gap-chart.md')
const gapSection = (gapChart ?? '').split('## Code the chart may be missing')[1]
if (gapSection) out.push('#### Code the chart may be missing', gapSection.trim(), '')
const chart = read('chart.md')
if (chart) out.push('<details><summary>Chart and tested paths (before the bugs)</summary>', '', chart.replace(/^# /, '### '), '', '</details>')
process.stdout.write(out.join('\n') + '\n')
