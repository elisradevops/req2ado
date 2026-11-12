import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileCard } from './ProfileCard';

const identity = { displayName: 'Jane Doe', email: 'jane@corp.example', accountName: 'CORP\\jane', userId: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000', orgUrl: 'https://tfs.corp.example/tfs/DefaultCollection' };

function renderCard(overrides: Partial<React.ComponentProps<typeof ProfileCard>> = {}) {
  return render(<ProfileCard {...identity} {...overrides} />);
}

describe('ProfileCard', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  it('shows who is signed in: name, e-mail, account and server', () => {
    renderCard();

    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('jane@corp.example')).toBeInTheDocument();
    expect(screen.getByText('CORP\\jane')).toBeInTheDocument();
    expect(screen.getByText('tfs.corp.example')).toBeInTheDocument();
    expect(screen.getByText('tfs/DefaultCollection')).toBeInTheDocument();
  });

  it('shows initials in an avatar that is not read out', () => {
    renderCard();

    const avatar = screen.getByText('JD');
    expect(avatar).toHaveAttribute('aria-hidden', 'true');
  });

  it('says what is not known, and why, instead of leaving a blank', () => {
    renderCard({ email: null, accountName: null });

    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.getByText(/sign in again to show your e-mail and account/i)).toBeInTheDocument();
  });

  it('does not show the technical id until asked, only a short handle', async () => {
    renderCard();

    expect(screen.queryByText(identity.userId)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /technical id/i }));

    const region = screen.getByRole('region', { name: /technical id/i });
    expect(within(region).getByText(/^[0-9a-f]{8}$/)).toBeInTheDocument();
    expect(within(region).queryByText(identity.userId)).toBeNull();
  });

  it('copies the full id on request, and says so', async () => {
    renderCard();
    await userEvent.click(screen.getByRole('button', { name: /technical id/i }));

    await userEvent.click(screen.getByRole('button', { name: /copy full id/i }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(identity.userId);
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });

  it('shows a Hebrew name bidirectionally safe', () => {
    renderCard({ displayName: 'דנה לוי' });

    expect(screen.getByText('דנה לוי').closest('bdi')).toHaveAttribute('dir', 'auto');
  });
});
