import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AreaPathPicker } from './AreaPathPicker';
import { ToastProvider } from './ToastProvider';
import * as adoApi from '../api/ado';

vi.mock('../api/ado');

describe('AreaPathPicker', () => {
  it('loads and flattens the area-path tree into selectable options', async () => {
    vi.spyOn(adoApi, 'getAreaPaths').mockResolvedValue({
      path: 'Project',
      children: [{ path: 'Project\\Frontend', children: [] }, { path: 'Project\\Backend', children: [] }],
    });
    const onChange = vi.fn();
    render(
      <ToastProvider>
        <AreaPathPicker value="" onChange={onChange} credential={{ orgUrl: 'https://ado.example', pat: 'x' }} />
      </ToastProvider>,
    );
    const input = await screen.findByRole('combobox');
    await userEvent.click(input);
    await waitFor(() => expect(screen.getByText('Project\\Frontend')).toBeInTheDocument());
  });
});
