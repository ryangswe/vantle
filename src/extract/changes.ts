import { Node, SyntaxKind, type CallExpression, type ClassDeclaration, type NewExpression, type Type } from 'ts-morph'
import type { FunctionLike } from '../project.js'
import { shortHash } from '../util.js'
import { isFunctionLike, resolveCallee } from './resolve.js'

/** Methods that change the object they're called on. */
export const MUTATING_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear'])

/** Methods that don't change the object they're called on, even when called only for their effect. */
export const NON_MUTATING_METHODS = new Set([
  'forEach', 'map', 'filter', 'some', 'every', 'find', 'findIndex', 'includes', 'indexOf', 'get', 'has', 'then', 'catch', 'finally',
  'log', 'debug', 'info', 'warn', 'error', 'trace', 'emit', 'toString', 'join', 'slice', 'concat', 'keys', 'values', 'entries',
  'reduce', 'reduceRight', 'flatMap', 'flat', 'at', 'findLast', 'findLastIndex', 'lastIndexOf', 'toSorted', 'toReversed', 'toSpliced', 'with',
  'union', 'intersection', 'difference', 'symmetricDifference', 'isSubsetOf', 'isSupersetOf', 'isDisjointFrom',
])

/**
 * Built-in functions that change nothing (reading the clock or a random number samples
 * something, which makes its check a question of its own, but changes nothing either).
 */
const PURE_BUILTIN =
  /^(Number|String|Boolean|BigInt|parseInt|parseFloat|isNaN|isFinite|encodeURIComponent|decodeURIComponent|encodeURI|decodeURI|structuredClone|Symbol|Math\.\w+|JSON\.(parse|stringify)|Array\.(isArray|from|of)|Object\.(keys|values|entries|fromEntries|freeze|isFrozen|getPrototypeOf|getOwnPropertyNames|is|hasOwn)|Number\.\w+|String\.\w+|Date\.now|performance\.now|crypto\.randomUUID|Promise\.(resolve|reject|all|allSettled|race|any)|Object\.prototype\.(toString|hasOwnProperty|propertyIsEnumerable)\.(call|apply))$/

/** Calls that consume or sample something, so two of them never ask the same question. */
export const VOLATILE_CALL = /^(next|shift|pop|dequeue|take|poll|read|random|rand|randomInt|randomUUID|roll|rollDie|draw|tick|now|uuid)$/i

/**
 * What a piece of code may change. Field writes name the field (`u.admin = false`
 * changes `admin` on whatever object `u` is). Changes to whole objects (`x.push(…)`,
 * an object handed to code Vantle can't see) keep the object's type. `effect` is
 * set when the code calls something Vantle can't see, which may change anything a
 * later lookup reads.
 */
export interface Summary {
  fields: Set<string>
  /** Some field Vantle can't name (`x[k] = v`), on any object. */
  anyField: boolean
  types: Type[]
  effect: boolean
}

/** One place in a function that may change something, at a position in its file. */
export interface Change extends Summary {
  file: string
  at: number
  /** Where the change is written. */
  node: Node
  /**
   * Set for changes inside a function written in this one (a callback or closure).
   * They run whenever it's called, which can be between any two checks.
   */
  floating?: boolean
}

const NONE = (): Summary => ({ fields: new Set(), anyField: false, types: [], effect: false })
const ALL = (): Summary => ({ fields: new Set(), anyField: true, types: [], effect: true })

function empty(s: Summary): boolean {
  return !s.fields.size && !s.anyField && !s.types.length && !s.effect
}

/** Past this many object types, a summary just says "some field of anything". */
const MAX_TYPES = 32

function merge(into: Summary, s: Summary) {
  for (const f of s.fields) into.fields.add(f)
  into.anyField ||= s.anyField
  into.effect ||= s.effect
  for (const t of s.types) addType(into, t)
}

function addType(into: Summary, t: Type) {
  if (into.anyField && !into.types.length) return
  // ts-morph wraps one compiler type in more than one object.
  const id = t.compilerType
  if (into.types.some((u) => u.compilerType === id)) return
  if (into.types.length >= MAX_TYPES) {
    into.anyField = true
    into.types = []
    return
  }
  into.types.push(t)
}

function unwrapAny(node: Node): Node {
  let n = node
  while (Node.isParenthesizedExpression(n) || Node.isAsExpression(n) || Node.isNonNullExpression(n) || Node.isTypeAssertion(n) || Node.isSatisfiesExpression(n)) n = n.getExpression()
  return n
}

