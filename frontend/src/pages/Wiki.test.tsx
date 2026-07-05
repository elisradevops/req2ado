import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { Wiki } from './Wiki';
import { httpClient } from '../api/httpClient';

vi.mock('../api/httpClient');

describe('Wiki', () => {
  it('fetches and renders the user guide markdown', async () => {
    (httpClient.get as any).mockResolvedValue({ data: '# req2ado User Guide\n\nSome content.' });
    render(<Wiki />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /req2ado user guide/i })).toBeInTheDocument());
  });
});
