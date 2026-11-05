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
function harness() {
  const controller = { modelCatalog: async () => catalog }
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

test('白名单过期时放行全部', async () => {
  writeWhitelist({
    at: Date.now() - 999 * 60_000,
    staleAfterMinutes: 180,
    keepProviders: ['deepseek-official'],
    models: [{ provider: 'trae', model: 'DeepSeek-V4-Pro' }],
  })
  const out = await harness().modelCatalog()
  assert.strictEqual(out.groups.length, catalog.groups.length)
})

test('白名单缺失时放行全部', async () => {
  fs.rmSync(whitelist, { force: true })
  const out = await harness().modelCatalog()
  assert.strictEqual(out.groups.length, catalog.groups.length)
})

test('白名单坏掉时放行全部', async () => {
  fs.writeFileSync(whitelist, '{ not json')
  const out = await harness().modelCatalog()
  assert.strictEqual(out.groups.length, catalog.groups.length)
})

test('当前选中的模型即使不在白名单也保留', async () => {
  writeWhitelist({ at: Date.now(), keepProviders: [], models: [{ provider: 'other', model: 'zzz' }] })
  const out = await harness().modelCatalog()
  const flat = out.groups.flatMap(group => group.models.map(model => `${group.id}/${model.id}`))
  assert.ok(flat.includes('trae/DeepSeek-V4-Pro'))
})