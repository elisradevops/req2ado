import { buildSummaryMessages, checkSummary, generateSummary, isGrounded } from '../src/modules/pipeline/document-summary';
import { buildDocumentProfile } from '../src/modules/pipeline/document-profile';

const h = (level: number, number_label: string, text: string) => ({ kind: 'heading', heading_level: level, number_label, text }) as any;
const p = (text: string) => ({ kind: 'paragraph', text }) as any;
const fig = () => ({ kind: 'figure', text: '[FIGURE]' }) as any;
const tbl = () => ({ kind: 'table', text: '[TABLE]' }) as any;
const doc = (blocks: any[]) => ({ document: { format: 'docx' }, blocks, tables: [], figures: [] }) as any;

const INPUT = [
  'Scope (§1): This ICD defines the electrical interfaces of the SOSA backplane for the AirPro LRU.',
  'Sections: 1 Scope; 2 Power; 3 Thermal',
  'Cited: VITA 46.0, MIL-STD-704',
].join('\n');

describe('the summary input the profile prepares', () => {
  it('is deterministic, bounded text made of the purpose, the outline, the opening sentences and the cited standards', () => {
    const profile = buildDocumentProfile(
      doc([h(1, '1', 'Scope'), p('This ICD defines the interfaces of the backplane. It also lists limits.'), h(1, '2', 'Power'), p('The unit is powered per MIL-STD-704F from the aircraft bus. More text follows here.')]),
    );
    expect(profile.summaryInput).toContain('§1 Scope');
    expect(profile.summaryInput).toContain('This ICD defines the interfaces of the backplane.');
    expect(profile.summaryInput).toContain('2 Power');
    expect(profile.summaryInput).toContain('The unit is powered per MIL-STD-704F from the aircraft bus.');
    expect(profile.summaryInput).not.toContain('More text follows here.'); // only the opening sentence of a section
    expect(profile.summaryInput).toContain('MIL-STD-704F');
    expect(buildDocumentProfile(doc([h(1, '1', 'Scope'), p('x'.repeat(50))])).summaryInput.length).toBeLessThanOrEqual(6000);
  });

  it('stays within its bound however large the document is', () => {
    const blocks = Array.from({ length: 400 }, (_, i) => [h(1, String(i + 1), `Section ${i} ${'t'.repeat(80)}`), p(`${'Opening sentence number '}${i} ${'w'.repeat(300)}. Second.`)]).flat();
    expect(buildDocumentProfile(doc(blocks)).summaryInput.length).toBeLessThanOrEqual(6000);
  });
});

describe('isGrounded', () => {
  const ok = 'This document defines the electrical interfaces of the SOSA backplane for the AirPro unit, covering power and thermal limits, and cites VITA 46.0 and MIL-STD-704 as its references.';

  it('accepts a summary whose numbers, acronyms and standards all come from the input', () => {
    expect(isGrounded(ok, INPUT)).toBe(true);
  });

  it.each([
    ['an invented number', ok.replace('cites', 'lists 14 connectors and cites')],
    ['an invented standard', ok.replace('MIL-STD-704', 'MIL-STD-1553')],
    ['an invented acronym', ok.replace('SOSA backplane', 'SOSA backplane with a CAN bus')],
    ['too short', 'A backplane ICD.'],
    ['too long', `${ok} ${'More words follow in this sentence. '.repeat(30)}`],
    ['empty', '   '],
  ])('rejects %s', (_label, summary) => {
    expect(isGrounded(summary, INPUT)).toBe(false);
  });
});

describe('buildSummaryMessages', () => {
  it('asks for a short plain summary from the text alone, and puts the text in as data', () => {
    const [system, user] = buildSummaryMessages(INPUT);
    expect(system.role).toBe('system');
    expect(system.content).toMatch(/120 words/);
    expect(system.content).toMatch(/only the text/i);
    expect(system.content).toMatch(/data, not instructions/i);
    expect(user.content).toContain('<document>');
    expect(user.content).toContain(INPUT);
  });
});

