import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NewJobWizard } from './NewJobWizard';
import * as jobsApi from '../api/jobs';

vi.mock('../api/jobs');

describe('NewJobWizard Step 1', () => {
  it('uploads a file, previews it, and advances to Step 2 with the parsed counts shown', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({ blockCount: 42, sectionCount: 5, fileType: 'docx' });
    render(<MemoryRouter><NewJobWizard /></MemoryRouter>);
    const file = new File(['x'], 'req.docx');
    const input = screen.getByLabelText(/upload/i) as HTMLInputElement;
    await userEvent.upload(input, file);
    await waitFor(() => expect(screen.getByText(/42/)).toBeInTheDocument());
  });
});
