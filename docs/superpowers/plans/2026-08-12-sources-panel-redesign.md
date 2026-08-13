# Sources Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `NodeDetailPanel.tsx`'s cluttered "Sources" block (§ symbol, raw character offsets, two overlapping prose paragraphs, an unlabeled red KB chip) with a plain-ASCII, labeled metadata card that's readable without decoding.

**Architecture:** Frontend-only change in `req2ado/frontend`. A pure formatting function (`sourceRefRows`) replaces the old single-string formatter; a new presentational component (`SourceProvenance`) replaces the inline JSX block in `NodeDetailPanel.tsx`; `KbCitationChips` switches from hardcoded hex colors to the app's existing semantic CSS tokens and gains an inline icon+label. No backend/API changes — every field already exists and is already sent.

**Tech Stack:** React 19 + TypeScript, Vitest + @testing-library/react, lucide-react icons, Tailwind v4 CSS-token design system (`frontend/src/index.css`).

## Global Constraints

- No backend changes. `SourceRefLike`'s fields (`documentPath`, `startOffset`, `endOffset`, `page`, `sectionPath`, `pageEnd`, `pageProvenance`) are unchanged; only which of them get rendered changes.
- No non-ASCII typographic characters in rendered output: no `§`, no `›`, no en dash. Section breadcrumbs join with a literal `>`; page ranges join with a literal `-`. Icons are lucide-react SVG components, never Unicode glyphs (✓/✗).
- `startOffset`/`endOffset` are never rendered anywhere in this feature.
- Chip colors come from the existing CSS custom properties in `frontend/src/index.css` (`--color-ok-soft`/`--color-ok-ink`/`--color-ok-border`, `--color-danger-soft`/`--color-danger-ink`/`--color-danger-border`, `--color-surface-alt`/`--color-ink-3`/`--color-hairline-strong`) — never new hardcoded hex values.
- Test command: `npm run test` (runs `vitest run`) from `req2ado/frontend`.
- Design doc: `docs/superpowers/specs/2026-08-12-sources-panel-redesign-design.md` — every task below implements a section of it.

---

### Task 1: `sourceRefRows` — replace the joined-string formatter

**Files:**
- Modify: `req2ado/frontend/src/utils/sourceRef.ts` (currently exports `SourceRefLike` and `formatSourceRef`)
- Test: `req2ado/frontend/src/utils/sourceRef.test.ts` (full rewrite — the old `formatSourceRef` tests no longer apply)

**Interfaces:**
- Consumes: nothing new.
- Produces: `basenameOf(documentPath: string): string`, `sourceRefRows(ref: SourceRefLike): SourceRefRow[]` where `SourceRefRow = { label: string; value: string }`. `SourceRefLike` keeps its existing shape (unchanged). `formatSourceRef` is deleted — Task 4 removes its only caller.

- [ ] **Step 1: Write the failing tests (full replacement of the test file)**

