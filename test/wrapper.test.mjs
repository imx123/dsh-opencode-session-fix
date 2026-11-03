/**
 * Behaviour tests for the opencode-session-fix Host plugin.
 *
 * The fake adapter reproduces the pi-ai shape that matters: `prepareCall()`
 * returns `{ model, stream }` whose `stream` closes over its own snapshot and
 * never calls the instance `stream()` method. A fix that wraps only
 * `stream()` therefore fails the reviewer test below — which is exactly the
 * mistake this file is here to catch.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, inject, name } from '../lib/index.js'

/** Minimal stand-in for the Cordis context the plugin touches. */
function makeContext() {
  const listeners = new Map()
  const disposers = []
  const warnings = []
  const ctx = {
    llm: { adapters: new Map() },
    logger: { warn: (...args) => warnings.push(args) },
    warnings,
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    // Cordis runs the generator and owns the yielded disposers.
    effect(factory) {
      for (const dispose of factory()) disposers.push(dispose)
    },
    emit(event) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener()
    },
    dispose() {
      for (const dispose of [...disposers].reverse()) dispose()
      disposers.length = 0
    },
  }
  return ctx
}

/** Adapter shaped like `@earendil-works/pi-ai`'s opencode provider. */
function makeAdapter() {
  const seen = []
  class FakeAdapter {
    stream(options) {
      seen.push({ via: 'stream', options })
      return (function* () {})()
    }
    prepareCall(provider, model) {
      return Promise.resolve({
        model: { provider, id: model },
        stream: (options) => this.snapshotStream(options),
      })
    }
    *snapshotStream(options) {
      seen.push({ via: 'snapshot', options })
    }
  }
  return { adapter: new FakeAdapter(), seen }
}

/** Register one adapter instance under the given routes. */
function register(ctx, adapter, routes) {
  for (const route of routes) {
    ctx.llm.adapters.set(route, {
      adapter,
      provider: { id: route, name: route },
      retryPolicy: {},
    })
  }
}

