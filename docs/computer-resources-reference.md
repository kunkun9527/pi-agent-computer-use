# Computer

- Load the `computer_*` tools with `tool_search`, one group per query: `computer open window`, `computer wait browser`, `computer files clipboard record`, `computer click hover drag scroll`, `computer type press select timeline`, `computer view viewport`.
- The `/computer-*` commands belong to the user: when a refusal names one, ask the user to run it.
- In IDE mode, native discovery of a `computer_*` action or `ide_capability_computer` loads computer-address help into the shared tools. Use the loader for a resource-only workflow. The first associated Codemode call loads that help too; `searchTools`, `describeTool` and `describeNamespace` leave it unloaded.
- Ordinary file calls and a direct computer-address {read} do not activate schema help. A direct computer-address {read} still works and loads this guide.

## Addresses

- A machine starts on its first use. An address belongs to the machine or sandbox that issued it, and every call on it runs there; nothing falls back to this machine.
- Short forms are `computer:<machine>/<letter><number><tag>`: `w` window, `o` observation, `s` sequence, `a` app, `b` sandbox, `d` display. The tag changes every Pi run, so an address from an earlier run refuses.

## Look

- A sandbox address takes the same `/windows` and `/apps` searches as a machine. Discovery launches nothing.
- {search} an observation to filter its lines without a new capture.
- An overview is 1280 px on the long edge by default.
- `offset` and `limit` page an observation's stored text without capturing again.
- A UI walk cut by limits or time leaves missing elements unknown, not absent.
- OCR can be wrong. For small text, use a viewport or `capture:{"granularity":"image","maxLongEdge":3840}`.

## Input

- Input spends the window's native refs; its change list brings the new ones.
- On native windows, a ref or locator goes through UI Automation in the background, without the human's pointer or focus. When the app does not react to it, use a point instead.
- Drags, `computer_hover` and `computer_timeline` are real input: the window comes to the front. `computer_select` and menus run through UI Automation.
- Real input runs at once, even while the human uses the computer. Another agent's action on the same desktop finishes first.
- `human_stop`: the human pressed Escape three times. Send no more input, tell the user what you were doing, and wait until they turn computer use on again.

Native locators run over the UI Automation tree:

- `getByRole` — UIA control types as ARIA roles: `Button` → `button`, `Edit` → `textbox`, `ListItem` → `listitem` and `option`.
- `getByText`, `getByLabel`, `getByTitle` — visible text, a control's label, UIA help text.
- `getByTestId` — UIA AutomationId.
- `.filter()`, `.nth()`, `.first()`, `.last()`, `.and()`, `.or()` and chaining work as in Playwright. CSS and XPath refuse.

## Waits and viewports

- After `computer_wait`, the last sample's refs are current.
- The change list after input on a viewport covers only the viewport.
- {read} of a viewport only looks: the window's latest observation and refs stay current.
- {delete} removes a viewport; it also goes away with its window.
- Maximize an app that resizes its own window before making viewports.

## Displays

- Pick a resolution with the display's aspect ratio: a 3840×2560 display has no 1920×1280, and 2160×1440 is its closest smaller mode.
- The human sees the new resolution too: tell the user it stays until the computer session closes. Earlier display and window observations stop working; {read} again.

## Browser pages

- Keys go to the page, so browser shortcuts such as `alt+ArrowLeft` do not run there: use `computer_browser`, or `space: "window"`.
- A popup does not become the active tab by itself: `computer_browser` `switch_tab`.
- Downloads land in a temporary folder that closing the session deletes; copy what you need.
- Providers such as Google can reject an automated browser even with `profile: "agent"`.
- Closing the session detaches an attached browser and leaves it open.

`computer_open` at a window address attaches by one of these routes:

- debugging endpoint — a browser, Electron or CEF app started with `--remote-debugging-port=0` in `args`, or a WebView2 app with debugging on. Chrome and Edge need their own `--user-data-dir` for this; Edge also `--disable-sync`.
- remote debugging turned on at `chrome://inspect/#remote-debugging` or `edge://inspect/#remote-debugging` — the browser asks "Allow remote debugging?" and waits up to 2 minutes; the user, or the agent in another call, clicks Allow.
- Playwright Extension — installed by the user; attaching waits up to 2 minutes for "Allow & select".
- VS Code's integrated browser — through `/computer-setup vscode-bridge` and a full VS Code restart.

## Work apart from the human's desktop

- Windows Sandbox — its own focus, pointer, windows and clipboard; starts in 15–20 s; one at a time per machine, and the human's Windows session must be active. Networking is enabled. The guest has no Notepad.
- Sandbox runtime and control mappings are automatic and read-only; its private output mapping is writable. `sandbox.import` is read-only unless `writable` is true, and `sandbox.export` is writable.
- Isolated session — invisible to the human; starts in 15–25 s; several can run at once. Its desktop is 640×480, some apps are missing by name (start them by `path`), and no user folders are shared automatically. Its network policy allows ingress and egress.
- Both use temporary control channels. Sandbox requires a driver bearer token and mutual identity proof; MXC reverse channels mutually prove their roles before forwarding application bytes. Their foreground UI stayed off the human desktop in verified Windows checks. Neither is qualified as hostile-code containment or protection from a local administrator.
- Another machine acts only there: a `url` such as `127.0.0.1` means that machine. Its Windows session must be active, or screenshots come back white. Remote control uses the existing SSH connection and temporary loopback forwards.

## Files and recording

- Save app documents in the session folder of `computer_files`, not in the user's folders.
- An app with its own scripting can build content: `computer_files` `put` the script, `computer_open` the app with its path in `args`, then {read} the window.
- The clipboard is shared with the user's apps.
- A window `sequence` spends the window's refs: {read} it again before input. A `watch` keeps them.
- While a `watch` runs, each action's receipt names its frames, and `frames:last` shows the newest one.

## Receipts in Codemode

Every `computer_*` tool resolves to a receipt object, also when it refused or its outcome is unknown, so a script branches without try/catch:

- `outcome` — `delivered` (not proof the app responded), `refused` (nothing was sent), `unknown` (may have reached the target: {read} again, never replay), `observed` or `closed`.
- `effect` — `applied`, `not-applied` or `unknown`.
- `stage` — `validation` when the request was rejected before reaching the target, otherwise `target`.
- `window`, `viewport`, `observation`, `sandbox` — the addresses the call used or issued.
- `reason`, `code` — why a refused or unknown action ended.
- `page`, `evaluation`, `verification`, `changes`, `steps`, `watch_spans` — when the action produced them.
- `text` — the receipt the model sees.

Check `outcome` before the next input: after a refused click, keys go to whatever has focus. A script that clicks many points uses a viewport: an action's change-list image can have another size than the last {read}. `store()` of a script that later fails is lost.

## Cleanup

Close only windows the task opened.