Replace the entire contents of `req2ado/frontend/src/utils/sourceRef.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { basenameOf, sourceRefRows } from './sourceRef';

describe('basenameOf', () => {
  it('strips a posix-style path down to just the filename', () => {
    expect(basenameOf('folder/spec.docx')).toBe('spec.docx');
  });

  it('strips a Windows-style path down to just the filename', () => {
    expect(basenameOf('C:\\docs\\spec.docx')).toBe('spec.docx');
  });

  it('returns the input unchanged when it has no path separators', () => {
    expect(basenameOf('spec.docx')).toBe('spec.docx');
  });
});

describe('sourceRefRows', () => {
  const base = { documentPath: 'spec.docx', startOffset: 0, endOffset: 10, page: null as number | null };

  it('returns no rows when neither sectionPath nor page is present', () => {
    expect(sourceRefRows(base)).toEqual([]);
  });

  it('returns only a Section row when sectionPath is present and page is null', () => {
    const rows = sourceRefRows({ ...base, sectionPath: ['3 Power', '3.2 Backplane'] });
    expect(rows).toEqual([{ label: 'Section', value: '3 Power > 3.2 Backplane' }]);
  });

  it('returns only a Page row when page is present and sectionPath is empty', () => {
    const rows = sourceRefRows({ ...base, page: 12 });
    expect(rows).toEqual([{ label: 'Page', value: '12' }]);
  });

  it('returns Section then Page, in that order, when both are present', () => {
    const rows = sourceRefRows({ ...base, page: 12, sectionPath: ['3 Power'] });
    expect(rows).toEqual([
      { label: 'Section', value: '3 Power' },
      { label: 'Page', value: '12' },
    ]);
  });

  it('never emits a Section row for an empty sectionPath array', () => {
    const rows = sourceRefRows({ ...base, page: 12, sectionPath: [] });
    expect(rows).toEqual([{ label: 'Page', value: '12' }]);
  });

  it('renders a page RANGE with label "Pages" when pageEnd is strictly after page', () => {
    const rows = sourceRefRows({ ...base, page: 12, pageEnd: 14 });
    expect(rows).toEqual([{ label: 'Pages', value: '12-14' }]);
  });

  it('keeps the singular "Page" label when pageEnd equals page', () => {
    const rows = sourceRefRows({ ...base, page: 12, pageEnd: 12 });
    expect(rows).toEqual([{ label: 'Page', value: '12' }]);
  });

  it('keeps the singular "Page" label when pageEnd is null', () => {
    const rows = sourceRefRows({ ...base, page: 12, pageEnd: null });
    expect(rows).toEqual([{ label: 'Page', value: '12' }]);
  });

  it('appends an "(approx.)" qualifier to a single page when pageProvenance is non-null', () => {
    const rows = sourceRefRows({ ...base, page: 12, pageProvenance: 'rendered' });
    expect(rows).toEqual([{ label: 'Page', value: '12 (approx.)' }]);
  });

  it('appends "(approx.)" to a page RANGE too, and never exposes the raw provenance string', () => {
    const rows = sourceRefRows({ ...base, page: 12, pageEnd: 14, pageProvenance: 'interpolated' });
    expect(rows).toEqual([{ label: 'Pages', value: '12-14 (approx.)' }]);
    expect(rows[0].value).not.toContain('interpolated');
  });

  it('uses the "Slide" label for a .pptx source, singular', () => {
    const rows = sourceRefRows({ ...base, documentPath: 'deck.pptx', page: 4 });
    expect(rows).toEqual([{ label: 'Slide', value: '4' }]);
  });

  it('uses the "Slides" label for a .pptx source RANGE', () => {
    const rows = sourceRefRows({ ...base, documentPath: 'deck.pptx', page: 4, pageEnd: 6 });
    expect(rows).toEqual([{ label: 'Slides', value: '4-6' }]);
  });

  it('matches .pptx case-insensitively and against a full path, not just a bare filename', () => {
    const rows = sourceRefRows({ ...base, documentPath: 'C:\\Decks\\Review.PPTX', page: 1 });
    expect(rows).toEqual([{ label: 'Slide', value: '1' }]);
  });

  it('never renders startOffset/endOffset in any row', () => {
    const rows = sourceRefRows({ ...base, page: 12, sectionPath: ['3 Power'], startOffset: 9182, endOffset: 9196 });
    const joined = rows.map((r) => r.value).join(' ');
    expect(joined).not.toContain('9182');
    expect(joined).not.toContain('9196');
    expect(joined).not.toContain('chars');
  });

  it('never renders § or › or an en dash in any row', () => {
    const rows = sourceRefRows({ ...base, page: 12, pageEnd: 14, sectionPath: ['3 Power', '3.2 Backplane'] });
    const joined = rows.map((r) => `${r.label} ${r.value}`).join(' ');
    expect(joined).not.toContain('§');
    expect(joined).not.toContain('›');
    expect(joined).not.toContain('\u2013'); // en dash
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd req2ado/frontend && npx vitest run src/utils/sourceRef.test.ts`
Expected: FAIL — `basenameOf`/`sourceRefRows` are not exported yet (old file only exports `formatSourceRef`/`SourceRefLike`).

- [ ] **Step 3: Replace the implementation**

Replace the entire contents of `req2ado/frontend/src/utils/sourceRef.ts` with:

