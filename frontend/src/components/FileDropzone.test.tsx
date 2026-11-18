import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileDropzone } from './FileDropzone';
import { fileTypeLabel } from './FileTypeIcon';
import { JOB_FILE_TYPE_LABELS } from '../utils/extension';

describe('FileDropzone', () => {
  it('calls onFileSelected when a file is chosen via the input', async () => {
    const onFileSelected = vi.fn();
    render(<FileDropzone onFileSelected={onFileSelected} />);
    const file = new File(['content'], 'req.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const input = screen.getByLabelText(/upload/i) as HTMLInputElement;
    await userEvent.upload(input, file);
    expect(onFileSelected).toHaveBeenCalledWith(file);
  });

  it('offers every file type a job can be made from in the picker', () => {
    render(<FileDropzone onFileSelected={vi.fn()} />);

    const accept = (screen.getByLabelText(/upload/i) as HTMLInputElement).accept.split(',');
    expect(accept).toEqual(expect.arrayContaining(['.doc', '.xls', '.csv', '.docx', '.xlsx', '.pdf']));
  });

  it('shows an icon for each type under the box', () => {
    const { container } = render(<FileDropzone onFileSelected={vi.fn()} />);
    expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(JOB_FILE_TYPE_LABELS.length);
  });

  it.each([['doc', 'DOC'], ['xls', 'XLS'], ['csv', 'CSV']])('gives .%s its own label and icon, not the neutral fallback', (extension, label) => {
    expect(fileTypeLabel(extension)).toBe(label);
  });
});

