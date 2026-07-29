import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DestinationBar } from './DestinationBar';

describe('DestinationBar', () => {
  it('renders nothing when neither teamProject nor areaPath is given', () => {
    const { container } = render(<DestinationBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the team project and area path when both are given', () => {
    render(<DestinationBar teamProject="Elisra EW Programs" areaPath="Elisra\EW\SRD\Receiver" />);
    expect(screen.getByText('Elisra EW Programs')).toBeInTheDocument();
    expect(screen.getByText('Elisra\\EW\\SRD\\Receiver')).toBeInTheDocument();
  });

  it('does not repeat the area path when it is identical to the team project', () => {
    render(<DestinationBar teamProject="Elisra EW Programs" areaPath="Elisra EW Programs" />);
    expect(screen.getAllByText('Elisra EW Programs')).toHaveLength(1);
  });

  it('uses a custom label when provided', () => {
    render(<DestinationBar label="Importing into" teamProject="Elisra EW Programs" />);
    expect(screen.getByText('Importing into')).toBeInTheDocument();
  });
});
