import { existsSync } from 'node:fs'
import path from 'node:path'
import { Node, Project, type SourceFile } from 'ts-morph'
import { kebab } from './util.js'

export type FunctionLike =
  | import('ts-morph').FunctionDeclaration
  | import('ts-morph').MethodDeclaration
  | import('ts-morph').ArrowFunction
  | import('ts-morph').FunctionExpression

export interface VantleProject {
  root: string
  project: Project
  /** Source files that belong to the repo (no node_modules, no .d.ts). */
  sourceFiles: SourceFile[]
}

export function loadProject(dir: string): VantleProject {
  const root = path.resolve(dir)
  const tsConfigFilePath = path.join(root, 'tsconfig.json')
  if (!existsSync(tsConfigFilePath)) {
    throw new UsageError(`No tsconfig.json in ${root}. Run vantle from a TypeScript project root, or pass --project.`)
  }
  const project = new Project({ tsConfigFilePath })
  const sourceFiles = project.getSourceFiles().filter((f) => isRepoFile(root, f))
  return { root, project, sourceFiles }
}

export function isRepoFile(root: string, file: SourceFile): boolean {
  const p = file.getFilePath()
  return !file.isDeclarationFile() && !p.includes('/node_modules/') && p.startsWith(root + path.sep)
}

export function relPath(root: string, file: SourceFile | string): string {
  const p = typeof file === 'string' ? file : file.getFilePath()
  return path.relative(root, p).split(path.sep).join('/')
}

export class UsageError extends Error {}

export interface Annotation {
  question: string
  fn: FunctionLike
  name: string
  file: SourceFile
}

const MARKER = /@vantle:\s*(?:"([^"]*)"|(.+))/

/** Finds every function marked with a `// @vantle: "<question>"` comment. */
export function findAnnotations(vp: VantleProject): Annotation[] {
  const found: Annotation[] = []
  for (const file of vp.sourceFiles) {
    file.forEachDescendant((node) => {
      const target = annotatedFunction(node)
      if (!target) return
      for (const range of node.getLeadingCommentRanges()) {
        const match = MARKER.exec(range.getText())
        if (match) {
          const question = (match[1] ?? match[2] ?? '').trim()
          found.push({ question, fn: target.fn, name: target.name, file })
          break
        }
      }
    })
  }
  return found
}

/** The function a comment above `node` would describe, if any. */
function annotatedFunction(node: Node): { fn: FunctionLike; name: string } | undefined {
  if (Node.isFunctionDeclaration(node) && node.hasBody()) {
    return { fn: node, name: node.getName() ?? 'default' }
  }
  if (Node.isMethodDeclaration(node) && node.hasBody()) {
    const cls = node.getParent()
    const owner = Node.isClassDeclaration(cls) ? cls.getName() : undefined
    return { fn: node, name: owner ? `${owner}.${node.getName()}` : node.getName() }
  }
  if (Node.isVariableStatement(node)) {
    const decl = node.getDeclarations()[0]
    const init = decl?.getInitializer()
    if (decl && init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return { fn: init, name: decl.getName() }
    }
  }
  return undefined
}

/** Name of the function that contains `node`, for source references. */
export function functionName(fn: FunctionLike): string {
  if (Node.isFunctionDeclaration(fn)) return fn.getName() ?? 'default'
  if (Node.isMethodDeclaration(fn)) {
    const parent = fn.getParent()
    if (Node.isClassDeclaration(parent)) return `${parent.getName() ?? 'Class'}.${fn.getName()}`
    if (Node.isObjectLiteralExpression(parent)) {
      const holder = parent.getParent()
      if (Node.isVariableDeclaration(holder)) return `${holder.getName()}.${fn.getName()}`
    }
    return fn.getName()
  }
  const holder = fn.getParent()
  if (Node.isVariableDeclaration(holder)) return holder.getName()
  if (Node.isPropertyAssignment(holder)) return holder.getName()
  return '<anonymous>'
}

export function flowSlug(name: string): string {
  return kebab(name.replace(/\./g, '-'))
}
