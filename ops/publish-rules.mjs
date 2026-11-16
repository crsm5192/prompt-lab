import { readFileSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { validateRules } from '../web/rule-store.js'

const missing = Symbol('missing')
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
const clone = (v) => v === missing ? missing : structuredClone(v)
const get = (v, k) => Object.hasOwn(v, k) ? v[k] : missing

// 只应用本地相对基线的变更，保留线上其他编辑；同一字段冲突时拒绝覆盖。
export function mergeRuleChanges(before, desired, current, path = '') {
  if (isDeepStrictEqual(before, desired)) return clone(current)
  if (isDeepStrictEqual(current, before) || isDeepStrictEqual(current, desired)) return clone(desired)
  if (object(before) && object(desired) && object(current)) {
    const entries = []
    for (const key of new Set([...Object.keys(current), ...Object.keys(before), ...Object.keys(desired)])) {
      const value = mergeRuleChanges(get(before, key), get(desired, key), get(current, key), `${path}/${key}`)
      if (value !== missing) entries.push([key, value])
    }
    return Object.fromEntries(entries)
  }
  throw new Error(`线上规则有冲突，未覆盖：${path || '/'}`)
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name) => args.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3)
  const baseline = option('baseline'), source = option('rules'), record = option('record')
  if (!baseline || !source || !record) throw new Error('需要 --baseline=文件 --rules=文件 --record=验收记录；加 --apply 才写入')
  const base = new URL(option('url') || 'http://10.147.18.102:33002')
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('无效服务地址')
  const read = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\ufeff/, ''))
  const old = validateRules(read(baseline)), desired = validateRules(read(source))
  const response = await fetch(new URL('/api/rules', base), { signal: AbortSignal.timeout(15000) })
  const current = await response.json()
  if (!response.ok || !current.ok || !current.writable) throw new Error('线上规则不可读取或不可写')
  const merged = validateRules(mergeRuleChanges(old, desired, current.rules))
  const evidence = { checkedAt: new Date().toISOString(), url: base.href, before: current.rules, merged, applied: false }
  writeFileSync(record, JSON.stringify(evidence, null, 2) + '\n')
  if (args.includes('--apply')) {
    const res = await fetch(new URL('/api/rules', base), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: merged }), signal: AbortSignal.timeout(15000),
    })
    const result = await res.json()
    if (!res.ok || !result.ok) throw new Error(result.error || '规则保存失败')
    const check = await fetch(new URL('/api/rules', base), { signal: AbortSignal.timeout(15000) })
    const saved = await check.json()
    if (!check.ok || !isDeepStrictEqual(saved.rules, merged) || saved.warning) throw new Error('线上规则复验失败')
    Object.assign(evidence, { applied: true, backup: result.backup, verifiedAt: new Date().toISOString() })
    writeFileSync(record, JSON.stringify(evidence, null, 2) + '\n')
  }
  console.log(JSON.stringify({ applied: evidence.applied, record, backup: evidence.backup || null }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
