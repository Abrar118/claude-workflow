// The project tree drawn in the Files section: dirs first, then files, alphabetically.

/** A file the main conversation is editing or edited in the current run. */
export type Touch = { path: string; isEditing: boolean; added: number; removed: number }

export type TreeRow = {
  depth: number
  name: string
  path: string
  isDir: boolean
  isOpen: boolean
  touch: Touch | null
  /** Changed in git (modified, staged or untracked) but not touched this run. */
  isChanged: boolean
  /** A "… N more" line standing for files and dirs not drawn; `path` is the dir that opens them. */
  more?: number
}

type Node = { name: string; path: string; dirs: Map<string, Node>; files: string[] }

const MAX_CHILDREN = 40

/** A path relative to `root`, with forward slashes; unchanged (slashes aside) when outside it. Windows paths compare without case. */
export function toRelative(path: string, root: string): string {
  const p = path.replace(/\\/g, '/')
  const r = root.replace(/\\/g, '/').replace(/\/$/, '')
  const isWindows = /^[A-Za-z]:\//.test(r)
  const [pp, rr] = isWindows ? [p.toLowerCase(), r.toLowerCase()] : [p, r]
  return r && pp.startsWith(rr + '/') ? p.slice(r.length + 1) : p
}

export function countLines(text: unknown): number {
  return typeof text === 'string' && text !== '' ? text.split('\n').length : 0
}

/** Lines an edit tool call adds and removes. */
export function editCounts(tool: string, input: Record<string, unknown>): { added: number; removed: number } {
  if (tool === 'Write') return { added: countLines(input.content), removed: 0 }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return (input.edits as { old_string?: string; new_string?: string }[]).reduce(
      (acc, x) => ({ added: acc.added + countLines(x.new_string), removed: acc.removed + countLines(x.old_string) }),
      { added: 0, removed: 0 },
    )
  }
  if (tool === 'NotebookEdit') return { added: countLines(input.new_source), removed: 0 }
  return { added: countLines(input.new_string), removed: countLines(input.old_string) }
}

function buildNodes(files: readonly string[]): Node {
  const root: Node = { name: '', path: '', dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = file.split('/')
    let node = root
    for (const name of parts.slice(0, -1)) {
      let child = node.dirs.get(name)
      if (!child) {
        child = { name, path: node.path ? `${node.path}/${name}` : name, dirs: new Map(), files: [] }
        node.dirs.set(name, child)
      }
      node = child
    }
    node.files.push(file)
  }
  return root
}

const ancestors = (path: string): string[] => path.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))

/**
 * The rows as drawn, smart by default: only touched and git-changed files show, with the dirs that lead
 * to them open; every other file folds into a "… N more" row. A dir the person opened shows all its files.
 * A dir whose only child is one dir is drawn as one row (`features/auth`).
 */
export function buildTree(
  files: readonly string[],
  touched: readonly Touch[],
  expanded: readonly string[],
  isAllOpen = false,
  changed: readonly string[] = [],
): TreeRow[] {
  const touchByPath = new Map(touched.map(t => [t.path, t]))
  const changedSet = new Set(changed)
  const isHot = (f: string) => touchByPath.has(f) || changedSet.has(f)
  const picked = new Set(expanded)
  const open = new Set(expanded)
  for (const p of [...touched.map(t => t.path), ...changed]) for (const a of ancestors(p)) open.add(a)

  const rows: TreeRow[] = []
  const walk = (node: Node, depth: number) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
    const names = [...node.files].sort((a, b) => a.localeCompare(b))
    const isFull = isAllOpen || picked.has(node.path)
    let hidden = 0
    let drawnDirs = 0
    for (const dir of dirs) {
      let d = dir
      let name = d.name
      while (d.files.length === 0 && d.dirs.size === 1) {
        d = [...d.dirs.values()][0]!
        name = `${name}/${d.name}`
      }
      // Smart: like files, only dirs on the way to a touched or changed file (or opened by the person) draw.
      if (!isFull && !open.has(d.path)) {
        hidden++
        continue
      }
      drawnDirs++
      const isOpen = isAllOpen || open.has(d.path)
      rows.push({ depth, name, path: d.path, isDir: true, isOpen, touch: null, isChanged: false })
      if (isOpen) walk(d, depth + 1)
    }
    // Touched and changed files always draw; a dir the person opened fills up to the cap with the rest.
    const keep = new Set(names.filter(isHot))
    if (isFull) {
      const room = Math.max(0, MAX_CHILDREN - drawnDirs)
      for (const f of names) {
        if (keep.size >= room) break
        keep.add(f)
      }
    }
    const drawn = names.filter(f => keep.has(f))
    for (const file of drawn)
      rows.push({ depth, name: file.split('/').at(-1)!, path: file, isDir: false, isOpen: false, touch: touchByPath.get(file) ?? null, isChanged: changedSet.has(file) && !touchByPath.has(file) })
    hidden += names.length - drawn.length
    if (hidden > 0) rows.push({ depth, name: '', path: node.path, isDir: false, isOpen: false, touch: null, isChanged: false, more: hidden })
  }
  walk(buildNodes([...new Set([...files, ...touched.map(t => t.path), ...changed])]), 0)
  return rows
}
