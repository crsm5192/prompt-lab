// Quoted lettering belongs to the image, including underscores and punctuation.
function withQuotedText(text, transform) {
  const quotes = []
  let marker = '\u0000Q'
  while (text.includes(marker)) marker += 'Q'
  const masked = text.replace(/"(?:\\.|[^"\\])*"|“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu, (value) => {
    quotes.push(value)
    return marker + (quotes.length - 1) + '\u0000'
  })
  const restore = (value) => value.replace(new RegExp(marker + '(\\d+)\\u0000', 'g'), (_, i) => quotes[i])
  return transform(masked, restore)
}

const quality = /^(?:best|good|low|worst) quality$/i
const complexity = /^(?:high|low) visual complexity$/i

export function cleanNibbles(text) {
  return withQuotedText(text, (body, restore) => restore(body
    .replace(/(^|[\s,，])artist\s*[:：]\s*/gi, '$1@')
    .replace(/_/g, ' ')
    .replace(/\(([^()\n]+?):\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*\)/g, '$1')
    .trim()))
}

export function nibblesIssues(text) {
  return withQuotedText(text, (body) => {
    const issues = []
    for (const [pattern, message] of [
      [/\b(?:best|good|low|worst) quality\b|最佳画质|良好画质|较低画质|最低画质|(?:最高|良好な|最低|低)画質/gi, '质量档只写一次'],
      [/\b(?:high|low) visual complexity\b|[高低]视觉复杂度|视觉复杂度[很较]?[高低]|視覚的複雑度が[高低]い/gi, '视觉复杂度只写一次'],
    ]) {
      if ((body.match(pattern) || []).length > 1) issues.push(message)
    }
    const blocks = body.split(/\[\s*bbox\b/i).slice(1)
    for (const block of blocks) {
      const box = block.match(/^:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\s*([^;；]+?)[;；]/)
      if (!box || !box[5].trim()) {
        issues.push('局部框需写成 [bbox:x1,y1,x2,y2] 局部描述;')
        break
      }
      const [left, top, right, bottom] = box.slice(1, 5).map(Number)
      if (left >= right || top >= bottom || right > 1000 || bottom > 1000) {
        issues.push('bbox 使用 0–1000 的画布坐标，左边界须小于右边界，上边界须小于下边界')
        break
      }
    }
    if (/^(?:(?:\d+(?:girl|boy)s?|solo|anime illustration|(?:best|good|low|worst) quality)[\s,，]*)+$/i.test(body)) {
      issues.push('请补充可见的主体、动作或场景')
    }
    return issues
  })
}

// Local assembly keeps the user's wording. The selected language affects only
// the generated header; translation and expansion belong to the LLM workflow.
export function assembleNibbles(options) {
  const { brief, medium = '', language = '', artists = '', year = '', boxes = '', size = '' } = options
  if (typeof brief !== 'string' || !brief.trim()) throw new RangeError('请填写画面描述')
  for (const value of [artists, year, boxes, size, medium, language, options.quality ?? '', options.complexity ?? '']) {
    if (typeof value !== 'string') throw new RangeError('编排字段须为文本')
  }
  if (brief.length + artists.length + boxes.length > 32000) throw new RangeError('单次编排最多支持 32000 个字符')
  if (year && !/^\d{4}$/.test(year)) throw new RangeError('年份须为四位数字')
  if (size && !/^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(size)) throw new RangeError('尺寸请用宽x高')
  if (!['', '中文', '日本語', 'English'].includes(language) || !['', 'anime', 'photo'].includes(medium)) {
    throw new RangeError('未知语言或媒介')
  }
  if ((options.quality && !quality.test(options.quality)) || (options.complexity && !complexity.test(options.complexity))) {
    throw new RangeError('未知画质或复杂度档位')
  }
  const ja = language === '日本語' || (!language && /[\u3040-\u30ff]/.test(brief))
  const zh = language === '中文' || (!language && !ja && /\p{Script=Han}/u.test(brief))
  const photo = medium === 'photo' || (!medium && /照片|摄影|写真|photograph(?:y)?\b|\bphoto\b/i.test(brief))
  const names = artists.split(/[,，、\n]/).map((s) => s.trim().replace(/^@+/, '').replace(/_/g, ' ')).filter(Boolean).map((s) => '@' + s)
  const descriptors = [options.quality, options.complexity].filter(Boolean)
  const zhWords = { 'best quality': '最佳画质', 'good quality': '良好画质', 'low quality': '较低画质', 'worst quality': '最低画质', 'high visual complexity': '高视觉复杂度', 'low visual complexity': '低视觉复杂度' }
  const jaWords = { 'best quality': '最高画質', 'good quality': '良好な画質', 'low quality': '低画質', 'worst quality': '最低画質', 'high visual complexity': '視覚的複雑度が高い', 'low visual complexity': '視覚的複雑度が低い' }
  let header
  if (zh || ja) {
    const author = names.join(zh ? ' 和 ' : ' と ')
    const media = zh ? (photo ? '摄影作品' : '动漫插画') : (photo ? '写真' : 'アニメイラスト')
    const prefix = zh ? [author && '由 ' + author, year && '于 ' + year + ' 年', (author || year) && '创作的']
      : [year && year + '年の', author && author + ' による']
    const words = zh ? zhWords : jaWords
    header = [prefix.filter(Boolean).join('') + media, ...descriptors.map((s) => words[s.toLowerCase()])].join(zh ? '，' : '、') + '。'
  } else {
    header = [photo ? 'A photograph' : 'An anime illustration', names.length && 'by ' + names.join(' and '), year && 'in ' + year,
      options.quality && 'rated as ' + options.quality, options.complexity && 'with ' + options.complexity].filter(Boolean).join(' ') + '.'
  }
  if (boxes.trim() && !/^\[bbox:/i.test(boxes.trim())) throw new RangeError('局部描述须以 [bbox:x1,y1,x2,y2] 开头')
  const positive = cleanNibbles([header, brief.trim(), boxes.trim()].filter(Boolean).join('\n\n'))
  const issues = nibblesIssues(positive)
  if (issues.length) throw new RangeError(issues.join('；'))
  return { positive, negative: '', params: size ? { size } : {} }
}

// Emphasis can span tags or weight groups. Drop only matched, unescaped pairs.
function stripNaiEmphasis(text) {
  const chars = text.split('')
  const openings = []
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]
    if (char === '\\') {
      i++
    } else if (char === '{' || char === '[') {
      openings.push(i)
    } else if (char === '}' || char === ']') {
      const start = openings.at(-1)
      if (chars[start] === (char === '}' ? '{' : '[')) {
        chars[start] = chars[i] = ''
        openings.pop()
      }
    }
  }
  return chars.join('')
}