/**
 * True when a call is part of a check: an `if`, `switch`, loop or `?:` condition, or a
 * `&&`/`||`/`!` that decides what's returned. Such a call is a lookup: its own answer is a
 * question, not an effect. (`force && lockAll()` written as a statement isn't a check.)
 */
export function inCheck(call: Node): boolean {
  let child: Node = call
  let logical = false
  for (let p = call.getParent(); p; child = p, p = p.getParent()) {
    if (Node.isStatement(p) || isFunctionLike(p)) {
      if ((Node.isIfStatement(p) || Node.isSwitchStatement(p) || Node.isWhileStatement(p) || Node.isDoStatement(p)) && p.getExpression() === child) return true
      if (Node.isForStatement(p) && p.getCondition() === child) return true
      return logical && Node.isReturnStatement(p)
    }
    if (Node.isConditionalExpression(p) && p.getCondition() === child) return true
    if (Node.isPrefixUnaryExpression(p) && p.getOperatorToken() === SyntaxKind.ExclamationToken) logical = true
    if (Node.isBinaryExpression(p)) {
      const op = p.getOperatorToken().getKind()
      if (op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken) logical = true
    }
  }
  return false
}

/**
 * A call that changes nothing and asks nothing that could change: `console.*`, pure
 * built-ins, methods of strings, numbers, booleans, regular expressions and dates, and
 * methods known not to change their object.
 */
export function pureCall(call: CallExpression): boolean {
  const callee = unwrapAny(call.getExpression())
  const text = callee.getText()
  if (/^console\./.test(text) || PURE_BUILTIN.test(text)) return true
  if (!Node.isPropertyAccessExpression(callee)) return false
  const t = callee.getExpression().getType().getNonNullableType()
  if (t.isString() || t.isNumber() || t.isBoolean() || t.isStringLiteral() || t.isNumberLiteral() || t.isBooleanLiteral() || t.isBigInt() || t.getText() === 'RegExp') return true
  if (t.isUnion() && t.getUnionTypes().every((u) => !changeableUnionMember(u))) return true
  if (t.getText() === 'Date' && /^(get|to|valueOf)/.test(callee.getName())) return true
  // Methods known not to change their object (\`ids.difference(x)\`, \`m.get(k)\`) aren't lookups of
  // their own: a change to their object still reaches the check through reading the method on it.
  return NON_MUTATING_METHODS.has(callee.getName())
}

/** The type of an object that can be changed, or undefined for primitives and fresh literals. */
function changeableType(expr: Node): Type | undefined {
  const e = unwrapAny(expr)
  if (Node.isObjectLiteralExpression(e) || Node.isArrayLiteralExpression(e) || Node.isLiteralExpression(e) || Node.isTemplateExpression(e)) return undefined
  if (Node.isFunctionExpression(e) || Node.isArrowFunction(e)) return undefined
  const t = e.getType().getNonNullableType()
  if (t.isNever()) return undefined
  // An untyped value a call hands back (a query builder, a library's result) is taken to be new,
  // not one of the caller's objects. An untyped variable or parameter still counts.
  if ((t.isAny() || t.isUnknown()) && fromCall(e)) return undefined
  if (t.isString() || t.isNumber() || t.isBoolean() || t.isBigInt() || t.isLiteral() || t.isStringLiteral() || t.isNumberLiteral() || t.isBooleanLiteral() || t.isEnumLiteral() || t.isUndefined() || t.isNull()) return undefined
  if (t.isUnion() && t.getUnionTypes().every((u) => !changeableUnionMember(u))) return undefined
  return t
}

/** True when a call is a statement of its own (awaited or not), so it's made for its effect. */
function forEffect(call: Node): boolean {
  let p = call.getParent()
  while (p && (Node.isAwaitExpression(p) || Node.isParenthesizedExpression(p) || Node.isVoidExpression(p))) p = p.getParent()
  return !!p && Node.isExpressionStatement(p)
}

/** True when \`expr\` is a call's result, or a property of one (\`db.select().where\`). */
function fromCall(expr: Node): boolean {
  for (let e = unwrapAny(expr); ; ) {
    if (Node.isCallExpression(e) || Node.isNewExpression(e) || Node.isAwaitExpression(e)) return true
    if (Node.isPropertyAccessExpression(e) || Node.isElementAccessExpression(e)) e = unwrapAny(e.getExpression())
    else return false
  }
}

