# Browser tests for the running-job screen

Checks the live view of a running SURVEY job (document metrics, "Now" card,
outline, side-by-side comparison, counted percentage) in a real browser. No
backend and no model: the API is mocked per test and the job event stream is a
scripted fake, so runs are fast and the same every time.

```
cd e2e
npm install
npx playwright install chromium     # once; the config pins @playwright/test 1.59.1
npm test                            # builds ../frontend, serves it, runs the matrix
npm run test:update                 # re-record screenshot baselines after an intended visual change
```

## The matrix

4 document kinds (Word, spreadsheet, text PDF, scanned PDF) x 7 situations x 4 projects.

| Situations | What it exercises |
|---|---|
| smooth | items finishing, one part in progress, counted percentage |
| parallel | three parts being worked on at once |
| conflict | two statements that disagree, side by side |
| duplicate | a proposed item next to the existing work item it matches |
| long-wait | one long model request: heartbeats arrive, nothing new is published |
| connection-lost | the stream errors and stays quiet for 30 s |
| reload-mid-run | the page reloads partway; the server replays state and lists finished items |

Projects: `desktop` (1440 wide), `phone` (390, navigation rail collapsed first,
as a phone user would), each with and without `prefers-reduced-motion`.

Every cell also checks: no horizontal scroll, one named progress bar with an
honest value text, one polite status region, an axe scan of the live view (WCAG
2.0/2.1/2.2 A and AA) with zero violations, tabbing never gets stuck and every
focused control in the live view shows focus, no looping animation in the live
view (and none anywhere under reduced motion), no uncaught page errors.
Screenshot baselines (the live view in smooth, parallel and conflict, per kind
and width) live in `tests/__screenshots__/<project>/`.

Cross-run tests: announcements are throttled and never carry an item or a
number; the feature off gives the old banner; live events with no document map;
unknown event kinds are ignored; failed and diff-ready end states; one event
stream per page and it closes on leaving; a hidden tab holds updates.

## Notes

- The plan listed "output limit reached" and "context assumed" as situations.
  Those notices belong to the typed-notice work, which is not built, so they are
  not here.
- `use.reducedMotion` alone did not make the media query match with this
  Playwright and Chromium, so the spec applies it with `page.emulateMedia` and
  asserts the query matches (or not) in every cell.
- Screenshot baselines are recorded on macOS with the bundled Chromium. If CI runs
  elsewhere, record baselines there (fonts and text rendering differ by platform).
- Not covered: the real backend and model (see `docs/job-transparency-implementation-plan.md`
  for the real-stack runs), and an old frontend build against the new backend.
