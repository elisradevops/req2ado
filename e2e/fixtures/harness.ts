import type { Page, Route } from '@playwright/test';
import type { DocFixture, SseEvent } from './documents';
import { narrationEvent, stageEvent } from './documents';

export const JOB_ID = 'job-e2e-1';
const API = 'http://localhost:3001';
const APP_ORIGIN = 'http://localhost:4173';
const CLOCK_START = new Date('2026-10-05T10:01:00Z');

export interface Harness {
  /** Sends events down the fake job event stream, then lets the page's batching timer fire. */
  push(events: SseEvent[]): Promise<void>;
  /** Moves the page's clock forward, firing timers on the way (the page uses fake time). */
  tick(ms: number): Promise<void>;
  /** Simulates the stream erroring (a dropped connection). */
  streamError(): Promise<void>;
  /** What the server would answer for "which items are finished" (a reload mid-run). */
  setDone(refs: string[] | null): void;
  /** The status the job endpoint reports (the page re-reads it when the run reaches an end state). */
  setJobStatus(status: string): void;
  /** How many event streams the page has opened, and how many of them are still open. */
  streams(): Promise<{ opened: number; open: number }>;
  /** Makes the tab look hidden or visible to the page. */
  setHidden(hidden: boolean): Promise<void>;
  /** Reloads the page; the new page's stream first replays `replay`, as the server does. */
  reloadWith(replay: SseEvent[]): Promise<void>;
  announcements(): Promise<string[]>;
  pageErrors: string[];
}

interface Options {
  /** Whether the server has a document map for this job. Default true. */
  mapAvailable?: boolean;
  /** Whether the live feature exists at all (off = the run-map and run-done routes 404). */
  liveFeature?: boolean;
  /** Use the browser's real clock (for performance measurements) instead of the test-controlled one. */
  realTime?: boolean;
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': APP_ORIGIN,
      'access-control-allow-credentials': 'true',
    },
    body: JSON.stringify(body),
  });
}

/**
 * Opens the running-job page against a mocked API and a scripted event stream,
 * with the page's clock under test control. Resolves once the progress banner
 * is on screen.
 */
export async function openRunningJob(page: Page, fx: DocFixture, options: Options = {}): Promise<Harness> {
  const { mapAvailable = true, liveFeature = true, realTime = false } = options;
  const state = { doneRefs: null as string[] | null, status: 'running' };
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': APP_ORIGIN,
          'access-control-allow-credentials': 'true',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        },
      });
    }
    if (pathname === `/jobs/${JOB_ID}`) {
      return json(route, {
        id: JOB_ID, status: state.status, mode: 'survey', dryRunDiff: state.status === 'running' ? null : [],
        createdAt: new Date(CLOCK_START.getTime() - 60_000).toISOString(),
        areaPath: 'Project\\Verify', adoProject: 'Project', originalFilename: fx.filename, state: 'Proposed',
        warnings: [], kbCitations: [], figureDescriptions: [], tableDescriptions: [],
      });
    }
    if (pathname === `/jobs/${JOB_ID}/run-map`) {
      return liveFeature && mapAvailable ? json(route, fx.map) : json(route, { message: 'none' }, 404);
    }
    if (pathname === `/jobs/${JOB_ID}/run-done`) {
      return liveFeature && state.doneRefs ? json(route, { refs: state.doneRefs }) : json(route, { message: 'none' }, 404);
    }
    if (pathname === '/llm/connection') return json(route, { configured: true, chatModel: 'gemma4:26b' });
    if (pathname.endsWith('/event-history') || pathname === '/jobs') return json(route, []);
    return json(route, request.method() === 'GET' ? {} : { ok: true });
  });

  if (!realTime) await page.clock.install({ time: CLOCK_START });
  await installPageHooks(page, []);
  await page.goto(`/jobs/${JOB_ID}`);
  await page.waitForFunction(() => (window as unknown as { __sse?: { instances: unknown[] } }).__sse?.instances.length);

  const harness: Harness = {
    pageErrors,
    async push(events) {
      await page.evaluate((list) => {
        const sse = (window as unknown as { __sse: { emit: (t: string, d: unknown) => void } }).__sse;
        for (const [type, data] of list) sse.emit(type, data);
      }, events);
      // The store applies a batch every 250 ms.
      if (realTime) await page.waitForTimeout(300);
      else await page.clock.runFor(300);
    },
    async tick(ms) {
      if (realTime) await page.waitForTimeout(ms);
      else await page.clock.runFor(ms);
    },
    async streamError() {
      await page.evaluate(() => (window as unknown as { __sse: { emit: (t: string, d: unknown) => void } }).__sse.emit('error', {}));
    },
    setDone(refs) {
      state.doneRefs = refs;
    },
    setJobStatus(status) {
      state.status = status;
    },
    streams() {
      return page.evaluate(() => {
        const list = (window as unknown as { __sse: { instances: { closed: boolean }[] } }).__sse.instances;
        return { opened: list.length, open: list.filter((s) => !s.closed).length };
      });
    },
    setHidden(hidden) {
      return page.evaluate((value) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (value ? 'hidden' : 'visible') });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);
    },
    async reloadWith(replay) {
      await installPageHooks(page, replay);
      await page.reload();
      await page.waitForFunction(() => (window as unknown as { __sse?: { instances: unknown[] } }).__sse?.instances.length);
      if (realTime) await page.waitForTimeout(300);
      else await page.clock.runFor(300);
    },
    announcements() {
      return page.evaluate(() => (window as unknown as { __announcements: string[] }).__announcements.slice());
    },
  };

  // The server's first words on a new connection: the current stage (and a narration line).
  await harness.push([stageEvent(), narrationEvent()]);
  await page.getByRole('progressbar', { name: 'Run progress' }).waitFor();
  return harness;
}

