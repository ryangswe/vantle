// Times extraction of every function in a package, as scan does, logging slow ones.
import { Node } from 'ts-morph'
import { DEFAULT_EXTRACT_OPTIONS, extractFlow } from '../../../src/extract/extract.js'
import { functionName, loadProject, relPath, type FunctionLike } from '../../../src/project.js'
const t0 = Date.now()
const vp = loadProject(process.argv[2]!)
console.log(`loaded ${vp.sourceFiles.length} files in ${Date.now() - t0} ms`)
let n = 0
const started = Date.now()
for (const file of vp.sourceFiles) {
  const fns: FunctionLike[] = []
  file.forEachDescendant((node) => {
    if ((Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) && node.hasBody()) fns.push(node)
    else if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
      const p = node.getParent()
      if (Node.isVariableDeclaration(p) || Node.isPropertyAssignment(p)) fns.push(node)
    }
  })
  for (const fn of fns) {
    const s = Date.now()
    if (n >= 15400) console.log('start ' + relPath(vp.root, file) + '#' + functionName(fn))
    try {
      extractFlow(vp, { fn, file, name: functionName(fn), question: '' }, 'scan', { ...DEFAULT_EXTRACT_OPTIONS, skipPaths: true })
    } catch {}
    const ms = Date.now() - s
    n++
    if (ms > 2000) console.log(`slow ${ms} ms ${relPath(vp.root, file)}#${functionName(fn)}`)
    if (n % 500 === 0) console.log(`${n} functions, ${Math.round((Date.now() - started) / 1000)} s`)
  }
}
console.log(`done ${n} functions in ${Math.round((Date.now() - started) / 1000)} s`)
