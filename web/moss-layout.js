/**
 * MOSS-Image Layout 编译器 —— 把「草稿格式」编译成「模型格式」。
 *
 * 为什么需要它：官方规范里模型吃的坐标是 abs_centralized / yxyx
 * （画布中心为原点），而人（和 LLM）写草稿用的是 abs / xyxy（左上角原点）。
 * 官方明说「The model should never calculate these values itself」——
 * 算术必须由工具做，模型做必然出错。本模块与官方
 * skills/moss-image-prompt-enhancer/scripts/compile_prompt.py 语义逐行对齐。
 *
 * 来源：OpenMOSS/MOSS-Image（Apache-2.0）
 */

/** 校验失败就抛错——绝不静默修正或截断。 */
function require(cond, message) {
  if (!cond) throw new Error(message)
}

const isNum = (v) => (typeof v === 'number' && Number.isFinite(v))
  || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))

/** 字段白名单校验：未知字段直接报错而不是悄悄丢弃（防止创意被吞）。 */
function fields(value, allowed, required, location) {
  require(value && typeof value === 'object' && !Array.isArray(value), `${location} 必须是对象`)
  const unknown = Object.keys(value).filter((k) => !allowed.has(k))
  const missing = [...required].filter((k) => !(k in value))
  require(unknown.length === 0, `${location}: 未知字段 ${unknown.sort().join(', ')}`)
  require(missing.length === 0, `${location}: 缺字段 ${missing.join(', ')}`)
}

function text(value, location) {
  require(typeof value === 'string' && value.trim() !== '', `${location} 必须是非空字符串`)
}

function strings(value, location) {
  require(Array.isArray(value), `${location} 必须是数组`)
  value.forEach((v, i) => text(v, `${location}[${i}]`))
}


/** 草稿框 → 模型框：先取整边缘，再减去画布中心，换序为 yxyx。 */
function centeredBox(box, width, height, location) {
  require(Array.isArray(box) && box.length === 4, `${location} 必须是 [x1,y1,x2,y2]`)
  require(box.every(isNum), `${location} 必须是四个有限数字`)
  const [x1, y1, x2, y2] = box.map(Number)
  require(x1 < x2 && y1 < y2, `${location} 必须是正宽高`)
  require(0 <= x1 && x1 < x2 && x2 <= width && 0 <= y1 && y1 < y2 && y2 <= height,
    `${location} 超出 ${width}x${height} 画布`)
  // 与官方一致：小数边缘先「左/上向下取整、右/下向上取整」再平移
  const fy1 = Math.floor(Number((y1).toFixed(9))) - Math.floor(height / 2)
  const fx1 = Math.floor(Number((x1).toFixed(9))) - Math.floor(width / 2)
  const fy2 = Math.ceil(Number((y2).toFixed(9))) - Math.floor(height / 2)
  const fx2 = Math.ceil(Number((x2).toFixed(9))) - Math.floor(width / 2)
  require(fy1 < fy2 && fx1 < fx2, `${location} 在导出精度下过小`)
  return [fy1, fx1, fy2, fx2]
}

/**
 * 编译一份草稿。
 * 输入两种之一：
 *   ① {"caption": "..."}                → 直接返回 caption 文本
 *   ② Layout 草稿（abs/xyxy + width/height）→ 返回单行模型 JSON
 */