function changeableUnionMember(t: Type): boolean {
  return !(t.isString() || t.isNumber() || t.isBoolean() || t.isLiteral() || t.isUndefined() || t.isNull() || t.isBigInt())
}

/**
 * Whether a change to a whole object of type `t` can change field `f` of some object.
 * True when `t` has `f`, has an index signature, or could be anything.
 */
export function typeHasField(t: Type, f: string | undefined): boolean {
  const memo = fieldMemo.get(t.compilerType) ?? new Map<string, boolean>()
  fieldMemo.set(t.compilerType, memo)
  const key = f ?? '*'
  const known = memo.get(key)
  if (known !== undefined) return known
  const out = hasField(t, f, 0)
  memo.set(key, out)
  return out
}

const fieldMemo = new WeakMap<object, Map<string, boolean>>()

/**
 * Whether a change to an object of type \`changed\` can change what a read of \`f\` on an object
 * of type \`read\` sees: \`changed\` declares \`f\` (a structural match: one object can be both
 * types); or it takes any key (an index signature, \`any\`, an unconstrained type parameter)
 * and the reading object's type is compatible with it.
 */
export function mayHold(changed: Type, f: string | undefined, read: Type | undefined): boolean {
  if (!typeHasField(changed, f)) return false
  if (f === undefined || !read || declares(changed, f)) return true
  const r = read.getNonNullableType()
  if (r.isAny() || r.isUnknown() || changed.isAny() || changed.isUnknown()) return true
  return r.isAssignableTo(changed) || changed.isAssignableTo(r)
}

/** True when \`t\` (or one of its union or intersection members) declares \`f\` by name. */
function declares(t: Type, f: string): boolean {
  if (t.isUnion()) return t.getUnionTypes().some((u) => declares(u, f))
  if (t.isIntersection()) return t.getIntersectionTypes().some((u) => declares(u, f))
  if (t.isArray()) {
    const el = t.getArrayElementType()
    return f === 'length' || /^\d+$/.test(f) || (!!el && declares(el, f))
  }
  return !!t.getProperty(f)
}

function hasField(t: Type, f: string | undefined, depth: number): boolean {
  if (depth > 4) return true
  if (t.isAny() || t.isUnknown()) return true
  // A type parameter (`this` in a class is one) is whatever its constraint allows.
  if (t.isTypeParameter()) {
    const c = t.getConstraint()
    return c ? hasField(c, f, depth + 1) : true
  }
  // Changing an array changes its length and elements, and possibly what its elements hold.
  if (t.isArray() || t.isTuple()) {
    if (f === undefined || f === 'length' || /^\d+$/.test(f)) return true
    const el = t.isArray() ? t.getArrayElementType() : undefined
    return el ? changeableUnionMember(el) && hasField(el, f, depth + 1) : true
  }
  if (t.isUnion()) return t.getUnionTypes().some((u) => hasField(u, f, depth + 1))
  if (t.isIntersection()) return t.getIntersectionTypes().some((u) => hasField(u, f, depth + 1))
  if (!changeableUnionMember(t)) return false
  if (f === undefined) return true
  if (t.getStringIndexType() || t.getNumberIndexType()) return true
  // `object` and `{}` could hold any field.
  if (!t.getProperties().length && (t.getText() === 'object' || t.getText() === '{}')) return true
  return !!t.getProperty(f)
}

/** What a function reads: field names with the types of the objects they're read on (undefined: too many to keep). */
export interface Reads {
  fields: Set<string>
  types: Map<string, Type[] | undefined>
  calls: boolean
  all: boolean
}

/** Works out what code changes, for one extraction. */
export class ChangeModel {
  private readonly summaries = new Map<FunctionLike, Summary>()
  private readonly sites = new Map<FunctionLike, Change[]>()
  private readonly reads = new Map<FunctionLike, Reads>()

  private readonly befores = new Map<Node, Change[]>()

  /** `rel` names a file as the chart does (relative to the project), so keys don't depend on where it's checked out. */
  constructor(
    private readonly isRepo: (fn: FunctionLike) => boolean,
    private readonly rel: (file: string) => string = (f) => f,
  ) {}

