/**
 * opencode-session-fix — Host plugin for DeepSeek Harness.
 *
 * The experimental Auto review gate builds a frozen request without a
 * `sessionId` and hands it to `ctx.llm.stream()`. For opencode routes the
 * pi-ai provider turns `options.sessionId` into the `x-opencode-session`
 * header, so that request reaches opencode without the header and is refused
 * with `400 MissingSessionID`.
 *
 * The `llm/stream` waterfall cannot repair this: its `next` thunk takes no
 * arguments, so a listener can wrap the stream but never rewrite `options`.
 * Re-registering the provider is refused with `DUPLICATE_ADAPTER`. The seam
 * that actually carries the request into the adapter is the registered adapter
 * instance: every dispatch path — `LlmRuntime.stream()` and the prepared-call
 * path — dispatches through the object returned by `adapter.prepareCall()`,
 * and the adapter's own `stream()` covers direct callers.
 *
 * This plugin therefore wraps those two methods on the adapter instance that
 * serves the configured provider routes, injecting one stable id only when the
 * request has none. A request that already carries a session id passes through
 * untouched, so the main conversation keeps its real session id.
 */
import { randomUUID } from 'node:crypto'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'opencode-session-fix'

/** The `llm` service owns the adapter registry this plugin repairs. */
export const inject = ['llm']

/** Provider routes that speak the opencode session-header protocol. */
const DEFAULT_PROVIDERS = ['opencode-go', 'opencode']

/** An absent or blank session id is what opencode rejects. */
function isBlank(value) {
  if (value === undefined || value === null) return true
  return typeof value === 'string' && value.trim() === ''
}

/**
 * Resolve the configured provider routes, falling back to the opencode ones.
 *
 * @param {unknown} config - the plugin row's `config` value, untrusted.
 * @returns {string[]} non-empty provider route names.
 */
function readProviders(config) {
  const configured = config?.providers
  if (!Array.isArray(configured)) return DEFAULT_PROVIDERS
  const providers = configured
    .filter((provider) => typeof provider === 'string')
    .map((provider) => provider.trim())
    .filter((provider) => provider !== '')
  return providers.length === 0 ? DEFAULT_PROVIDERS : providers
}

/**
 * Resolve the id injected into requests that carry none.
 *
 * @param {unknown} config - the plugin row's `config` value, untrusted.
 * @returns {string} the configured id, or one generated per activation.
 */
function readSessionId(config) {
  const configured = config?.sessionId
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return `dsh-opencode-session-${randomUUID()}`
}

/**
 * Install the request repair on the opencode adapter routes.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {{ providers?: string[], sessionId?: string }} [config] - row config.
 */
export function apply(ctx, config) {
  const providers = new Set(readProviders(config))
  const injectedSessionId = readSessionId(config)
  /** @type {Map<object, Record<string, any>>} adapter instance -> undo record */
  const patched = new Map()

  /**
   * Add the fallback session id to one request, copying instead of mutating.
   *
   * Auto review deep-freezes its request, and adapters may hand along objects
   * they own, so the original is never written to. Requests that already carry
   * a session id, and routes this plugin does not serve, are returned as-is.
   *
   * @param {unknown} options - the `GenerateOptions` about to reach the adapter.
   * @returns {unknown} the original request, or a copy carrying a session id.
   */
  const withSessionId = (options) => {
    if (options === null || typeof options !== 'object') return options
    if (!isBlank(options.sessionId)) return options
    if (typeof options.provider !== 'string' || !providers.has(options.provider)) return options
    return { ...options, sessionId: injectedSessionId }
  }

  /**
   * Replace one adapter instance's dispatch seam.
   *
   * `prepareCall()` is the important one: pi-ai returns
   * `{ model, stream }` where `stream` closes over its snapshot and never
   * touches the instance `stream()` method, so wrapping `stream()` alone would
   * leave the reviewer path unfixed. `stream()` is wrapped as well so direct
   * adapter callers are covered.
   *
   * @param {object} adapter - the adapter instance registered for a route.
   */
  const patch = (adapter) => {
    const record = {
      adapter,
      ownStream: Object.hasOwn(adapter, 'stream'),
      ownPrepareCall: Object.hasOwn(adapter, 'prepareCall'),
      stream: adapter.stream,
      prepareCall: adapter.prepareCall,
    }
    patched.set(adapter, record)
    try {
      if (typeof record.stream === 'function') {
        const wrapped = function (options) {
          return record.stream.call(this, withSessionId(options))
        }
        record.wrappedStream = wrapped
        adapter.stream = wrapped
      }
      if (typeof record.prepareCall === 'function') {
        const wrapped = async function (...args) {
          const call = await record.prepareCall.apply(this, args)
          if (call === null || typeof call !== 'object' || typeof call.stream !== 'function') return call
          const stream = call.stream
          // Keep the original prepared-call object's shape and prototype so the
          // adapter's snapshot binding, model metadata, and any own fields survive.
          const descriptors = Object.getOwnPropertyDescriptors(call)
          descriptors.stream = {
            configurable: true,
            enumerable: true,
            writable: true,
            value: (options) => stream.call(call, withSessionId(options)),
          }
          return Object.create(Object.getPrototypeOf(call), descriptors)
        }
        record.wrappedPrepareCall = wrapped
        adapter.prepareCall = wrapped
      }
    } catch (error) {
      restore(record)
      patched.delete(adapter)
      throw error
    }
  }

  /**
   * Undo one patch, leaving a foreign replacement in place.
   *
   * Methods that were inherited are deleted again rather than shadowed, so an
   * unload leaves the adapter exactly as it was found.
   *
   * @param {Record<string, any>} record - the undo record for one adapter.
   */
  const restore = (record) => {
    const adapter = record.adapter
    if (record.wrappedStream !== undefined && adapter.stream === record.wrappedStream) {
      if (record.ownStream) adapter.stream = record.stream
      else delete adapter.stream
    }
    if (record.wrappedPrepareCall !== undefined && adapter.prepareCall === record.wrappedPrepareCall) {
      if (record.ownPrepareCall) adapter.prepareCall = record.prepareCall
      else delete adapter.prepareCall
    }
  }

  /** Patch one adapter, degrading to a warning when the instance is sealed. */
  const patchQuietly = (adapter) => {
    if (patched.has(adapter)) return
    try {
      patch(adapter)
    } catch (error) {
      ctx.logger?.warn?.('opencode-session-fix: could not wrap one LLM adapter', error)
    }
  }

  /**
   * Patch every adapter currently registered for a configured route.
   *
   * One pi-ai adapter instance serves several routes, so routes are mapped to
   * instances and each instance is patched once; which requests a patched
   * adapter rewrites is decided per request by `options.provider`.
   */
  const install = () => {
    const registry = ctx.llm?.adapters
    if (!(registry instanceof Map)) {
      ctx.logger?.warn?.(
        'opencode-session-fix: llm.adapters is not a Map, so the opencode session header cannot be supplied',
      )
      return
    }
    for (const provider of providers) {
      const adapter = registry.get(provider)?.adapter
      if (adapter === null || adapter === undefined) continue
      patchQuietly(adapter)
    }
  }

  /** Undo every patch this activation holds. */
  const uninstall = () => {
    for (const record of patched.values()) restore(record)
    patched.clear()
  }

  ctx.effect(function* () {
    install()
    // pi-ai rebuilds its adapter when the model configuration changes, so the
    // patch has to follow the registry rather than a captured instance.
    yield ctx.on('llm/adapters-updated', () => {
      uninstall()
      install()
    })
    yield () => {
      uninstall()
    }
  }, 'opencode-session-fix: opencode session header')
}
