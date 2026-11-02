# Lean context changes

This fork follows the principle of [my-lean-pi-setup](https://github.com/kunkun9527/my-lean-pi-setup): keep the fields and behavioral instructions an agent needs; remove repeated explanations.

## Scope

- The 17 action tools and the three standalone resource tools remain **deferred**. With Pi Agent IDE, its existing Read, Search and Delete tools are reused.
- Only model-facing text changed in `src/computer-tools.ts`, `src/provider.ts` and `src/standalone-tools.ts`. Parameter names, types, constraints, execution code, native driver and browser integration are unchanged.
- The automatically injected resource guide was shortened. The previous full guide remains in `docs/computer-resources-reference.md`.

## Size comparison

| Item | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| First resource guide (characters) | 7,737 | 2,571 | 66.8% |
| Changed model-facing source text (characters removed) | — | — | 3,733 |

These values describe the first lean pass (PR #1). Follow-up changes in PR #2 restore critical invocation hints and further compress remaining parameter/tool descriptions. Measure serialized schema output for current totals; never infer it from source length.

These are **character** measurements, not exact token counts. The second figure is the aggregate source-text delta of the edited tool/provider files (primarily descriptions), **not** a fully serialized tool-schema benchmark. The guide alone saves roughly `ceil(7737/4)-ceil(2571/4) = 1291` estimated tokens using the rough metric of my-lean-pi-setup. Actual model token use depends on the tokenizer, selected deferred tools, Pi version, prompt caching and response length.

Run `npm test`, `npm run typecheck` and Pi's `pi-context-view` on the actual installation to validate behavior and measure loaded tool schemas. Do not claim that all 20 tool definitions are always sent: deferred tools load only when discovered.

## Desktop-only variant (PR #3)

The fork now exposes 16 deferred typed computer tools instead of 17 (19 total in standalone mode). `computer_browser` and the browser-specific parameters of `computer_open` are removed from the model-facing registry. Local and SSH sessions no longer create a Playwright launcher; `computer_open` rejects window-address browser attachment. Native UIA, screenshots and native input still work for Chrome/Edge as ordinary Windows windows.

This is an API-level and startup/backend-entry disable, **not** a full source-code deletion. Browser internals, tests, and the `playwright-core` dependency remain in the repository to avoid breaking shared session functionality before integration tests can run. To make the package smaller, remove these internals in a separate verified refactor. Browser-only features cannot be used through these Pi tools.
