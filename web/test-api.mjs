import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url)))
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const good = '1girl, solo, white shirt,\nThe woman reads an open book by the window. Warm sunlight falls across the quiet room.'

async function fixture(fallbackToWd14 = true, corruptRules = false) {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-lab-api-'))
  const rulesPath = join(dir, 'rules.json'), configPath = join(dir, 'config.json')
  const state = { replies: [], requests: [], chatCalls: 0, wdCalls: 0, loaded: true, onChat: null, onChatClose: null }
  const stub = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/health') return res.end(JSON.stringify({ ok: state.loaded, loaded: state.loaded }))
    if (req.url === '/tags') { state.wdCalls++; return res.end(JSON.stringify({ ok: true, tags: '1girl, solo, white_shirt', rating: 'general', count: 3, ms: 1 })) }
    if (req.url === '/v1/models') return res.end('{"data":[{"id":"test-model"}]}')
    if (req.url === '/v1/chat/completions') {
      state.chatCalls++
      state.requests.push(body)
      const reply = state.replies.shift() ?? { positive: good, negative: '', params: {}, notes: [] }
      state.onChat?.()
      if (reply?.hold) { res.once('close', () => state.onChatClose?.()); return }
      if (reply?.httpStatus) { res.writeHead(reply.httpStatus); return res.end(JSON.stringify({ error: reply.error })) }
      return res.end(JSON.stringify({ model: 'test-model', choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] }))
    }
    res.writeHead(404); res.end('{}')
  })
  const stubPort = await listen(stub)
  const reserved = createServer(), port = await listen(reserved)
  await new Promise((r) => reserved.close(r))
  if (corruptRules) {
    const backupDir = join(dir, 'settings', 'rules-backups')
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, '2026-11-16-valid.json'), JSON.stringify(rules))
    writeFileSync(rulesPath, '{broken rules')
  } else {
    writeFileSync(rulesPath, JSON.stringify(rules))
  }
  writeFileSync(configPath, JSON.stringify({ server: { host: '127.0.0.1', port }, camera: {}, llm: { baseURL: `http://127.0.0.1:${stubPort}/v1`, apiKeyEnv: 'API_TEST_KEY', defaultModel: 'test-model', models: [{ id: 'test-model' }], timeoutSeconds: 5, maxTokens: 1000 },
    wd14: { host: `http://127.0.0.1:${stubPort}`, timeoutSeconds: 5 }, vlm: { enabled: true, fallbackToWd14, timeoutSeconds: 5 }, booru: { enabled: false }, viking: { enabled: false, instances: [] } }))
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CONFIG_PATH: configPath, RULES_READ_PATH: rulesPath, RULES_WRITE_PATH: rulesPath, SETTINGS_DIR: join(dir, 'settings'), API_TEST_KEY: 'FAKE_TEST_KEY', LLM_BASE_URL: '', WORKBUDDY_API_KEY: '', OPENVIKING_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (c) => { output += c }); child.stderr.on('data', (c) => { output += c })
  const base = `http://127.0.0.1:${port}`
  const close = async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
    stub.closeAllConnections()
    await new Promise((r) => stub.close(r))
    rmSync(dir, { recursive: true, force: true })
  }
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output)
      try { if ((await fetch(base + '/api/config')).ok) break } catch { /* startup */ }
      await new Promise((r) => setTimeout(r, 20))
      if (i === 99) throw new Error('Server startup timed out: ' + output)
    }
  } catch (error) {
    await close()
    throw error
  }
  const api = async (path, body, options = {}) => {
    const res = await fetch(base + path, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ...options })
    return { status: res.status, body: await res.json() }
  }
  return { state, api, rulesPath, close }
}

