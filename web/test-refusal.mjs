// 拒答检测测试 —— 这是「VLM 优先」能否正确降级的关键。
// 误判两个方向都糟：误杀正常输出 → 白跑 WD14；漏判拒答 → 输出垃圾提示词。
import assert from 'node:assert'
import { detectRefusal, extractTagsFromVlm } from './vlm.js'

let pass = 0, fail = 0
function t(label, fn) {
  try { fn(); pass++; console.log(`  ✓ ${label}`) }
  catch (e) { fail++; console.log(`  ✗ ${label}\n      ${e.message}`) }
}
const refused = (text) => detectRefusal(text).refused
const ok = (text) => !detectRefusal(text).refused

console.log('='.repeat(70))
console.log(' 拒答检测')
console.log('='.repeat(70))

console.log('\n[1] 应该判为拒答')
const shouldRefuse = [
  ["I'm sorry, I cannot help with that.", '英文道歉拒绝'],
  ["I'm unable to view images.", '声明无法看图'],
  ["I can't assist with this request.", '拒绝协助'],
  ['As an AI, I am not able to describe explicit content.', 'AI + 政策'],
  ['抱歉，我无法查看这张图片。', '中文拒绝'],
  ['作为一个人工智能，我不能处理这类内容。', '中文 AI 声明'],
  ['请提供一张图片，我才能描述。', '反向要求'],
  ['This image appears to be inappropriate content.', '内容判定'],
  ['', '空输出'],
  ['   ', '纯空白'],
  ['...', '只有标点'],
  ['Sure! Here are the tags you requested:', '元话语（没看图）'],
  ['I would describe it as follows:', '元话语 2'],
  ['Based on your request, here are some tags:', '元话语 3'],
  ['a person', '太短且无视觉信号'],
  ['something', '单词'],
]
for (const [text, label] of shouldRefuse) {
  t(label, () => {
    const r = detectRefusal(text)
    assert.strictEqual(r.refused, true, `未判为拒答: ${JSON.stringify(text)} -> ${r.reason}`)
  })
}

console.log('\n[2] 绝对不能误判（正常输出）')
const shouldPass = [
  ['1girl, solo, long_hair, blue_eyes, school_uniform', '标准标签'],
  ['1boy, solo, armor, black_hair, cape, sword', '实测 VLM 输出'],
  ['1girl, solo, nude, large_breasts, nipples, lying', 'NSFW 标签（必须放行）'],
  ['A young woman with long black hair stands in a neon-lit street, rain falling.', '完整描述句'],
  ['masterpiece, best quality, 1girl, solo, detailed background, cinematic lighting', '带质量前缀'],
  ['1girl, solo, school uniform, classroom, sunlight, window, sitting', '多标签'],
  ['画面中是一名黑色长发的少女，身穿校服，站在教室窗边。', '中文描述'],
  ['1girl, 2boys, multiple_girls, group, beach, swimsuit', '多人物'],
  ['1girl, solo, smiling, looking at viewer, upper body, simple background', '带构图'],
]
for (const [text, label] of shouldPass) {
  t(label, () => {
    const r = detectRefusal(text)
    assert.strictEqual(r.refused, false, `误判为拒答: ${JSON.stringify(text)} (${r.reason}: ${r.matched})`)
  })
}

console.log('\n[3] 软回避（模型不拒答，但否认画面内容）')
const softAvoid = [
  ["I can describe this image, but there's no nudity or sexual content to describe — it's a fully clothed character illustration.", '实测原文：否认裸露'],
  ['This image does not contain any nudity or explicit content.', '否认含裸露'],
  ["There's no sexual content here, just a portrait.", '否认性内容'],
  ['The character is fully clothed in this illustration.', '强调衣着完整'],
  ['抱歉，画面中并没有裸露内容。', '中文否认裸露'],
  ['图中没有任何色情或性暗示内容。', '中文否认色情'],
]
for (const [text, label] of softAvoid) {
  t(label, () => {
    const r = detectRefusal(text)
    assert.strictEqual(r.refused, true, `软回避未识别: ${r.reason}`)
    assert.strictEqual(r.reason, 'soft-avoid', `reason 应为 soft-avoid，实际 ${r.reason}`)
  })
}
t('否认但同时给了敏感证据 -> 放行', () => {
  // 模型顺口说没有，但实际描述了裸露细节 -> 它确实在看图
  const s = "There's no explicit content, but the figure is topless with visible nipples."
  const r = detectRefusal(s)
  assert.strictEqual(r.refused, false, `误杀: ${r.reason}`)
})

console.log('\n[4] 边界情况')
t('NSFW 描述句应放行（不含拒答词）', () => {
  // 关键：含 explicit/nsfw 字样但不是拒答语境
  const s = '1girl, solo, nude, explicit, uncensored, bed, lying on back'
  assert.strictEqual(refused(s), false, 'NSFW 标签被误杀')
})
t('含 "sorry" 但是正常内容', () => {
  // "sorry" 单独出现不应触发（需要 I'm sorry 形式）
  const s = '1girl, solo, sad expression, sorry look, crying'
  const r = detectRefusal(s)
  assert.strictEqual(r.refused, false, `误杀: ${r.reason}`)
})
t('含 "cannot" 但是画面描述', () => {
  const s = '1girl, solo, blindfold, hands cannot be seen, cropped'
  const r = detectRefusal(s)
  // 这条允许判为拒答或放行，但要能给出理由
  assert.ok(typeof r.reason === 'string')
})
t('reason 字段总是存在', () => {
  for (const s of ['', 'x', '1girl, solo', "I'm sorry"]) {
    const r = detectRefusal(s)
    assert.ok(r.reason, 'reason 缺失')
    assert.strictEqual(typeof r.refused, 'boolean')
  }
})

console.log('\n[4] 标签提取')
t('逗号列表转标签', () => {
  const { tags } = extractTagsFromVlm('1boy, black hair, armor, cape')
  assert.ok(tags.includes('1boy'), tags)
  assert.ok(tags.includes('black_hair'), tags)
})
t('去掉 a/an/the 冠词', () => {
  const { tags } = extractTagsFromVlm('a young man, the armor, an apple')
  assert.ok(!/\ba_young/.test(tags), tags)
  assert.ok(tags.includes('young_man'), tags)
})
t('句子进 sentences 而非 tags', () => {
  const long = 'This is a very long description of the image that goes on and on and should be treated as a sentence rather than a tag.'
  const { tags, sentences } = extractTagsFromVlm(long)
  assert.ok(sentences.length > 0, '句子未归入 sentences')
  assert.ok(!tags.includes(long.slice(0, 20)), '长句被塞进 tags')
})
t('混合内容分别归位', () => {
  const txt = '1girl, solo, long hair, She is standing in a beautiful garden with many flowers blooming around her.'
  const { tags, sentences } = extractTagsFromVlm(txt)
  assert.ok(tags.includes('1girl'), tags)
  assert.ok(sentences.includes('garden'), sentences)
})
t('去掉句首序号/项目符号', () => {
  const { tags } = extractTagsFromVlm('1. 1girl, 2. solo, - smile')
  assert.ok(tags.includes('1girl'), tags)
  assert.ok(!/^\d+_/.test(tags), tags)
})

console.log('\n' + '='.repeat(70))
console.log(` 结果: ${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(70))
process.exit(fail ? 1 : 0)
