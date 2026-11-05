import { ts } from 'ts-morph'

/** `start:end` of an expression → the name of the function it's in ('' at the top level). */
export type Ranges = Map<string, string>

/**
 * Every node in a file that can be a tested, returned or thrown expression:
 * not type names, declaration names or property names, which would change
 * what the code does if a probe went there.
 */
export function expressionRanges(file: string, code: string): Ranges {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const ranges: Ranges = new Map()
  const visit = (node: ts.Node, fn: string) => {
    if (ts.isTypeNode(node)) return
    const parent = node.parent as (ts.Node & { name?: ts.Node }) | undefined
    const isName = !!parent && parent.name === node
    if (!isName && (!ts.isToken(node) || node.kind === ts.SyntaxKind.Identifier || isLiteralToken(node))) {
      const key = `${node.getStart(sf)}:${node.getEnd()}`
      if (!ranges.has(key)) ranges.set(key, fn)
    }
    const inner = ts.isFunctionLike(node) ? functionName(node, fn) : fn
    ts.forEachChild(node, (child) => visit(child, inner))
  }
  visit(sf, '')
  return ranges
}

/**
 * Start offsets where `text` is a whole expression, in order. With `fn`, only
 * inside the function of that name, so a probe never moves into another function.
 */
export function occurrences(code: string, text: string, ranges: Ranges, fn?: string): number[] {
  const found: number[] = []
  for (let at = code.indexOf(text); at >= 0; at = code.indexOf(text, at + 1)) {
    const inFn = ranges.get(`${at}:${at + text.length}`)
    if (inFn !== undefined && (fn === undefined || inFn === fn)) found.push(at)
  }
  return found
}

/** A name for a function, nested inside `outer`: `outer>inner`. */
function functionName(node: ts.SignatureDeclaration, outer: string): string {
  const own = (n: ts.Node & { name?: ts.Node }) => (n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) ? n.name.text : undefined)
  let name = own(node)
  const parent = node.parent as ts.Node & { name?: ts.Node }
  if (!name && parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))) name = own(parent)
  if (ts.isClassLike(parent) || ts.isObjectLiteralExpression(parent)) name = `${own(parent) ?? own(parent.parent as ts.Node & { name?: ts.Node }) ?? ''}.${name ?? ''}`
  return `${outer ? `${outer}>` : ''}${name ?? '<anonymous>'}`
}

function isLiteralToken(node: ts.Node): boolean {
  return (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.ThisKeyword ||
    ts.isLiteralExpression(node)
  )
}
