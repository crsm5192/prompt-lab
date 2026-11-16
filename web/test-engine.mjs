// 引擎逻辑测试：验证从 DSH 插件移植过来的纯函数行为一致。
//
// 重点测「移植后仍然正确」的部分：JSON 宽容解析、长度预算、相机角度、
// 格式规范化、安全标签兜底。
import assert from 'node:assert'
import { readFileSync } from 'node:fs'

import {
  extractJson, salvageField, cameraPrompt, cameraFromPrompt,
  measureLength, finalizeText, normalizeSeparators, stripForbidden,
  ensureSafetyTag, pickBudget, buildSystem, buildUser, wd14ToPrompt,
} from './engine.js'

const config = JSON.parse(readFileSync('./config.json', 'utf8'))
const rules = JSON.parse(readFileSync('./rules.json', 'utf8'))

// 合并规则与配置（与 server.js 的行为一致）
const merged = { ...rules, lengthBudget: config.lengthBudget, wording: rules.wording }
const fam = (id) => merged.families[id]

let pass = 0, fail = 0
function t(label, fn) {
  try { fn(); pass++; console.log(`  ✓ ${label}`) }
  catch (e) { fail++; console.log(`  ✗ ${label}\n      ${e.message}`) }
}
const eq = (a, b, msg) => assert.strictEqual(a, b, msg || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`)

console.log('='.repeat(70))
console.log(' 引擎移植测试')
console.log('='.repeat(70))

console.log('\n[1] JSON 宽容解析')
t('正常 JSON', () => {
  const r = extractJson('{"positive":"a, b","negative":"c"}')
  eq(r.positive, 'a, b')
})
t('带代码块', () => {
  eq(extractJson('```json\n{"positive":"x"}\n```').positive, 'x')
})
t('尾逗号', () => {
  eq(extractJson('{"positive":"a",}').positive, 'a')
})
t('字符串内真实换行（模型常见错误）', () => {
  const r = extractJson('{"positive":"line1\nline2","negative":"z"}')
  eq(r.positive, 'line1\nline2')
})
t('前置说明文字', () => {
  eq(extractJson('好的：\n{"positive":"p"}').positive, 'p')
})
t('单引号键', () => {
  eq(extractJson("{'positive':'m'}").positive, 'm')
})
t('彻底失败返回 null', () => {
  eq(extractJson('完全不是 JSON'), null)
})

console.log('\n[2] 剥壳兜底')
t('从畸形 JSON 抽 positive', () => {
  const bad = '{"positive": "a, b, c", "negative": "x"} 后面有杂音'
  eq(salvageField(bad, 'positive'), 'a, b, c')
})
t('还原转义换行', () => {
  eq(salvageField('{"positive":"l1\\nl2"}', 'positive'), 'l1\nl2')
})

console.log('\n[3] 格式规范化')
t('下划线转空格（anima，kind=tag+NL）', () => {
  eq(normalizeSeparators('long_hair, blue_eyes', fam('anima')), 'long hair, blue eyes')
})
// noobai 的规则2 明确要求「单词之间用空格分隔，不要下划线写法」，
// 所以它也会转换（依据是 separator:"space"，不是 kind）
t('noobai 也转空格（其规则要求空格写法）', () => {
  eq(normalizeSeparators('long_hair, blue_eyes', fam('noobai')), 'long hair, blue eyes')
})
t('未声明 separator 且 kind=tag 时保留下划线', () => {
  const custom = { kind: 'tag' }   // 没有 separator 字段
  eq(normalizeSeparators('long_hair, blue_eyes', custom), 'long_hair, blue_eyes')
})
t('score_* 不转换', () => {
  eq(normalizeSeparators('score_9, long_hair', fam('anima')), 'score 9, long hair'.replace('score 9', 'score_9'))
})
t('权重表达式', () => {
  eq(normalizeSeparators('(long_hair:1.5)', fam('anima')), '(long hair:1.5)')
})
t('LoRA 标签保护', () => {
  eq(normalizeSeparators('<lora:my_style:0.8>', fam('anima')), '<lora:my_style:0.8>')
})

console.log('\n[4] 违规内容清除')
t('删画师前缀', () => {
  const r = stripForbidden('1girl, artist:someone, smile', merged.wording)
  assert(!r.includes('artist:'), '仍有 artist:')
  assert(r.includes('1girl'))
})
t('删 @ 前缀', () => {
  const r = stripForbidden('1girl, @someone, smile', merged.wording)
  assert(!r.includes('@someone'))
})
t('删 BREAK', () => {
  const r = stripForbidden('a BREAK b', merged.wording)
  assert(!r.includes('BREAK'))
})

console.log('\n[5] 质量词与安全标签已停用')
t('不再自动补安全标签（有 NSFW 信号也不补）', () => {
  const f = fam('anima')
  eq(ensureSafetyTag('1girl, nude', f, ''), '1girl, nude')
})
t('已有 safe 原样返回', () => {
  const f = fam('anima')
  eq(ensureSafetyTag('1girl, safe', f, ''), '1girl, safe')
})
t('普通图也不补 safe', () => {
  const f = fam('anima')
  eq(ensureSafetyTag('1girl, smile', f, ''), '1girl, smile')
})
t('finalizeText 不再追加安全标签', () => {
  const r = finalizeText('1girl, smile', fam('anima'), merged, '')
  assert(!/,\s*(safe|sensitive|nsfw|explicit)$/.test(r), r)
})
t('各族的 qualityPrefix 已全部清空', () => {
  for (const [id, f] of Object.entries(merged.families)) {
    eq(f.qualityPrefix || '', '', `族 ${id} 仍有 qualityPrefix`)
    for (const [k, s] of Object.entries(f.styles || {})) {
      eq((s && s.qualityPrefix) || '', '', `族 ${id} 风格档 ${k} 仍有 qualityPrefix`)
    }
  }
})
t('WD14 兜底不再拼质量头', () => {
  const r = wd14ToPrompt({ tags: '1girl, solo', rating: 'general' }, fam('noobai'), merged)
  assert(!/masterpiece|best quality|absurdres/.test(r.positive), r.positive)
  eq(r.positive, '1girl, solo')
})
t('系统提示要求不带质量词与安全标签', () => {
  const sys = buildSystem(fam('anima'), 'gen', merged, '')
  assert(sys.includes('不要写质量词'), '缺质量词禁令')
  assert(sys.includes('不要写安全标签'), '缺安全标签禁令')
  assert(!/推荐正向前缀/.test(sys), '仍在要求正向前缀')
})

console.log('\n[6] 长度上限（实测标定）')
t('pickBudget 恒返回 null（预算改由 LEN_LIMITS 内置）', () => {
  eq(pickBudget(config.lengthBudget, fam('anima')), null)
})
t('anima 上限取自实测：300/380 token', () => {
  const m = measureLength('1girl, solo', fam('anima'), merged)
  eq(m.targetMax, 300)
  eq(m.hardMax, 380)
})
t('超目标触发 warn（未超硬限）', () => {
  // 约 345 token，介于 300 与 380 之间
  const t345 = Array(238).fill('word').join(' ')
  const m = measureLength(t345, fam('anima'), merged)
  assert(m.value > 300 && m.value <= 380, `token=${m.value}`)
  eq(m.warn, true)
  eq(m.over, false)
})
t('超硬限触发 over', () => {
  const t500 = Array(345).fill('word').join(' ')  // ≈500 token
  const m = measureLength(t500, fam('anima'), merged)
  assert(m.value > 380, `token=${m.value}`)
  eq(m.over, true)
})
t('用户实测的 688 词/963 token 会被判 over', () => {
  const big = Array(688).fill('word').join(' ')
  const m = measureLength(big, fam('anima'), merged)
  assert(m.value > 900, `token=${m.value}`)
  eq(m.over, true)
})
t('noobai 用 77 token 硬限', () => {
  const m = measureLength('1girl, solo', fam('noobai'), merged)
  eq(m.hardMax, 77)
})
t('短文本不告警', () => {
  const m = measureLength('best quality, 1girl, solo', fam('anima'), merged)
  eq(m.over, false); eq(m.warn, false)
})
t('余量计算：短文有正余量', () => {
  const m = measureLength('1girl, solo, long hair', fam('anima'), merged)
  assert(m.headroomWords > 200, `余量 ${m.headroomWords}`)
})
t('中文长度统计正确（不按空格分词）', () => {
  const cn = '超写实电影感摄影，雨夜，旧书店门口，白发少女站在门框旁。'
  const m = measureLength(cn, fam('anima'), merged)
  assert(m.cjkChars > 20, `CJK 字数应 > 20，实际 ${m.cjkChars}`)
  assert(m.words > 20, `词数应 > 20，实际 ${m.words}`)
})
t('英文长度统计正常', () => {
  const m = measureLength('1girl, solo, white hair, long hair, wet street', fam('anima'), merged)
  eq(m.latinWords, 8)
  eq(m.cjkChars, 0)
})
t('Layout JSON 不参与长度判定', () => {
  const json = JSON.stringify({ summary: { caption: 'x' }, items: [{ label: 'text', caption: 'y', text: 'z', bbox: [-1, -1, 1, 1] }] })
  const m = measureLength(json, fam('moss'), merged)
  eq(m.over, false); eq(m.warn, false)
})

t('anima 出现 JSON 文本仍要判定长度（兜底路径漏判修复）', () => {
  const big = '{ "positive": "' + Array(566).fill('word').join(' ') + '" }'
  const m = measureLength(big, fam('anima'), merged)
  eq(m.over, true, 'JSON 包裹的超长文本也应按正文判定')
})
t('moss 的 Layout JSON 跳过长度判定', () => {
  const lay = JSON.stringify({ summary: { caption: 'x'.repeat(200) }, items: [{ label: 'text', caption: 'y', text: 'z', bbox: [-1, -1, 1, 1] }] })
  const m = measureLength(lay, fam('moss'), merged)
  eq(m.over, false)
})

console.log('\n[6.5] 重复度检测')
t('同一句重复 10 次能被检出', () => {
  const rep = 'A girl stands by the window. '.repeat(10) + 'The rain falls softly.'
  const m = measureLength(rep, fam('anima'), merged)
  eq(m.repetition.top, 10)
})
t('句句不同则不报重复', () => {
  const uniq = 'The jacket fabric has a matte weave. A railing runs behind her. ' +
               'A ventilation grate exhales vapour. Storefront awnings recede down the block.'
  const m = measureLength(uniq, fam('anima'), merged)
  eq(m.repetition.top, 1)
})
t('近似重复（词袋重叠 >80%）计入 nearPairs', () => {
  const near = 'The neon light glows on the wet street. The neon light glows on the wet pavement.'
  const m = measureLength(near, fam('anima'), merged)
  assert(m.repetition.nearPairs >= 1, `nearPairs=${m.repetition.nearPairs}`)
})

console.log('\n[7] 相机角度（VNCCS 基准）')
t('az270/el30/wide -> left side view elevated shot wide shot', () => {
  eq(cameraPrompt({ azimuth: 270, elevation: 30, distance: 'wide shot' }, config.camera).text,
    'left side view elevated shot wide shot')
})
t('默认档', () => {
  eq(cameraPrompt({}, config.camera).text, 'front view eye-level shot medium shot')
})
t('8 方位全覆盖', () => {
  const want = {
    0: 'front view', 45: 'front-right quarter view', 90: 'right side view',
    135: 'back-right quarter view', 180: 'back view', 225: 'back-left quarter view',
    270: 'left side view', 315: 'front-left quarter view',
  }
  for (const [deg, w] of Object.entries(want)) {
    const got = cameraPrompt({ azimuth: Number(deg), elevation: 0, distance: 'medium shot' }, config.camera).text
    eq(got, `${w} eye-level shot medium shot`, `${deg}° 不符`)
  }
})
t('回绕 350 -> front view', () => {
  eq(cameraPrompt({ azimuth: 350 }, config.camera).text, 'front view eye-level shot medium shot')
})
t('负数 -90 -> left side view', () => {
  eq(cameraPrompt({ azimuth: -90 }, config.camera).text, 'left side view eye-level shot medium shot')
})
t('补充词：单选组只取第一个', () => {
  const r = cameraPrompt({ extras: { angle: ['dutch angle', 'pov'] } }, config.camera)
  eq(r.text, 'front view eye-level shot medium shot dutch angle')
  eq(r.extras.angle.length, 1)
})
t('补充词：多选叠加', () => {
  const r = cameraPrompt({ extras: { lens: ['bokeh', 'vignette'] } }, config.camera)
  assert(r.text.endsWith('bokeh vignette'), r.text)
})
t('冲突检测：god\'s eye + 仰俯30', () => {
  const r = cameraPrompt({ elevation: 30, extras: { angle: ["god's eye view"] } }, config.camera)
  assert(r.conflicts.length > 0, '应报冲突')
})
t('dutch angle 不算冲突', () => {
  const r = cameraPrompt({ elevation: 60, extras: { angle: ['dutch angle'] } }, config.camera)
  eq(r.conflicts.length, 0)
})
t('generic 写法', () => {
  eq(cameraPrompt({ azimuth: 270, style: 'generic' }, config.camera).text,
    'from the left side eye level medium shot')
})
t('反解角度', () => {
  const r = cameraFromPrompt('back-left quarter view high-angle shot close-up', config.camera)
  eq(r.azimuth, 225); eq(r.elevation, 60); eq(r.distance, 'close-up')
})

console.log('\n[7.5] 迭代时形态必须按族规范')
t('tag+NL 族的迭代指令要求补齐自然语言', () => {
  const sys = buildSystem(fam('anima'), 'iterate', merged, '')
  assert(/形态必须按族规范/.test(sys), '缺形态要求')
  assert(/缺自然语言段，必须补齐/.test(sys), '未点名补齐自然语言')
  assert(/不得缩水/.test(sys), '缺不得缩水约束')
})
t('NL 族不被注入「补齐自然语言段」', () => {
  const sys = buildSystem(fam('krea2'), 'iterate', merged, '')
  assert(!/缺自然语言段，必须补齐/.test(sys), 'krea2 不该有这条')
})
t('纯标签输入时用户消息点名形态不合规', () => {
  const usr = buildUser({ familyKind: 'tag+NL', positive: '1girl, solo, long hair', feedback: '加帽子' }, 'iterate')
  assert(/形态不合规/.test(usr), usr.slice(0, 200))
  assert(/补齐/.test(usr), '未要求补齐')
})
t('已有自然语言的输入不再点形态问题', () => {
  const good = '1girl, solo,\nShe stands by the window, her hair catching the warm afternoon light.'
  const usr = buildUser({ familyKind: 'tag+NL', positive: good, feedback: '改光线' }, 'iterate')
  assert(!/形态不合规/.test(usr), usr.slice(0, 200))
})
t('纯 NL 族的用户消息不点 tag 形态', () => {
  const usr = buildUser({ familyKind: 'NL', positive: 'A girl stands by a window.', feedback: '改光线' }, 'iterate')
  assert(!/形态不合规/.test(usr))
})

console.log('\n[8] 系统提示拼装')
t('含族规则', () => {
  const s = buildSystem(fam('anima'), 'gen', merged)
  assert(s.includes('Anima'), '缺族名')
  assert(!/长度预算 · 用户要留画风余量/.test(s), '不应再有旧的预算段落')
})
t('含输出格式要求', () => {
  const s = buildSystem(fam('krea2'), 'refine', merged)
  assert(s.includes('"positive"'), '缺 JSON 格式')
})

console.log('\n[9] WD14 -> 提示词')
t('标签族直接出提示词', () => {
  const r = wd14ToPrompt({ tags: '1girl, solo, nude', rating: 'explicit', count: 3 }, fam('noobai'), merged)
  assert(r.positive.includes('1girl'))
  eq(r.needsLLM, false)
})
t('anima 需要 LLM 补自然语言', () => {
  const r = wd14ToPrompt({ tags: '1girl, nude', rating: 'nsfw' }, fam('anima'), merged)
  eq(r.needsLLM, true)
  // rating 只作为元信息返回，不写进正向提示词
  eq(r.positive, '1girl, nude')
  eq(r.rating, 'nsfw')
})

console.log('\n' + '='.repeat(70))
console.log(` 结果: ${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(70))
process.exit(fail ? 1 : 0)