```ts
export interface SourceRefLike {
  documentPath: string;
  startOffset: number;
  endOffset: number;
  page: number | null;
  // Root-first heading ancestry (e.g. ["3 Power", "3.2 Backplane"]) -- empty/
  // absent when the source node has no heading ancestry (e.g. a document
  // with no heading structure, or a manually-added entry).
  sectionPath?: string[];
  // Last page this node's content spans -- null/absent/equal-to-`page` all
  // mean "same page" (a single Page/Slide row). Only a value strictly
  // greater than `page` renders as a range.
  pageEnd?: number | null;
  // null = real pagination from the file itself. Any non-null value
  // ("rendered"/"interpolated") renders as a bare "(approx.)" qualifier,
  // never the raw provenance string, so a reviewer gets an honest heads-up
  // without jargon they'd need to look up.
  pageProvenance?: string | null;
}

export interface SourceRefRow {
  label: string;
  value: string;
}

// Loaders only ever write their own format's extension into document_path
// (ingestion/app/loaders/*.py) -- checking the extension is a reliable,
// backend-change-free way to tell a pptx-sourced ref apart from a pdf/docx
// one. Matched against the whole path, case-insensitively: 'pptx' and the
// legacy 'ppt' both count.
const PPTX_EXTENSION_PATTERN = /\.pptx?$/i;

function isPptxSource(documentPath: string): boolean {
  return PPTX_EXTENSION_PATTERN.test(documentPath);
}

// Only the filename, not the full path, since documentPath can be a long
// SharePoint-relative path a reviewer doesn't need to see in full.
export function basenameOf(documentPath: string): string {
  return documentPath.split(/[/\\]/).pop() || documentPath;
}

// Human-readable provenance rows for a diff entry's sourceRef -- distinct
// from the server's own wire format (JobsService.formatSourceRef, e.g.
// "path#page=12&offset=3400-3820", used for the ADO custom field, not for
// display). Deliberately drops startOffset/endOffset (nobody reading this
// panel needs a character range) and never emits a non-ASCII typographic
// character -- section breadcrumbs join with a literal '>', page ranges
// with a literal '-'. Each row is independently conditional; returns []
// when neither sectionPath nor page applies (e.g. an XLSX-sourced entry
// today, which carries neither).
export function sourceRefRows(ref: SourceRefLike): SourceRefRow[] {
  const rows: SourceRefRow[] = [];
  if (ref.sectionPath && ref.sectionPath.length > 0) {
    rows.push({ label: 'Section', value: ref.sectionPath.join(' > ') });
  }
  if (ref.page != null) {
    const isRange = ref.pageEnd != null && ref.pageEnd > ref.page;
    const isSlide = isPptxSource(ref.documentPath);
    const label = isSlide ? (isRange ? 'Slides' : 'Slide') : isRange ? 'Pages' : 'Page';
    let value = isRange ? `${ref.page}-${ref.pageEnd}` : `${ref.page}`;
    if (ref.pageProvenance != null) value += ' (approx.)';
    rows.push({ label, value });
  }
  return rows;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd req2ado/frontend && npx vitest run src/utils/sourceRef.test.ts`
Expected: PASS, all 16 tests.

- [ ] **Step 5: Commit**

```bash
cd req2ado
git add frontend/src/utils/sourceRef.ts frontend/src/utils/sourceRef.test.ts
git commit -m "refactor(frontend): replace formatSourceRef with row-based sourceRefRows

Drops char-offset rendering, non-ASCII symbols (§/›), and adds pptx
Slide/Slides labeling. No backend change -- SourceRefLike is unchanged."
```

---

### Task 2: `KbCitationChips` — semantic tokens + inline relevance label

**Files:**
- Modify: `req2ado/frontend/src/components/KbCitationChips.tsx`
- Test: `req2ado/frontend/src/components/KbCitationChips.test.tsx` (new file — no dedicated test file exists today; this behavior was only indirectly covered via `NodeDetailPanel.test.tsx`, which Task 4 updates separately)

**Interfaces:**
- Consumes: `Chip` (`../ui/Chip`, props `{ color?, bg?, className?, style?, ...HTMLAttributes<HTMLSpanElement> }`), `Tooltip` (`../ui/Tooltip`, props `{ content: ReactNode; children: ReactNode }`), `Check`/`X` from `lucide-react`.
- Produces: `KbCitation` interface (unchanged: `{ sourceFile: string; similarity: number; relevance: 'relevant' | 'not_relevant' | 'unknown' }`) and `KbCitationChips({ citations }): React.ReactElement` (same signature as today). Rendered chip text is now `"<Label> · <sourceFile>"` (e.g. `"Not relevant · doc-b.pdf"`), not bare `sourceFile` — Task 4 must update every test that currently asserts on a bare filename string.

- [ ] **Step 1: Write the failing test (new file)**

