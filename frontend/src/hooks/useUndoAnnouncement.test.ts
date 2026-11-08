import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useUndoAnnouncement, type QueueUndo } from './useUndoAnnouncement';

function makeUndo(label = 'item'): QueueUndo {
  return { label, run: async () => true };
}

describe('useUndoAnnouncement', () => {
  describe('undo slot', () => {
    it('starts with nothing to undo', () => {
      const { result } = renderHook(() => useUndoAnnouncement());
      expect(result.current.hasUndo).toBe(false);
      expect(result.current.lastUndoRef.current).toBeNull();
    });

    it('keeps the ref and the hasUndo mirror in step when an undo is set and cleared', () => {
      const { result } = renderHook(() => useUndoAnnouncement());
      const undo = makeUndo();
      act(() => result.current.setLastUndo(undo));
      expect(result.current.lastUndoRef.current).toBe(undo);
      expect(result.current.hasUndo).toBe(true);
      act(() => result.current.setLastUndo(null));
      expect(result.current.lastUndoRef.current).toBeNull();
      expect(result.current.hasUndo).toBe(false);
    });

    it('clearLastUndoIf clears only the undo it is given (the toast already ran that step)', () => {
      const { result } = renderHook(() => useUndoAnnouncement());
      const first = makeUndo('first');
      const second = makeUndo('second');
      act(() => result.current.setLastUndo(second));
      act(() => result.current.clearLastUndoIf(first));
      expect(result.current.lastUndoRef.current).toBe(second);
      expect(result.current.hasUndo).toBe(true);
      act(() => result.current.clearLastUndoIf(second));
      expect(result.current.lastUndoRef.current).toBeNull();
      expect(result.current.hasUndo).toBe(false);
    });

    it('clearLastUndoIf ignores undefined', () => {
      const { result } = renderHook(() => useUndoAnnouncement());
      const undo = makeUndo();
      act(() => result.current.setLastUndo(undo));
      act(() => result.current.clearLastUndoIf(undefined));
      expect(result.current.lastUndoRef.current).toBe(undo);
    });
  });

  describe('announcement', () => {
    it('starts empty and holds a plain message', () => {
      const { result } = renderHook(() => useUndoAnnouncement());
      expect(result.current.announcement).toBe('');
      act(() => result.current.setAnnouncement('Accepted. 2 left.'));
      expect(result.current.announcement).toBe('Accepted. 2 left.');
    });

    it('announceAgain alternates a trailing zero-width space so an identical message is re-spoken', () => {
      const { result } = renderHook(() => useUndoAnnouncement());
      act(() => result.current.announceAgain('Still saving. Try again.'));
      const first = result.current.announcement;
      act(() => result.current.announceAgain('Still saving. Try again.'));
      const second = result.current.announcement;
      act(() => result.current.announceAgain('Still saving. Try again.'));
      const third = result.current.announcement;
      expect(first).not.toBe(second);
      expect(second).not.toBe(third);
      expect(third).toBe(first);
      for (const text of [first, second, third]) {
        expect(text.replace('\u200b', '')).toBe('Still saving. Try again.');
      }
    });

    it('announceAgain after a direct setAnnouncement of the same text still changes it, by a trailing U+200B', () => {
      const { result } = renderHook(() => useUndoAnnouncement());
      const message = 'Still saving. Try again.';
      // An earlier announceAgain must not leave a hidden flip state behind that a later direct set can collide with.
      act(() => result.current.announceAgain(message));
      act(() => result.current.setAnnouncement(message));
      act(() => result.current.announceAgain(message));
      expect(result.current.announcement).not.toBe(message);
      expect(result.current.announcement).toBe(`${message}\u200b`);
      expect(result.current.announcement.charCodeAt(message.length)).toBe(0x200b);
      // A second repeat comes back to the plain text.
      act(() => result.current.announceAgain(message));
      expect(result.current.announcement).toBe(message);
    });
  });
});
