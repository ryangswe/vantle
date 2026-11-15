import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// vantle-map's anchor checker is a Python script; these cases run it on small synthetic files.
const script = path.resolve(import.meta.dirname, '../docs/receipts/skills/vantle-map/check_anchors.py')

const files: Record<string, string> = {
  'store.ts': `
export class Store<T> extends Base<T> implements Saver {
  private cache = new Map<string, T>()
  count: number = 0
  maybe?(): void
  static create() { return new Store() }
  async load(id: string): Promise<T> {
    const save = (x: T) => x
    function flush() {}
    class Inner { persist() {} }
    return save(this.cache.get(id)!)
  }
  get size() { return this.cache.size }
  *items() {}
  #secret() {}
  handler = () => {}
  @Get() find() {}
  // remove() {}
  label = 'drop() {'
}

export class Repo<T extends { id: string }> extends mixin({ tag: 1 }) {
  private readonly client =
    createClient(opts)
  readonly enabled =
    env.X === '1' ||
    defaultFlag
  handle = (x: T) =>
    route(x)
  query(id: string) {}
}

function elsewhere() {
  const remove = 1
  let drop = 2
}
`,
  'api.ts': `
export const api = {
  get(id: string) { const put = 1; return id },
  list: () => [],
}
export namespace Outer {
  export function slug() {}
  export class Inner { run() {} }
}
enum Color { Red, Green = 2 }
interface Port { send(msg: string): void }
enum Level {
  Low,
  High,
}
`,
  'client.ts': `
export class Client {
  baseUrl = 'https://api'
  fetch() {}
  name = "x"
  first() {}
  t = \`x\`
  second() {}
  re = /x/
  third() {}
  mode: 'a' | 'b' = 'a'
  fourth() {}
  odd() {
    if (x) return'}'
    const tucked = 1
  }
}
interface Kind {
  kind: 'a'
  run(): void
}
let lone, paired = {
  inside: 1,
}
`,
  'view.tsx': `
export class View {
  render() { return <p>don't stop</p> }
  clean(s: string) { return s.replace(/['"]/g, '') }
  split(s: string) {
    const parts = s.split(/}/)
    const hidden = 1
  }
  show() {}
}
`,
  'store.py': `
class Store(Base):
    """def fake(self): pass"""
    limit: int = 3
    name = "x"

    @property
    def size(self):
        save = 1
        return save

    async def load(self):
        class Local:
            def persist(self): pass

    class Inner:
        def run(self): pass


class Other:
    def remove(self): pass
    options = dict(
    inner=1)
`,
  'server.go': `
package main

type Server struct {
  addr string
}

func (s *Server) Start() error {
  stop := 1
  return nil
}

type Client struct{}

func (c *Client) Connect() error { return nil }
`,
}
// [file, symbol, expected to be found]
const cases: [string, string, boolean][] = [
  // the reported hole: a local with the member's name, inside another method or function
  ['store.ts', 'Store.save', false],
  ['store.ts', 'Store.flush', false],
  ['store.ts', 'Store.remove', false],
  ['store.ts', 'Store.drop', false],
  ['store.ts', 'Store.persist', false],
  ['store.ts', 'Store.load', true],
  ['store.ts', 'Store.create', true],
  ['store.ts', 'Store.cache', true],
  ['store.ts', 'Store.count', true],
  ['store.ts', 'Store.maybe', true],
  ['store.ts', 'Store.size', true],
  ['store.ts', 'Store.items', true],
  ['store.ts', 'Store.secret', true],
  ['store.ts', 'Store.handler', true],
  ['store.ts', 'Store.find', true],
  ['store.ts', 'Store.label', true],
  ['store.ts', 'Nowhere.load', false],
  ['store.ts', 'Store.Inner.persist', false],
  // generics and an extends call before the body, and initializers that continue on the next line
  ['store.ts', 'Repo.query', true],
  ['store.ts', 'Repo.client', true],
  ['store.ts', 'Repo.enabled', true],
  ['store.ts', 'Repo.handle', true],
  ['store.ts', 'Repo.id', false],
  ['store.ts', 'Repo.tag', false],
  ['store.ts', 'Repo.createClient', false],
  ['store.ts', 'Repo.defaultFlag', false],
  ['store.ts', 'Repo.route', false],
  // a line that ends in a string, template or regex doesn't hide the member after it
  ['client.ts', 'Client.fetch', true],
  ['client.ts', 'Client.first', true],
  ['client.ts', 'Client.second', true],
  ['client.ts', 'Client.third', true],
  ['client.ts', 'Client.fourth', true],
  ['client.ts', 'Kind.run', true],
  ['client.ts', 'Client.tucked', false],
  ['client.ts', 'lone.inside', false],
  // an apostrophe in JSX text and quotes or braces in a regex don't hide the rest of the class
  ['view.tsx', 'View.show', true],
  ['view.tsx', 'View.clean', true],
  ['view.tsx', 'View.hidden', false],
  // plain names keep matching anywhere in the file
  ['store.ts', 'remove', true],
  ['store.ts', 'save', true],
  ['store.ts', 'Store', true],
  ['api.ts', 'api.get', true],
  ['api.ts', 'api.list', true],
  ['api.ts', 'api.put', false],
  ['api.ts', 'Outer.slug', true],
  ['api.ts', 'Outer.Inner.run', true],
  ['api.ts', 'Outer.run', false],
  ['api.ts', 'Color.Red', true],
  ['api.ts', 'Color.Green', true],
  ['api.ts', 'Color.Blue', false],
  ['api.ts', 'Port.send', true],
  ['api.ts', 'Level.Low', true],
  ['api.ts', 'Level.High', true],
  ['store.py', 'Store.size', true],
  ['store.py', 'Store.load', true],
  ['store.py', 'Store.limit', true],
  ['store.py', 'Store.name', true],
  ['store.py', 'Store.Inner.run', true],
  ['store.py', 'Store.save', false],
  ['store.py', 'Store.fake', false],
  ['store.py', 'Store.Local.persist', false],
  ['store.py', 'Store.persist', false],
  ['store.py', 'Store.remove', false],
  ['store.py', 'Other.remove', true],
  ['store.py', 'Other.options', true],
  ['store.py', 'Other.inner', false],
  ['server.go', 'Server.Start', true],
  ['server.go', 'Server.Stop', false],
  ['server.go', 'Server.stop', false],
  ['server.go', 'Client.Connect', true],
  ['server.go', 'Client.Start', false],
]

describe('vantle-map anchor check', () => {
  let repo = ''
  const found = new Map<string, boolean>()
  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'vantle-anchors-'))
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(repo, name), text)
    const map = {
      nodes: cases.map(([file, symbol], i) => ({ id: `n${i}`, anchors: [{ path: file, symbol }] })),
    }
    const mapPath = path.join(repo, 'map.json')
    writeFileSync(mapPath, JSON.stringify(map))
    const out = JSON.parse(execFileSync('python3', ['-I', script, mapPath, repo, '--json'], { encoding: 'utf8' }))
    for (const n of out.nodes as { id: string; status: string }[]) found.set(n.id, n.status !== 'missing')
  })
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  it.each(cases.map(([file, symbol, expected], i) => ({ file, symbol, expected, id: `n${i}` })))(
    '$file $symbol found: $expected',
    ({ id, expected }) => {
      expect(found.get(id)).toBe(expected)
    },
  )
})
