import { Node, type CallExpression } from 'ts-morph'
import type { FunctionLike } from '../project.js'

/** The function a call goes to, when its body is available in the program. */
export function resolveCallee(call: CallExpression): FunctionLike | undefined {
  const decl = calleeDeclaration(call)
  if (!decl) return undefined
  if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
    return decl.hasBody() ? decl : undefined
  }
  if (Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) return decl
  if (Node.isVariableDeclaration(decl) || Node.isPropertyAssignment(decl)) {
    const init = decl.getInitializer()
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return init
  }
  return undefined
}

export function calleeDeclaration(call: CallExpression): Node | undefined {
  let symbol = call.getExpression().getSymbol()
  if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol() ?? symbol
  return symbol?.getDeclarations()[0]
}

export type CallOrigin = 'repo' | 'builtin' | 'external' | 'unresolved'

/** Where a call's target lives, without needing its body. */
export function callOrigin(call: CallExpression, isRepoPath: (filePath: string) => boolean): { origin: CallOrigin; filePath?: string } {
  const decl = calleeDeclaration(call)
  if (!decl) return { origin: 'unresolved' }
  const filePath = decl.getSourceFile().getFilePath()
  if (filePath.includes('/typescript/lib/') || filePath.includes('/@types/node/')) return { origin: 'builtin', filePath }
  if (isRepoPath(filePath) && !decl.getSourceFile().isDeclarationFile()) return { origin: 'repo', filePath }
  return { origin: 'external', filePath }
}

/** True when a function body has its own branches, so inlining it adds information to the chart. */
export function hasBranching(fn: FunctionLike): boolean {
  const body = fn.getBody()
  if (!body) return false
  let found = false
  body.forEachDescendant((node, traversal) => {
    if (found) return traversal.stop()
    // traversal.skip() returns a value that would end the walk, so don't return it.
    if (isFunctionLike(node)) {
      traversal.skip()
      return
    }
    if (Node.isIfStatement(node) || Node.isSwitchStatement(node) || Node.isConditionalExpression(node)) {
      found = true
      traversal.stop()
    }
  })
  return found || (Node.isConditionalExpression(body))
}

export function isFunctionLike(node: Node): node is FunctionLike {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node)
  )
}
