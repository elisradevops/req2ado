import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MultiFileDropzone } from './MultiFileDropzone';

describe('MultiFileDropzone', () => {
  it('calls onFilesAdded with every selected file when multiple are chosen via the input', async () => {
    const onFilesAdded = vi.fn();
    render(<MultiFileDropzone files={[]} onFilesAdded={onFilesAdded} onFileRemoved={vi.fn()} />);
    const files = [new File(['a'], 'a.docx'), new File(['b'], 'b.pdf')];
    const input = screen.getByLabelText(/upload requirements documents/i) as HTMLInputElement;

    await userEvent.upload(input, files);

    expect(onFilesAdded).toHaveBeenCalledWith(files);
  });

  it('filters out unsupported extensions and shows a skipped-count line, still accepting the supported ones', async () => {
    // applyAccept: false -- userEvent.upload otherwise pre-filters against
    // the input's own `accept` attribute before this component's onChange
    // ever sees the file list, which would make this test exercise
    // userEvent's filtering instead of the component's own.
    const user = userEvent.setup({ applyAccept: false });
    const onFilesAdded = vi.fn();
    render(<MultiFileDropzone files={[]} onFilesAdded={onFilesAdded} onFileRemoved={vi.fn()} />);
    const files = [new File(['a'], 'good.docx'), new File(['b'], 'malware.exe')];
    const input = screen.getByLabelText(/upload requirements documents/i) as HTMLInputElement;

    await user.upload(input, files);

    expect(onFilesAdded).toHaveBeenCalledWith([files[0]]);
    expect(screen.getByText(/1 file skipped \(unsupported type\)/i)).toBeInTheDocument();
  });

  it('renders the selected files with a remove button that calls onFileRemoved with the right index', async () => {
    const onFileRemoved = vi.fn();
    const files = [new File(['a'], 'a.docx'), new File(['b'], 'b.pdf')];
    render(<MultiFileDropzone files={files} onFilesAdded={vi.fn()} onFileRemoved={onFileRemoved} />);

    expect(screen.getByText('a.docx')).toBeInTheDocument();
    expect(screen.getByText('b.pdf')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Remove b.pdf'));

    expect(onFileRemoved).toHaveBeenCalledWith(1);
  });

  it('disables the dropzone and remove buttons when disabled is true', () => {
    render(<MultiFileDropzone files={[new File(['a'], 'a.docx')]} onFilesAdded={vi.fn()} onFileRemoved={vi.fn()} disabled />);

    expect(screen.getByLabelText(/choose requirements documents/i)).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByLabelText('Remove a.docx')).toBeDisabled();
  });
});
