// 运行时设置测试：覆盖优先级、密钥不回显、原子写入、模型清单解析。
import assert from 'node:assert'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSettings } from './settings.js'

let pass = 0, fail = 0
function t(label, fn) {
  try { fn(); pass++; console.log(`  ✓ ${label}`) }
  catch (e) { fail++; console.log(`  ✗ ${label}\n      ${e.message}`) }
}
const eq = (a, b, msg) => assert.strictEqual(a, b, msg || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`)

console.log('='.repeat(70))
console.log(' 运行时设置')
console.log('='.repeat(70))

const defaults = {
  baseURL: 'http://default.local/v1',
  apiKeyEnv: 'TEST_LLM_KEY',
  baseURLEnv: 'TEST_LLM_BASE',
  defaultModel: 'model-a',
  models: [{ id: 'model-a' }, { id: 'model-b' }],
  timeoutSeconds: 120,
  maxTokens: 4000,
}

const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-settings-'))
  return { dir, s: createSettings({ dir, defaults }) }
}

// 每个用例用干净环境
delete process.env.TEST_LLM_KEY
delete process.env.TEST_LLM_BASE

console.log('\n[1] 默认值与优先级')
{
  const { dir, s } = mk()
  t('无任何设置时回落 config.json', () => {
    const r = s.resolve()
    eq(r.baseURL, 'http://default.local/v1')
    eq(r.defaultModel, 'model-a')
    eq(r.source.baseURL, 'config')
    eq(r.source.apiKey, 'none')
  })
  t('保存后覆盖 config.json', () => {
    s.save({ baseURL: 'https://saved.example/v1', defaultModel: 'model-b' })
    const r = s.resolve()
    eq(r.baseURL, 'https://saved.example/v1')
    eq(r.defaultModel, 'model-b')
    eq(r.source.baseURL, 'settings')
  })
  t('环境变量优先级最高', () => {
    process.env.TEST_LLM_BASE = 'http://env.example/v1'
    process.env.TEST_LLM_KEY = 'env-key'
    const r = s.resolve()
    eq(r.baseURL, 'http://env.example/v1')
    eq(r.apiKey, 'env-key')
    eq(r.source.baseURL, 'env')
    eq(r.source.apiKey, 'env')
    delete process.env.TEST_LLM_BASE
    delete process.env.TEST_LLM_KEY
  })
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n[2] 密钥安全')
{
  const { dir, s } = mk()
  t('publicView 不含密钥明文', () => {
    s.save({ apiKey: 'super-secret-value' })
    const v = s.publicView()
    const dump = JSON.stringify(v)
    assert(!dump.includes('super-secret-value'), '密钥泄漏到 publicView！')
    eq(v.hasApiKey, true)
    assert(v.apiKeyMask.length > 0, '应有掩码')
  })
  t('密钥落单独文件，不进 settings.json', () => {
    const sj = readFileSync(join(dir, 'settings.json'), 'utf8')
    assert(!sj.includes('super-secret-value'), 'settings.json 里出现密钥！')
    assert(existsSync(join(dir, 'llm-key.txt')), '密钥文件不存在')
    eq(readFileSync(join(dir, 'llm-key.txt'), 'utf8').trim(), 'super-secret-value')
  })
  t('传掩码或空值不覆盖已有密钥', () => {
    s.save({ apiKey: '••••••••' })          // 前端把掩码原样回传
    eq(s.resolve().apiKey, 'super-secret-value')
    s.save({ apiKey: undefined })            // 不传
    eq(s.resolve().apiKey, 'super-secret-value')
  })
  t('显式空字符串 = 清除', () => {
    s.save({ apiKey: '' })
    eq(s.resolve().apiKey, '')
    eq(s.publicView().hasApiKey, false)
  })
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n[3] 模型清单')
{
  const { dir, s } = mk()
  t('接受字符串数组', () => {
    s.save({ models: ['m1', 'm2'] })
    eq(s.resolve().models.map((m) => m.id).join(','), 'm1,m2')
  })
  t('接受对象数组并保留 label', () => {
    s.save({ models: [{ id: 'm3', label: '模型三' }] })
    eq(s.resolve().models[0].label, '模型三')
  })
  t('过滤无效条目', () => {
    s.save({ models: [{ id: 'm4' }, null, { label: '无 id' }, '  '] })
    eq(s.resolve().models.length, 1)
    eq(s.resolve().models[0].id, 'm4')
  })
  t('传空数组回落到 config.json 的模型', () => {
    s.save({ models: [] })
    eq(s.resolve().models.length, 2)
    eq(s.resolve().source.models, 'config')
  })
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n[4] 健壮性')
{
  const { dir, s } = mk()
  t('settings.json 损坏时回落默认值', () => {
    writeFileSync(join(dir, 'settings.json'), '{坏掉的 JSON', 'utf8')
    const r = s.resolve()
    eq(r.baseURL, 'http://default.local/v1')
  })
  t('baseURL 末尾斜杠被归一化', () => {
    s.save({ baseURL: 'https://x.example/v1///' })
    eq(s.resolve().baseURL, 'https://x.example/v1')
  })
  t('写入是原子替换（不留 .tmp 残file）', () => {
    s.save({ defaultModel: 'z' })
    const junk = readdirSync(dir).filter((f) => f.includes('.tmp'))
    eq(junk.length, 0)
  })
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n======================================================================')
console.log(` 结果: ${pass} 通过 / ${fail} 失败`)
console.log('======================================================================')
process.exit(fail ? 1 : 0)
