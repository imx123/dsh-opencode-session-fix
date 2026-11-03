# dsh-opencode-session-fix

[![npm](https://img.shields.io/npm/v/dsh-opencode-session-fix.svg)](https://www.npmjs.com/package/dsh-opencode-session-fix)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Tested on DSH Desktop **0.2.1-rc.5** (Windows 11, Node 26.12.1), profile bundle
> `@deepseek-ai/dsh-experimental-auto-review` + `@deepseek-ai/dsh-llm-pi-ai`,
> provider `opencode-go`.
>
> 中文文档：[README.zh.md](./README.zh.md)

A Host-only plugin for DeepSeek Harness that repairs one specific failure: with
the **Auto review** permission preset (`EXP`) and an opencode family provider as
the current model, every reviewed tool call fails before its body runs:

```
auto-review: reviewer ended with error INVALID_REQUEST: 400:
{"type":"MissingSessionID","message":"Request is missing x-opencode-session ..."}
```

The plugin supplies a session id for opencode requests that arrive without one,
so the pi-ai provider can emit the `x-opencode-session` header. Requests that
already carry a session id — the main conversation — are untouched.

## Root cause

| Step | Where | Detail |
| --- | --- | --- |
| Auto review builds its request | `dsh-experimental-auto-review/lib/index.js` (`classifyRisk`) | frozen `{ provider, model, system, messages, temperature, signal }` — **no `sessionId`**, then `ctx.llm.stream(options)` |
| Main agent builds its request | `dsh-agent-loop/lib/index.js` | the same call **with** `sessionId: this.session.id` |
| Dispatch | `dsh-llm/lib/index.js` | `stream()` → `llm/stream` waterfall → `adapterStream()` → `registration.adapter.prepareCall()` → that call's `stream(preparedOptions)` |
| Header construction | `dsh-llm-pi-ai/lib/index.js` | `...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }` |
| Header injection | `@earendil-works/pi-ai/dist/providers/opencode-headers.js` | `if (!options?.sessionId) return options` — no session id means no header |

So the reviewer request reaches opencode without the routing header and is
rejected with `400 MissingSessionID`. Nothing is wrong with the provider
configuration.

## Why this seam

- The `llm/stream` waterfall cannot rewrite the request: its listener signature
  is `(options, next)` and `next` takes no arguments, so a listener can only
  wrap the stream that the adapter has already been handed.
- Re-registering the provider is refused with `DUPLICATE_ADAPTER`, and rewriting
  the provider's static `headers` would collapse the main conversation into the
  reviewer's bucket.
- Every dispatch path — `llm.stream()` and a prepared call — goes through the
  object returned by the registered adapter's `prepareCall()`. That object, plus
  the adapter's own `stream()`, is what this plugin wraps.

**Wrap `prepareCall()`, not just `stream()`.** In 0.2.1-rc.5 pi-ai's
`prepareCall()` returns `{ model, stream }` whose `stream` closes over its own
snapshot and never calls the instance `stream()` method:

```js
prepareCall(provider, model, _signal) {
  const snapshot = this.current()
  return Promise.resolve({
    model: this.modelInfo(snapshot, provider, model),
    stream: (options) => this.streamWithSnapshot(options, snapshot),
  })
}
```

Wrapping only `stream()` therefore leaves the reviewer path unfixed. The test
suite in `test/wrapper.test.mjs` reproduces exactly this adapter shape.

## Behaviour

- Provider routes: `opencode-go` and `opencode` by default; configurable.
- Missing or blank `sessionId` → a stable id is injected
  (`dsh-opencode-session-<uuid>`, one per activation, or `config.sessionId`).
- Existing `sessionId` → forwarded unchanged, so the main conversation keeps its
  real session id and its own routing bucket.
- Other providers served by the same adapter instance → untouched, because every
  request is filtered by `options.provider`.
- A frozen request (Auto review deep-freezes its request) is copied, never
  mutated.
- On `llm/adapters-updated` the patch is moved to the newly built adapter; when
  the plugin unloads, every wrapped method is restored (inherited methods are
  deleted again, not shadowed).
- If `llm.adapters` is not a `Map`, the plugin warns once and does nothing
  instead of failing profile activation.

## Install

```powershell
dsh plugin --profile web add dsh-opencode-session-fix
dsh --profile web --dump-config
```

Swap `web` for your profile name; the dump should contain
`- id: opencode-session-fix`. The package is published to npm, so it is also
available in the in-app plugin center.

Desktop: the `desktop` profile is owned by the Electron shell and the CLI
refuses it. Use **Settings → Plugins → install** with the package name
`dsh-opencode-session-fix`, or with this repository's URL.

Source install without npm:
`dsh plugin --profile web add github:imx123/dsh-opencode-session-fix`, or a local
checkout path.

## Configuration

Override the inserted row in the profile's `cordis.patch.yml` (the override
replaces the whole `config`):

```yaml
- id: opencode-session-fix
  name: dsh-opencode-session-fix
  config:
    providers: ['opencode-go']   # default ['opencode-go', 'opencode']
    sessionId: ''                # empty = new UUID per activation
```

## Verify

```powershell
node --check lib/index.js
node test/wrapper.test.mjs
```

Real device: enable Auto review (`EXP`), select an `opencode-go` model, let a
`write` be reviewed. The session log shows the gate that decides it:

```
{"type":"permission/preset","seq":286,"time":1793718502130,"data":{"preset":"auto"}}
```

and that reviewed `write` returned normally instead of
`auto-review of tool "write" failed ... 400 MissingSessionID`.

Regression: the main conversation's `x-opencode-session` must still equal the
real session id (not the plugin's id). Uninstalling the plugin must bring the
`400` back — the patch is reversible.

## Risk and scope

Process-local only: no network calls of its own, no credentials, no disk writes,
no session events. The plugin wraps one object inside the running Host and
restores it when unloaded, so the only thing it can influence is the
`x-opencode-session` header of the configured provider routes.

This is a community plugin, not affiliated with or endorsed by DeepSeek.

## Limits

| Item | Note |
| --- | --- |
| Internal field | `ctx.llm.adapters` is a public class field of the `llm` service, but not a documented extension point; a rename degrades to a warning. |
| Shared bucket | All repaired requests share one id. opencode uses it for routing/caching only, so behaviour is correct while cache locality is coarser than a real session. |
| Upstream fix | If `dsh-experimental-auto-review` later passes its own `sessionId`, the plugin becomes a no-op and can be removed. |
| Not done here | No change to `app.asar`, no session id for unrelated providers, no `llm/stream` attempt to rewrite `options`. |

## License

MIT.