  /**
   * What calling `fn` may change: field writes and whole-object changes anywhere in it
   * (functions written inside it included, since they may be called), and in repo
   * functions it calls; plus an effect when it calls code Vantle can't see outside a check.
   * Recursion and very deep chains count as changing anything.
   */
  summary(fn: FunctionLike, active = new Set<FunctionLike>(), depth = 0): Summary {
    const known = this.summaries.get(fn)
    if (known) return known
    if (active.has(fn) || depth > 12) return ALL()
    active.add(fn)
    const out = NONE()
    const body = fn.getBody()
    body?.forEachDescendant((n) => {
      const own = this.direct(n, fn, active, depth)
      if (own) merge(out, own)
      if (Node.isCallExpression(n)) merge(out, this.callEffect(n, active, depth))
      if (Node.isNewExpression(n)) merge(out, this.newEffect(n, active, depth))
    })
    active.delete(fn)
    this.summaries.set(fn, out)
    return out
  }

  /**
   * A field write or whole-object change written right at `n`, not counting calls to
   * functions. A write to a fresh object (\`const r = {}; r.x = 1\`) can't change anything else.
   */
  private direct(n: Node, fn: FunctionLike, active = new Set<FunctionLike>(), depth = 0): Summary | undefined {
    const target = (left: Node): Summary | undefined => {
      const l = unwrapAny(left)
      // A variable from outside this function (a module variable, or one a closure captured).
      if (Node.isIdentifier(l)) {
        const v = outsideVariable(l, fn)
        return v ? { ...NONE(), fields: new Set([v]), effect: true } : undefined
      }
      if ((Node.isPropertyAccessExpression(l) || Node.isElementAccessExpression(l)) && freshLocal(l.getExpression())) return undefined
      // In a constructor, \`this\` is the object being made, which nothing else can be yet.
      if ((Node.isPropertyAccessExpression(l) || Node.isElementAccessExpression(l)) && Node.isConstructorDeclaration(fn) && unwrapAny(l.getExpression()).getKind() === SyntaxKind.ThisKeyword) return undefined
      if (Node.isPropertyAccessExpression(l)) {
        const out: Summary = { ...NONE(), fields: new Set([l.getName()]) }
        // A setter can change anything its body changes.
        for (const d of l.getNameNode().getSymbol()?.getDeclarations() ?? []) {
          if (Node.isSetAccessorDeclaration(d) && d.getBody()) merge(out, this.summary(d as unknown as FunctionLike, active, depth + 1))
        }
        return out
      }
      if (Node.isElementAccessExpression(l)) {
        const a = l.getArgumentExpression()
        if (a && (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a))) return { ...NONE(), fields: new Set([a.getLiteralValue()]) }
        // A computed key changes some field of that object: known by its type when there is one.
        const t = changeableType(l.getExpression())
        return t ? { ...NONE(), types: [t] } : { ...NONE(), anyField: true }
      }
      return undefined
    }
    if (Node.isBinaryExpression(n)) {
      const op = n.getOperatorToken().getKind()
      if (op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment) return target(n.getLeft())
    }
    if ((Node.isPrefixUnaryExpression(n) || Node.isPostfixUnaryExpression(n)) && (n.getOperatorToken() === SyntaxKind.PlusPlusToken || n.getOperatorToken() === SyntaxKind.MinusMinusToken)) {
      return target(n.getOperand())
    }
    if (Node.isDeleteExpression(n)) return target(n.getExpression())
    return undefined
  }

  /**
   * What one call may change. A repo function with a body: what its summary says.
   * Anything else: built-in mutating methods change their object; `console.*` and
   * methods known not to change anything change nothing; other code Vantle can't see
   * may change every object it's given (and the one it's called on) and is an effect,
   * unless the call is a lookup in a check.
   */
  callEffect(call: CallExpression, active = new Set<FunctionLike>(), depth = 0): Summary {
    const callee = unwrapAny(call.getExpression())
    const text = callee.getText()
    const out = NONE()
    // \`super(...)\`: the base class's constructor, which only builds the new object unless it's in the repo.
    if (callee.getKind() === SyntaxKind.SuperKeyword) {
      const cls = call.getFirstAncestorByKind(SyntaxKind.ClassDeclaration)?.getBaseClass()
      if (cls && !cls.getSourceFile().isInNodeModules() && !cls.getSourceFile().isDeclarationFile()) {
        for (const c of cls.getConstructors()) if (c.getBody()) merge(out, this.summary(c as unknown as FunctionLike, active, depth + 1))
      }
      return out
    }
    // Functions handed in by name (`us.forEach(demote)`) run here.
    for (const a of call.getArguments()) {
      const arg = unwrapAny(a)
      if (!Node.isIdentifier(arg) && !Node.isPropertyAccessExpression(arg)) continue
      if (!arg.getType().getCallSignatures().length) continue
      const symbol = arg.getSymbol()
      const decl = (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations()[0]
      const init = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined
      const target = decl && isFunctionLike(decl) ? decl : init && isFunctionLike(init) ? init : undefined
      if (target && target.getBody() && this.isRepo(target) && trusted(target)) merge(out, this.summary(target, active, depth + 1))
      else merge(out, { ...NONE(), effect: true, anyField: true })
    }
    if (pureCall(call)) return out
    const fn = resolveCallee(call)
    if (fn && fn.getBody() && this.isRepo(fn) && trusted(fn)) {
      merge(out, this.summary(fn, active, depth + 1))
      // A subclass can override the method that's called.
      for (const o of this.overrides(fn)) {
        if (o.getBody() && this.isRepo(o)) merge(out, this.summary(o, active, depth + 1))
        else merge(out, { ...NONE(), effect: true, anyField: true })
      }
      return out
    }
    if (text === 'Object.assign' && call.getArguments()[0]) {
      const t = changeableType(call.getArguments()[0]!)
      if (t) addType(out, t)
      return out
    }
    if (Node.isPropertyAccessExpression(callee)) {
      const name = callee.getName()
      if (MUTATING_METHODS.has(name)) {
        if (freshLocal(callee.getExpression())) return out
        const t = changeableType(callee.getExpression())
        if (t) addType(out, t)
        else out.anyField = true
      }
      if (MUTATING_METHODS.has(name) || NON_MUTATING_METHODS.has(name)) {
        // A callback passed in runs here: what it changes is covered where it's written.
        return out
      }
    }
    // Code Vantle can't see may change what it's given. Its own answer is a lookup when it's
    // asked in a check; anywhere else the call is also an effect.
    for (const a of call.getArguments()) {
      const t = changeableType(Node.isSpreadElement(a) ? a.getExpression() : a)
      if (t) addType(out, t)
    }
    // Code Vantle can't see may change the object a method is called on. An untyped object whose
    // call's result is used (\`db.select().where()\`: a query builder) is taken as a value instead.
    if (Node.isPropertyAccessExpression(callee)) {
      const t = changeableType(callee.getExpression())
      if (t && !((t.isAny() || t.isUnknown()) && !forEffect(call))) addType(out, t)
    }
    if (!inCheck(call)) out.effect = true
    return out
  }

  /** What `new X(...)` may change: the constructor's summary for a class in the repo, else as an unseen call. */
  newEffect(n: NewExpression, active = new Set<FunctionLike>(), depth = 0): Summary {
    // The error a \`throw\` builds (\`throw new AuthError(m)\`) is taken to only build itself.
    if (Node.isThrowStatement(n.getParent())) return NONE()
    const name = n.getExpression().getText()
    if (/^(Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|Map|Set|WeakMap|WeakSet|Date|Array|Object|Promise|URL|URLSearchParams|RegExp)$/.test(name)) return NONE()
    const symbol = n.getExpression().getSymbol()
    // Through an import to the class itself.
    const decl = (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations()[0]
    if (decl && Node.isClassDeclaration(decl) && !decl.getSourceFile().isInNodeModules() && !decl.getSourceFile().isDeclarationFile() && !decl.hasDeclareKeyword()) {
      // The nearest class up the chain that has a constructor (a subclass without one runs its base's).
      let cls: ClassDeclaration | undefined = decl
      while (cls && !cls.getConstructors().length) cls = cls.getBaseClass()
      const out = NONE()
      if (!cls) return out
      if (cls.getSourceFile().isInNodeModules() || cls.getSourceFile().isDeclarationFile() || cls.hasDeclareKeyword()) return { ...NONE(), effect: !inCheck(n) }
      for (const c of cls.getConstructors()) if (c.getBody()) merge(out, this.summary(c as unknown as FunctionLike, active, depth + 1))
      return out
    }
    const out: Summary = { ...NONE(), effect: !inCheck(n) }
    for (const a of n.getArguments() ?? []) {
      const t = changeableType(a)
      if (t) addType(out, t)
    }
    return out
  }

  /**
   * Every place in `fn` that may change something, in order: field writes, whole-object
   * changes and calls. A call in a check counts only for what a repo helper changes.
   * Changes inside a function written in `fn` and kept to run later are marked floating.
   */
  changesIn(fn: FunctionLike): Change[] {
    const known = this.sites.get(fn)
    if (known) return known
    const out: Change[] = []
    const file = this.rel(fn.getSourceFile().getFilePath())
    const visit = (n: Node, floating: boolean) => {
      if (n !== fn && isFunctionLike(n)) {
        // A callback handed to a call runs during that call, so its changes sit where it's written.
        // Any other function written here (kept in a variable, a property, returned) can run later,
        // between any two checks.
        const argument = Node.isCallExpression(n.getParent()) && (n.getParent() as CallExpression).getArguments().includes(n as never)
        n.forEachChild((c) => visit(c, floating || !argument))
        return
      }
      const own = this.direct(n, fn)
      if (own) out.push({ ...own, file, at: n.getStart(), node: n, ...(floating ? { floating } : {}) })
      const s = Node.isCallExpression(n) ? this.callEffect(n) : Node.isNewExpression(n) ? this.newEffect(n) : undefined
      if (s && !empty(s)) out.push({ ...s, file, at: n.getStart(), node: n, ...(floating ? { floating } : {}) })
      n.forEachChild((c) => visit(c, floating))
    }
    fn.getBody()?.forEachChild((c) => visit(c, false))
    this.sites.set(fn, out)
    return out
  }

  /**
   * The changes in `fn` that can happen before `at`: anywhere in a loop around it, in a
   * callback (which can run at any time), or written earlier on a route that can still go on
   * to `at` (not in the other branch of an \`if\`, nor in a branch that has returned or thrown).
   */
  before(fn: FunctionLike, at: Node): Change[] {
    const known = this.befores.get(at)
    if (known) return known
    const loop = outermostLoop(at, fn)
    const start = at.getStart()
    const out = this.changesIn(fn).filter((c) => c.floating || (loop && c.at >= loop.getStart() && c.at < loop.getEnd()) || (c.at < start && canPrecede(c.node, at)))
    this.befores.set(at, out)
    return out
  }

  /** Field names `fn` reads (helpers it calls included), and whether a check of its asks a call (a lookup). */
  readsOf(fn: FunctionLike, active = new Set<FunctionLike>(), depth = 0): Reads {
    const known = this.reads.get(fn)
    if (known) return known
    if (active.has(fn) || depth > 12) return { fields: new Set(), types: new Map(), calls: true, all: true }
    active.add(fn)
    const fields = new Set<string>()
    const types = new Map<string, Type[] | undefined>()
    const note = (f: string, t: Type | undefined) => {
      fields.add(f)
      const list = types.has(f) ? types.get(f) : []
      if (!list) return
      if (!t || list.length >= 8) types.set(f, undefined)
      else if (!list.some((u) => u.compilerType === t.compilerType)) types.set(f, [...list, t])
    }
    let calls = false
    let all = false
    fn.getBody()?.forEachDescendant((n) => {
      if (Node.isPropertyAccessExpression(n)) note(n.getName(), n.getExpression().getType())
      else if (Node.isElementAccessExpression(n)) all = true
      else if (Node.isIdentifier(n)) {
        const v = outsideVariable(n, fn)
        if (v) fields.add(v)
      } else if (Node.isCallExpression(n)) {
        // Only a call a check asks, directly or through a variable it reads, can answer differently after an effect.
        if (!pureCall(n) && (inCheck(n) || !!n.getFirstAncestorByKind(SyntaxKind.VariableDeclaration))) calls = true
        const callee = resolveCallee(n)
        if (callee && callee.getBody() && this.isRepo(callee)) {
          const r = this.readsOf(callee, active, depth + 1)
          for (const f of r.fields) {
            const ts = r.types.get(f)
            if (ts) for (const t of ts) note(f, t)
            else note(f, undefined)
          }
          all ||= r.all
        }
      }
    })
    active.delete(fn)
    // Cached even when a recursive call stood in as "reads anything": that only makes it broader.
    const out = { fields, types, calls, all }
    this.reads.set(fn, out)
    return out
  }

  private subclasses?: Map<Node, ClassDeclaration[]>

  /**
   * Methods of subclasses (at any depth) that override \`fn\`, when it's a class method.
   * Subclasses are found once per extraction from every class's \`extends\`: asking ts-morph
   * for a class's derived classes searches the whole project each time.
   */
  overrides(fn: FunctionLike): FunctionLike[] {
    if (!Node.isMethodDeclaration(fn)) return []
    const cls = fn.getParent()
    if (!Node.isClassDeclaration(cls)) return []
    if (!this.subclasses) {
      this.subclasses = new Map()
      for (const file of fn.getProject().getSourceFiles()) {
        if (file.isDeclarationFile() || file.isInNodeModules()) continue
        for (const c of file.getDescendantsOfKind(SyntaxKind.ClassDeclaration)) {
          const base = c.getBaseClass()
          if (base) this.subclasses.set(base, [...(this.subclasses.get(base) ?? []), c])
        }
      }
    }
    const name = fn.getName()
    const out: FunctionLike[] = []
    const seen = new Set<Node>()
    const visit = (c: Node) => {
      for (const d of this.subclasses!.get(c) ?? []) {
        if (seen.has(d)) continue
        seen.add(d)
        out.push(...d.getInstanceMethods().filter((m) => m.getName() === name))
        visit(d)
      }
    }
    visit(cls)
    return out
  }

  /** Whether a change could matter to a helper that reads `reads`. */
  relevant(c: Change, reads: Reads): boolean {
    if (reads.all || c.anyField) return !empty(c)
    if (c.effect && reads.calls) return true
    for (const f of c.fields) if (reads.fields.has(f)) return true
    for (const t of c.types) {
      for (const f of reads.fields) {
        const ts = reads.types.get(f)
        if (ts ? ts.some((r) => mayHold(t, f, r)) : mayHold(t, f, undefined)) return true
      }
    }
    return false
  }
}

const freshCache = new WeakMap<Node, boolean>()

/** A variable that only ever holds an object made right where it's declared, so nothing else can be it. */
function freshLocal(expr: Node): boolean {
  const e = unwrapAny(expr)
  if (!Node.isIdentifier(e)) return false
  const decls = e.getSymbol()?.getDeclarations() ?? []
  if (decls.length !== 1 || !Node.isVariableDeclaration(decls[0]!)) return false
  const d = decls[0]
  const known = freshCache.get(d)
  if (known !== undefined) return known
  const fresh = freshDeclaration(d, e)
  freshCache.set(d, fresh)
  return fresh
}

function freshDeclaration(d: import('ts-morph').VariableDeclaration, e: Node): boolean {
  // \`const\` only, so it can't be pointed at something else later.
  if (d.getVariableStatement()?.getDeclarationKind() !== 'const') return false
  const init = d.getInitializer()
  const i = init && unwrapAny(init)
  if (!i || !(Node.isObjectLiteralExpression(i) || Node.isArrayLiteralExpression(i) || Node.isArrowFunction(i) || Node.isFunctionExpression(i))) return false
  // And it's never handed anywhere: every use reads or writes one of its own properties.
  const symbol = e.getSymbol()
  // Only a function's own variable: a module's object can be read and changed from anywhere.
  const scope = d.getFirstAncestor((a) => isFunctionLike(a))
  if (!scope) return false
  return scope.getDescendantsOfKind(SyntaxKind.Identifier).every((id) => {
    if (id === d.getNameNode() || id.getSymbol() !== symbol) return true
    const parent = id.getParent()
    return (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) && parent.getExpression() === id
  })
}

/**
 * Whether code at \`change\`, written before \`check\`, can run before it on one route. Not when
 * they're in different branches of an \`if\` or \`?:\`, or in different \`case\`s where the earlier
 * one can't fall through; and not when the change sits in a branch that always returns or throws.
 * (Loops are handled by the caller.)
 */
export function canPrecede(change: Node, check: Node): boolean {
  const above = new Set<Node>()
  for (let p: Node | undefined = check; p; p = p.getParent()) above.add(p)
  // A change in a \`try\` block reaches its catch and \`finally\` however its branch ends.
  for (let p = change.getParent(), c: Node = change; p; c = p, p = p.getParent()) {
    if (isFunctionLike(p)) break
    if (Node.isTryStatement(p) && c === p.getTryBlock()) {
      const handler = p.getCatchClause()
      const fin = p.getFinallyBlock()
      if ((handler && above.has(handler)) || (fin && above.has(fin))) return true
    }
  }
  let child: Node = change
  for (let p = change.getParent(); p; child = p, p = p.getParent()) {
    if (above.has(p)) {
      // \`p\` holds both: are they on branches that exclude each other?
      const other = [...p.getChildren()].find((c) => above.has(c))
      if (Node.isIfStatement(p) && other && child !== p.getExpression() && other !== p.getExpression()) return false
      if (Node.isConditionalExpression(p) && other && child !== p.getCondition() && other !== p.getCondition()) return false
      if (Node.isCaseBlock(p) && other) {
        // Clauses run in order; an earlier one reaches a later one only by falling through.
        const clauses = p.getClauses()
        const from = clauses.indexOf(child as never)
        const to = clauses.indexOf(other as never)
        if (from >= 0 && to > from && clauses.slice(from, to).some((c) => endsInExit(c.getStatements(), true))) return false
      }
      return true
    }
    // Past a function boundary (a callback), nothing below says anything about this function.
    if (isFunctionLike(p)) return true
    // A \`return\` or \`throw\` only ends the function it's written in: these rules hold when that's
    // the function holding the check, not a callback around the change.
    const own = p.getFirstAncestor((a) => isFunctionLike(a))
    if (own && !above.has(own)) continue
    // Code in a \`return\` or \`throw\` that doesn't hold the check ends the function there.
    if (Node.isReturnStatement(p) || Node.isThrowStatement(p)) return false
    // A branch of an \`if\` or a \`case\` that always returns or throws never goes on to code after it.
    const parent = p.getParent()
    if ((Node.isBlock(p) || Node.isCaseClause(p) || Node.isDefaultClause(p)) && endsInExit(p.getStatements(), false) && parent && (Node.isIfStatement(parent) || Node.isCaseBlock(parent))) {
      return false
    }
  }
  return true
}

/** True when the last statement is a \`return\` or \`throw\` (or, with \`orBreak\`, a \`break\` or \`continue\`). */
function endsInExit(statements: Node[], orBreak: boolean): boolean {
  const last = statements.at(-1)
  if (!last) return false
  if (Node.isReturnStatement(last) || Node.isThrowStatement(last)) return true
  if (orBreak && (Node.isBreakStatement(last) || Node.isContinueStatement(last))) return true
  if (Node.isBlock(last)) return endsInExit(last.getStatements(), orBreak)
  return false
}

/** The outermost loop around `node` inside `fn`: its checks run again on later passes. */
export function outermostLoop(node: Node, fn: FunctionLike): Node | undefined {
  let found: Node | undefined
  for (let p = node.getParent(); p && p !== fn; p = p.getParent()) {
    if (isFunctionLike(p)) break
    if (Node.isForStatement(p) || Node.isForOfStatement(p) || Node.isForInStatement(p) || Node.isWhileStatement(p) || Node.isDoStatement(p)) found = p
  }
  return found
}

/** A key for a change, stable within one extraction. */
export function changeKey(c: Change): string {
  return shortHash(`${c.file}:${c.at}`)
}

/**
 * For a variable declared outside `fn` (a module variable, or one a closure captured), a
 * name for it that changes and reads can share, like a field: `$var:<file>:<offset>`.
 */
export function outsideVariable(id: Node, fn: Node): string | undefined {
  const symbol = id.getSymbol()
  const decl = (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations()[0]
  if (!decl || !(Node.isVariableDeclaration(decl) || Node.isBindingElement(decl) || Node.isParameterDeclaration(decl))) return undefined
  if (decl.getSourceFile() === fn.getSourceFile() && decl.getStart() >= fn.getStart() && decl.getEnd() <= fn.getEnd()) return undefined
  return `$var:${shortHash(decl.getSourceFile().getFilePath())}:${decl.getStart()}`
}

/**
 * Whether the function a call resolved to is the one that runs. Not when it's the starting
 * value of a variable that can be pointed elsewhere (`let hook = () => {}`), or a value
 * stored in a property.
 */
function trusted(fn: FunctionLike): boolean {
  const parent = fn.getParent()
  if (parent && Node.isVariableDeclaration(parent)) return parent.getVariableStatement()?.getDeclarationKind() === 'const'
  if (parent && (Node.isPropertyAssignment(parent) || Node.isBinaryExpression(parent))) return false
  return true
}