test('API validates inputs, repairs formats, reloads rules and reports unhealthy dependencies', async (t) => {
  const f = await fixture()
  try {
    await t.test('empty refine and unknown family fail before a model call', async () => {
      assert.equal((await f.api('/api/compose', { mode: 'refine', source: '' })).status, 400)
      assert.equal((await f.api('/api/compose', { brief: 'scene', family: 'unknown' })).status, 400)
      assert.equal((await f.api('/api/compose', { brief: 'scene', family: 'constructor' })).status, 400)
      assert.equal((await f.api('/api/compose', { brief: 'scene', family: 'toString' })).status, 400)
      assert.equal((await f.api('/api/compose', { brief: 'scene', family: 'anima', composition: 'constructor' })).status, 400)
      assert.equal(f.state.chatCalls, 0)
    })
    await t.test('pure tags are repaired once into Anima tag plus prose', async () => {
      f.state.replies.push({ positive: '1girl, solo, white shirt', notes: [] }, { positive: good, notes: [] })
      const r = await f.api('/api/compose', { mode: 'gen', family: 'anima', brief: 'woman reading', verifyAnchors: false })
      assert.equal(r.body.validation.valid, true)
      assert.equal(r.body.validation.retried, true)
      assert.equal(f.state.chatCalls, 2)
    })
    await t.test('persistent malformed output is marked instead of claimed conformant', async () => {
      f.state.replies.push({ positive: '1girl, solo, reading' }, { positive: '1girl, solo, reading' })
      const r = await f.api('/api/compose', { family: 'anima', brief: 'woman reading', verifyAnchors: false })
      assert.equal(r.body.validation.valid, false)
      assert.match(r.body.notes[0], /输出格式/)
    })
    await t.test('rules saved through API and edited on disk affect subsequent requests', async () => {
      const next = structuredClone(rules); next.families.anima.label = 'Saved label'
      assert.equal((await f.api('/api/rules', { rules: next })).status, 200)
      next.families.anima.label = 'Edited on host'; writeFileSync(f.rulesPath, JSON.stringify(next))
      assert.equal((await f.api('/api/config')).body.families.find((x) => x.id === 'anima').label, 'Edited on host')
      const before = readFileSync(f.rulesPath, 'utf8')
      assert.equal((await f.api('/api/rules', { rules: { families: [] } })).status, 400)
      assert.equal(readFileSync(f.rulesPath, 'utf8'), before)
      assert.equal((await f.api('/api/settings')).status, 200)
    })
    await t.test('probe aggregate becomes false when WD14 is not ready', async () => {
      f.state.loaded = false
      const r = await f.api('/api/probe', {})
      assert.equal(r.body.ok, false); assert.equal(r.body.wd14.ok, false)
      assert.equal(r.body.booru.disabled, true)
    })
    await t.test('VLM-only failure never invokes WD14 or reports success', async () => {
      const before = f.state.wdCalls
      f.state.replies.push('I cannot view this image.')
      const r = await f.api('/api/reverse', { family: 'anima', engine: 'vlm', imageB64: 'test' })
      assert.equal(r.status, 502); assert.equal(f.state.wdCalls, before)
      assert.doesNotMatch(r.body.error, /反推成功|已降级 WD14/)
    })
    await t.test('MOSS Layout from VLM is compiled too', async () => {
      f.state.replies.push({ positive: { width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy', summary: { caption: 'A cup.', meta: [], canvas: 'single' }, items: [{ label: 'object', caption: 'A cup.', bbox: [0, 0, 512, 512] }] }, params: {}, notes: [] })
      const r = await f.api('/api/reverse', { family: 'moss', engine: 'vlm', imageB64: 'test' })
      assert.equal(r.status, 200)
      assert.equal(JSON.parse(r.body.positive).bbox_coord_space, 'abs_centralized')
      assert.equal(r.body.params.size, '1024x1024')
    })
    await t.test('invented MOSS schema is repaired once before final compilation', async () => {
      const before = f.state.chatCalls
      f.state.replies.push({ positive: { type: 'layout', canvas: { width: 1024, height: 1024 }, elements: [{ type: 'object', name: 'red ceramic cup', bbox: [256, 256, 768, 768] }] } },
        { positive: { width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy', summary: { caption: 'A red cup on white.' }, items: [{ label: 'object', caption: 'A red ceramic cup.', bbox: [256, 256, 768, 768] }] } })
      const r = await f.api('/api/compose', { family: 'moss', brief: 'Red cup, 1024x1024 Layout.', verifyAnchors: false })
      assert.equal(r.status, 200)
      assert.equal(r.body.validation.retried, true)
      assert.deepEqual(JSON.parse(r.body.positive).items[0].bbox, [-256, -256, 256, 256])
      assert.equal(r.body.params.size, '1024x1024')
      assert.equal(f.state.chatCalls - before, 2)
    })
    await t.test('MOSS prose containing prompt introduction is repaired without changing the scene', async () => {
      const before = f.state.chatCalls
      const scene = 'An adult female painter sits on a wooden stool, supporting a palette in her left hand and holding a brush in her right hand.'
      f.state.replies.push({ positive: 'A full-body eye-level caption of an adult female painter sitting on a wooden stool.' }, { positive: scene })
      const r = await f.api('/api/compose', { family: 'moss', brief: 'Woman painting, palette in left hand, brush in right hand. Use ordinary caption.', verifyAnchors: false })
      assert.equal(r.status, 200)
      assert.equal(r.body.validation.valid, true)
      assert.equal(r.body.validation.retried, true)
      assert.equal(r.body.positive, scene)
      assert.match(f.state.requests.at(-1).messages[1].content, /正文混入了 caption of/)
      assert.equal(f.state.chatCalls - before, 2)
    })
    await t.test('persistently invalid MOSS schema fails after one repair', async () => {
      const before = f.state.chatCalls
      const bad = { positive: { type: 'layout', elements: [] } }
      f.state.replies.push(bad, bad)
      const r = await f.api('/api/compose', { family: 'moss', brief: 'A cup in Layout.', verifyAnchors: false })
      assert.equal(r.status, 502)
      assert.match(r.body.error, /Layout/)
      assert.equal(f.state.chatCalls - before, 2)
    })
    await t.test('selected composition and hard constraints reach the real upstream request', async () => {
      const r = await f.api('/api/compose', { family: 'anima', brief: 'Woman painting, palette in left hand, brush in right hand.', composition: 'negative_space', hardNote: '水彩插画，双脚完整入镜，不出现第二块调色板。', verifyAnchors: false })
      assert.equal(r.status, 200)
      const request = f.state.requests.at(-1)
      assert.match(request.messages[1].content, /偏置与留白/)
      assert.match(request.messages[1].content, /双脚完整入镜，不出现第二块调色板/)
      assert.match(request.messages[0].content, /动作、接触与空间精度/)
    })
    await t.test('reverse and local iteration preserve existing composition instead of automatically redesigning', async () => {
      assert.equal((await f.api('/api/compose', { family: 'anima', mode: 'iterate', positive: good, feedback: 'Change daylight to sunset.', verifyAnchors: false })).status, 200)
      assert.match(f.state.requests.at(-1).messages[1].content, /未被要求改动的构图/)
      assert.doesNotMatch(f.state.requests.at(-1).messages[1].content, /构图偏好「自动艺术构图」/)
      assert.equal((await f.api('/api/reverse', { family: 'anima', engine: 'vlm', imageB64: 'test', composition: 'diagonal' })).status, 200)
      const text = f.state.requests.at(-1).messages[1].content.find((part) => part.type === 'text').text
      assert.match(text, /不根据构图偏好重排原图/)
      assert.doesNotMatch(text, /构图偏好「对角线与动势」/)
    })
    await t.test('an empty upstream response is reported as a model failure', async () => {
      f.state.replies.push('')
      const r = await f.api('/api/compose', { family: 'anima', brief: 'A dancer.', verifyAnchors: false })
      assert.equal(r.status, 502)
      assert.match(r.body.error, /模型返回空内容/)
    })
    await t.test('format-valid Anima style conflicts trigger one quality repair', async () => {
      const before = f.state.chatCalls
      f.state.replies.push({ positive: good, negative: 'anime, bad hands' }, { positive: good, negative: 'bad hands' })
      const r = await f.api('/api/compose', { family: 'anima', brief: 'Watercolor illustration of a woman reading.', verifyAnchors: false })
      assert.equal(r.status, 200)
      assert.equal(r.body.validation.valid, true)
      assert.equal(r.body.quality.valid, true)
      assert.equal(r.body.quality.retried, true)
      assert.equal(r.body.negative, 'bad hands')
      assert.match(f.state.requests.at(-1).messages[1].content, /负面 anime/)
      assert.equal(f.state.chatCalls - before, 2)
    })
    await t.test('MOSS requested tags and explicit exclusions do not cause unnecessary repairs', async () => {
      const before = f.state.chatCalls
      f.state.replies.push({ positive: '1girl, solo, white dress, reading, garden', negative: 'anime' })
      const r = await f.api('/api/compose', { family: 'moss', brief: '只要英文 tag 串，不要动漫，不用 Layout。', verifyAnchors: false })
      assert.equal(r.status, 200)
      assert.equal(r.body.quality.valid, true)
      assert.equal(r.body.quality.retried, false)
      assert.equal(f.state.chatCalls - before, 1)
    })
    await t.test('persistent pose conflicts are visible and limited to one repair call', async () => {
      const before = f.state.chatCalls
      const positive = 'An adult woman appears in full-body and half-body waist-up framing beside a window.'
      f.state.replies.push({ positive }, { positive })
      const r = await f.api('/api/compose', { family: 'moss', brief: 'Full-body adult woman beside a window.', verifyAnchors: false })
      assert.equal(r.status, 200)
      assert.equal(r.body.validation.valid, true)
      assert.equal(r.body.quality.valid, false)
      assert.equal(r.body.quality.retried, true)
      assert.match(r.body.notes[0], /提示词仍需检查/)
      assert.equal(f.state.chatCalls - before, 2)
    })
    await t.test('repeated Anima iterations repack over-budget candidates and preserve the scene', async () => {
      const expanded = 'adult woman, solo, single blue maid dress, white gloves, navy mary janes, dpmix\nThe woman wears one blue maid dress with one pair of white gloves and one pair of navy mary janes, under ' + 'soft '.repeat(245) + 'window light. A whale-tail silhouette follows her shadow on the wall beside a sign reading "Blue tide".'
      const compact = 'adult woman, solo, single blue maid dress, white gloves, navy mary janes, dpmix\nThe woman wears one blue maid dress, one pair of white gloves and one pair of navy mary janes in the original pose under soft window light. A whale-tail silhouette follows her shadow on the wall beside a sign reading "Blue tide".'
      let current = expanded
      const before = f.state.chatCalls
      for (const feedback of ['只保留一套衣物，不能误杀剪影与鲸尾。', '手指自然，保持鲸尾剪影和原构图。', '光线更柔和，保留原衣物、姿态和文字。']) {
        f.state.replies.push({ positive: expanded }, { positive: compact })
        const r = await f.api('/api/compose', { family: 'anima', mode: 'iterate', positive: current, feedback, verifyAnchors: false })
        assert.equal(r.status, 200)
        assert.equal(r.body.validation.valid, true)
        assert.equal(r.body.quality.valid, true)
        assert.equal(r.body.quality.repairAttempts, 1)
        assert.ok(r.body.length.value <= 300)
        assert.equal(r.body.length.hardMax, 300)
        assert.equal(r.body.length.budget.enforced, true)
        assert.equal(r.body.positive, compact)
        assert.match(r.body.notes.join(' '), /按迭代预算重组/)
        const request = f.state.requests.at(-1).messages[1].content
        assert.ok(request.includes(current))
        assert.ok(request.includes(feedback))
        assert.match(request, /完整重组验收/)
        assert.match(request, /≤ 300/)
        assert.match(request, /待修正候选/)
        current = r.body.positive
      }
      assert.equal(f.state.chatCalls - before, 6)
    })
    await t.test('iteration may repack length a second time while retaining sampling parameters', async () => {
      const expanded = '1girl, solo, blue dress\nThe woman stands beside a window with ' + 'soft '.repeat(250) + 'light on her blue dress. A whale-tail shadow remains visible on the wall.'
      const compact = '1girl, solo, blue dress\nThe woman stands beside a window under soft light. A whale-tail shadow remains visible on the wall.'
      const params = { steps: '34', cfg: '4.5', sampler: 'er_sde', size: '1344x896' }
      const before = f.state.chatCalls
      f.state.replies.push({ positive: expanded, params }, { positive: expanded, params: { steps: 99, cfg: 9 } }, { positive: compact, params: { steps: 77, cfg: 7 } })
      const r = await f.api('/api/compose', { family: 'anima', mode: 'iterate', positive: expanded, feedback: 'Only make the window light softer.', verifyAnchors: false })
      assert.equal(r.status, 200)
      assert.equal(r.body.quality.repairAttempts, 2)
      assert.ok(r.body.length.value <= 300)
      for (const [key,value] of Object.entries(params)) assert.equal(r.body.params[key], value)
      assert.equal(f.state.chatCalls - before, 3)
    })
    await t.test('iteration keeps reorganizing past two repairs until it fits without accumulating longer drafts', async () => {
      const expanded = '1girl, solo, blue dress, dpmix\nThe woman stands beside a window with ' + 'soft '.repeat(250) + 'light on her blue dress. A whale-tail silhouette is beside a sign reading "Keep this exact text".'
      const longer = expanded + ' Additional ' + 'soft '.repeat(40) + 'details remain visible.'
      const compact = '1girl, solo, blue dress, dpmix\nThe woman stands beside a window under soft light in one blue dress. A whale-tail silhouette is beside a sign reading "Keep this exact text".'
      const before = f.state.chatCalls
      f.state.replies.push({ positive: expanded }, { positive: longer }, ...Array.from({ length: 4 }, () => ({ positive: expanded })), { positive: compact })
      const r = await f.api('/api/compose', { family: 'anima', mode: 'iterate', positive: expanded, feedback: 'Keep all quoted text.', verifyAnchors: false })
      assert.equal(r.status, 200)
      assert.equal(r.body.ok, true)
      assert.equal(r.body.positive, compact)
      assert.equal(r.body.quality.repairAttempts, 6)
      assert.equal(r.body.validation.valid, true)
      assert.ok(r.body.length.value <= 300)
      assert.equal(r.body.length.budget.enforced, true)
      assert.equal(r.body.code, undefined)
      assert.equal(f.state.chatCalls - before, 7)
      const repairs = f.state.requests.slice(before + 1).map((request) => request.messages[1].content)
      assert.match(repairs[1], /切换重组策略/)
      assert.ok(!repairs[1].includes(longer))
      const targets = repairs.map((request) => Number(request.match(/英文优先约 (\d+) 词/)[1]))
      assert.ok(targets[1] < targets[0])
      assert.ok(targets.at(-1) < targets[1])
    })
    await t.test('disconnecting an iteration aborts its pending rewrite and stops subsequent model calls', async () => {
      const expanded = '1girl, solo, blue dress\nThe woman stands in ' + 'soft '.repeat(250) + 'light. A sign reads "Blue tide".'
      const before = f.state.chatCalls
      f.state.replies.push({ positive: expanded }, { hold: true })
      let started, closed
      const rewriting = new Promise((resolve) => { started = resolve })
      const aborted = new Promise((resolve) => { closed = resolve })
      f.state.onChat = () => { if (f.state.chatCalls === before + 2) started() }
      f.state.onChatClose = () => closed()
      const controller = new AbortController()
      const request = f.api('/api/compose', { family: 'anima', mode: 'iterate', positive: expanded, feedback: 'Keep the scene.', verifyAnchors: false }, { signal: controller.signal })
      try {
        await rewriting
        const rejected = assert.rejects(request, { name: 'AbortError' })
        controller.abort()
        await rejected
        let timer
        try {
          await Promise.race([aborted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Upstream rewrite was not aborted')), 1500) })])
        } finally { clearTimeout(timer) }
        assert.equal(f.state.chatCalls - before, 2)
      } finally {
        controller.abort()
        f.state.onChat = null
        f.state.onChatClose = null
      }
    })
    await t.test('an unavailable upstream remains a service error rather than a prompt-budget rejection', async () => {
      const expanded = '1girl, solo, blue dress\nThe woman stands in ' + 'soft '.repeat(250) + 'light. A sign reads "Blue tide".'
      const before = f.state.chatCalls
      f.state.replies.push({ positive: expanded }, { httpStatus: 503, error: 'Model service temporarily unavailable' })
      const r = await f.api('/api/compose', { family: 'anima', mode: 'iterate', positive: expanded, feedback: 'Keep the scene.', verifyAnchors: false })
      assert.equal(r.status, 502)
      assert.match(r.body.error, /模型调用失败.*503/)
      assert.equal(r.body.code, undefined)
      assert.equal(r.body.positive, undefined)
      assert.equal(f.state.chatCalls - before, 2)
    })
    await t.test('MOSS iteration retains requested tags and Layout without forcing prose compaction', async () => {
      const before = f.state.chatCalls
      const tags = '1girl, solo, blue dress, reading, garden'
      f.state.replies.push({ positive: tags })
      const tagResult = await f.api('/api/compose', { family: 'moss', mode: 'iterate', positive: tags, feedback: 'Only change the dress to blue.', verifyAnchors: false })
      assert.equal(tagResult.status, 200)
      assert.equal(tagResult.body.positive, tags)
      assert.equal(tagResult.body.quality.repairAttempts, 0)
      const layout = JSON.stringify({ width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy', summary: { caption: 'A garden with ' + 'green '.repeat(400) + 'leaves.' }, items: [{ label: 'text', caption: 'A sign.', text: '春日茶会', bbox: [64,64,512,256] }] })
      f.state.replies.push({ positive: layout, params: { size: '1024x1024' } })
      const layoutResult = await f.api('/api/compose', { family: 'moss', mode: 'iterate', positive: layout, feedback: 'Keep the quoted Chinese title and Layout.', verifyAnchors: false })
      assert.equal(layoutResult.status, 200)
      assert.equal(layoutResult.body.quality.budget, null)
      assert.equal(JSON.parse(layoutResult.body.positive).items[0].text, '春日茶会')
      assert.equal(f.state.chatCalls - before, 2)
    })
  } finally { await f.close() }
})

test('fallbackToWd14=false prevents automatic fallback, but forced WD14 still works', async () => {
  const f = await fixture(false)
  try {
    f.state.replies.push('I cannot view this image.')
    assert.equal((await f.api('/api/reverse', { family: 'anima', imageB64: 'test' })).status, 502)
    assert.equal(f.state.wdCalls, 0)
    assert.equal((await f.api('/api/reverse', { family: 'anima', engine: 'wd14', organize: false, imageB64: 'test' })).status, 200)
    assert.equal(f.state.wdCalls, 1)
  } finally { await f.close() }
})

test('server starts with a valid backup when the selected rules file is corrupt', async () => {
  const f = await fixture(true, true)
  try {
    const config = await f.api('/api/config')
    assert.equal(config.status, 200)
    assert.equal(config.body.families.length, Object.keys(rules.families).length)
    assert.match(config.body.rulesWarning, /规则文件无效|备份/)
    const compose = await f.api('/api/compose', { family: 'anima', brief: 'woman reading', verifyAnchors: false })
    assert.equal(compose.status, 200)
    assert.equal(compose.body.validation.valid, true)
    assert.equal(readFileSync(f.rulesPath, 'utf8'), '{broken rules')
    assert.equal((await f.api('/api/rules', { rules })).status, 200)
    assert.equal((await f.api('/api/config')).body.rulesWarning, '')
    assert.deepEqual(JSON.parse(readFileSync(f.rulesPath, 'utf8')), rules)
  } finally { await f.close() }
})