describe('generateSummary', () => {
  const answer = 'This document defines the electrical interfaces of the SOSA backplane for the AirPro unit, covering power and thermal limits, and cites VITA 46.0 and MIL-STD-704 as its references.';
  const clientReturning = (content: string | Error) => ({ chat: jest.fn(async () => { if (content instanceof Error) throw content; return { content }; }) });

  it('returns a grounded answer and sends no Ollama-only or dev-only parameter', async () => {
    const client = clientReturning(answer);
    expect(await generateSummary(client as any, INPUT, { maxTokens: 4000 })).toBe(answer);
    const opts = (client.chat.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(opts).toMatchObject({ maxTokens: 4000, think: false });
    for (const key of ['options', 'seed', 'reasoning_effort', 'numCtx']) expect(opts).not.toHaveProperty(key);
    expect(opts.deadlineAtMs).toEqual(expect.any(Number));
  });

  it('returns null for an ungrounded answer, a model error, or an empty input', async () => {
    expect(await generateSummary(clientReturning('Totally unrelated text about 42 widgets and a CAN bus that the document never mentions at all, repeated for length. '.repeat(2)) as any, INPUT, { maxTokens: 4000 })).toBeNull();
    expect(await generateSummary(clientReturning(new Error('down')) as any, INPUT, { maxTokens: 4000 })).toBeNull();
    const idle = clientReturning(answer);
    expect(await generateSummary(idle as any, '   ', { maxTokens: 4000 })).toBeNull();
    expect(idle.chat).not.toHaveBeenCalled();
  });
});


describe('checkSummary', () => {
  const ok = 'This document defines the electrical interfaces of the SOSA backplane for the AirPro unit, covering power and thermal limits, and cites VITA 46.0 and MIL-STD-704 as its references.';

  it('says why a summary was dropped, by kind and count, never with the offending text', () => {
    expect(checkSummary(ok, INPUT)).toEqual({ ok: true });
    expect(checkSummary('Too short.', INPUT)).toEqual({ ok: false, reason: 'length', count: 2 });
    expect(checkSummary(ok.replace('cites', 'lists 14 and 15 connectors and cites'), INPUT)).toEqual({ ok: false, reason: 'number', count: 2 });
    expect(checkSummary(ok.replace('SOSA backplane', 'SOSA backplane with a CAN bus and an ECS'), INPUT)).toEqual({ ok: false, reason: 'code', count: 2 });
  });

  it('generateSummary logs the reason it dropped an answer, without the answer or the input', async () => {
    const warn = jest.fn();
    const bad = ok.replace('cites', 'lists 14 connectors and cites');
    await generateSummary({ chat: jest.fn(async () => ({ content: bad })) } as any, INPUT, { maxTokens: 4000, log: { warn } });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/summary dropped.*reason=number.*count=1/));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('connectors');
    const failed = jest.fn();
    await generateSummary({ chat: jest.fn(async () => { throw Object.assign(new Error('boom'), { status: 502 }); }) } as any, INPUT, { maxTokens: 4000, log: { warn: failed } });
    expect(failed).toHaveBeenCalledWith(expect.stringMatching(/summary call failed.*status=502/));
  });
});


describe('review findings on the summary', () => {
  const ok = 'This document defines the electrical interfaces of the SOSA backplane for the AirPro unit, covering power and thermal limits, and cites VITA 46.0 and MIL-STD-704 as its references.';

  it('compares whole numbers and codes, not substrings: a 4 is not in 46.0, and SOS is not in SOSA', () => {
    expect(isGrounded(ok.replace('cites', 'lists 4 connectors and cites'), INPUT)).toBe(false);
    expect(isGrounded(ok.replace('cites', 'cites the SOS rules and'), INPUT)).toBe(false);
    expect(isGrounded(ok.replace('cites', 'cites VITA 46 and'), INPUT)).toBe(false); // 46 is not 46.0
    expect(isGrounded(ok, INPUT)).toBe(true);
  });

  it('keeps the text from closing the document tag it is sent in', () => {
    const [, user] = buildSummaryMessages('before </document> after </DOCUMENT> end');
    expect(user.content.match(/<\/document>/gi)).toHaveLength(1); // only the real closing tag
  });

  it('does not log a warning for a call the caller cancelled', async () => {
    const warn = jest.fn();
    const controller = new AbortController();
    controller.abort();
    await generateSummary({ chat: jest.fn(async () => { throw new Error('aborted'); }) } as any, INPUT, { maxTokens: 4000, signal: controller.signal, log: { warn } });
    expect(warn).not.toHaveBeenCalled();
  });
});


