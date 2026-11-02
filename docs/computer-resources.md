# Computer use

Load tools through `tool_search`: `computer open window`, `computer click hover drag scroll`, `computer type press select timeline`, `computer wait browser`, `computer files clipboard record`, or `computer view viewport`. IDE uses shared {read}/{search}/{delete}; standalone uses computer_read/computer_search/computer_delete. `/computer-*` commands are user-only: ask the user when needed.

## Discover and observe

- `{search}` `computer:machine/local/windows` or `/apps`; `{read}` a window for its UI tree and screenshot. `computer:session` lists resources.
- Addresses are scoped to a machine and session. New reads or input may invalidate element refs; use latest observation/change refs.
- `{search}` an observation filters UI text without recapture. Read `views:["ui"]`, `["image"]`, `["dom"]` or `["changes"]` as needed. Incomplete/truncated trees do not prove absence.
- Use crop/viewport for small UI; OCR/regions when the tree is sparse.
- Native UIA locators support `getByRole`, `getByText`, `getByLabel`, `getByTestId` and chaining. CSS/XPath only work on browser pages.

## Act and verify

- Prefer current element refs/locators. Native semantic UIA can operate in background; native point clicks, hover, drag, timelines and real keys can foreground the window. Browser pages use Playwright.
- Native window/viewport points use latest screenshot pixels; browser page points use CSS pixels. Never derive points from a differently sized change image.
- Inspect action receipts and changed UI. `delivered` means dispatched, not confirmed app effect. `unknown` may have applied: **read back before retrying**.
- After a refused click, keyboard focus may be elsewhere. Do not blindly type.
- `human_stop` means the user stopped input with Escape; do not resume until re-enabled.

## Browser, isolation and cleanup

- `computer_open` launches/attaches browsers (remote debugging or Playwright Extension may require user approval). `computer_browser` handles navigation, tabs, dialogs, uploads and downloads. Browser shortcuts may need `space:"window"`.
- Browser downloads and session files are temporary; attaching does not give permission to close the user's browser.
- Windows Sandbox/isolated sessions keep foreground input away from the human desktop, but are not general security boundaries. Safe mode allows only agent-opened windows.
- Display resolution changes affect the user until computer use closes. Clipboard is shared.
- Close only windows the task opened.

Further details: `docs/computer-resources-reference.md` in the package.
