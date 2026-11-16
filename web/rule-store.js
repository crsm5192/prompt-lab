import { readFileSync, writeFileSync, mkdirSync, readdirSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { inputError } from './output.js'

const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string')
const KINDS = new Set(['tag', 'tag+NL', 'NL', 'NL+layout'])

export function validateRules(rules) {
  const reject = (message) => { throw inputError('规则无效：' + message) }
  if (!object(rules) || !object(rules.families) || !Object.keys(rules.families).length) reject('families 必须是非空对象')
  if (rules.sharedBlocks !== undefined && !object(rules.sharedBlocks)) reject('sharedBlocks 必须是对象')
  for (const [id, block] of Object.entries(rules.sharedBlocks || {})) {
    if (id.startsWith('_')) continue
    if (!object(block) || !strings(block.rules)) reject(`共享块 ${id} 的 rules 必须是字符串数组`)
  }
  for (const [id, family] of Object.entries(rules.families)) {
    if (!object(family) || !KINDS.has(family.kind)) reject(`${id} 的 kind 无效`)
    if (typeof family.label !== 'string' || !family.label.trim()) reject(`${id} 缺少 label`)
    if (!strings(family.rules)) reject(`${id}.rules 必须是字符串数组`)
    if (family.negative !== undefined && typeof family.negative !== 'string') reject(`${id}.negative 必须是文本`)
    if (family.params !== undefined && (!object(family.params) || Object.values(family.params).some((v) => !['string', 'number'].includes(typeof v)))) reject(`${id}.params 无效`)
    if (family.styles !== undefined && !object(family.styles)) reject(`${id}.styles 必须是对象`)
    for (const [name, style] of Object.entries(family.styles || {})) {
      if (!object(style) || !strings(style.rules)) reject(`${id}.styles.${name} 无效`)
    }
    if (family.sharedBlocks !== undefined && !strings(family.sharedBlocks)) reject(`${id}.sharedBlocks 必须是字符串数组`)
    for (const name of family.sharedBlocks || []) if (!Object.hasOwn(rules.sharedBlocks || {}, name) || !object(rules.sharedBlocks[name])) reject(`${id} 引用了缺失共享块 ${name}`)
    if (family.modeStyle !== undefined && !object(family.modeStyle)) reject(`${id}.modeStyle 必须是对象`)
    for (const [mode, name] of Object.entries(family.modeStyle || {})) {
      if (!mode.startsWith('_') && (typeof name !== 'string' || !Object.hasOwn(family.styles || {}, name))) reject(`${id}.modeStyle.${mode} 引用了缺失风格档`)
    }
  }
  if (rules.wording !== undefined && !object(rules.wording)) reject('wording 必须是对象')
  if (rules.wording?.banned !== undefined && !strings(rules.wording.banned)) reject('wording.banned 必须是字符串数组')
  if (rules.wording?.replacements !== undefined && (!object(rules.wording.replacements) || Object.values(rules.wording.replacements).some((v) => typeof v !== 'string'))) reject('wording.replacements 无效')
  return rules
}

export function createRuleStore({ readPath, writePath, backupDir }) {
  const parse = (text) => validateRules(JSON.parse(text))
  let current
  let warning = ''
  try { current = parse(readFileSync(readPath, 'utf8')) } catch (e) {
    const files = (() => { try { return readdirSync(backupDir).filter((n) => n.endsWith('.json')).sort().reverse() } catch { return [] } })()
    for (const file of files) {
      try { current = parse(readFileSync(join(backupDir, file), 'utf8')); break } catch { /* next backup */ }
    }
    if (!current) throw e
    warning = '规则文件损坏，已使用最近有效备份；请重新保存规则'
  }
  let lastText = JSON.stringify(current)
  function refresh() {
    try {
      const text = readFileSync(readPath, 'utf8')
      if (text !== lastText) current = parse(text)
      lastText = text
      warning = ''
    } catch (e) { warning = `规则文件无效，继续使用上次有效规则：${e.message}` }
    return current
  }
  function durableWrite(file, text) {
    // Preserve the inode: read and write paths are two binds of the same file.
    writeFileSync(file, text, 'utf8')
    const fd = openSync(file, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
  function save(next) {
    validateRules(next)
    if (!writePath) throw inputError('规则未配置可写路径')
    const text = JSON.stringify(next, null, 2) + '\n'
    const previous = JSON.stringify(refresh(), null, 2) + '\n'
    mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    const backup = join(backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`)
    writeFileSync(backup, previous, { mode: 0o600 })
    try { durableWrite(writePath, text) } catch (error) {
      try { durableWrite(writePath, previous) } catch (rollback) { error.message += `；恢复失败，备份位于 ${backup}：${rollback.message}` }
      throw error
    }
    current = parse(text)
    lastText = text
    warning = ''
    return { rules: current, backup }
  }
  return { refresh, save, get warning() { return warning } }
}