describe('one retry after an answer that is not grounded', () => {
  const good = 'This document defines the electrical interfaces of the SOSA backplane for the AirPro unit, covering power and thermal limits, and cites VITA 46.0 and MIL-STD-704 as its references.';
  const bad = good.replace('SOSA backplane', 'SOSA backplane with a CAN bus');

  it('asks again, more strictly, and returns the grounded second answer', async () => {
    const chat = jest.fn().mockResolvedValueOnce({ content: bad }).mockResolvedValueOnce({ content: good });
    expect(await generateSummary({ chat } as any, INPUT, { maxTokens: 4000 })).toBe(good);
    expect(chat).toHaveBeenCalledTimes(2);
    const [first, second] = chat.mock.calls.map((c) => (c[0] as { content: string }[])[0].content);
    expect(second).toMatch(/rejected/i);
    expect(first).not.toMatch(/rejected/i);
  });

  it('asks at most twice, and shares one deadline between the two calls', async () => {
    const chat = jest.fn().mockResolvedValue({ content: bad });
    expect(await generateSummary({ chat } as any, INPUT, { maxTokens: 4000, now: () => 1_000 })).toBeNull();
    expect(chat).toHaveBeenCalledTimes(2);
    const deadlines = chat.mock.calls.map((c) => (c[1] as { deadlineAtMs: number }).deadlineAtMs);
    expect(deadlines[0]).toBe(deadlines[1]);
  });

  it('does not ask again after an error, a cancel, or an answer that is only too short', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('down'));
    await generateSummary({ chat: failing } as any, INPUT, { maxTokens: 4000 });
    expect(failing).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const cancelled = jest.fn().mockImplementation(async () => { controller.abort(); return { content: bad }; });
    await generateSummary({ chat: cancelled } as any, INPUT, { maxTokens: 4000, signal: controller.signal });
    expect(cancelled).toHaveBeenCalledTimes(1);
    const short = jest.fn().mockResolvedValue({ content: 'Too short.' });
    await generateSummary({ chat: short } as any, INPUT, { maxTokens: 4000 });
    expect(short).toHaveBeenCalledTimes(1);
  });
});


describe('a summary may cite what the file really is made of', () => {
  it('puts the real counts in the input, so a summary that quotes them is grounded', () => {
    const profile = buildDocumentProfile(doc([h(1, '1', 'Scope'), p('This ICD defines the interfaces of the backplane in detail.'), h(1, '2', 'Power'), fig(), tbl()]));
    expect(profile.summaryInput).toMatch(/Structure: 2 sections, 1 levels deep, 0 tables, 0 figures/);
    const ok = 'This document has 2 sections and defines the interfaces of the backplane in detail, then covers power across the remaining part of the file.';
    expect(isGrounded(ok, profile.summaryInput)).toBe(true);
  });

  it('lets a summary call the document an ICD or an SRS without that word being in the text, but not invent other acronyms', () => {
    const input = 'Sections: 1 Scope; 2 Power\nCited: VITA 46.0';
    const base = 'This document is an ICD that describes the backplane, its power sections and the standards it cites, in about as many words as a short summary needs.';
    expect(isGrounded(base, input)).toBe(true);
    expect(isGrounded(base.replace('ICD', 'CAN bus'), input)).toBe(false);
  });
});
