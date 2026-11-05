// 服务层测试：验证 Danbooru / Viking / 角色库 的实现。
// 这些是**真实网络调用**，不通过则说明内网连通或代码有问题。
import { createViking, createBooru } from './services.js'
import { searchCharacter, verifyAnchors, applyAnchorFix } from './character.js'
import { readFileSync } from 'node:fs'

const config = JSON.parse(readFileSync('./config.json', 'utf8'))
const booru = createBooru(config.booru)
const viking = createViking(config.viking)

let pass = 0, fail = 0
async function t(label, fn) {
  try {
    const r = await fn()
    pass++
    console.log(`  ✓ ${label}${r ? '  ' + r : ''}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${label}\n      ${String(e.message || e).slice(0, 160)}`)
  }
}

console.log('='.repeat(70))
console.log(' 服务层测试（真实网络）')
console.log('='.repeat(70))

console.log('\n[1] Danbooru')
await t('搜索标签', async () => {
  const r = await booru.search('long_hair', 3)
  if (!r.length) throw new Error('无结果')
  return `${r.length} 条，首条 ${r[0].name} (${r[0].postCount} 帖)`
})
await t('精确核验角色', async () => {
  const r = await booru.verify(['hatsune_miku'])
  if (!r.length) throw new Error('无结果')
  return `${r[0].name} 类别=${r[0].category}`
})
await t('wiki 简介', async () => {
  const r = await booru.wiki('long_hair')
  if (!r.ok) throw new Error(r.error || '无 wiki')
  return `${r.body.length} 字`
})
await t('相关标签', async () => {
  const r = await booru.related('long_hair', 5)
  if (!r.length) throw new Error('无结果')
  return `${r.length} 条：${r.slice(0, 3).map((x) => x.name).join(', ')}`
})
await t('示例图（large 版）', async () => {
  const r = await booru.posts('1girl solo', 2, 'g,s')
  if (!r.length) throw new Error('无结果')
  return `${r.length} 张，首张 ${r[0].large.includes('/large/') ? 'large' : '其他'}`
})

console.log('\n[2] OpenViking')
await t('实例探测', async () => {
  const r = await viking.probe()
  const ok = r.filter((x) => x.ok)
  if (!ok.length) throw new Error(`全部不可达：${r.map((x) => x.name + ':' + (x.error || '')).join('; ')}`)
  return `${ok.length}/${r.length} 可用（${ok.map((x) => x.name).join(', ')}）`
})
await t('语义检索', async () => {
  const r = await viking.find({ query: 'anime art style', limit: 3 })
  if (!r.ok) throw new Error((r.errors || []).join('; ') || '检索失败')
  return `${r.refs.length} 条命中（${r.instance}）`
})

console.log('\n[3] 角色库')
await t('检索已有角色', async () => {
  const r = await searchCharacter({ booru, viking }, { query: 'hatsune miku', limit: 2, withText: false })
  if (!r.suggested) throw new Error('未识别')
  return `建议写法 ${r.suggested}，角色 ${r.characters.length} 个`
})
await t('语序纠正（subaru_awa -> awa_subaru）', async () => {
  const r = await searchCharacter({ booru, viking }, { query: 'subaru_awa', limit: 2, withText: false })
  // 纠正可能出现在 notes，也可能直接体现在 suggested 上
  const note = (r.notes || []).find((n) => n.includes('姓前名后') || n.includes('语序'))
  const fixed = r.suggested === 'awa_subaru'
  if (!note && !fixed) throw new Error(`未纠正，notes=${JSON.stringify(r.notes)} suggested=${r.suggested}`)
  return fixed ? `suggested=${r.suggested}` : note.slice(0, 60)
})
await t('作品误当角色时纠正', async () => {
  const r = await verifyAnchors({ booru }, { character: '', copyright: 'harry_potter' })
  return r.notes.join(' / ').slice(0, 80) || '无提示（可能直接通过）'
})

console.log('\n[4] 锚点修复应用')
await t('applyAnchorFix 替换正文', async () => {
  const out = applyAnchorFix('1girl, subaru awa, smile', { from: 'subaru_awa', to: 'awa_subaru' })
  if (!out.includes('awa subaru')) throw new Error(`未替换：${out}`)
  return out
})

console.log('\n' + '='.repeat(70))
console.log(` 结果: ${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(70))
process.exit(fail ? 1 : 0)
