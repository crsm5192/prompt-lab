import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLLM } from './llm.js'
import { createBooru, createViking } from './services.js'
import { createRuleStore, validateRules } from './rule-store.js'
import { validateOutput, validateTask, compileResultLayout } from './output.js'
import { buildUser } from './engine.js'
import { buildSystem } from './engine.js'
import { reviewPrompt } from './prompt-quality.js'

const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url)))
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)))
const close = (server) => new Promise((r) => { server.closeAllConnections?.(); server.close(r) })

test('changing model URL does not send the existing key to the new service', async () => {
  const seen = []
  const server = createServer((req, res) => { seen.push(req.headers.authorization); res.end('{"data":[{"id":"test-model"}]}') })
  const address = await listen(server)
  try {
    const llm = createLLM({ baseURL: address + '/v1', apiKey: 'FAKE_EXISTING_KEY' })
    await llm.listModels()
    await llm.listModels({ baseURL: address + '/other' })
    await llm.listModels({ baseURL: address + '/other', apiKey: 'FAKE_TEMP_KEY' })
    assert.deepEqual(seen, ['Bearer FAKE_EXISTING_KEY', undefined, 'Bearer FAKE_TEMP_KEY'])
  } finally { await close(server) }
})

test('disabled optional services perform no network requests', async () => {
  const booru = createBooru({ enabled: false, baseURL: 'http://127.0.0.1:1' })
  assert.deepEqual(await booru.search('tag', 1), [])
  assert.deepEqual(await booru.verify(['tag']), [])
  assert.deepEqual(await booru.related('tag'), [])
  assert.deepEqual(await booru.posts('tag'), [])
  assert.equal((await booru.wiki('tag')).disabled, true)
  assert.equal((await booru.probe()).disabled, true)
  const viking = createViking({ enabled: false, instances: [{ name: 'test', baseURL: 'http://127.0.0.1:1' }] })
  assert.equal((await viking.find({ query: 'tag' })).disabled, true)
  assert.equal((await viking.probe())[0].disabled, true)
})

test('Danbooru requests actually traverse the configured proxy tunnel', async () => {
  let tunnels = 0
  const sockets = new Set()
  const upstream = createServer((_req, res) => res.end('[{"name":"long_hair","post_count":10,"category":0}]'))
  const address = await listen(upstream)
  const proxy = createServer()
  proxy.on('connect', (req, client, head) => {
    tunnels++
    const [host, port] = req.url.split(':')
    const socket = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) socket.write(head)
      client.pipe(socket); socket.pipe(client)
    })
    sockets.add(client); sockets.add(socket)
    socket.on('error', () => client.destroy())
  })
  const proxyAddress = await listen(proxy)
  try {
    const tags = await createBooru({ baseURL: address, proxy: proxyAddress }).search('long_hair', 1)
    assert.equal(tags[0].name, 'long_hair')
    assert.equal(tunnels, 1)
  } finally {
    for (const socket of sockets) socket.destroy()
    await close(proxy); await close(upstream)
  }
})

