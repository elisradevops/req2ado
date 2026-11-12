import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KbAddBatchDialog, type BatchFile } from './KbAddBatchDialog';

const MB = 1024 * 1024;

function files(n: number, overrides: Partial<BatchFile> = {}): BatchFile[] {
  return Array.from({ length: n }, (_, i) => ({ id: `f${i + 1}`, name: `Customer_SRS_${i + 1}.docx`, sizeBytes: 200 * 1024, currentMode: null, ...overrides }));
}

function renderDialog(list: BatchFile[], props: Partial<React.ComponentProps<typeof KbAddBatchDialog>> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(<KbAddBatchDialog open onOpenChange={onOpenChange} files={list} rememberedMode={null} onConfirm={onConfirm} {...props} />);
  return { onConfirm, onOpenChange };
}

const search = () => screen.getByRole('radio', { name: /^search/i });
const reference = () => screen.getByRole('radio', { name: /^reference/i });
const confirmButton = (n: number) => screen.getByRole('button', { name: new RegExp(`^add ${n} to knowledge base$`, 'i') });
const rowSwitch = (name: string) => screen.getByRole('switch', { name: `Reference: ${name}` });

describe('KbAddBatchDialog', () => {
  it('names how many files are being added', () => {
    renderDialog(files(3));

    expect(screen.getByRole('dialog', { name: /add 3 files to the knowledge base/i })).toBeInTheDocument();
  });

  describe('when the page re-renders around it (a status poll, any state change) with an equal but new file list', () => {
    const element = (list: BatchFile[], rememberedMode: 'retrieve' | 'always_include' | null = null) => (
      <KbAddBatchDialog open onOpenChange={vi.fn()} files={list} rememberedMode={rememberedMode} onConfirm={vi.fn()} />
    );

    it('keeps the mode the user chose, instead of putting the remembered one back', async () => {
      const { rerender } = render(element(files(2), 'always_include'));
      expect(reference()).toHaveAttribute('aria-checked', 'true'); // the remembered choice is the start
      await userEvent.click(search());

      rerender(element(files(2), 'always_include'));

      expect(search()).toHaveAttribute('aria-checked', 'true');
      expect(reference()).toHaveAttribute('aria-checked', 'false');
    });

    it('keeps a file switched by hand, and the "remember" tick', async () => {
      const { rerender } = render(element(files(2)));
      await userEvent.click(search());
      await userEvent.click(rowSwitch('Customer_SRS_1.docx'));
      await userEvent.click(screen.getByRole('checkbox', { name: /remember my choice for this folder/i }));

      rerender(element(files(2)));

      expect(rowSwitch('Customer_SRS_1.docx')).toBeChecked();
      expect(screen.getByRole('checkbox', { name: /remember my choice for this folder/i })).toBeChecked();
    });
  });

  it('says "1 file" for one', () => {
    renderDialog(files(1));

    expect(screen.getByRole('dialog', { name: /add 1 file to the knowledge base/i })).toBeInTheDocument();
  });

  it('explains that it runs in the background, so the user can leave the page', () => {
    renderDialog(files(2));

    expect(screen.getByText(/added in the background, one after another/i)).toBeInTheDocument();
  });

  it('makes the user choose how the files are used: nothing is selected and Add is disabled until they do', () => {
    renderDialog(files(2));

    expect(search()).toHaveAttribute('aria-checked', 'false');
    expect(reference()).toHaveAttribute('aria-checked', 'false');
    expect(confirmButton(2)).toBeDisabled();
  });

  it('applies the choice to every file', async () => {
    const { onConfirm } = renderDialog(files(3));

    await userEvent.click(reference());
    await userEvent.click(confirmButton(3));

    expect(onConfirm).toHaveBeenCalledWith(
      [
        { id: 'f1', mode: 'always_include' },
        { id: 'f2', mode: 'always_include' },
        { id: 'f3', mode: 'always_include' },
      ],
      false,
    );
  });

  describe('per-file overrides', () => {
    it('shows every file with its mode, following the choice for all', async () => {
      renderDialog(files(2));

      await userEvent.click(search());

      expect(rowSwitch('Customer_SRS_1.docx')).not.toBeChecked();
      await userEvent.click(reference());
      expect(rowSwitch('Customer_SRS_1.docx')).toBeChecked();
      expect(rowSwitch('Customer_SRS_2.docx')).toBeChecked();
    });

    it('lets one file differ from the rest', async () => {
      const { onConfirm } = renderDialog(files(3));
      await userEvent.click(search());

      await userEvent.click(rowSwitch('Customer_SRS_2.docx'));
      await userEvent.click(confirmButton(3));

      expect(onConfirm).toHaveBeenCalledWith(
        [
          { id: 'f1', mode: 'retrieve' },
          { id: 'f2', mode: 'always_include' },
          { id: 'f3', mode: 'retrieve' },
        ],
        false,
      );
    });

    it('changing the choice for all starts every file over from it', async () => {
      const { onConfirm } = renderDialog(files(2));
      await userEvent.click(search());
      await userEvent.click(rowSwitch('Customer_SRS_1.docx'));

      await userEvent.click(reference());
      await userEvent.click(confirmButton(2));

      expect(onConfirm.mock.calls[0][0].map((c: { mode: string }) => c.mode)).toEqual(['always_include', 'always_include']);
    });

    it('says what a file already in the knowledge base is now', () => {
      renderDialog([{ id: 'f1', name: 'guide.pptx', sizeBytes: 1024, currentMode: 'always_include' }, ...files(1).map((f) => ({ ...f, id: 'f2' }))]);

      const row = screen.getByText('guide.pptx').closest('li')!;
      expect(row).toHaveTextContent(/in the knowledge base: reference/i);
    });
  });

  describe('suggestions', () => {
    const mixed = (): BatchFile[] => [
      { id: 'g1', name: 'Requirements_Writing_Standard.pdf', sizeBytes: 100 * 1024, currentMode: null },
      { id: 'g2', name: 'מדריך כתיבת דרישות.docx', sizeBytes: 100 * 1024, currentMode: null },
      { id: 'c1', name: 'Customer_SRS.docx', sizeBytes: 100 * 1024, currentMode: null },
    ];

    it('says for how many files the names look like guides, without selecting anything', () => {
      renderDialog(mixed());

      expect(screen.getByText(/suggested for 2 of these files/i)).toBeInTheDocument();
      expect(reference()).toHaveAttribute('aria-checked', 'false');
    });

    it('marks each suggested file in the list', () => {
      renderDialog(mixed());

      expect(screen.getByText('Requirements_Writing_Standard.pdf').closest('li')).toHaveTextContent(/suggested: reference/i);
      expect(screen.getByText('Customer_SRS.docx').closest('li')).not.toHaveTextContent(/suggested/i);
    });

    it('makes none when no name looks like a guide', () => {
      renderDialog(files(2));

      expect(screen.queryByText(/suggested/i)).toBeNull();
    });
  });

  describe('what it starts from', () => {
    it('preselects the choice remembered for this folder, and says so', () => {
      renderDialog(files(2), { rememberedMode: 'always_include' });

      expect(reference()).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByText(/your earlier choice for this folder \(reference\)\. change it above/i)).toBeInTheDocument();
      expect(confirmButton(2)).toBeEnabled();
    });

    it('preselects the mode the files already share, over the remembered one', () => {
      renderDialog(files(2, { currentMode: 'retrieve' }), { rememberedMode: 'always_include' });

      expect(search()).toHaveAttribute('aria-checked', 'true');
    });

    it('preselects nothing when the files already differ', () => {
      renderDialog([{ ...files(1)[0], currentMode: 'retrieve' }, { ...files(1)[0], id: 'f2', currentMode: 'always_include' }]);

      expect(search()).toHaveAttribute('aria-checked', 'false');
      expect(reference()).toHaveAttribute('aria-checked', 'false');
    });
  });

  describe('limits and warnings', () => {
    it('leaves out a file over the size limit, says so, and adds the rest', async () => {
      const { onConfirm } = renderDialog([...files(2), { id: 'big', name: 'Huge.pdf', sizeBytes: 60 * MB, currentMode: null }]);

      expect(screen.getByText(/1 file is over 50 MB and will be skipped/i)).toHaveTextContent('Huge.pdf');
      expect(screen.getByRole('dialog', { name: /add 2 files/i })).toBeInTheDocument();
      await userEvent.click(search());
      await userEvent.click(confirmButton(2));

      expect(onConfirm.mock.calls[0][0].map((c: { id: string }) => c.id)).toEqual(['f1', 'f2']);
    });

    it('cannot add anything when every file is over the limit', () => {
      renderDialog([{ id: 'big', name: 'Huge.pdf', sizeBytes: 60 * MB, currentMode: null }]);

      expect(screen.getByText(/nothing to add/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^add 0 to knowledge base$/i })).toBeDisabled();
    });

    it('warns about the cost of many Reference files, and not about a few', async () => {
      renderDialog(files(6));

      await userEvent.click(reference());

      expect(screen.getByText(/6 files as reference/i)).toBeInTheDocument();
    });

    it('does not warn about the cost for a few', async () => {
      renderDialog(files(5));

      await userEvent.click(reference());

      expect(screen.queryByText(/files as reference/i)).toBeNull();
    });

    it('does not warn about the cost when they are added as Search', async () => {
      renderDialog(files(8));

      await userEvent.click(search());

      expect(screen.queryByText(/files as reference/i)).toBeNull();
    });

    it('names a large file added as Reference', async () => {
      renderDialog([{ id: 'l', name: 'Large_Guide.pdf', sizeBytes: 6 * MB, currentMode: null }]);

      await userEvent.click(reference());

      expect(screen.getByText(/large reference file/i)).toHaveTextContent('Large_Guide.pdf');
    });

    it('reminds the user that a long batch runs in the background', () => {
      renderDialog(files(30));

      expect(screen.getByText(/30 files can take a while/i)).toBeInTheDocument();
    });

    it('does not say that for a short one', () => {
      renderDialog(files(5));

      expect(screen.queryByText(/can take a while/i)).toBeNull();
    });

    it('refuses more files than one batch holds', async () => {
      renderDialog(files(201));
      await userEvent.click(search());

      expect(screen.getByText(/at most 200 files/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^add 201 to knowledge base$/i })).toBeDisabled();
    });
  });

  it('can remember the choice for this folder', async () => {
    const { onConfirm } = renderDialog(files(2));

    await userEvent.click(search());
    await userEvent.click(screen.getByRole('checkbox', { name: /remember my choice for this folder/i }));
    await userEvent.click(confirmButton(2));

    expect(onConfirm.mock.calls[0][1]).toBe(true);
  });

  it('Cancel closes without confirming', async () => {
    const { onConfirm, onOpenChange } = renderDialog(files(2));

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disables everything while the request is on its way', () => {
    renderDialog(files(2), { rememberedMode: 'retrieve', isSubmitting: true });

    expect(confirmButton(2)).toBeDisabled();
    expect(rowSwitch('Customer_SRS_1.docx')).toBeDisabled();
  });

  it('shows a Hebrew file name bidirectionally safe', () => {
    renderDialog([{ id: 'h', name: 'מדריך.docx', sizeBytes: 1024, currentMode: null }]);

    expect(within(screen.getByRole('list', { name: /files to add/i })).getByText('מדריך.docx').closest('bdi')).toHaveAttribute('dir', 'auto');
  });

  describe('files from subfolders', () => {
    const nested = (): BatchFile[] => [
      { id: 'a', name: 'a.pdf', sizeBytes: 1000, currentMode: null },
      { id: 'b', name: 'same.pdf', sizeBytes: 1000, currentMode: null, folder: 'Sub Items' },
      { id: 'c', name: 'same.pdf', sizeBytes: 1000, currentMode: null, folder: 'Sub Items/Deep' },
      { id: 'd', name: 'מדריך.docx', sizeBytes: 1000, currentMode: null, folder: 'תיקייה' },
    ];

    it('groups the files by the folder they are in, so the same name in two folders can be told apart', () => {
      renderDialog(nested());

      const list = screen.getByRole('list', { name: /files to add/i });
      const groups = within(list).getAllByRole('group');
      expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['This folder', 'Sub Items', 'Sub Items/Deep', 'תיקייה']);
      expect(within(groups[1]).getByText('same.pdf')).toBeInTheDocument();
      expect(within(groups[2]).getByText('same.pdf')).toBeInTheDocument();
    });

    it('shows a folder name bidirectionally safe', () => {
      renderDialog(nested());

      const heading = screen.getByText('תיקייה');
      expect(heading.closest('bdi')).toHaveAttribute('dir', 'auto');
    });

    it('keeps one switch per file, each named by its own file, and sends every file back', async () => {
      const { onConfirm } = renderDialog(nested());
      await userEvent.click(search());

      await userEvent.click(confirmButton(4));

      expect(onConfirm).toHaveBeenCalledWith(
        [{ id: 'a', mode: 'retrieve' }, { id: 'b', mode: 'retrieve' }, { id: 'c', mode: 'retrieve' }, { id: 'd', mode: 'retrieve' }],
        false,
      );
    });

    it('does not group a list that is all in one folder', () => {
      renderDialog(files(3));

      expect(screen.queryByRole('group')).toBeNull();
    });
  });

  describe('a scan that did not find everything', () => {
    it('says what was left out, and still lets the user add what was found', async () => {
      const { onConfirm } = renderDialog(files(2), { scanNotices: ['Could not read "Secret".', 'Some folders are nested more than 5 levels deep and were not opened.'] });

      expect(screen.getByText(/could not read "secret"/i)).toBeInTheDocument();
      expect(screen.getByText(/more than 5 levels deep/i)).toBeInTheDocument();
      await userEvent.click(search());
      await userEvent.click(confirmButton(2));
      expect(onConfirm).toHaveBeenCalled();
    });

    it('says nothing when the scan was complete', () => {
      renderDialog(files(2), { scanNotices: [] });

      expect(screen.queryByText(/not opened|could not read/i)).toBeNull();
    });
  });

  it('tells the user how to get under the limit when a selection is too big', async () => {
    renderDialog(files(201));
    await userEvent.click(search());

    expect(screen.getByText(/open a subfolder/i)).toBeInTheDocument();
  });

  it('stays within the screen, scrolling inside, so the buttons are always reachable', () => {
    renderDialog(files(3));

    expect(screen.getByRole('dialog').className).toContain('max-h-[calc(100dvh-2rem)]');
  });

  it('says in words, beside every switch, what it does', () => {
    renderDialog(files(2));

    const rows = within(screen.getByRole('list', { name: /files to add/i })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(within(row).getByText('Reference')).toBeInTheDocument();
  });

  it('lets a long unbroken file name wrap instead of cutting it off', () => {
    const name = 'Requirements_Engineering_and_ADO_Work_Item_Standard_Version_2_Final_Reviewed_Customer_Copy.docx';
    renderDialog([{ id: 'long', name, sizeBytes: 1024, currentMode: null }]);

    const text = within(screen.getByRole('list', { name: /files to add/i })).getByText(name).parentElement as HTMLElement;
    expect(text.className).toContain('[overflow-wrap:anywhere]');
    expect(text.className).not.toContain('truncate');
  });
});
