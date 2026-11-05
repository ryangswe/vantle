// Changes the Slack fixture after its chart was made, to show verify catches it.
//   bugs (default): two bugs that the saved path tests should catch.
//   new-branch: an early return the chart doesn't know about, which no path test
//   runs; the check for code no path test ran should find it.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = process.argv[2] ?? 'fixtures/slack-notify'
const mode = process.argv[3] ?? 'bugs'
const modes = {
  bugs: [
    ['src/modes.ts', "case 'never':\n      return false", "case 'never':\n      return true", 'Global pref "Never" now notifies'],
    ['src/notify.ts', '    if (!msg.dndOverride) return false\n', '', 'Do Not Disturb no longer blocks notifications'],
  ],
  'new-branch': [
    [
      'src/notify.ts',
      '  // Muted channels only notify for threads the user follows.\n',
      '  // Very long messages never notify.\n  if (msg.text.length > 4000) return false\n\n  // Muted channels only notify for threads the user follows.\n',
      'Messages over 4,000 characters never notify',
    ],
  ],
}
const edits = modes[mode]
if (!edits) throw new Error(`Unknown mode ${mode}`)
for (const [file, from, to, what] of edits) {
  const full = path.join(root, file)
  const text = readFileSync(full, 'utf8')
  if (!text.includes(from)) throw new Error(`Couldn't apply "${what}" to ${file}`)
  writeFileSync(full, text.replace(from, to))
  console.log(`Changed ${file}: ${what}`)
}
