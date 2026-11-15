import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IterationPathPicker } from './IterationPathPicker';
import { ToastProvider } from './ToastProvider';
import * as adoApi from '../api/ado';

vi.mock('../api/ado');

describe('IterationPathPicker', () => {
  it('labels the field in sentence case (DESIGN.md section 4)', async () => {
    vi.spyOn(adoApi, 'getIterationPaths').mockResolvedValue([] as never);
    render(
      <ToastProvider>
        <IterationPathPicker value="" onChange={vi.fn()} project="P" />
      </ToastProvider>,
    );
    expect(await screen.findByRole('combobox', { name: 'Iteration path (optional)' })).toBeInTheDocument();
  });
});
