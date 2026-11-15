import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePageTitle } from './usePageTitle';

describe('usePageTitle (WCAG 2.4.2: every page has a title that says where you are)', () => {
  beforeEach(() => {
    document.title = 'req2ado';
  });

  it('puts the page first and the product after it, and restores the previous title on leaving', () => {
    const { unmount } = renderHook(() => usePageTitle('Jobs'));
    expect(document.title).toBe('Jobs - req2ado');
    unmount();
    expect(document.title).toBe('req2ado');
  });

  it('follows a title that changes, such as a job whose name has just loaded', () => {
    const { rerender } = renderHook(({ title }) => usePageTitle(title), { initialProps: { title: 'Job' } });
    expect(document.title).toBe('Job - req2ado');
    rerender({ title: 'radar-icd.docx' });
    expect(document.title).toBe('radar-icd.docx - req2ado');
  });

  it('leaves the title alone when given nothing', () => {
    renderHook(() => usePageTitle(null));
    expect(document.title).toBe('req2ado');
  });

  it('restores the ORIGINAL title after a title change and then leaving', () => {
    const { rerender, unmount } = renderHook(({ title }) => usePageTitle(title), { initialProps: { title: 'Job' } });
    rerender({ title: 'radar-icd.docx' });
    expect(document.title).toBe('radar-icd.docx - req2ado');
    unmount();
    expect(document.title).toBe('req2ado');
  });
});

