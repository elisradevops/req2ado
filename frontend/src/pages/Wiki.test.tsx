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

  it('keeps one level-one heading: a markdown top-level heading renders as a level two', async () => {
    (httpClient.get as any).mockResolvedValue({ data: '# req2ado User Guide\n\nSome content.' });
    render(<Wiki />);
    await screen.findByRole('heading', { level: 2, name: /req2ado user guide/i });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('says it is loading to assistive technology from the first moment, while the placeholder is still undrawn', () => {
    (httpClient.get as any).mockReturnValue(new Promise(() => {}));
    render(<Wiki />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/loading the user guide/i);
    expect(status).toHaveAttribute('aria-busy', 'true');
  });
});
