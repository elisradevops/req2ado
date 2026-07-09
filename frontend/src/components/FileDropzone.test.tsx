import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileDropzone } from './FileDropzone';

describe('FileDropzone', () => {
  it('calls onFileSelected when a file is chosen via the input', async () => {
    const onFileSelected = vi.fn();
    render(<FileDropzone onFileSelected={onFileSelected} />);
    const file = new File(['content'], 'req.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const input = screen.getByLabelText(/upload/i) as HTMLInputElement;
    await userEvent.upload(input, file);
    expect(onFileSelected).toHaveBeenCalledWith(file);
  });
});
