import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { inputError } from './output.js'

export function createCabinet(path) {
  function list() {
    try {
      const items = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(items) || !items.every(entry => entry && typeof entry.id === 'string'
        && typeof entry.name === 'string' && typeof entry.text === 'string' && entry.text.trim()
        && Number.isSafeInteger(entry.version) && ['blend', 'prefix'].includes(entry.mode))) throw new Error()
      return items
    }
    catch (error) {
      if (error.code === 'ENOENT') return []
      throw new Error('无法读取提示词柜')
    }
  }

  function save(items) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = path + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(temp, JSON.stringify(items), { flag: 'wx', mode: 0o600 })
      renameSync(temp, path)
    } finally { rmSync(temp, { force: true }) }
  }

  function change(action, body = {}) {
    const items = list()
    const index = items.findIndex(entry => entry.id === body.id)
    if (action !== 'create' && (index < 0 || items[index].version !== body.version)) {
      throw Object.assign(new Error('条目已在别处修改或删除，请重新载入提示词柜。'), { status: 409 })
    }
    if (action === 'delete') items.splice(index, 1)
    else {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      const mode = body.mode ?? 'blend'
      if (!name || !text || name.length > 100 || text.length > 8000) throw inputError('请填写名称（最多 100 字）和内容（最多 8000 字）')
      if (!['blend', 'prefix'].includes(mode)) throw inputError('未知的条目用法')
      const entry = { id: action === 'create' ? randomUUID() : body.id, version: action === 'create' ? 1 : body.version + 1, name, text, mode }
      if (action === 'create') items.push(entry)
      else items[index] = entry
    }
    save(items)
    return items
  }

  function select(ids, mode) {
    if (ids === undefined) return []
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw inputError('无效的提示词柜选项')
    if (!ids.length) return []
    if (!['gen', 'refine'].includes(mode)) throw inputError('提示词柜可用于生成和润色')
    const entries = new Map(list().map(entry => [entry.id, entry]))
    return ids.map(id => {
      if (!entries.has(id)) throw inputError('选中的条目已删除，请重新载入提示词柜')
      return entries.get(id)
    })
  }
  return { list, change, select }
}

export function prependEntries(positive, prefixes, family) {
  function join(text) {
    // A refinement can already start with the selected literals.
    for (;;) {
      const found = prefixes.find(p => text.startsWith(p) && (!text[p.length] || /[\s,，]/.test(text[p.length])))
      if (!found) break
      text = text.slice(found.length).replace(/^[\s,，]+/, '')
    }
    return [...prefixes, text].filter(Boolean).reduce((a, b) =>
      a + (/[.,;:!?，。；：！？]$/.test(a) ? ' ' : ', ') + b)
  }
  if (family.kind === 'NL+layout' && positive.trimStart().startsWith('{')) {
    const layout = JSON.parse(positive)
    if (typeof layout.summary?.caption !== 'string') throw Object.assign(new Error('MOSS Layout 缺少全局描述'), { status: 502 })
    layout.summary.caption = join(layout.summary.caption)
    return JSON.stringify(layout)
  }
  return join(positive)
}
