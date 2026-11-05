import { Node, SyntaxKind, type SourceFile, type Statement } from 'ts-morph'
import { isFunctionLike } from '../extract/resolve.js'
import { functionName, relPath, type FunctionLike, type VantleProject } from '../project.js'
import type { AnyFlow } from '../schema/labeled.js'
import { normalizeCode, shortHash } from '../util.js'

/**
 * A place in the charted code that changes what the function does: a `return` or
 * `throw`, a branch that sets a variable read later, or a `catch` block. If no
 * test ever runs one, the chart may be missing the branch that leads there.
 */
export interface Target {
  /** Stable across edits elsewhere in the file. */
  key: string
  kind: 'exit' | 'branch' | 'catch'
  file: string
  line: number
  fn: string
  /** The code as written, shortened to one line. */
  code: string
  /** What a test has to make the code do, as a sentence. */
  goal: string
  /** Where to record that the code got here: before `start`, or around `start..end` when `wrap`. */
  insert: { start: number; end: number; wrap: boolean }
}

/** Every target in the functions the chart describes. */
export function coverageTargets(vp: VantleProject, flow: AnyFlow): Target[] {
  const scope = flow.scope ?? [{ file: flow.flow.entry.file, name: flow.flow.entry.symbol }]
  const targets: Target[] = []
  const seen = new Set<FunctionLike>()
  for (const { file, name } of scope) {
    const source = vp.sourceFiles.find((f) => relPath(vp.root, f) === file)
    if (!source) continue
    for (const fn of findFunctions(source, name)) {
      if (seen.has(fn)) continue
      seen.add(fn)
      targets.push(...functionTargets(vp, fn, file, name))
    }
  }
  return targets.sort((a, b) => a.file.localeCompare(b.file) || a.insert.start - b.insert.start)
}

/** Where a charted function's body starts, to record that the code entered it. */
export interface FunctionEntry {
  /** `file#name`, as in chart nodes' `source`. */
  key: string
  file: string
  start: number
  /** For an arrow function with an expression body: where the body ends; the body is wrapped in a block. */
  end?: number
}

/** The entry function and every helper drawn inline, where their bodies start. */
export function functionEntries(vp: VantleProject, flow: AnyFlow): FunctionEntry[] {
  const scope = flow.scope ?? [{ file: flow.flow.entry.file, name: flow.flow.entry.symbol }]
  const out: FunctionEntry[] = []
  for (const { file, name } of scope) {
    const source = vp.sourceFiles.find((f) => relPath(vp.root, f) === file)
    // Every function by that name gets an entry, so each run of it is told apart. What a
    // probe records goes to the run of the function it's written in, whichever one that is.
    for (const fn of source ? findFunctions(source, name) : []) {
      const body = fn.getBody()
      if (!body) continue
      if (Node.isBlock(body)) {
        // After any directives ("use strict"), which stop being directives if anything comes first.
        const directives = body.getStatements().filter((s, i, all) => all.slice(0, i + 1).every(isDirective))
        out.push({ key: `${file}#${name}`, file, start: directives.at(-1)?.getEnd() ?? body.getStart() + 1 })
      }
      else out.push({ key: `${file}#${name}`, file, start: body.getStart(), end: body.getEnd() })
    }
  }
  return out
}

const isDirective = (s: Node) => Node.isExpressionStatement(s) && Node.isStringLiteral(s.getExpression())

function findFunctions(source: SourceFile, name: string): FunctionLike[] {
  const found: FunctionLike[] = []
  source.forEachDescendant((node) => {
    if (isFunctionLike(node) && node.getBody() && functionName(node) === name) found.push(node)
  })
  return found
}

function functionTargets(vp: VantleProject, fn: FunctionLike, file: string, name: string): Target[] {
  const body = fn.getBody()
  if (!body || !Node.isBlock(body)) return []
  const out: Target[] = []
  const counts = new Map<string, number>()
  const add = (kind: Target['kind'], node: Node, code: string, goal: string, insert: Target['insert']) => {
    const base = `${file}#${name}:${kind}:${shortHash(normalizeCode(node.getText()))}`
    const n = counts.get(base) ?? 0
    counts.set(base, n + 1)
    out.push({ key: `${base}:${n}`, kind, file, line: node.getStartLineNumber(), fn: name, code, goal, insert })
  }

  forEachOwnNode(body, (node) => {
    if (Node.isReturnStatement(node) || Node.isThrowStatement(node)) {
      const code = oneLine(node.getText())
      add('exit', node, code, `run \`${code}\``, statementInsert(node))
      return
    }
    if (Node.isIfStatement(node)) {
      const header = oneLine(`if (${node.getExpression().getText()})`)
      const arms: [Statement, string][] = [[node.getThenStatement(), 'yes']]
      const elseArm = node.getElseStatement()
      // An `else if` is its own if statement, with its own arms.
      if (elseArm && !Node.isIfStatement(elseArm)) arms.push([elseArm, 'no'])
      for (const [arm, side] of arms) {
        if (!matters(arm, node, fn)) continue
        add('branch', arm, `${header} → ${side}`, `take the ${side} side of \`${header}\``, armInsert(arm))
      }
      return
    }
    if (Node.isCaseClause(node) || Node.isDefaultClause(node)) {
      const first = node.getStatements()[0]
      if (!first || !matters(node, node.getParentOrThrow().getParentOrThrow(), fn)) return
      const header = Node.isCaseClause(node) ? oneLine(`case ${node.getExpression().getText()}:`) : 'default:'
      add('branch', node, header, `enter \`${header}\``, { start: first.getStart(), end: first.getStart(), wrap: false })
      return
    }
    if (Node.isCatchClause(node)) {
      const block = node.getBlock()
      if (containsExit(block)) return
      const header = oneLine(node.getText().slice(0, block.getStart() - node.getStart()))
      add('catch', node, header, `enter the \`${header}\` block (make the \`try\` block throw)`, { start: block.getStart() + 1, end: block.getStart() + 1, wrap: false })
    }
  })
  return out
}