test('rules refresh, reject invalid saves, preserve bind inode and recover from backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-lab-rules-'))
  const file = join(dir, 'rules.json'), backups = join(dir, 'backups')
  try {
    writeFileSync(file, JSON.stringify(rules))
    const store = createRuleStore({ readPath: file, writePath: file, backupDir: backups })
    const changed = structuredClone(rules)
    changed.families.anima.label = 'Changed on host'
    writeFileSync(file, JSON.stringify(changed))
    assert.equal(store.refresh().families.anima.label, 'Changed on host')
    const before = readFileSync(file, 'utf8'), inode = statSync(file).ino
    const badStyle = structuredClone(rules)
    badStyle.families.anima.modeStyle.gen = 'constructor'
    assert.throws(() => validateRules(badStyle), /缺失风格档/)
    const badBlock = structuredClone(rules)
    badBlock.families.anima.sharedBlocks = ['__proto__']
    assert.throws(() => validateRules(badBlock), /缺失共享块/)
    assert.throws(() => store.save({ families: { bad: { kind: 'invalid' } } }))
    assert.equal(readFileSync(file, 'utf8'), before)
    const saved = store.save(rules)
    assert.equal(statSync(file).ino, inode)
    assert.equal(JSON.parse(readFileSync(saved.backup)).families.anima.label, 'Changed on host')
    writeFileSync(file, '{broken')
    assert.equal(store.refresh().families.anima.label, 'Anima')
    assert.match(store.warning, /上次有效/)
    const recovered = createRuleStore({ readPath: file, writePath: file, backupDir: backups })
    assert.equal(recovered.refresh().families.anima.label, 'Changed on host')
    assert.match(recovered.warning, /规则文件无效/)
    assert.throws(() => validateRules({ ...rules, families: { ...rules.families, anima: { ...rules.families.anima, sharedBlocks: ['missing'] } } }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('real malformed output samples and empty task inputs are detected', () => {
  assert.equal(validateOutput('1girl, solo, white shirt, reading, window', rules.families.anima).valid, false)
  assert.equal(validateOutput('白衬衫，窗边，读书。\nThe woman reads a book. Warm light falls on her shirt.', rules.families.anima).valid, false)
  assert.equal(validateOutput('1girl, solo, white shirt,\nThe woman reads an open book. Warm sunlight falls across the quiet room.', rules.families.anima).valid, true)
  assert.equal(validateOutput('1girl, solo, white shirt,\nThe woman reads an open book. Warm sunlight falls across the quiet room. She sits beside a window. The room has wooden walls.', rules.families.anima).valid, false)
  assert.equal(validateOutput('...', rules.families.krea2).unusable, true)
  assert.throws(() => validateTask({ mode: 'refine', draft: 'wrong field' }))
  assert.throws(() => validateTask({ mode: 'iterate', positive: 'some text', feedback: '' }))
  assert.throws(() => validateTask({ engine: 'wd14', path: '/images/../etc/file' }, true))
  assert.equal(validateOutput('A sign displays "你好" above the doorway.', rules.families.krea2).valid, true)
  assert.equal(validateOutput('A full-body eye-level caption of a woman painting.', rules.families.moss).valid, false)
  assert.equal(validateOutput('A sign displays "A caption of a woman painting" above the doorway.', rules.families.moss).valid, true)
  assert.equal(validateOutput('{"summary":{"caption":"A cup on a table."},"bbox_coord_space":"abs_centralized","bbox_format":"yxyx","items":[{"label":"object","caption":"A red cup.","bbox":[-256,-256,256,256]}]}', rules.families.moss).valid, true)
})

test('Layout compilation is shared by all completed output paths', () => {
  const result = { positive: JSON.stringify({ width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
    summary: { caption: 'A cup on a table.', meta: [], canvas: 'single' }, items: [{ label: 'object', caption: 'A red cup.', bbox: [0, 0, 512, 512] }] }), params: {}, notes: [] }
  compileResultLayout(result, rules.families.moss)
  assert.equal(JSON.parse(result.positive).bbox_coord_space, 'abs_centralized')
  assert.equal(result.params.size, '1024x1024')
  assert.throws(() => compileResultLayout({ positive: '{"positive":"nested envelope"}', params: {}, notes: [] }, rules.families.moss), /Layout/)
  assert.equal(validateOutput('{"type":"layout","elements":[]}', rules.families.moss).valid, false)
  assert.match(buildUser({ familyKind: 'NL+layout', brief: 'A cup.' }, 'gen'), /summary.*items/)
})

test('all families receive spatial and art rules while keeping their output language and user intent', () => {
  for (const family of Object.values(rules.families)) {
    const system = buildSystem(family, 'gen', rules)
    assert.match(system, /动作、接触与空间精度/)
    assert.match(system, /艺术构图、光色与材质/)
    assert.doesNotMatch(system, /每帧只给 1 个主导动作|末段必为情绪收尾|男性角色统一最简配色/)
  }
  const tags = buildUser({ familyKind: 'tag', brief: 'A violinist.', composition: 'diagonal' }, 'gen')
  assert.match(tags, /本族只输出短标签/)
  assert.match(tags, /对角线与动势/)
  const preserve = buildUser({ familyKind: 'NL', source: 'Centered watercolor portrait.', composition: 'preserve' }, 'refine')
  assert.match(preserve, /保留原有主体位置、景别、机位/)
  assert.match(preserve, /保留用户明确要求的非现实结构/)
})

test('style protection keeps explicit exclusions, supplied negatives and displayed text', () => {
  const scene = { positive: 'A woman in a watercolor illustration reads by a window.', negative: '(anime:1.4), watercolor, bad hands' }
  assert.equal(reviewPrompt(scene, rules.families.anima, { brief: '水彩插画。' }).issues.filter((s) => s.includes('负面')).length, 2)
  assert.equal(reviewPrompt(scene, rules.families.anima, { brief: '不要动漫，不用水彩。' }).valid, true)
  assert.equal(reviewPrompt(scene, rules.families.anima, { brief: 'Non-anime, no watercolor.' }).valid, true)
  assert.equal(reviewPrompt(scene, rules.families.anima, { mode: 'iterate', negative: scene.negative, feedback: 'Only change the dress color.' }).valid, true)
  assert.equal(reviewPrompt({ positive: 'A sign reads "no anime".', negative: 'anime' }, rules.families.moss, { brief: '画面标牌上准确写出“no anime”。' }).valid, false)
  assert.equal(reviewPrompt({ positive: 'A photorealistic ceramic cup on a table.', negative: 'photorealistic' }, rules.families.moss, { brief: '写实摄影。' }).valid, false)
  assert.equal(reviewPrompt({ positive: 'A cup drawn with black lines.', negative: 'line art' }, rules.families.moss, { brief: 'Without line art.' }).valid, true)
  const photo = { positive: 'A commercial photograph of a white ceramic teapot.', negative: 'anime, cartoon, illustration' }
  assert.equal(reviewPrompt(photo, rules.families.moss, { brief: '产品摄影，不要动漫或插画。' }).valid, true)
  assert.equal(reviewPrompt(photo, rules.families.moss, { brief: 'Product photograph, no anime or illustration.' }).valid, true)
  assert.equal(reviewPrompt(photo, rules.families.moss, { brief: '不要“anime”或“illustration”。' }).valid, true)
  assert.equal(reviewPrompt(photo, rules.families.moss, { brief: 'No watermark, keep illustration.' }).valid, false)
})

test('single-person pose conflicts are detected without comparing different people or panels', () => {
  const frame = { positive: 'An adult woman is shown in full body and half-body waist-up framing.', negative: '' }
  assert.match(reviewPrompt(frame, rules.families.moss).issues.join(' '), /景别/)
  assert.equal(reviewPrompt(frame, rules.families.moss, { brief: 'Two women in separate panels.' }).valid, true)
  const leap = { positive: 'A solo dancer is airborne with both bare feet planted flat on the stage.', negative: '' }
  assert.match(reviewPrompt(leap, rules.families.anima).issues.join(' '), /腾空又双脚接地/)
  assert.equal(reviewPrompt({ ...leap, positive: 'A solo dancer is airborne, both feet clear of the stage floor.' }, rules.families.anima).valid, true)
  assert.equal(reviewPrompt(leap, rules.families.anima, { mode: 'reverse' }).valid, true)
})

test('MOSS plain prose, requested tags and Layout retain their separate forms', () => {
  const tags = { positive: '1girl, solo, white dress, reading, garden', negative: '' }
  assert.equal(reviewPrompt(tags, rules.families.moss, { brief: 'A woman reads.' }).valid, false)
  assert.equal(reviewPrompt(tags, rules.families.moss, { brief: '只要英文 tag 串，不用 Layout。' }).valid, true)
  const layout = { positive: JSON.stringify({ summary: { caption: 'A cup.' }, items: [{ caption: 'A red cup.', bbox: [0,0,512,512] }] }), negative: '' }
  assert.equal(reviewPrompt(layout, rules.families.moss, { brief: 'Use Layout.' }).valid, true)
  assert.equal(reviewPrompt(layout, rules.families.moss, { brief: '不用 Layout。' }).valid, false)
})

test('conciseness checks request a rewrite while retaining source text and local iteration', () => {
  const scene = { positive: '1girl, solo, solo,\n' + 'The woman wears a red linen dress with ' + 'small '.repeat(215) + 'buttons. Warm light enters from the left window.', negative: '' }
  const saved = scene.positive
  assert.match(reviewPrompt(scene, rules.families.anima).issues.join(' '), /300/)
  assert.match(reviewPrompt(scene, rules.families.anima).issues.join(' '), /重复/)
  assert.equal(scene.positive, saved)
  assert.equal(reviewPrompt(scene, rules.families.anima, { mode: 'iterate', positive: saved, feedback: 'Only change red to blue.' }).valid, true)
  const text = { positive: 'A poster displays "Read this.\nRead this." on a white background.', negative: '' }
  assert.equal(reviewPrompt(text, rules.families.moss).valid, true)
})
