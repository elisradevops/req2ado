import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ConnectionStatusItem } from './ConnectionStatusItem';
import { useConnectionStatusStore } from '../store/connectionStatusStore';

type Entries = Partial<Pick<ReturnType<typeof useConnectionStatusStore.getState>, 'ado' | 'sharePoint' | 'llm'>>;

const known = <T,>(data: T, checkedAt = new Date('2026-11-12T10:05:00').getTime()) => ({ data, error: false, checkedAt, inFlight: false });

function seed(entries: Entries = {}, refresh = vi.fn().mockResolvedValue(undefined)) {
  useConnectionStatusStore.setState({
    ado: known({ status: 'valid' as const }),
    sharePoint: known({ status: 'valid' as const, expiresInSeconds: 2820 }),
    llm: known({ status: 'reachable' as const, latencyMs: 42 }),
    refresh,
    ...entries,
  });
  return refresh;
}

function renderItem(collapsed = false) {
  return render(
    <MemoryRouter>
      <ConnectionStatusItem collapsed={collapsed} />
    </MemoryRouter>,
  );
}

describe('ConnectionStatusItem', () => {
  beforeEach(() => seed());

  describe('the rail item', () => {
    it('says all is well in words when every connection is', () => {
      renderItem();

      expect(screen.getByRole('button', { name: 'System status: All systems OK' })).toBeInTheDocument();
      expect(screen.getByText('All systems OK')).toBeVisible();
    });

    it('says how many need attention, with a count', () => {
      seed({ ado: known({ status: 'unreachable' as const }), sharePoint: known({ status: 'invalid' as const, expiresInSeconds: null }) });
      renderItem();

      expect(screen.getByRole('button', { name: 'System status: 2 need attention' })).toBeInTheDocument();
      expect(screen.getByText('2 need attention')).toBeVisible();
      expect(screen.getByTestId('connection-count')).toHaveTextContent('2');
    });

    it('says it is checking until the first answers arrive, never a false failure', () => {
      seed({ ado: { data: null, error: false, checkedAt: null, inFlight: true } });
      renderItem();

      expect(screen.getByRole('button', { name: 'System status: Checking connections…' })).toBeInTheDocument();
      expect(screen.queryByTestId('connection-count')).toBeNull();
    });

    it('collapsed, keeps the words for screen readers and the count on screen', () => {
      seed({ llm: known({ status: 'unreachable' as const, latencyMs: null }) });
      renderItem(true);

      expect(screen.getByText('1 needs attention')).toHaveClass('sr-only');
      expect(screen.getByTestId('connection-count')).toHaveTextContent('1');
      expect(screen.getByRole('button', { name: 'System status: 1 needs attention' })).toBeInTheDocument();
    });

    it('collapsed, puts the count on the icon inside the rail instead of beside it, where there is no room', () => {
      seed({ llm: known({ status: 'unreachable' as const, latencyMs: null }) });
      renderItem(true);

      expect(screen.getByTestId('connection-count')).toHaveClass('absolute');
      expect(screen.getByTestId('connection-count')).not.toHaveClass('ml-auto');
    });

    it('expanded, keeps the count at the end of the row', () => {
      seed({ llm: known({ status: 'unreachable' as const, latencyMs: null }) });
      renderItem(false);

      expect(screen.getByTestId('connection-count')).toHaveClass('ml-auto');
    });
  });

  describe('the popover', () => {
    async function open() {
      await userEvent.click(screen.getByRole('button', { name: /^system status:/i }));
      return screen.findByRole('dialog', { name: /connections/i });
    }

    it('lists each connection in words, with its detail and when it was checked', async () => {
      renderItem();

      const dialog = await open();

      const list = within(dialog).getByRole('list');
      const items = within(list).getAllByRole('listitem');
      expect(items.map((item) => item.textContent)).toEqual([
        expect.stringMatching(/Azure DevOps.*Connected.*Checked 10:05/s),
        expect.stringMatching(/SharePoint.*Connected, expires in 47 minutes/s),
        expect.stringMatching(/LLM backend.*Connected, 42ms/s),
      ]);
    });

    it('tells a rejected credential from an unreachable service, in words as well as colour', async () => {
      seed({ sharePoint: known({ status: 'invalid' as const, expiresInSeconds: null }), llm: known({ status: 'unreachable' as const, latencyMs: null }) });
      renderItem();

      const dialog = await open();

      expect(within(dialog).getByText('Token invalid').closest('li')).toHaveTextContent(/needs attention|action needed/i);
      expect(within(dialog).getByText("Can't reach the LLM backend")).toBeInTheDocument();
    });

    it('lists a connection that is not set up without counting it as a fault', async () => {
      seed({ sharePoint: known({ status: 'not_configured' as const, expiresInSeconds: null }) });
      renderItem();

      const dialog = await open();

      expect(within(dialog).getByText('Not configured')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'System status: All systems OK' })).toBeInTheDocument();
    });

    it('checks again on demand, and says it is checking meanwhile', async () => {
      const refresh = seed();
      renderItem();
      const dialog = await open();

      await userEvent.click(within(dialog).getByRole('button', { name: /^check now$/i }));

      expect(refresh).toHaveBeenCalledWith();
    });

    it('cannot start another check while one runs', async () => {
      seed({ llm: { data: { status: 'reachable' as const, latencyMs: 1 }, error: false, checkedAt: 1, inFlight: true } });
      renderItem();

      const dialog = await open();

      expect(within(dialog).getByRole('button', { name: /checking…/i })).toBeDisabled();
    });

    it('points to where each problem is fixed', async () => {
      seed({ sharePoint: known({ status: 'invalid' as const, expiresInSeconds: null }) });
      renderItem();

      const dialog = await open();

      expect(within(dialog).getByRole('link', { name: /reconnect sharepoint/i })).toHaveAttribute('href', '/knowledge-base');
      expect(within(dialog).getByRole('link', { name: /profile & connections/i })).toHaveAttribute('href', '/settings');
    });

    it('offers to reconnect Azure DevOps, on the page where it is done, when its token is rejected', async () => {
      seed({ ado: known({ status: 'invalid' as const }) });
      renderItem();

      const dialog = await open();

      expect(within(dialog).getByText('Token rejected')).toBeInTheDocument();
      expect(within(dialog).getByRole('link', { name: /reconnect azure devops/i })).toHaveAttribute('href', '/settings');
    });

    it('does not offer it when Azure DevOps is only unreachable: a new token would not help', async () => {
      seed({ ado: known({ status: 'unreachable' as const }) });
      renderItem();

      const dialog = await open();

      expect(within(dialog).queryByRole('link', { name: /reconnect azure devops/i })).toBeNull();
    });

    it('gives the links in the popover room to be hit, also on a phone', async () => {
      seed({ sharePoint: known({ status: 'invalid' as const, expiresInSeconds: null }) });
      renderItem();
      const dialog = await open();

      for (const link of within(dialog).getAllByRole('link')) {
        // class pin: jsdom has no layout. At least 24px high (WCAG 2.5.8), 44px below md.
        expect(link.className).toMatch(/\bpy-1\.5\b/);
        expect(link.className).toContain('max-md:py-3');
      }
    });

    it('offers no reconnect link when SharePoint is fine', async () => {
      renderItem();

      const dialog = await open();

      expect(within(dialog).queryByRole('link', { name: /reconnect sharepoint/i })).toBeNull();
    });

    it('closes with Escape and gives focus back to the item', async () => {
      renderItem();
      const trigger = screen.getByRole('button', { name: /^system status:/i });
      await open();

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(trigger).toHaveFocus();
    });
  });
});