Create `req2ado/frontend/src/components/KbCitationChips.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KbCitationChips } from './KbCitationChips';

describe('KbCitationChips', () => {
  it('renders a "Relevant" label for a relevant citation', () => {
    render(<KbCitationChips citations={[{ sourceFile: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' }]} />);
    expect(screen.getByText('Relevant · doc-a.docx')).toBeInTheDocument();
  });

  it('renders a "Not relevant" label for a not_relevant citation', () => {
    render(<KbCitationChips citations={[{ sourceFile: 'doc-b.pdf', similarity: 0.4, relevance: 'not_relevant' }]} />);
    expect(screen.getByText('Not relevant · doc-b.pdf')).toBeInTheDocument();
  });

  it('renders an "Unverified" label for an unknown-relevance citation', () => {
    render(<KbCitationChips citations={[{ sourceFile: 'doc-c.docx', similarity: 0.6, relevance: 'unknown' }]} />);
    expect(screen.getByText('Unverified · doc-c.docx')).toBeInTheDocument();
  });

  it('renders one chip per citation, in order', () => {
    render(
      <KbCitationChips
        citations={[
          { sourceFile: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' },
          { sourceFile: 'doc-b.pdf', similarity: 0.4, relevance: 'not_relevant' },
        ]}
      />,
    );
    expect(screen.getByText('Relevant · doc-a.docx')).toBeInTheDocument();
    expect(screen.getByText('Not relevant · doc-b.pdf')).toBeInTheDocument();
  });

  it('renders nothing for an empty or undefined citations list', () => {
    const { container: emptyContainer } = render(<KbCitationChips citations={[]} />);
    expect(emptyContainer.querySelectorAll('span').length).toBe(0);
    const { container: undefinedContainer } = render(<KbCitationChips citations={undefined} />);
    expect(undefinedContainer.querySelectorAll('span').length).toBe(0);
  });

  it('uses the ok-token CSS variables for a relevant chip, not a hardcoded hex', () => {
    render(<KbCitationChips citations={[{ sourceFile: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' }]} />);
    const chip = screen.getByText('Relevant · doc-a.docx').closest('span');
    expect(chip).toHaveStyle({ backgroundColor: 'var(--color-ok-soft)', color: 'var(--color-ok-ink)' });
  });

  it('uses the danger-token CSS variables for a not_relevant chip, not a hardcoded hex', () => {
    render(<KbCitationChips citations={[{ sourceFile: 'doc-b.pdf', similarity: 0.4, relevance: 'not_relevant' }]} />);
    const chip = screen.getByText('Not relevant · doc-b.pdf').closest('span');
    expect(chip).toHaveStyle({ backgroundColor: 'var(--color-danger-soft)', color: 'var(--color-danger-ink)' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd req2ado/frontend && npx vitest run src/components/KbCitationChips.test.tsx`
Expected: FAIL — current implementation renders bare `sourceFile` text and hex colors, not `"<Label> · <sourceFile>"` with token colors.

- [ ] **Step 3: Replace the implementation**

Replace the entire contents of `req2ado/frontend/src/components/KbCitationChips.tsx` with:

```tsx
import { Check, X, type LucideIcon } from 'lucide-react';
import { Chip } from '../ui/Chip';
import { Tooltip } from '../ui/Tooltip';

export interface KbCitation {
  sourceFile: string;
  similarity: number;
  relevance: 'relevant' | 'not_relevant' | 'unknown';
}

interface RelevancePresentation {
  bg: string;
  color: string;
  border: string;
  // Short label rendered directly ON the chip -- a reviewer previously had
  // to hover to learn what the color meant.
  chipLabel: string;
  // Longer form used only in the hover tooltip, alongside the retrieval
  // score explanation -- kept separate from chipLabel, which needs to fit
  // inline without hovering.
  tooltipLabel: string;
  // null for "unknown" -- there's no positive/negative verdict to depict.
  Icon: LucideIcon | null;
}

// Color reflects the LLM's own relevance verdict where available (a real
// judgment call, not just "was retrieved above a similarity cutoff") --
// the app's existing semantic soft/ink/border token triples (same ones
// KbFileDetailPane.tsx already uses), not one-off hex values, so this
// chip reads consistently with the rest of the app instead of introducing
// its own color language.
const RELEVANCE_PRESENTATION: Record<KbCitation['relevance'], RelevancePresentation> = {
  relevant: {
    bg: 'var(--color-ok-soft)',
    color: 'var(--color-ok-ink)',
    border: 'var(--color-ok-border)',
    chipLabel: 'Relevant',
    tooltipLabel: 'Judged relevant',
    Icon: Check,
  },
  not_relevant: {
    bg: 'var(--color-danger-soft)',
    color: 'var(--color-danger-ink)',
    border: 'var(--color-danger-border)',
    chipLabel: 'Not relevant',
    tooltipLabel: 'Judged not relevant',
    Icon: X,
  },
  unknown: {
    bg: 'var(--color-surface-alt)',
    color: 'var(--color-ink-3)',
    border: 'var(--color-hairline-strong)',
    chipLabel: 'Unverified',
    tooltipLabel: 'Relevance not verified',
    Icon: null,
  },
};

export function KbCitationChips({ citations }: { citations: KbCitation[] | undefined }): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-1">
      {(citations ?? []).map((citation) => {
        const presentation = RELEVANCE_PRESENTATION[citation.relevance];
        const Icon = presentation.Icon;
        return (
          <Tooltip
            key={citation.sourceFile}
            content={`${presentation.tooltipLabel} -- retrieval text-overlap score: ${(citation.similarity * 100).toFixed(0)}% (not a relevance measure; this KB doc is a process/style guide, so overlap with a specific technical requirement is naturally low even when the guidance applies)`}
          >
            <Chip bg={presentation.bg} color={presentation.color} className="border" style={{ borderColor: presentation.border }}>
              {Icon && <Icon className="h-3 w-3" />}
              {presentation.chipLabel} · {citation.sourceFile}
            </Chip>
          </Tooltip>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd req2ado/frontend && npx vitest run src/components/KbCitationChips.test.tsx`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
cd req2ado
git add frontend/src/components/KbCitationChips.tsx frontend/src/components/KbCitationChips.test.tsx
git commit -m "refactor(frontend): KB citation chips use semantic tokens + inline label

Relevance is now a visible label+icon on the chip itself, not just a
color fill. Colors move from hardcoded hex to the existing ok/danger/
surface-alt CSS tokens."
```

---

### Task 3: `SourceProvenance` — new presentational component

**Files:**
- Create: `req2ado/frontend/src/components/SourceProvenance.tsx`
- Test: `req2ado/frontend/src/components/SourceProvenance.test.tsx` (new file)

**Interfaces:**
- Consumes: `basenameOf`, `sourceRefRows`, `SourceRefLike` (from Task 1's `../utils/sourceRef`), `KbCitationChips`, `KbCitation` (from Task 2's `./KbCitationChips`), `FileText` from `lucide-react`.
- Produces: `SourceProvenance({ sourceRef, showScoringNote, kbCitations }): React.ReactElement` — `sourceRef?: SourceRefLike | null`, `showScoringNote: boolean`, `kbCitations?: KbCitation[]`. Task 4 renders this in place of the old inline JSX, passing `sourceRef={entry.sourceRef}`, `showScoringNote={entry.type === 'Requirement'}`, `kbCitations={kbCitations}`.

- [ ] **Step 1: Write the failing test (new file)**

Create `req2ado/frontend/src/components/SourceProvenance.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceProvenance } from './SourceProvenance';