// Native mode interprets the sign as inclusion/exclusion. SD mode reproduces
// the supplied converter's magnitudes, brace depth and escaped literal parens.
export function convertNai(source, profile = 'native') {
  return withQuotedText(source, (body, restore) => {
    if (profile === 'native') body = stripNaiEmphasis(body)
    const positive = []
    const negative = []
    const metadata = new Map()
    function append(raw, weight = '') {
      let tag = raw.trim()
      if (!tag) return
      const braces = profile === 'sd' && tag.match(/^(\{+)([^{}]+)(\}+)$/)
      const depth = braces && braces[1].length === braces[3].length ? braces[1].length : 0
      if (depth) tag = braces[2].trim()
      tag = tag.replace(/^artist\s*[:：]\s*(.+)$|^artist_(.+)$/i, (_, colonName, underscoreName) => {
        const name = colonName || underscoreName
        return name.startsWith('@') || (profile === 'sd' && /[()]/.test(name)) ? name : '@' + name
      }).replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
      const excluded = weight.startsWith('-') && /[1-9]/.test(weight)
      if (profile === 'sd') {
        tag = tag.replace(/(\\*)([()])/g, (_, slashes, paren) => slashes + (slashes.length % 2 ? '' : '\\') + paren)
        tag = '('.repeat(depth) + tag + ')'.repeat(depth)
        if (weight) {
          const [integer, decimal = ''] = weight.replace(/^[+-]/, '').split('.')
          const fraction = decimal.replace(/0+$/, '')
          const magnitude = (integer.replace(/^0+/, '') || '0') + (fraction ? '.' + fraction : '')
          if (magnitude !== '1') tag = '(' + tag + ':' + magnitude + ')'
        }
      }
      if (profile === 'sd' && !weight && /^(?:anime illustration|best quality)$/i.test(tag)) return
      if (profile === 'native' && !excluded && tag.toLowerCase() === 'anime illustration') return
      if (!excluded && profile === 'native' && (quality.test(tag) || complexity.test(tag))) {
        const dimension = quality.test(tag) ? 'quality' : 'complexity'
        if (metadata.has(dimension) && metadata.get(dimension) !== tag.toLowerCase()) {
          throw new RangeError('原文含有冲突的质量或复杂度档位，请每个维度选一项')
        }
        metadata.set(dimension, tag.toLowerCase())
        return
      }
      const destination = excluded ? negative : positive
      destination.push(restore(tag))
    }
    const appendPlain = (plain) => plain.split(/[,\n，]/).forEach((tag) => append(tag))
    let cursor = 0
    for (const match of body.matchAll(/(?<![\w.])([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*::(.*?)::/gs)) {
      appendPlain(body.slice(cursor, match.index))
      if (profile === 'native') match[2].split(/[,\n，]/).forEach((tag) => append(tag, match[1]))
      else append(match[2], match[1])
      cursor = match.index + match[0].length
    }
    appendPlain(body.slice(cursor))
    const prefix = profile === 'sd' ? ['anime illustration', 'best quality']
      : ['anime illustration', metadata.get('quality'), metadata.get('complexity')].filter(Boolean)
    return { positive: [...prefix, ...positive].join(', '), negative: negative.join(', ') }
  })
}
