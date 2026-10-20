// Where a requirement sits in its job's document, for the chat: its parents, the other items under the same parent, the items it is
// linked to and the captions of its own figures and tables. Built only from what the job already holds (the diff and the stored
// captions); the source document is not kept after a job, so nothing here reads it. Ingestion renders it into the prompt and
// caps it again; the limits here only keep the request small.

interface DiffLike {
  localId: string;
  parentLocalId: string | null;
  type: string;
  title: string;
  description: string;
  action?: string;
  excluded?: boolean;
  traceLinks?: { displayName?: string; referenceName?: string; targetKind: string; targetLocalId?: string }[];
  figureIds?: string[];
  tableIds?: string[];
}

interface JobLike {
  filename?: string | null;
  figureDescriptions?: { figureId: string; name: string | null; caption: string | null }[] | null;
  tableDescriptions?: { tableId: string; caption: string }[] | null;
}

export interface ChatContext {
  documentName?: string;
  parents: { type: string; title: string; description: string }[];
  siblings: { title: string }[];
  linked: { relation: string; title: string }[];
  figures: { name: string; caption: string }[];
  tables: { caption: string }[];
}

const MAX_PARENTS = 5;
const MAX_SIBLINGS = 20;
const MAX_LINKED = 10;

export function buildChatContext(diff: DiffLike[], entry: DiffLike, job: JobLike): ChatContext {
  const byId = new Map(diff.map((e) => [e.localId, e]));

  const parents: ChatContext['parents'] = [];
  const seen = new Set<string>([entry.localId]);
  for (let id = entry.parentLocalId; id && parents.length < MAX_PARENTS && !seen.has(id); id = byId.get(id)?.parentLocalId ?? null) {
    const parent = byId.get(id);
    if (!parent) break;
    seen.add(id);
    parents.unshift({ type: parent.type, title: parent.title, description: parent.description });
  }

  const siblings = diff
    .filter((e) => e.localId !== entry.localId && e.parentLocalId === entry.parentLocalId && e.action === 'create' && !e.excluded)
    .slice(0, MAX_SIBLINGS)
    .map((e) => ({ title: e.title }));

  const linked: ChatContext['linked'] = [];
  for (const link of entry.traceLinks ?? []) {
    const target = link.targetKind === 'intraJob' && link.targetLocalId ? byId.get(link.targetLocalId) : undefined;
    if (target && linked.length < MAX_LINKED) linked.push({ relation: link.displayName ?? link.referenceName ?? 'Related', title: target.title });
  }

  const figureById = new Map((job.figureDescriptions ?? []).map((f) => [f.figureId, f]));
  const figures = (entry.figureIds ?? [])
    .map((id) => figureById.get(id))
    .filter((f): f is NonNullable<typeof f> => Boolean(f && (f.name || f.caption)))
    .map((f) => ({ name: f.name ?? '', caption: f.caption ?? '' }));
  const tableById = new Map((job.tableDescriptions ?? []).map((t) => [t.tableId, t]));
  const tables = (entry.tableIds ?? [])
    .map((id) => tableById.get(id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t?.caption))
    .map((t) => ({ caption: t.caption }));

  return { ...(job.filename ? { documentName: job.filename } : {}), parents, siblings, linked, figures, tables };
}
