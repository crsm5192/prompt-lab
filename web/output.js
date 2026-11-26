import { fieldText, layoutInstruction } from './engine.js'
import { normalizeLayoutOutput } from './moss-layout.js'
import { COMPOSITION_MODES } from './art-direction.js'
import { nibblesIssues } from './nibbles.js'

export function inputError(message) {
  return Object.assign(new Error(message), { status: 400 })
}

export function validateTask(payload, reverse = false) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw inputError('请求必须是对象')
  const mode = reverse ? 'reverse' : (payload.mode || 'gen')
  if (!['gen', 'refine', 'iterate', 'reverse'].includes(mode)) throw inputError('未知任务模式')
  if (payload.composition !== undefined && !Object.hasOwn(COMPOSITION_MODES, payload.composition)) throw inputError('未知构图偏好')
  const required = mode === 'gen' ? ['brief'] : mode === 'refine' ? ['source']
    : mode === 'iterate' ? ['positive', 'feedback'] : []
  for (const key of required) {
    if (typeof payload[key] !== 'string' || !payload[key].trim()) throw inputError(`请填写 ${key}`)
  }
  if (reverse) {
    if (!['auto', 'vlm', 'wd14'].includes(payload.engine || 'auto')) throw inputError('未知反推引擎')
    if (!['path', 'imageB64', 'url'].some((k) => typeof payload[k] === 'string' && payload[k].trim())) {
      throw inputError('需要 path / imageB64 / url 之一')
    }
    if (payload.path && (!/^\/images\//.test(payload.path) || payload.path.split('/').includes('..'))) {
      throw inputError('图片路径必须在 /images/ 下')
    }
  } else if (mode === 'reverse' && ![payload.refTags, payload.refDesc].some((v) => typeof v === 'string' && v.trim())) {
    throw inputError('请提供参考标签或画面描述')
  }
  return mode
}

export function validateOutput(text, family, params = {}) {
  const value = fieldText(text).trim()
  const issues = []
  if (!value || /^(?:\.{2,}|…+|null|undefined|\[object Object\])$/i.test(value)) {
    return { valid: false, unusable: true, issues: ['提示词为空或只有占位内容'] }
  }
  const kind = family?.kind || 'tag'
  if (kind === 'NL+layout' && value.startsWith('{')) {
    try { compileResultLayout({ positive: value, params, notes: [] }, family) }
    catch (e) { issues.push('Layout 结构无效：' + e.message) }
  }
  if (kind !== 'NL+layout' && value.startsWith('{')) issues.push('正文包含 JSON 信封，应仅包含 positive 的内容')
  // Quoted text may intentionally appear in its original language on an image.
  const prose = value.replace(/"[^"\n]*"|“[^”\n]*”/g, '')
  if (!value.startsWith('{') && /^(?:(?:a|an|the)\s+)?(?:(?:full[- ]body|half[- ]body|close[- ]up|eye[- ]level|wide[- ]angle|vertical|horizontal|detailed|cinematic)\s+){0,4}caption\s+(?:of|depicting|showing)\b/i.test(prose)) {
    issues.push('正文混入了 caption of 等提示词介绍语，应直接描述可见画面')
  }
  if (kind === 'Nibbles') issues.push(...nibblesIssues(value))
  if (kind !== 'Nibbles' && /[\u4e00-\u9fff\u3040-\u30ff]/.test(prose) && !value.startsWith('{')) {
    issues.push('画面描述应使用英文；要渲染的原语言文字请用引号包裹')
  }
  const sentences = prose.match(/[A-Za-z][^.!?\n]{8,}[.!?](?=\s|,|$)/g) || []
  if (kind === 'tag+NL') {
    const lines = value.split(/\n+/).filter((s) => s.trim())
    if (!lines.some((s) => s.split(/[,，]/).filter((v) => v.trim()).length >= 3)) issues.push('缺少逗号分隔的英文基础标签段')
    if (sentences.length < 2 || sentences.length > 3) issues.push('标签段后需要 2–3 句完整英文自然语言')
    if (lines.length < 2) issues.push('标签和自然语言段需要用真换行分开')
  } else if (kind === 'NL' && !sentences.length) {
    issues.push('本族要求完整英文自然语言句子，不能只给标签')
  } else if (kind === 'tag' && sentences.length) {
    issues.push('本族要求逗号分隔的英文短标签，不能使用自然语言长句')
  }
  return { valid: !issues.length, unusable: false, issues }
}

export function repairInstruction(family, issues) {
  return '【本次输出格式验收】' + (issues.length ? issues.join('；') + '。' : '')
    + (family.kind === 'tag+NL' ? 'positive 第一行必须是英文基础标签；然后真换行，写 2–3 句英文画面描述。' : '')
    + (family.kind === 'NL' ? 'positive 必须使用完整英文句子。' : '')
    + (family.kind === 'Nibbles' ? '按要求使用中日英自然语言，保留指定画师、质量档和引用文字。每个 bbox 后紧跟局部描述及分号。' : '')
    + (family.kind === 'tag' ? 'positive 必须使用逗号分隔的英文短标签。' : '')
    + (family.kind === 'NL+layout' ? layoutInstruction() : '')
    + '正文直接描述可见画面，不用 caption of 等提示词介绍语；用户要求画出的引用文字和 Layout 的 caption 字段保留。'
    + '保留用户指定的主体、数量、动作、服装、环境、机位、文字和触发词，修正已指出的书写形态、重复或相互冲突的描述；精简不得截断或删除指定内容。不要新增设定。只返回约定 JSON 信封。'
}

export function compileResultLayout(result, family) {
  if (family.kind !== 'NL+layout') return result
  let text = fieldText(result.positive)
  let layout = normalizeLayoutOutput(text)
  if (!layout && text.trim().startsWith('{')) throw Object.assign(new Error('MOSS 正文 JSON 缺少有效的 Layout 结构'), { status: 502 })
  if (layout?.kind === 'draft-incomplete') {
    const m = fieldText(result.params?.size).match(/^(\d+)\s*[x×]\s*(\d+)$/i)
    if (!m) throw Object.assign(new Error('Layout 草稿缺少 width/height 或明确的 params.size'), { status: 502 })
    const draft = JSON.parse(text)
    draft.width ??= Number(m[1]); draft.height ??= Number(m[2])
    layout = normalizeLayoutOutput(JSON.stringify(draft))
  }
  if (layout?.kind === 'compiled') {
    result.positive = layout.positive
    result.params = { ...result.params, size: `${layout.width}x${layout.height}` }
    result.layout = { width: layout.width, height: layout.height }
    result.notes.push(`已编译 Layout：abs/xyxy → abs_centralized/yxyx，尺寸 ${layout.width}×${layout.height}`)
  } else if (layout?.kind === 'model' || layout?.kind === 'caption') {
    result.positive = layout.positive
  }
  return result
}
