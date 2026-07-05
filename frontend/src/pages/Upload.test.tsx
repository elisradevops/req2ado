import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { Upload } from './Upload';
import { httpClient } from '../api/httpClient';

vi.mock('../api/httpClient');

describe('Upload', () => {
  it('disables the Survey mode option', () => {
    render(<Upload onJobSubmitted={vi.fn()} />);
    expect(screen.getByLabelText(/survey/i)).toBeDisabled();
  });

  it('submits the file and areaPath, then calls onJobSubmitted with the returned jobId', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { jobId: 'job-1' } });
    const onJobSubmitted = vi.fn();
    render(<Upload onJobSubmitted={onJobSubmitted} />);

    const file = new File(['spec content'], 'spec.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText(/file/i), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText(/area path/i), { target: { value: 'Project\\Area1' } });
    fireEvent.click(screen.getByRole('button', { name: /upload/i }));

    await waitFor(() => expect(onJobSubmitted).toHaveBeenCalledWith('job-1'));
    expect(httpClient.post).toHaveBeenCalledWith('/jobs', expect.any(FormData), expect.any(Object));
  });

  it('shows an error message when submission fails', async () => {
    (httpClient.post as any).mockRejectedValue(new Error('network error'));
    render(<Upload onJobSubmitted={vi.fn()} />);

    const file = new File(['spec content'], 'spec.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText(/file/i), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText(/area path/i), { target: { value: 'Project\\Area1' } });
    fireEvent.click(screen.getByRole('button', { name: /upload/i }));

    await waitFor(() => expect(screen.getByText(/upload failed/i)).toBeInTheDocument());
  });
});
