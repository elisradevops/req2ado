import { render, screen, within } from '@testing-library/react';
import { SharePointTokenHelp, SHAREPOINT_TOKEN_DIALOG_DESCRIPTION } from './SharePointTokenHelp';

describe('SharePointTokenHelp', () => {
  it('tells a first-time user where the token comes from, as numbered steps with a link to Graph Explorer', () => {
    render(<SharePointTokenHelp />);
    const steps = screen.getByRole('list', { name: /steps to get a token/i });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3);
    const link = within(steps).getByRole('link', { name: /graph explorer/i });
    expect(link).toHaveAttribute('href', 'https://developer.microsoft.com/graph/graph-explorer');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('says plainly that one token serves everyone, without claiming a lifetime or a permission the app cannot back up', () => {
    expect(SHAREPOINT_TOKEN_DIALOG_DESCRIPTION).toMatch(/one token serves everyone/i);
    render(<SharePointTokenHelp />);
    expect(document.body.textContent).not.toMatch(/\b\d+\s*(minutes?|hours?)\b/i);
    expect(document.body.textContent).not.toMatch(/Sites\.|Files\.Read/);
  });
});
