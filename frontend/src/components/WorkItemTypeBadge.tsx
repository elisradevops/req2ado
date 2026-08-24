import { Award, Trophy, ListCheck, Circle } from 'react-bootstrap-icons';
import { Chip } from '../ui/Chip';
import type { WorkItemTypeCatalogEntry } from '../api/ado';

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const value = parseInt(full, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Fallback color map (Agile/CMMI process defaults) used until a real
// per-project catalog entry is available -- see useWorkItemTypeCatalog,
// which fetches the project's actual process-template colors/icons live
// from ADO. This map only applies when uncredentialed or the fetch failed.
const TYPE_COLOR: Record<string, string> = {
  Epic: '#FF7B00',
  Feature: '#773B93',
  Requirement: '#009CCC',
};

// A plain flat-colored square (the old fallback) read as "no icon" next to
// every other icon in the app -- these give the fallback a real pictogram
// instead, so a row still reads as iconed even before/without a live
// per-project ADO catalog fetch. Award/Trophy echo ADO's own default Epic
// (crown) / Feature (trophy) glyphs -- Bootstrap Icons has no literal
// crown, Award is the closest equivalent.
const TYPE_ICON: Record<string, typeof Award> = {
  Epic: Award,
  Feature: Trophy,
  Requirement: ListCheck,
};

function fallbackColor(type: string): string {
  return TYPE_COLOR[type] ?? '#64748B';
}

function fallbackIcon(type: string): typeof Award {
  return TYPE_ICON[type] ?? Circle;
}

export function WorkItemTypeBadge({
  type,
  catalogEntry,
}: {
  type: string;
  catalogEntry?: WorkItemTypeCatalogEntry;
}): React.ReactElement {
  const color = catalogEntry?.color ? `#${catalogEntry.color.replace('#', '')}` : fallbackColor(type);
  const Icon = fallbackIcon(type);
  return (
    // A real tinted-background, colored-border pill -- matches this app's
    // own established chip language (ActionBadge/IssueChips already use
    // exactly this bg/border/text treatment) and the sibling
    // ado-hierarchy-viewer app's work-item type badge, which this
    // previously-plain icon+bold-text rendering was inconsistent with.
    <Chip bg={hexToRgba(color, 0.1)} color={color} className="border" style={{ borderColor: hexToRgba(color, 0.3) }} title={type}>
      {catalogEntry ? (
        // draggable={false} -- real bug (user-reported): <img> elements are
        // natively draggable in every browser regardless of any ancestor's
        // own `draggable` attribute. Inside DiffTree's now-draggable rows
        // (DESIGN.md §11.5), grabbing a row directly on top of this icon
        // started the BROWSER's own image-drag gesture instead of the row's
        // custom row-move drag -- looked like "grabbing this spot does
        // nothing" (a data: URI often produces no visible drag ghost).
        <img src={catalogEntry.iconDataUrl} alt="" className="h-3.5 w-3.5 flex-none" aria-hidden="true" draggable={false} />
      ) : (
        <Icon className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
      )}
      {type}
    </Chip>
  );
}
