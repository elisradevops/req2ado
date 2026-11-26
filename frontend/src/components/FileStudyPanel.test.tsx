import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FileStudyPanel, verdictCounts } from './FileStudyPanel';
import { BuildPreview } from './BuildPreview';
import { AboutFilePanel } from './AboutFilePanel';
import type { FileReading } from '../api/jobs';

const reading: FileReading = {
  kind: 'requirements_export',
  coverTitle: '[220.3] Vireo Television Set (VTS)',
  requirements: 121,
  withIds: 120,
  epics: 3,
  features: 2,
  outline: [
    { id: 'g_b1', parent: null, type: 'Epic', title: 'Requirements', headingId: 'b1', requirements: 121 },
    { id: 'g_b2', parent: 'g_b1', type: 'Epic', title: 'General', headingId: 'b2', requirements: 3 },
    { id: 'g_b3', parent: 'g_b2', type: 'Feature', title: 'Product family', headingId: 'b3', requirements: 3 },
    { id: 'g_b4', parent: 'g_b1', type: 'Epic', title: 'TV receiver', headingId: 'b4', requirements: 118 },
    { id: 'g_b5', parent: 'g_b4', type: 'Feature', title: 'Audio', headingId: 'b5', requirements: 118 },
  ],
  outlineMore: 0,
  decisions: [
    { headingId: 'b1', action: 'rename', title: 'Requirements', newTitle: 'Vireo Television Set (VTS)', reason: 'Named after the cover.', decision: null },
    { headingId: 'b2', action: 'drop_wrapper', title: 'General', newTitle: null, reason: 'A generic name holding one section.', decision: null },
  ],
  fixes: [{ headingId: 'b9', from: 'Enclousure', to: 'Enclosure' }],
  examples: [{ customerId: 'gen_1', title: 'Set delivered with a paired VR-7 remote', under: 'Product family' }],
  leftOut: [{ text: '3 REQUIREMENT IDENTITIES', page: 24, pageEnd: 27 }],
  context: ['1.1 IDENTIFICATION'],
};

describe('FileStudyPanel', () => {
  it('says what the study does while it runs, in a status region, without claiming which step is running', () => {
    render(<FileStudyPanel status="studying" startedAt={new Date().toISOString()} decisions={{}} onDecide={vi.fn()} onOpenAbout={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Studying the file' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Checking every answer against the file');
    expect(screen.queryByText(/minute/)).toBeNull(); // no fixed duration promised
  });

  it('shows one verdict line and each change as applied, which the user can undo or apply again', () => {
    // Owner rule R4 (2026-11-26): the study's proposals apply unless the user undoes them before Start.
    const onDecide = vi.fn();
    render(<FileStudyPanel status="ready" reading={reading} decisions={{ b2: 'keep' }} onDecide={onDecide} onOpenAbout={vi.fn()} />);
    expect(screen.getByText('Read as a requirements-tool export')).toBeInTheDocument();
    expect(screen.getByTestId('file-study-counts')).toHaveTextContent(verdictCounts(reading, { b2: 'keep' }));
    expect(screen.getByText("2 changes to the file's structure · 1 undone")).toBeInTheDocument();
    expect(screen.getByText('Renamed “Requirements” to “Vireo Television Set (VTS)”')).toBeInTheDocument();
    expect(screen.getByText('Kept “General” as the file has it')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo: keep “Requirements” as the file has it' }));
    expect(onDecide).toHaveBeenCalledWith('b1', 'keep');
    fireEvent.click(screen.getByRole('button', { name: 'Apply the change to “General” again' }));
    expect(onDecide).toHaveBeenCalledWith('b2', 'accept');
  });

  it('opens the reason under a decision on Why?', () => {
    render(<FileStudyPanel status="ready" reading={reading} decisions={{}} onDecide={vi.fn()} onOpenAbout={vi.fn()} />);
    const [why] = screen.getAllByRole('button', { name: 'Why?' });
    expect(screen.queryByText('Named after the cover.')).toBeNull();
    fireEvent.click(why);
    expect(why).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Named after the cover.')).toBeInTheDocument();
  });
});

describe('BuildPreview', () => {
  it('draws each Epic and Feature with the project real Azure DevOps icon, as the review tree does, through its real type name', () => {
    const typeCatalog = {
      Epic: { color: 'FF7B00', iconDataUrl: 'data:image/svg+xml;base64,RVBJQw==' },
      'Feature Area': { color: '773B93', iconDataUrl: 'data:image/svg+xml;base64,RkVBVA==' },
    };
    const categoryLabels = { Epic: 'Epic', Feature: 'Feature Area', Requirement: 'User Story' } as const;
    const { container } = render(<BuildPreview reading={reading} decisions={{}} typeCatalog={typeCatalog} categoryLabels={categoryLabels} />);
    const sources = Array.from(container.querySelectorAll('img')).map((img) => img.getAttribute('src'));
    expect(sources).toContain(typeCatalog.Epic.iconDataUrl);
    expect(sources).toContain(typeCatalog['Feature Area'].iconDataUrl);
  });

  it('shows the Epics and Features with every change applied, and an undone one as in the file', () => {
    const { rerender } = render(<BuildPreview reading={reading} decisions={{}} />);
    expect(screen.getByText('Vireo Television Set (VTS)')).toHaveAttribute('title', 'Renamed from Requirements');
    expect(screen.queryByText('General')).toBeNull();
    expect(screen.getByTestId('build-preview')).toHaveTextContent('Removed level: General.');
    rerender(<BuildPreview reading={reading} decisions={{ b1: 'keep', b2: 'keep' }} />);
    expect(screen.getByText('Requirements')).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getAllByText('as in the file')).toHaveLength(2);
  });
});

describe('AboutFilePanel', () => {
  it('holds how the file was read, its codes and examples, what was left out and what was fixed', () => {
    render(<AboutFilePanel open onOpenChange={vi.fn()} reading={reading} codes={['gen_1', 'btn_2']} />);
    const panel = screen.getByTestId('about-file-panel');
    expect(panel).toHaveTextContent('Read as a requirements-tool export');
    expect(panel).toHaveTextContent('gen_1, btn_2');
    expect(panel).toHaveTextContent('↳ under Product family');
    expect(panel).toHaveTextContent('3 REQUIREMENT IDENTITIES · p24–27');
    expect(panel).toHaveTextContent('“Enclousure” → “Enclosure”');
    expect(panel).not.toHaveTextContent('What it will build'); // the preview lives in the rail only
  });
});