export function compileLayoutDraft(draft) {
  require(draft && typeof draft === 'object' && !Array.isArray(draft), '草稿必须是 JSON 对象')

  // caption 草稿：无需编译
  if ('caption' in draft && !('items' in draft)) {
    fields(draft, new Set(['caption']), ['caption'], 'Caption 草稿')
    text(draft.caption, 'caption')
    return draft.caption
  }

  const rootFields = new Set(['width', 'height', 'bbox_coord_space', 'bbox_format', 'summary', 'items'])
  fields(draft, rootFields, ['width', 'height', 'bbox_coord_space', 'bbox_format', 'summary', 'items'], 'Layout 草稿')
  const { width, height } = draft
  for (const [name, value] of [['width', width], ['height', height]]) {
    require(Number.isInteger(value) && value > 0 && value % 16 === 0,
      `${name} 必须是 16 的正整数倍`)
  }
  require(draft.bbox_coord_space === 'abs', '草稿 bbox_coord_space 必须是 abs')
  require(draft.bbox_format === 'xyxy', '草稿 bbox_format 必须是 xyxy')

  const summary = draft.summary
  fields(summary, new Set(['caption', 'meta', 'canvas', 'palette']), ['caption'], 'summary')
  text(summary.caption, 'summary.caption')
  if ('canvas' in summary) {
    require(['single', 'multi_panel', 'collage'].includes(summary.canvas),
      'summary.canvas 必须是 single / multi_panel / collage')
  }
  for (const key of ['meta', 'palette']) {
    if (key in summary) strings(summary[key], `summary.${key}`)
  }

  require(Array.isArray(draft.items) && draft.items.length > 0, 'items 必须是非空扁平数组')
  const itemAllowed = new Set(['label', 'caption', 'bbox', 'text', 'tags', 'palette'])
  const compiledItems = draft.items.map((item, index) => {
    const location = `items[${index}]`
    fields(item, itemAllowed, ['label', 'caption', 'bbox'], location)
    require(['object', 'character', 'text'].includes(item.label),
      `${location}.label 必须是 object / character / text`)
    text(item.caption, `${location}.caption`)
    if (item.label === 'text') {
      require('text' in item, `${location}: text 元素必须有 text 字段`)
    }
    if ('text' in item) text(item.text, `${location}.text`)
    for (const key of ['tags', 'palette']) {
      if (key in item) strings(item[key], `${location}.${key}`)
    }
    const out = { ...item }
    out.bbox = centeredBox(item.bbox, width, height, location)
    return out
  })

  const result = {
    summary,
    items: compiledItems,
    bbox_coord_space: 'abs_centralized',
    bbox_format: 'yxyx',
  }
  // 单行、紧凑、不带画布元数据（width/height 不进 prompt）
  return JSON.stringify(result)
}

/** 宽松识别：这段文本是不是一份 Layout 输出（草稿或已编译），用于自动接手。 */
export function looksLikeLayoutDraft(text) {
  if (typeof text !== 'string') return false
  const s = text.trim()
  if (!s.startsWith('{') || !s.endsWith('}')) return false
  try {
    const j = JSON.parse(s)
    return !!(j && typeof j === 'object'
      && !Array.isArray(j)
      && 'items' in j
      && 'summary' in j)
  } catch {
    return false
  }
}

/**
 * 处理模型给出的 Layout 输出，统一成「可交付」形态。
 *
 * 返回 { kind, positive, width, height } 或 null（不是 Layout）。
 *   kind='compiled'  —— 草稿(abs/xyxy)已编译为模型格式
 *   kind='model'     —— 模型自己已输出中心化坐标，校验后原样放行
 *
 * @returns {{kind:string, positive:string, width?:number, height?:number}|null}
 */
export function normalizeLayoutOutput(text) {
  if (!looksLikeLayoutDraft(text)) return null
  const j = JSON.parse(text.trim())

  // 已是模型格式：校验坐标在中心化范围内、bbox 顺序正确即可
  if (j.bbox_format === 'yxyx' || j.bbox_coord_space === 'abs_centralized') {
    const items = j.items || []
    for (const [i, it] of items.entries()) {
      const b = it && it.bbox
      require(Array.isArray(b) && b.length === 4 && b.every(isNum),
        `items[${i}].bbox 必须是四个数字`)
      require(Number(b[0]) < Number(b[2]) && Number(b[1]) < Number(b[3]),
        `items[${i}].bbox 必须是 [y_min,x_min,y_max,x_max] 且正宽高`)
    }
    return { kind: 'model', positive: JSON.stringify(j) }
  }

  // 草稿格式：编译（内部会做全部校验）。
  // 缺 width/height 时报 kind='draft-incomplete'，调用方可从 params.size 回填后再来。
  if (!('width' in j) || !('height' in j)) {
    return { kind: 'draft-incomplete', positive: JSON.stringify(j) }
  }
  const compiled = compileLayoutDraft(j)
  if (!compiled.startsWith('{')) return { kind: 'caption', positive: compiled }
  return { kind: 'compiled', positive: compiled, width: j.width, height: j.height }
}