/** Consume a chunk iterable. */
async function drain(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** Dispatch through the prepared-call path, as `LlmRuntime` does. */
async function dispatch(adapter, provider, model, options) {
  const call = await adapter.prepareCall(provider, model)
  await drain(call.stream(options))
  return call
}

test('exports the Host plugin contract', () => {
  assert.equal(name, 'opencode-session-fix')
  assert.deepEqual(inject, ['llm'])
})

test('repairs a frozen reviewer request that carries no session id', async () => {
  const ctx = makeContext()
  const { adapter, seen } = makeAdapter()
  register(ctx, adapter, ['opencode-go'])
  apply(ctx, {})

  const options = Object.freeze({ provider: 'opencode-go', model: 'm', messages: [], temperature: 0 })
  await dispatch(adapter, 'opencode-go', 'm', options)

  assert.equal(seen.length, 1)
  const [{ via, options: forwarded }] = seen
  assert.equal(via, 'snapshot')
  assert.match(forwarded.sessionId, /^dsh-opencode-session-/)
  assert.notEqual(forwarded, options, 'the frozen request must be copied, never mutated')
  assert.equal(options.sessionId, undefined)
})

test('keeps the real session id on the main conversation', async () => {
  const ctx = makeContext()
  const { adapter, seen } = makeAdapter()
  register(ctx, adapter, ['opencode-go'])
  apply(ctx, {})

  const options = Object.freeze({ provider: 'opencode-go', model: 'm', messages: [], sessionId: 'real-session-7' })
  await dispatch(adapter, 'opencode-go', 'm', options)

  assert.equal(seen.at(-1).options.sessionId, 'real-session-7')
  assert.equal(seen.at(-1).options, options, 'a call that needs no repair is forwarded as-is')
})

test('leaves other routes served by the same adapter alone', async () => {
  const ctx = makeContext()
  const { adapter, seen } = makeAdapter()
  register(ctx, adapter, ['opencode-go', 'aaa'])
  apply(ctx, {})

  await dispatch(adapter, 'aaa', 'm', Object.freeze({ provider: 'aaa', model: 'm', messages: [] }))

  assert.equal(seen.at(-1).options.sessionId, undefined)
})

test('covers direct adapter.stream() callers as well', async () => {
  const ctx = makeContext()
  const { adapter, seen } = makeAdapter()
  register(ctx, adapter, ['opencode'])
  apply(ctx, {})

  await drain(adapter.stream({ provider: 'opencode', model: 'm', messages: [] }))

  assert.equal(seen.at(-1).via, 'stream')
  assert.match(seen.at(-1).options.sessionId, /^dsh-opencode-session-/)
})

test('treats a blank session id as missing', async () => {
  const ctx = makeContext()
  const { adapter, seen } = makeAdapter()
  register(ctx, adapter, ['opencode-go'])
  apply(ctx, {})

  await dispatch(adapter, 'opencode-go', 'm', Object.freeze({ provider: 'opencode-go', model: 'm', messages: [], sessionId: '  ' }))

  assert.match(seen.at(-1).options.sessionId, /^dsh-opencode-session-/)
})

test('honours config.sessionId and a narrowed provider list', async () => {
  const ctx = makeContext()
  const opencodeGo = makeAdapter()
  const plainOpencode = makeAdapter()
  register(ctx, opencodeGo.adapter, ['opencode-go'])
  register(ctx, plainOpencode.adapter, ['opencode'])
  apply(ctx, { providers: ['opencode-go'], sessionId: 'team-fixed-id' })

  await dispatch(opencodeGo.adapter, 'opencode-go', 'm', Object.freeze({ provider: 'opencode-go', model: 'm', messages: [] }))
  assert.equal(opencodeGo.seen.at(-1).options.sessionId, 'team-fixed-id')

  await dispatch(plainOpencode.adapter, 'opencode', 'm', Object.freeze({ provider: 'opencode', model: 'm', messages: [] }))
  assert.equal(plainOpencode.seen.at(-1).options.sessionId, undefined)
  assert.equal(Object.hasOwn(plainOpencode.adapter, 'prepareCall'), false)
})

test('one stable id is shared by every repaired request', async () => {
  const ctx = makeContext()
  const { adapter, seen } = makeAdapter()
  register(ctx, adapter, ['opencode-go', 'opencode'])
  apply(ctx, {})

  await dispatch(adapter, 'opencode-go', 'm', Object.freeze({ provider: 'opencode-go', model: 'm', messages: [] }))
  await dispatch(adapter, 'opencode', 'm', Object.freeze({ provider: 'opencode', model: 'm', messages: [] }))

  assert.equal(seen[0].options.sessionId, seen[1].options.sessionId)
})

test('re-attaches to a rebuilt adapter on llm/adapters-updated', async () => {
  const ctx = makeContext()
  const first = makeAdapter()
  register(ctx, first.adapter, ['opencode-go'])
  apply(ctx, {})

  const second = makeAdapter()
  ctx.llm.adapters.set('opencode-go', { adapter: second.adapter, provider: { id: 'opencode-go', name: 'opencode-go' }, retryPolicy: {} })
  ctx.emit('llm/adapters-updated')

  assert.equal(Object.hasOwn(first.adapter, 'prepareCall'), false, 'the retired instance is restored')
  await dispatch(second.adapter, 'opencode-go', 'm', Object.freeze({ provider: 'opencode-go', model: 'm', messages: [] }))
  assert.match(second.seen.at(-1).options.sessionId, /^dsh-opencode-session-/)
})

test('repeat installs do not wrap a method twice', async () => {
  const ctx = makeContext()
  const { adapter, seen } = makeAdapter()
  register(ctx, adapter, ['opencode-go'])
  apply(ctx, {})

  ctx.emit('llm/adapters-updated')
  ctx.emit('llm/adapters-updated')

  await dispatch(adapter, 'opencode-go', 'm', Object.freeze({ provider: 'opencode-go', model: 'm', messages: [] }))
  assert.equal(seen.length, 1)
  assert.match(seen[0].options.sessionId, /^dsh-opencode-session-/)
})

test('uninstall restores the adapter exactly', async () => {
  const ctx = makeContext()
  const { adapter, seen } = makeAdapter()
  register(ctx, adapter, ['opencode-go'])
  apply(ctx, {})

  ctx.dispose()

  assert.equal(Object.hasOwn(adapter, 'stream'), false)
  assert.equal(Object.hasOwn(adapter, 'prepareCall'), false)
  await dispatch(adapter, 'opencode-go', 'm', Object.freeze({ provider: 'opencode-go', model: 'm', messages: [] }))
  assert.equal(seen.at(-1).options.sessionId, undefined)
})

test('degrades with a warning when llm.adapters is unavailable', () => {
  const ctx = makeContext()
  ctx.llm = {}
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(ctx.warnings.length, 1)
  assert.match(String(ctx.warnings[0][0]), /llm\.adapters/)
})