/** Visits the nodes under `root`, without going into nested functions or classes. */
function forEachOwnNode(root: Node, visit: (node: Node) => void) {
  root.forEachDescendant((node, traversal) => {
    if (isFunctionLike(node) || Node.isClassDeclaration(node) || Node.isClassExpression(node) || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
      // traversal.skip() returns a value that would end the walk, so don't return it.
      traversal.skip()
      return
    }
    visit(node)
  })
}

/**
 * A branch matters when taking it changes what happens next without reaching a
 * return or throw (those are targets of their own): it leaves a loop early, or
 * it sets a variable that's read afterwards.
 */
function matters(arm: Node, branch: Node, fn: FunctionLike): boolean {
  if (containsExit(arm)) return false
  let jumps = false
  const jump = (node: Node) => {
    if (Node.isContinueStatement(node)) jumps = true
    if (Node.isBreakStatement(node) && breaksLoop(node, arm)) jumps = true
  }
  jump(arm)
  forEachOwnNode(arm, jump)
  if (jumps) return true
  for (const decl of assignedVariables(arm, fn)) {
    if (readAfter(decl, branch, arm, fn)) return true
  }
  return false
}

function containsExit(node: Node): boolean {
  let found = Node.isReturnStatement(node) || Node.isThrowStatement(node)
  forEachOwnNode(node, (n) => {
    if (Node.isReturnStatement(n) || Node.isThrowStatement(n)) found = true
  })
  return found
}

/** True when a `break` leaves a loop rather than a `switch`, and the loop isn't inside the arm. */
function breaksLoop(stmt: Node, arm: Node): boolean {
  for (let p = stmt.getParent(); p; p = p.getParent()) {
    if (Node.isSwitchStatement(p)) return false
    if (isLoop(p)) return !(p.getPos() >= arm.getPos() && p.getEnd() <= arm.getEnd())
  }
  return false
}

function isLoop(node: Node): boolean {
  return (
    Node.isForStatement(node) || Node.isForOfStatement(node) || Node.isForInStatement(node) || Node.isWhileStatement(node) || Node.isDoStatement(node)
  )
}

/** Variables and parameters of `fn` that `node` assigns. */
function assignedVariables(node: Node, fn: FunctionLike): Set<Node> {
  const out = new Set<Node>()
  const check = (target: Node) => {
    if (!Node.isIdentifier(target)) return
    const decl = target.getSymbol()?.getDeclarations()[0]
    if (!decl || !(Node.isVariableDeclaration(decl) || Node.isBindingElement(decl) || Node.isParameterDeclaration(decl))) return
    if (decl.getSourceFile() !== fn.getSourceFile() || decl.getPos() < fn.getPos() || decl.getEnd() > fn.getEnd()) return
    out.add(decl)
  }
  forEachOwnNode(node, (n) => {
    if (Node.isBinaryExpression(n)) {
      const op = n.getOperatorToken().getKind()
      if (op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment) check(n.getLeft())
    } else if (Node.isPrefixUnaryExpression(n) || Node.isPostfixUnaryExpression(n)) {
      const op = n.getOperatorToken()
      if (op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken) check(n.getOperand())
    }
  })
  return out
}

/** True when the variable is read after the branch, or anywhere in a loop around it. */
function readAfter(decl: Node, branch: Node, arm: Node, fn: FunctionLike): boolean {
  let loop: Node | undefined
  for (let p = branch.getParent(); p && p !== fn; p = p.getParent()) {
    if (isLoop(p)) loop = p
  }
  let found = false
  fn.getBody()?.forEachDescendant((node, traversal) => {
    if (found) return traversal.stop()
    if (!Node.isIdentifier(node) || node.getSymbol()?.getDeclarations()[0] !== decl) return
    if (node.getParent() === decl) return
    const pos = node.getStart()
    const inArm = pos >= arm.getStart() && pos < arm.getEnd()
    if (pos >= branch.getEnd() || (loop && !inArm && pos >= loop.getStart() && pos < loop.getEnd())) found = true
  })
  return found
}

/** Statements in a list get a marker before them; others (`if (x) return y`) get wrapped in braces. */
function statementInsert(stmt: Node): Target['insert'] {
  const parent = stmt.getParent()
  const inList = Node.isBlock(parent) || Node.isCaseClause(parent) || Node.isDefaultClause(parent) || Node.isSourceFile(parent)
  return inList ? { start: stmt.getStart(), end: stmt.getStart(), wrap: false } : { start: stmt.getStart(), end: stmt.getEnd(), wrap: true }
}

function armInsert(arm: Statement): Target['insert'] {
  if (Node.isBlock(arm)) return { start: arm.getStart() + 1, end: arm.getStart() + 1, wrap: false }
  return { start: arm.getStart(), end: arm.getEnd(), wrap: true }
}

function oneLine(text: string): string {
  const line = normalizeCode(text)
  return line.length > 100 ? `${line.slice(0, 97)}…` : line
}
