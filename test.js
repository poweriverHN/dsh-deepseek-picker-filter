/**
 * 用假 ctx 跑一遍过滤逻辑：白名单正常 / 过期 / 缺失 / 坏 JSON / 当前选中保护。
 * 运行：node --test
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from './index.js'

const catalog = {
  default: { provider: 'trae', model: 'DeepSeek-V4-Pro' },
  groups: [
    { id: 'trae', models: [{ id: 'DeepSeek-V4-Pro' }, { id: 'dead-model' }] },
    { id: 'deepseek-official', models: [{ id: 'deepseek-flash' }] },
    { id: 'unlisted-channel', models: [{ id: 'whatever' }] },
  ],
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-filter-'))
const whitelist = path.join(tmp, 'whitelist.json')

/** 假 ctx：只提供 modelCatalog 和 effect。 */
function harness(catalogForTest = catalog) {
  const controller = { modelCatalog: async () => catalogForTest }
  const ctx = {
    sessionController: controller,
    effect: (fn) => fn(),
  }
  apply(ctx, { whitelistPath: whitelist })
  return controller
}

/** 写一份白名单。 */
function writeWhitelist(value) {
  fs.writeFileSync(whitelist, JSON.stringify(value))
}

test('只保留白名单里的模型和 keepProviders', async () => {
  writeWhitelist({
    at: Date.now(),
    staleAfterMinutes: 180,
    keepProviders: ['deepseek-official', 'deepseek-account', 'codearts'],
    models: [{ provider: 'trae', model: 'DeepSeek-V4-Pro' }],
  })
  const out = await harness().modelCatalog()
  assert.deepStrictEqual(out.groups.map(group => group.id), ['trae', 'deepseek-official'])
  assert.deepStrictEqual(out.groups[0].models.map(model => model.id), ['DeepSeek-V4-Pro'])
  assert.deepStrictEqual(out.routableProviders, ['trae', 'deepseek-official'])
})

test('白名单过期时沿用上次清单，不再放行全目录', async () => {
  writeWhitelist({
    at: Date.now() - 999 * 60_000,
    staleAfterMinutes: 180,
    keepProviders: ['deepseek-official'],
    models: [{ provider: 'trae', model: 'DeepSeek-V4-Pro' }],
  })
  const out = await harness().modelCatalog()
  // 过期不等于「没有白名单」：继续用最后一次巡检确认的清单，只是可能有新模型还没进来。
  assert.deepStrictEqual(out.groups.map(group => group.id), ['trae', 'deepseek-official'])
  assert.deepStrictEqual(out.groups[0].models.map(model => model.id), ['DeepSeek-V4-Pro'])
})

test('白名单从未读到过（缺失）时放行全部', async () => {
  fs.rmSync(whitelist, { force: true })
  const out = await harness().modelCatalog()
  assert.strictEqual(out.groups.length, catalog.groups.length)
})

test('白名单坏掉且从未成功读过时放行全部', async () => {
  fs.writeFileSync(whitelist, '{ not json')
  const out = await harness().modelCatalog()
  assert.strictEqual(out.groups.length, catalog.groups.length)
})

test('成功读过之后文件被删，仍沿用上次清单（不放行全目录）', async () => {
  writeWhitelist({
    at: Date.now(),
    staleAfterMinutes: 180,
    keepProviders: ['deepseek-official'],
    models: [{ provider: 'trae', model: 'DeepSeek-V4-Pro' }],
  })
  // 同一个实例先成功读一次，再删文件
  const controller = harness()
  const first = await controller.modelCatalog()
  assert.strictEqual(first.groups.length, 2)

  fs.rmSync(whitelist, { force: true })
  const second = await controller.modelCatalog()
  assert.deepStrictEqual(second.groups.map(group => group.id), ['trae', 'deepseek-official'],
    '巡检停了也不该把无关渠道摊出来')
})

test('成功读过之后白名单变成坏 JSON，仍沿用上次清单', async () => {
  writeWhitelist({
    at: Date.now(),
    staleAfterMinutes: 180,
    keepProviders: ['deepseek-official'],
    models: [{ provider: 'trae', model: 'DeepSeek-V4-Pro' }],
  })
  const controller = harness()
  await controller.modelCatalog()

  fs.writeFileSync(whitelist, '{ not json')
  const out = await controller.modelCatalog()
  assert.deepStrictEqual(out.groups.map(group => group.id), ['trae', 'deepseek-official'])
})

test('当前选中的模型即使不在白名单也保留', async () => {
  writeWhitelist({ at: Date.now(), keepProviders: [], models: [{ provider: 'other', model: 'zzz' }] })
  const out = await harness().modelCatalog()
  const flat = out.groups.flatMap(group => group.models.map(model => `${group.id}/${model.id}`))
  assert.ok(flat.includes('trae/DeepSeek-V4-Pro'))
})

const volcCatalog = {
  default: { provider: 'codearts', model: 'glm-5.3' },
  groups: [
    { id: 'trae', models: [{ id: 'DeepSeek-V4-Pro' }] },
    { id: 'deepseek-official', models: [{ id: 'deepseek-flash' }] },
    { id: 'volcengine', models: [{ id: 'deepseek-v4-1-flash-261017' }, { id: 'doubao-seed-2-1-pro-260915' }] },
    { id: 'codearts', models: [{ id: 'glm-5.3' }] },
  ],
}

test('火山方舟不参与巡检筛选，且整组紧跟在 codearts 之后', async () => {
  writeWhitelist({
    at: Date.now(),
    staleAfterMinutes: 180,
    keepProviders: ['deepseek-official', 'deepseek-account', 'codearts'],
    models: [],
  })
  const out = await harness(volcCatalog).modelCatalog()
  assert.deepStrictEqual(out.groups.map(group => group.id), ['deepseek-official', 'codearts', 'volcengine'])
  assert.deepStrictEqual(out.routableProviders, ['deepseek-official', 'codearts', 'volcengine'])
  assert.deepStrictEqual(out.groups[out.groups.length - 1].models.map(model => model.id),
    ['deepseek-v4-1-flash-261017', 'doubao-seed-2-1-pro-260915'])
})

test('白名单 keepProviders 为空时，火山方舟仍保留', async () => {
  writeWhitelist({ at: Date.now(), staleAfterMinutes: 180, keepProviders: [], models: [] })
  const out = await harness(volcCatalog).modelCatalog()
  assert.ok(out.groups.some(group => group.id === 'volcengine'))
})

test('火山方舟在白名单里没有对应条目，也不被白名单过滤掉', async () => {
  writeWhitelist({
    at: Date.now(),
    staleAfterMinutes: 180,
    keepProviders: ['deepseek-official'],
    models: [{ provider: 'trae', model: 'DeepSeek-V4-Pro' }],
  })
  const out = await harness(volcCatalog).modelCatalog()
  const ark = out.groups.find(group => group.id === 'volcengine')
  assert.ok(ark && ark.models.length === 2, '火山方舟整组应完整保留')
})