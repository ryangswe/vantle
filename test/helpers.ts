import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractFlow, DEFAULT_EXTRACT_OPTIONS, type ExtractOptions } from '../src/extract/extract.js'
import { findAnnotations, flowSlug, loadProject } from '../src/project.js'

export const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/slack-notify')

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src'],
})

/** Writes a throwaway TypeScript project and returns its folder. */
export function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vantle-test-'))
  writeFileSync(path.join(dir, 'tsconfig.json'), TSCONFIG)
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, 'src', name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  return dir
}

/** Copies the Slack fixture so a test can edit it. */
export function copyFixture(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vantle-fixture-'))
  cpSync(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.vantle`) })
  return dir
}

export function editFile(file: string, edit: (text: string) => string) {
  const before = readFileSync(file, 'utf8')
  const after = edit(before)
  if (after === before) throw new Error(`edit did not change ${file}`)
  writeFileSync(file, after)
}

/** Extracts the only (or the named) marked function in a project folder. */
export function extract(dir: string, name?: string, options: Partial<ExtractOptions> = {}) {
  const vp = loadProject(dir)
  const annotations = findAnnotations(vp)
  const annotation = name ? annotations.find((a) => a.name === name) : annotations[0]
  if (!annotation) throw new Error(`no @vantle function${name ? ` named ${name}` : ''} in ${dir}`)
  return extractFlow(vp, annotation, flowSlug(annotation.name), { ...DEFAULT_EXTRACT_OPTIONS, ...options })
}
