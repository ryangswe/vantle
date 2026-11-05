import { Node, SyntaxKind, type BinaryExpression } from 'ts-morph'
import { DEFAULT_EXTRACT_OPTIONS, extractFlow } from './extract/extract.js'
import { isFunctionLike } from './extract/resolve.js'
import { findAnnotations, functionName, relPath, type FunctionLike, type VantleProject } from './project.js'

export interface ScanRow {
  name: string
  file: string
  line: number
  /** Boxes the chart for this function would have, following calls the way `vantle extract` does. */
  boxes: number
  /** Decision points in this function's own body. */
  own: number
  lines: number
  marked: boolean
  /** Why the extractor couldn't chart it, when it couldn't. */
  error?: string
}

/**
 * Ranks functions by how big a chart they'd produce, which makes this a list
 * of good places to put `@vantle`. Charts are built the same way `extract`
 * builds them, so an entry point that delegates to branching helpers ranks
 * above the helpers.
 */
export function scan(vp: VantleProject, under?: string): ScanRow[] {
  const marked = new Set(findAnnotations(vp).map((a) => a.fn))
  const rows: ScanRow[] = []
  for (const { fn, file } of listFunctions(vp)) {
    const rel = relPath(vp.root, file)
    if (under && !rel.startsWith(under.replace(/^\.\//, ''))) continue
    const own = countDecisions(fn)
    let boxes = 0
    let error: string | undefined
    try {
      const flow = extractFlow(vp, { fn, file, name: functionName(fn), question: '' }, 'scan', { ...DEFAULT_EXTRACT_OPTIONS, skipPaths: true, maxBoxes: undefined })
      boxes = flow.nodes.filter((n) => n.kind === 'decision').length
    } catch (e) {
      // A function the extractor can't walk still shows up with its own count, and the reason.
      error = e instanceof Error ? e.message : String(e)
    }
    if (boxes === 0 && own === 0 && !error) continue
    rows.push({
      name: functionName(fn),
      file: rel,
      line: fn.getStartLineNumber(),
      boxes,
      own,
      lines: fn.getEndLineNumber() - fn.getStartLineNumber() + 1,
      marked: marked.has(fn),
      ...(error ? { error } : {}),
    })
  }
  return rows.sort((a, b) => b.boxes - a.boxes || b.own - a.own || a.name.localeCompare(b.name))
}

/** Named functions: declarations, methods, and functions assigned to a variable or property. */
function listFunctions(vp: VantleProject) {
  const out: { fn: FunctionLike; file: import('ts-morph').SourceFile }[] = []
  for (const file of vp.sourceFiles) {
    file.forEachDescendant((node) => {
      if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
        if (node.hasBody()) out.push({ fn: node, file })
      } else if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
        const parent = node.getParent()
        if (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent)) out.push({ fn: node, file })
      }
    })
  }
  return out
}

/**
 * Decisions that change where control goes: if, case, ternaries, and && or ||
 * inside a condition or return. Guards like `debug && log(...)` and defaults
 * like `url || ""` aren't counted.
 */
export function countDecisions(fn: FunctionLike): number {
  let count = 0
  fn.getBody()?.forEachDescendant((node, traversal) => {
    if (node !== fn && isFunctionLike(node) && Node.isFunctionDeclaration(node)) {
      // traversal.skip() returns a value that would end the walk, so don't return it.
      traversal.skip()
      return
    }
    const kind = node.getKind()
    if (kind === SyntaxKind.IfStatement || kind === SyntaxKind.CaseClause || kind === SyntaxKind.ConditionalExpression) count++
    else if (kind === SyntaxKind.BinaryExpression && isLogical(node as BinaryExpression) && inCondition(node)) count++
  })
  return count
}

function isLogical(node: BinaryExpression): boolean {
  const op = node.getOperatorToken().getKind()
  return op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken
}

/** True when the node sits in an if, loop or ternary condition, or in a return value. */
function inCondition(node: Node): boolean {
  for (let current: Node | undefined = node; current; current = current.getParent()) {
    const parent = current.getParent()
    if (!parent) return false
    if (Node.isIfStatement(parent) || Node.isWhileStatement(parent) || Node.isDoStatement(parent)) return parent.getExpression() === current
    if (Node.isConditionalExpression(parent)) return parent.getCondition() === current
    if (Node.isReturnStatement(parent)) return true
    if (Node.isStatement(parent) || isFunctionLike(parent)) return false
  }
  return false
}
