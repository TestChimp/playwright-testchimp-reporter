# @testchimp/playwright

A [Playwright](https://playwright.dev/) / Mobilewright reporter that sends test execution results to the [TestChimp](https://testchimp.io) platform. It powers **QA intelligence insights**, surfaces **AI-native steps** (e.g. `ai.act`, `ai.verify`) from the test runner into TestChimp for CI, and **augments RUM events** from [@testchimp/rum-js](https://www.npmjs.com/package/@testchimp/rum-js) so test runs align with real user events for **TrueCoverage**.

---

## Purpose

### 1. Report execution results to TestChimp for QA intelligence

The reporter collects test runs (pass/fail, steps, errors, timing) and sends them to the TestChimp backend. TestChimp uses this data to:

- Track which tests ran, when, and their outcome
- Drive dashboards, trends, and QA intelligence
- Correlate failures with steps and screenshots for faster debugging
- Support traceability between tests, scenarios, and coverage

You run tests with the normal Playwright CLI or via your CI (GitHub Actions etc.); the reporter runs in process and posts results to TestChimp without changing how you execute tests.

### 2. Pipe AI-native steps through TestChimp so they work wherever you run tests

The reporter plugin pipes AI-native step calls (`ai.act`, `ai.verify`, etc.) via TestChimp backends, so that those steps work seamlessly—wherever you run your tests (local, CI, or any environment).

### 3. Augment RUM events for TrueCoverage (test ↔ real user alignment)

[@testchimp/rum-js](https://www.npmjs.com/package/@testchimp/rum-js) (web), **TestChimpRum** (iOS — Swift package [testchimp-rum-ios](https://github.com/testchimphq/testchimp-rum-ios)), and **TestChimpRum** (Android — [testchimp-rum-android](https://github.com/testchimphq/testchimp-rum-android), typically via JitPack: `com.github.testchimphq:testchimp-rum-android:<tag>` per [JitPack](https://jitpack.io/#testchimphq/testchimp-rum-android)) emit real user events to TestChimp. When the same app is exercised **in CI** (Playwright or Mobilewright), you want those events tagged with **which test** produced them so TestChimp can:

- Align test runs with real user sessions (TrueCoverage)
- See which tests generated which events
- Compare test coverage to production usage to drive better QA strategy.

Read more about TestChimps' TrueCoverage feature [here](https://docs.testchimp.io/truecoverage/intro).

---

## Installation

```bash
npm install @testchimp/playwright
```

Peer dependency: `@playwright/test` (e.g. `>=1.40.0`) for web projects, and `mobilewright` for mobile projects.

Platform is determined per test from Mobilewright `projects[].use.platform` (`ios` / `android`; omitted = web), with fallback to `testInfo.annotations` (`device.platform`, Mobilewright 0.0.36+). Requires **mobilewright >= 0.0.37** for multi-project `installApps`. Pass `installTestChimp(base, { uiFixture: 'screen' })` when wrapping `@mobilewright/test`; default `page` for `@playwright/test` (web path never touches `device` fixtures).

---

## Quick start

### 1. Playwright config

Configure the reporter in your playwright.config.js like below:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

// Optional: import runtime so CI test info is injected for @testchimp/rum-js (TrueCoverage)


export default defineConfig({
  reporter: [
    ['list'],
    ['@testchimp/playwright/reporter', {
      verbose: true,
      reportOnlyFinalAttempt: true,
      captureScreenshots: true,
    }],
  ],
});
```

For TrueCoverage, **wrap and re-export** `test` from your fixtures entry (recommended):

```ts
import { test as base } from '@playwright/test';
import { installTestChimp } from '@testchimp/playwright/runtime';
export const test = installTestChimp(base); // default uiFixture: 'page'

// Mobilewright fixtures barrel:
// import { test as base } from '@mobilewright/test';
// export const test = installTestChimp(base, { uiFixture: 'screen' });
```

A side-effect-only `import '@testchimp/playwright/runtime'` does not apply extended fixtures or mobile hooks; the returned `TestType` from `installTestChimp` must be what your specs import.

**Web:** the runtime injects `__TC_CI_TEST_INFO` on the `page` fixture for `@testchimp/rum-js`, then calls `globalThis.__TC_RUM_FLUSH` after each test (fixture teardown) so buffered events are sent before Playwright closes the page. Requires `@testchimp/rum-js` **≥ 0.1.3**. Optional: `TESTCHIMP_RUM_WEB_FLUSH_TIMEOUT_MS` (default **5000**, clamp **100–30000**) caps `page.evaluate` for the flush.

**Mobile (iOS/Android):** set `use.platform` to `ios` or `android` on Mobilewright UI projects and use `installTestChimp(base, { uiFixture: 'screen' })`. The runtime extends the Mobilewright **`device`** fixture so **`SET`** runs right after Mobilewright’s **`launchApp`** (via `device.openUrl`), before **`screen`** and the test body; **`afterEach`** still sends a trailing **`SET`** + **`v1/flush`**. By default **no** `/v1/clear` between tests—each test **`SET`s** new CI so RUM avoids a clear→set gap with missing `ci_test_info`. Integrate **TestChimpRum** for that platform (see `testchimp-rum-ios` / `testchimp-rum-android` READMEs): URL scheme / intent filter for `testchimp-rum://truecoverage/...`.

Optional URL overrides: `TESTCHIMP_RUM_AUTOMATION_SET_PREFIX`, `TESTCHIMP_RUM_AUTOMATION_CLEAR_URL`, `TESTCHIMP_RUM_AUTOMATION_FLUSH_URL` (defaults match the native SDKs). Legacy: set **`TESTCHIMP_RUM_AUTOMATION_CLEAR_BETWEEN_TESTS=1`** to send `/v1/clear` before each test’s `SET` again.

### 2. Environment variables

Set these so the reporter can talk to TestChimp (env vars override programmatic options):

| Variable | Required | Description |
|----------|----------|-------------|
| `TESTCHIMP_API_KEY` | Yes | API key for TestChimp. |
| `TESTCHIMP_PROJECT_ID` | No | Legacy/optional; the backend resolves the project from the API key when omitted. |
| `TESTCHIMP_TESTS_FOLDER` | No | Base folder for relative paths (default: `tests`). |
| `TESTCHIMP_RELEASE` | No | Release/version identifier. |
| `TESTCHIMP_ENV` | No | Environment (e.g. `staging`, `prod`). |
| `TESTCHIMP_RUM_AUTOMATION_SET_PREFIX` | No | Override set-URL prefix (default `testchimp-rum://truecoverage/v1/set?p=` + base64url JSON). |
| `TESTCHIMP_RUM_AUTOMATION_CLEAR_URL` | No | Override clear URL (default `testchimp-rum://truecoverage/v1/clear`). |
| `TESTCHIMP_RUM_AUTOMATION_CLEAR_BETWEEN_TESTS` | No | When `1`/`true`/`yes`, each test’s **`device`** fixture sends `/v1/clear` before `SET` (legacy). **Default off** so CI stays set until overwritten, avoiding null `ci_test_info` on RUM during the clear→set window. |
| `TESTCHIMP_RUM_AUTOMATION_SUITE_TEARDOWN_CLEAR` | No | When `1`/`true`/`yes`, registers `afterAll` to send `/v1/clear` then `/v1/flush` after the spec file. **Default off** (avoids clearing CI between spec files before the next file’s `SET`). |
| `TESTCHIMP_RUM_TRANSPORT_RESYNC` | No | Mobile `screen` fixture: set to `0` to disable automatic TrueCoverage `v1/set` after likely WebSocket/mobilecli transport failures (default: enabled). |
| `TESTCHIMP_RUM_WEB_FLUSH_TIMEOUT_MS` | No | Web `page` fixture: per-call timeout for RUM flush `page.evaluate` (default **5000**, clamp **100–30000**). |

If `TESTCHIMP_API_KEY` is missing, the reporter logs a warning and disables reporting (no request is sent).

### 3. Run tests

```bash
export TESTCHIMP_API_KEY=your-api-key
npx playwright test
```

Results are reported to TestChimp after each test (or after the final attempt when using retries and `reportOnlyFinalAttempt: true`).

---

## Reporter options

You can pass options in `playwright.config.ts`:

```ts
['@testchimp/playwright/reporter', {
  apiKey: '...',           // override env (not recommended in CI)
  backendUrl: '...',       // override TESTCHIMP_BACKEND_URL
  projectId: '...',       // optional override env
  testsFolder: 'tests',   // base dir for relative path calculation
  release: '1.0.0',
  environment: 'staging',
  reportOnlyFinalAttempt: true,  // only send report for last retry (default: true)
  captureScreenshots: true,      // attach screenshots to failing steps (default: true)
  verbose: false,               // extra logging (default: false)
}]
```

Environment variables take precedence over these options.

---

## What gets reported

For each test (or its final attempt when using retries), the reporter sends a **Smart Test Execution Report** that includes:

- **Identity**: `folderPath`, `fileName`, `suitePath`, `testName` (derived from test file and describe blocks).
- **Run context**: `batchInvocationId`, `branchName` (from env when available), `release`, `environment`.
- **Job detail**:
  - **Steps**: Every Playwright step with category `test.step`, `expect`, or `pw:api` (including AI-native steps).
  - **Status**: Completed, Failed, or Unknown (mapped from Playwright status).
  - **Error**: Top-level test error message if failed.
  - **Screenshots**: For failing steps, when `captureScreenshots` is true and Playwright has attached screenshots (e.g. `screenshot: 'only-on-failure'`).

Retries are tracked; with `reportOnlyFinalAttempt: true` only the last attempt is reported.


---

## Exports

- **Subpath**: `@testchimp/playwright/reporter` — explicit reporter entry for Playwright `reporter` config.
- **Named**: `TestChimpReporter`, `TestChimpApiClient`, and types/utilities from `./types` and `./utils`.
- **Subpath**: `@testchimp/playwright/runtime` — use `installTestChimp(test)` on your runner’s `test` object (see Quick start).
  - **Web:** extends `page` to set `__TC_CI_TEST_INFO` and flush `@testchimp/rum-js` after each test via `globalThis.__TC_RUM_FLUSH` (requires rum-js **≥ 0.1.3**).
  - **Mobile:** when `projects[].use.platform` is `ios`/`android`, registers hooks that call `device.openUrl` for the iOS Swift SDK and Android Kotlin SDK (same URL contract). Default: **SET-only** between tests; **no** automatic `afterAll` clear (CI clears on SDK TTL or opt-in `TESTCHIMP_RUM_AUTOMATION_SUITE_TEARDOWN_CLEAR=1`).
- **Named**: `buildCiTestInfoJson`, `attachMobileRumAutomationHooks`, `extendMobileTestWithTrueCoverageDevice`, `clearBetweenTestsEnabled`, `suiteTeardownClearEnabled`, `resyncTrueCoverageSetForCurrentTest`, `isLikelyMobileTransportFailure`, etc., for advanced wiring.

---

## Troubleshooting

- **“Reporting disabled”**  
  Set `TESTCHIMP_API_KEY` (or pass it in reporter options). `TESTCHIMP_PROJECT_ID` should be present to enable TrueCoverage.

- **No steps or only some steps**  
  Only steps with category `test.step`, `expect`, or `pw:api` are reported. Internal/hook steps are excluded.

- **No screenshots on failure**  
  Enable screenshot capture in Playwright (e.g. `use: { screenshot: 'only-on-failure' }`). The reporter only attaches existing attachments to failing steps.

- **RUM events not linked to tests / missing `ci_test_info` (mobile)**  
  Use `export const test = installTestChimp(base, { uiFixture: 'screen' })` from a Mobilewright fixtures barrel and import `test` from there. Set `use.platform` on Mobilewright projects and handle `testchimp-rum://truecoverage/...` in the app (`TestChimpRum.handleAutomationURL` on iOS, `TestChimpRum.handleAutomationUri` on Android).  
  **Android SDK:** use **testchimp-rum-android ≥ 0.1.7** (automation **`/v1/set`** on caller thread; **`/v1/flush`** drains buffered events when the runner opens that URL).  
  **Runner:** `installTestChimp(..., { uiFixture: 'screen' })` extends the **`device`** fixture so one **`v1/set`** runs right after Mobilewright’s **`launchApp`** (before **`screen`**), then settle (**`TESTCHIMP_RUM_AUTOMATION_POST_SET_SETTLE_MS`**, default **100** ms). **`afterEach`** (mobile projects only) sends a trailing **`set` + `v1/flush`**. **Does not** send `/v1/clear` between tests by default (avoids null `ci-test-info`). Opt in to legacy clear-first with **`TESTCHIMP_RUM_AUTOMATION_CLEAR_BETWEEN_TESTS=1`**, or **`TESTCHIMP_RUM_AUTOMATION_SUITE_TEARDOWN_CLEAR=1`** for `afterAll` `clear`+`flush` after each spec file. **Re-sends `set` after likely transport failures** on `screen` API calls. Disable resync with **`TESTCHIMP_RUM_TRANSPORT_RESYNC=0`**. Optional URL overrides: **`TESTCHIMP_RUM_AUTOMATION_FLUSH_URL`**. If **`device.openUrl`** wedges (mobilecli), set **`TESTCHIMP_RUM_AUTOMATION_OPEN_URL_TIMEOUT_MS`** (default **25000**, clamp **100–120000**). Use **`@testchimp/playwright` ≥ 0.2.3** (restores 0.1.43 device SET behaviour; 0.2.0–0.2.2 could skip SET when `platformFromTestInfo` was `web` at fixture time).

- **RUM events not linked to tests (web)**  
  Same `installTestChimp` barrel; web uses `__TC_CI_TEST_INFO` on `page` for `@testchimp/rum-js`. Use **`@testchimp/rum-js` ≥ 0.1.3** and **`@testchimp/playwright` ≥ 0.2.2** so the page fixture flushes buffered events after each test. Fast tests that finish in under the default 10s batch interval need this flush (or call `globalThis.__TC_RUM_FLUSH()` manually).
- **Verbose logging**  
  Set `verbose: true` in reporter options or use it during setup to see which steps are captured and when reports are sent.

---

## License

MIT.