describe('SourceProvenance', () => {
  it('renders the file row (basename only, not the full path) when sourceRef is present', () => {
    render(
      <SourceProvenance
        sourceRef={{ documentPath: 'folder/spec.docx', startOffset: 0, endOffset: 10, page: null }}
        showScoringNote={false}
      />,
    );
    expect(screen.getByText('spec.docx')).toBeInTheDocument();
    expect(screen.queryByText('folder/spec.docx')).not.toBeInTheDocument();
  });

  it('renders nothing at all when sourceRef is null and showScoringNote is false and there are no citations', () => {
    const { container } = render(<SourceProvenance sourceRef={null} showScoringNote={false} />);
    expect(container.textContent).toBe('');
  });

  it('renders a Section row when sectionPath is present', () => {
    render(
      <SourceProvenance
        sourceRef={{ documentPath: 'spec.docx', startOffset: 0, endOffset: 10, page: null, sectionPath: ['3 Power', '3.2 Backplane'] }}
        showScoringNote={false}
      />,
    );
    expect(screen.getByText('Section')).toBeInTheDocument();
    expect(screen.getByText('3 Power > 3.2 Backplane')).toBeInTheDocument();
  });

  it('renders a Page row when page is present, and omits Section when sectionPath is absent', () => {
    render(
      <SourceProvenance sourceRef={{ documentPath: 'spec.docx', startOffset: 0, endOffset: 10, page: 13 }} showScoringNote={false} />,
    );
    expect(screen.getByText('Page')).toBeInTheDocument();
    expect(screen.getByText('13')).toBeInTheDocument();
    expect(screen.queryByText('Section')).not.toBeInTheDocument();
  });

  it('renders neither Section nor Page when sourceRef has no page and no sectionPath (the XLSX-today case)', () => {
    render(<SourceProvenance sourceRef={{ documentPath: 'sheet.xlsx', startOffset: 0, endOffset: 0, page: null }} showScoringNote={false} />);
    expect(screen.getByText('sheet.xlsx')).toBeInTheDocument();
    expect(screen.queryByText('Section')).not.toBeInTheDocument();
    expect(screen.queryByText('Page')).not.toBeInTheDocument();
  });

  it('renders the one-line scoring note only when showScoringNote is true', () => {
    const { rerender } = render(<SourceProvenance sourceRef={null} showScoringNote={true} />);
    expect(screen.getByText('Scored on wording only, not engineering content.')).toBeInTheDocument();

    rerender(<SourceProvenance sourceRef={null} showScoringNote={false} />);
    expect(screen.queryByText('Scored on wording only, not engineering content.')).not.toBeInTheDocument();
  });

  it('renders KB references heading and chips only when kbCitations is non-empty', () => {
    const { rerender } = render(<SourceProvenance sourceRef={null} showScoringNote={false} kbCitations={[]} />);
    expect(screen.queryByText('KB references')).not.toBeInTheDocument();

    rerender(
      <SourceProvenance
        sourceRef={null}
        showScoringNote={false}
        kbCitations={[{ sourceFile: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' }]}
      />,
    );
    expect(screen.getByText('KB references')).toBeInTheDocument();
    expect(screen.getByText('Relevant · doc-a.docx')).toBeInTheDocument();
  });

  it('uses the "Slide" label end to end for a pptx-sourced entry', () => {
    render(<SourceProvenance sourceRef={{ documentPath: 'deck.pptx', startOffset: 0, endOffset: 0, page: 4 }} showScoringNote={false} />);
    expect(screen.getByText('Slide')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd req2ado/frontend && npx vitest run src/components/SourceProvenance.test.tsx`
Expected: FAIL — `./SourceProvenance` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `req2ado/frontend/src/components/SourceProvenance.tsx`:

```tsx
import { FileText } from 'lucide-react';
import { basenameOf, sourceRefRows, type SourceRefLike } from '../utils/sourceRef';
import { KbCitationChips, type KbCitation } from './KbCitationChips';

// The "Sources" section's actual content -- file identity, where in that
// file, why it was scored the way it was, and which KB docs informed the
// score. Pulled out of NodeDetailPanel.tsx (which owns the surrounding
// gating: whether to show a "Sources" section at all depends on jobMode/
// entry.action, neither of which this component needs) because this block
// had grown its own internal structure worth a focused file and test
// suite. No margin-top on the root -- every other labeled section in
// NodeDetailPanel.tsx (Trace links, Tables) renders its content flush
// under its own label, with spacing coming from the PARENT's `mt-1`
// between sections, not between a label and its own content.
export function SourceProvenance({
  sourceRef,
  showScoringNote,
  kbCitations,
}: {
  sourceRef?: SourceRefLike | null;
  showScoringNote: boolean;
  kbCitations?: KbCitation[];
}): React.ReactElement {
  const rows = sourceRef ? sourceRefRows(sourceRef) : [];
  return (
    <div className="flex flex-col gap-2">
      {sourceRef && (
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 flex-none text-ink-3" />
          <span className="min-w-0 break-words text-sm font-semibold text-ink-1">{basenameOf(sourceRef.documentPath)}</span>
        </div>
      )}
      {rows.length > 0 && (
        <dl className="flex flex-col gap-1">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline gap-2">
              <dt className="w-14 flex-none text-xs text-ink-3">{row.label}</dt>
              <dd className="min-w-0 text-xs text-ink-2">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {showScoringNote && <p className="text-sm text-ink-2">Scored on wording only, not engineering content.</p>}
      {kbCitations && kbCitations.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-ink-2">KB references</p>
          <KbCitationChips citations={kbCitations} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd req2ado/frontend && npx vitest run src/components/SourceProvenance.test.tsx`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Commit**

```bash
cd req2ado
git add frontend/src/components/SourceProvenance.tsx frontend/src/components/SourceProvenance.test.tsx
git commit -m "feat(frontend): add SourceProvenance component

Labeled metadata-card rendering of a diff entry's source (filename,
Section/Page-or-Slide rows, one-line scoring note, KB reference chips).
Not yet wired into NodeDetailPanel -- next commit."
```

---

### Task 4: Wire `SourceProvenance` into `NodeDetailPanel`

**Files:**
- Modify: `req2ado/frontend/src/components/NodeDetailPanel.tsx:1-15` (imports), `:478-519` (the Sources block)
- Modify: `req2ado/frontend/src/components/NodeDetailPanel.test.tsx:473-676` (Sources-related tests)

**Interfaces:**
- Consumes: `SourceProvenance` from Task 3 (`./SourceProvenance`).
- Produces: nothing new — this is the integration point. After this task, `formatSourceRef` and the direct `KbCitationChips` import are no longer used in `NodeDetailPanel.tsx`.

- [ ] **Step 1: Update the imports**

In `req2ado/frontend/src/components/NodeDetailPanel.tsx`, remove these two lines (the file's `KbCitationChips`/`formatSourceRef` imports — confirmed by grep to be used nowhere else in this file):

```ts
import { KbCitationChips, type KbCitation } from './KbCitationChips';
```
```ts
import { formatSourceRef } from '../utils/sourceRef';
```

Keep the `KbCitation` type import (still needed for this component's own `kbCitations` prop type) by changing the first removed line to:

```ts
import type { KbCitation } from './KbCitationChips';
```

Add, alongside the other local component imports (near the `TraceLinkChips` import):

```ts
import { SourceProvenance } from './SourceProvenance';
```

- [ ] **Step 2: Replace the Sources block**

Find this block in `NodeDetailPanel.tsx` (currently lines ~478–519):

```tsx
      {(entry.sourceRef ||
        (jobMode === 'survey' && entry.action === 'create' && (entry.type === 'Requirement' || (kbCitations && kbCitations.length > 0)))) && (
        <div className="mt-1">
          <span className="text-xs font-semibold text-ink-2">Sources</span>
          {/* Document provenance -- computed server-side and shipped on
              every entry, previously never rendered anywhere. Available
              regardless of mode/action (unlike the judged-against lines
              below, which are SURVEY/create-scoped); null for manually-added
              entries, which have no source document position. */}
          {entry.sourceRef && (
            <p className="font-mono text-xs text-ink-3">{formatSourceRef(entry.sourceRef)}</p>
          )}
          {/* DESIGN.md §11.4.3 -- gated on the item's real ADO work-item
              type (matching the gauge above), not on qualityScore presence
              (see that block's own comment for why they're not the same
              check). Copy is a REVERSAL, not a tune-up: an earlier version
              of this line named EARS/INCOSE/ISO/IEC/IEEE 29148 with a
              glossed InfoTip explaining each acronym -- customer feedback
              was that the acronyms themselves, independent of whether they
              came with an explanation, were the problem. No standard's
              name appears anywhere below, glossed or not; do not
              reintroduce one. */}
          {entry.type === 'Requirement' && (
            <>
              <p className="text-sm text-ink-2">Scored on how the requirement is written — its wording, not its engineering content.</p>
              <p className="text-xs text-ink-3">
                The checklist follows established requirements-writing practice — the same checks a systems engineer would run by
                hand.
                {kbCitations && kbCitations.length > 0
                  ? ` Your knowledge base contributed ${kbCitations.length} document${kbCitations.length === 1 ? '' : 's'}.`
                  : ''}
              </p>
            </>
          )}
          {kbCitations && kbCitations.length > 0 && (
            <div className="mt-1">
              <p className="text-sm text-ink-2">KB references:</p>
              <KbCitationChips citations={kbCitations} />
            </div>
          )}
        </div>
      )}
```

Replace it with:

```tsx
      {(entry.sourceRef ||
        (jobMode === 'survey' && entry.action === 'create' && (entry.type === 'Requirement' || (kbCitations && kbCitations.length > 0)))) && (
        <div className="mt-1">
          <span className="text-xs font-semibold text-ink-2">Sources</span>
          {/* DESIGN.md §11.4.3 -- gauge/section gating rationale is unchanged
              from before this component was extracted; see SourceProvenance
              for the row-by-row rendering rules (2026-08-12 redesign spec). */}
          <SourceProvenance sourceRef={entry.sourceRef} showScoringNote={entry.type === 'Requirement'} kbCitations={kbCitations} />
        </div>
      )}
```

- [ ] **Step 3: Update `NodeDetailPanel.test.tsx`'s Sources-related assertions**

In `req2ado/frontend/src/components/NodeDetailPanel.test.tsx`, apply these five changes:

**3a.** Replace the test at line ~473 (`'renders the source document provenance when sourceRef is present'`) — its old assertion (`'spec.docx · p. 3 · chars 100–200'`) no longer exists; the row-level detail is now covered by `SourceProvenance.test.tsx`, so this test becomes a thin wiring smoke-check:

```tsx
  it('renders the source document provenance when sourceRef is present', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{
          localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
          action: 'create', customerId: null, tags: [],
          sourceRef: { documentPath: 'spec.docx', startOffset: 100, endOffset: 200, page: 3 },
        }}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText('spec.docx')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
```

**3b.** In the test `'renders no provenance line for a manually-added entry (sourceRef null)'` (~line 487), replace the assertion (the old `/chars \d/` regex no longer applies):

```tsx
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
```

**3c.** In `'shows the standards line and KB references for a SURVEY create entry with citations'` (~line 602), replace the three assertions:

```tsx
    expect(screen.getByText('Scored on wording only, not engineering content.')).toBeInTheDocument();
    expect(screen.getByText('Relevant · doc-a.docx')).toBeInTheDocument();
    expect(screen.getByText('Unverified · doc-b.pdf')).toBeInTheDocument();
```

(drops the old `/Your knowledge base contributed 2 documents\./` assertion entirely — that copy no longer exists.)

**3d.** In `'shows the standards line but no KB-count sentence when kbCitations is empty'` (~line 623), replace:

```tsx
    expect(screen.getByText('Scored on wording only, not engineering content.')).toBeInTheDocument();
    expect(screen.queryByText(/KB references/i)).not.toBeInTheDocument();
```

(drops the old `/Your knowledge base contributed/` assertion — that copy no longer exists.)

**3e.** In the four remaining tests that assert `/Scored on how the requirement is written/` is absent (`'does not claim a judgment happened...'` ~line 636, `'does not show the Sources section for a BASELINE job'` ~line 647, `'...for a reuse entry...'` ~line 658, `'...when jobMode is omitted...'` ~line 669), replace every occurrence of:

```tsx
    expect(screen.queryByText(/Scored on how the requirement is written/)).not.toBeInTheDocument();
```

with:

```tsx
    expect(screen.queryByText('Scored on wording only, not engineering content.')).not.toBeInTheDocument();
```

- [ ] **Step 4: Run the full frontend test suite**

Run: `cd req2ado/frontend && npm run test`
Expected: PASS — all tests, including the updated `NodeDetailPanel.test.tsx`, `sourceRef.test.ts`, `KbCitationChips.test.tsx`, and `SourceProvenance.test.tsx`.

- [ ] **Step 5: Commit**

```bash
cd req2ado
git add frontend/src/components/NodeDetailPanel.tsx frontend/src/components/NodeDetailPanel.test.tsx
git commit -m "refactor(frontend): wire SourceProvenance into NodeDetailPanel

Replaces the inline Sources JSX (§ symbol, char-offset string, two
prose paragraphs) with the SourceProvenance component. Section gating
logic (jobMode/action/type) is unchanged."
```

---

## Manual verification (after Task 4)

Not a substitute for the automated tests above, but worth doing once before calling this done, since it's a visual/UX change:

1. `cd req2ado/frontend && npm run dev`
2. Open a job whose diff has at least one SURVEY `create` Requirement with a `sourceRef` (section + page) and at least one KB citation with `relevance: 'not_relevant'`.
3. Confirm the Sources block shows: file icon + filename, a `Section` row (plain `>` separators, no `§`), a `Page` row, one line of scoring copy, and a KB chip reading `"Not relevant · <filename>"` on a soft red background — no red pill with no label.
4. If a pptx-sourced job is available, confirm its row says `Slide`, not `Page`.
