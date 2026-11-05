// Layout 编译器测试：基准值来自官方 references/layout.md 的换算验算
// （1536×1024 画布，杯子草稿框 [176,224,800,864] → [-288,-592,352,32]）
import assert from 'node:assert'
import { compileLayoutDraft, looksLikeLayoutDraft } from './moss-layout.js'

let pass = 0, fail = 0
function t(label, fn) {
  try { fn(); pass++; console.log(`  ✓ ${label}`) }
  catch (e) { fail++; console.log(`  ✗ ${label}\n      ${e.message}`) }
}
const eq = (a, b, msg) => assert.strictEqual(a, b, msg || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`)

console.log('='.repeat(70))
console.log(' MOSS-Image Layout 编译器')
console.log('='.repeat(70))

const draft = {
  width: 1536, height: 1024,
  bbox_coord_space: 'abs', bbox_format: 'xyxy',
  summary: { meta: ['product campaign', 'studio photography'], canvas: 'single',
    caption: 'A warm studio campaign for a handmade ceramic cup.' },
  items: [
    { label: 'object', caption: 'An ivory ceramic cup.', bbox: [176, 224, 800, 864] },
    { label: 'text', caption: 'Large dark-green Chinese title.', text: '把日常，过成诗。', bbox: [928, 272, 1408, 448] },
  ],
}

t('官方换算验算：杯子框 [-288,-592,352,32]', () => {
  const out = JSON.parse(compileLayoutDraft(draft))
  eq(out.items[0].bbox.join(','), '-288,-592,352,32')
})
t('输出为单行模型格式 yxyx / abs_centralized', () => {
  const s = compileLayoutDraft(draft)
  eq(s, JSON.stringify(s && JSON.parse(s)))
  const j = JSON.parse(s)
  eq(j.bbox_format, 'yxyx')
  eq(j.bbox_coord_space, 'abs_centralized')
  assert(!('width' in j) && !('height' in j), '画布尺寸不应进 prompt')
})
t('文字字段逐字保留', () => {
  const j = JSON.parse(compileLayoutDraft(draft))
  eq(j.items[1].text, '把日常，过成诗。')
})
t('1024×1024 画布中心为原点', () => {
  const out = JSON.parse(compileLayoutDraft({
    ...draft, width: 1024, height: 1024,
    items: [{ label: 'object', caption: 'x', bbox: [0, 0, 512, 512] }],
  }))
  eq(out.items[0].bbox.join(','), '-512,-512,0,0')
})
t('小数边缘：左/下取整、右/上取整', () => {
  const out = JSON.parse(compileLayoutDraft({
    ...draft, width: 1024, height: 1024,
    items: [{ label: 'object', caption: 'x', bbox: [10.4, 20.6, 300.2, 400.8] }],
  }))
  // x1→floor(10.4)=10-512=-502；y1→floor(20.6)=20-512=-492
  // x2→ceil(300.2)=301-512=-211；y2→ceil(400.8)=401-512=-111
  eq(out.items[0].bbox.join(','), '-492,-502,-111,-211')
})
t('caption 草稿直接返回文本', () => {
  eq(compileLayoutDraft({ caption: 'A cat.' }), 'A cat.')
})
t('未知字段拒绝（防创意被静默吞掉）', () => {
  assert.throws(() => compileLayoutDraft({ ...draft, items: [{ ...draft.items[0], id: 1 }] }),
    /未知字段/)
})
t('缺 text 字段的 text 元素拒绝', () => {
  assert.throws(() => compileLayoutDraft({
    ...draft, items: [{ label: 'text', caption: 'x', bbox: [0, 0, 100, 100] }],
  }), /text 元素必须有 text 字段/)
})
t('非 16 倍数尺寸拒绝', () => {
  assert.throws(() => compileLayoutDraft({ ...draft, width: 1000 }), /16 的正整数倍/)
})
t('出界框拒绝', () => {
  assert.throws(() => compileLayoutDraft({
    ...draft, items: [{ label: 'object', caption: 'x', bbox: [-10, 0, 100, 100] }],
  }), /超出/)
})
t('识别器：草稿认得出来，caption 和散文不误判', () => {
  eq(looksLikeLayoutDraft(JSON.stringify(draft)), true)
  eq(looksLikeLayoutDraft('{"caption":"A cat."}'), false)
  eq(looksLikeLayoutDraft('1girl, solo, long hair'), false)
})

console.log('\n[11] normalizeLayoutOutput：两种输出形态都接管')

// ── normalizeLayoutOutput：两种输出形态都接管 ──
import { normalizeLayoutOutput } from './moss-layout.js'

t('草稿 → 编译并带尺寸', () => {
  const r = normalizeLayoutOutput(JSON.stringify(draft))
  eq(r.kind, 'compiled')
  eq(r.width, 1536); eq(r.height, 1024)
  eq(JSON.parse(r.positive).items[0].bbox.join(','), '-288,-592,352,32')
})
t('模型自算的中心化坐标 → 校验后原样放行', () => {
  const j = { summary: { caption: 'x' },
    items: [{ label: 'text', caption: 't', text: 'HI', bbox: [-512, -512, 0, 0] }],
    bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx' }
  const r = normalizeLayoutOutput(JSON.stringify(j))
  eq(r.kind, 'model')
  eq(JSON.parse(r.positive).items[0].bbox.join(','), '-512,-512,0,0')
})
t('中心化坐标顺序错误 → 拒绝', () => {
  const j = { summary: { caption: 'x' },
    items: [{ label: 'text', caption: 't', text: 'HI', bbox: [0, 0, -512, -512] }],
    bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx' }
  assert.throws(() => normalizeLayoutOutput(JSON.stringify(j)), /正宽高/)
})
t('草稿缺尺寸 → draft-incomplete，回填后可编译', () => {
  const noSize = { ...draft }
  delete noSize.width; delete noSize.height
  const r1 = normalizeLayoutOutput(JSON.stringify(noSize))
  eq(r1.kind, 'draft-incomplete')
  // 模拟 server 从 params.size 回填
  const backfilled = { ...JSON.parse(r1.positive), width: 1536, height: 1024 }
  const r2 = normalizeLayoutOutput(JSON.stringify(backfilled))
  eq(r2.kind, 'compiled')
  eq(JSON.parse(r2.positive).items[0].bbox.join(','), '-288,-592,352,32')
})
t('caption 散文 → null', () => {
  eq(normalizeLayoutOutput('1girl, solo'), null)
})

console.log('======================================================================')
console.log(` 结果: ${pass} 通过 / ${fail} 失败`)
console.log('======================================================================')
process.exit(fail ? 1 : 0)