/**
 * Runs before the app on every load: signs the user in, swaps EventSource for a
 * fake the test drives, replays what the server would replay on a new
 * connection, and records every change to the one live status region.
 */
async function installPageHooks(page: Page, replay: SseEvent[]): Promise<void> {
  await page.addInitScript((replayEvents) => {
    sessionStorage.setItem(
      'req2ado-auth-v2',
      JSON.stringify({ orgUrl: 'http://ado.example', displayName: 'Test User', userId: 'user-1' }),
    );
    type Listener = (event: { data: string }) => void;
    class FakeEventSource {
      url: string;
      closed = false;
      private listeners: Record<string, Listener[]> = {};
      constructor(url: string) {
        this.url = url;
        const w = window as unknown as { __sse: { instances: FakeEventSource[] }; __replay: SseEvent[] };
        w.__sse.instances.push(this);
        // The server replays current state right after connecting; the app has
        // registered its listeners by the time this microtask runs.
        queueMicrotask(() => {
          for (const [type, data] of w.__replay) this.dispatch(type, data);
        });
      }
      addEventListener(type: string, handler: Listener): void {
        (this.listeners[type] ??= []).push(handler);
      }
      removeEventListener(): void {}
      close(): void {
        this.closed = true;
      }
      dispatch(type: string, data: unknown): void {
        for (const handler of this.listeners[type] ?? []) handler({ data: JSON.stringify(data) });
      }
    }
    const w = window as unknown as Record<string, unknown>;
    w.__sse = {
      instances: [],
      emit(type: string, data: unknown) {
        for (const source of (w.__sse as { instances: FakeEventSource[] }).instances) {
          if (!source.closed && /\/events$/.test(source.url)) source.dispatch(type, data);
        }
      },
    };
    w.__replay = replayEvents;
    w.EventSource = FakeEventSource;

    w.__announcements = [] as string[];
    const record = (): void => {
      const region = document.querySelector('[data-testid="live-status-region"]');
      const text = region?.textContent?.trim();
      const list = w.__announcements as string[];
      if (text && list[list.length - 1] !== text) list.push(text);
    };
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(record).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    });
  }, replay);
}
