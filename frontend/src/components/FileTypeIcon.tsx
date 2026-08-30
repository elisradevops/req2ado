import { FiletypeDoc, FiletypeDocx, FiletypeMd, FiletypePdf, FiletypeTxt, FiletypeXls, FiletypeXlsx } from 'react-bootstrap-icons';
import { cn } from '../lib/cn';
import { NEUTRAL_FALLBACK_COLOR } from '../utils/neutralColor';

// Bootstrap Icons' dedicated filetype-* glyphs (via react-bootstrap-icons) --
// each extension gets its own real pictogram (a "W" mark for docx, a grid
// for xlsx, a document outline for pdf/txt), not the same generic
// file-with-lines glyph recolored per type. That reuse-the-same-icon
// approach (an earlier pass here, and lucide's own icon set before that)
// read as flat and undifferentiated at a glance -- exactly the complaint
// this replaces.
const FILE_TYPE_CONFIG: Record<string, { icon: typeof FiletypePdf; color: string; label: string }> = {
  docx: { icon: FiletypeDocx, color: '#2563EB', label: 'DOCX' },
  doc: { icon: FiletypeDoc, color: '#2563EB', label: 'DOC' },
  pdf: { icon: FiletypePdf, color: '#D1434B', label: 'PDF' },
  xlsx: { icon: FiletypeXlsx, color: '#15803D', label: 'XLSX' },
  xls: { icon: FiletypeXls, color: '#15803D', label: 'XLS' },
  txt: { icon: FiletypeTxt, color: '#64748B', label: 'TXT' },
  md: { icon: FiletypeMd, color: '#7C3AED', label: 'MD' },
};

function configFor(extension: string): { icon: typeof FiletypePdf; color: string; label: string } {
  const key = extension.replace(/^\./, '').toLowerCase();
  return FILE_TYPE_CONFIG[key] ?? { icon: FiletypeTxt, color: NEUTRAL_FALLBACK_COLOR, label: key.toUpperCase() };
}

export function FileTypeIcon({ extension, className }: { extension: string; className?: string }): React.ReactElement {
  const { icon: Icon, color } = configFor(extension);
  return (
    <span className={cn('grid flex-none place-items-center rounded-md', className)} style={{ backgroundColor: color }} aria-hidden="true">
      <Icon className="h-[55%] w-[55%] text-white" />
    </span>
  );
}

export function fileTypeLabel(extension: string): string {
  return configFor(extension).label;
}
