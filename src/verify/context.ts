import path from 'node:path'
import type { SourceFile } from 'ts-morph'
import { isRepoFile, relPath, type VantleProject } from '../project.js'
import type { AnyFlow } from '../schema/labeled.js'

export interface TestContext {
  /** Folder the test files live in, absolute. */
  testDir: string
  /** Import specifier, from a test file, for each repo file the code touches. */
  importPaths: { file: string; specifier: string }[]
  /** Full source of those files, in dependency order, capped in size. */
  files: { file: string; code: string }[]
  entry: { file: string; specifier: string; name: string; exportName: string | undefined; isMethod: boolean }
  truncated: boolean
}

const MAX_SOURCE_CHARS = 60_000

export function testDir(vp: VantleProject, slug: string): string {
  return path.join(vp.root, '.vantle', 'tests', slug)
}

/** Everything a test writer needs to import and drive the entry function. */
export function testContext(vp: VantleProject, flow: AnyFlow): TestContext {
  const dir = testDir(vp, flow.flow.slug)
  const entryFile = vp.sourceFiles.find((f) => relPath(vp.root, f) === flow.flow.entry.file)
  if (!entryFile) throw new Error(`Can't find ${flow.flow.entry.file} in the project.`)

  // The entry file plus every repo file it imports, directly or indirectly.
  const ordered: SourceFile[] = []
  const seen = new Set<SourceFile>()
  const visit = (file: SourceFile) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const imp of file.getImportDeclarations()) {
      const target = imp.getModuleSpecifierSourceFile()
      if (target && isRepoFile(vp.root, target)) visit(target)
    }
    for (const exp of file.getExportDeclarations()) {
      const target = exp.getModuleSpecifierSourceFile()
      if (target && isRepoFile(vp.root, target)) visit(target)
    }
    ordered.push(file)
  }
  visit(entryFile)

  const specifier = (file: SourceFile) => {
    let rel = path.relative(dir, file.getFilePath()).split(path.sep).join('/')
    rel = rel.replace(/\.(m|c)?tsx?$/, '')
    return rel.startsWith('.') ? rel : `./${rel}`
  }

  let total = 0
  let truncated = false
  const files: TestContext['files'] = []
  for (const file of ordered) {
    const code = file.getFullText()
    if (total + code.length > MAX_SOURCE_CHARS) {
      truncated = true
      continue
    }
    total += code.length
    files.push({ file: relPath(vp.root, file), code })
  }

  const symbol = flow.flow.entry.symbol
  const isMethod = symbol.includes('.')
  const exportName = isMethod ? symbol.split('.')[0] : symbol
  const exported = entryFile.getExportedDeclarations().has(exportName ?? '')
  return {
    testDir: dir,
    importPaths: ordered.map((f) => ({ file: relPath(vp.root, f), specifier: specifier(f) })),
    files,
    entry: { file: relPath(vp.root, entryFile), specifier: specifier(entryFile), name: symbol, exportName: exported ? exportName : undefined, isMethod },
    truncated,
  }
}
