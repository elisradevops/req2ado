import { describe, it, expect } from 'vitest';
import { parseDeterministicSubtreeChunk, formatDeterministicSubtreePassSubLabel } from './deterministicSubtreeChunk';

describe('parseDeterministicSubtreeChunk', () => {
  it('parses a synthesis-pass label', () => {
    expect(parseDeterministicSubtreeChunk('synthesizing requirement text for 150 node(s) (chunk 1 of 2)')).toEqual({
      chunkIndex: 1,
      chunkCount: 2,
      passLabel: 'synthesizing text',
      nodeCount: 150,
    });
  });

  it('parses a title/tag-pass label', () => {
    expect(parseDeterministicSubtreeChunk('enhancing titles/tags for 3 node(s) (chunk 2 of 2)')).toEqual({
      chunkIndex: 2,
      chunkCount: 2,
      passLabel: 'enhancing titles/tags',
      nodeCount: 3,
    });
  });

  it('parses a label with a subtree label prefix', () => {
    expect(
      parseDeterministicSubtreeChunk('Heading hierarchy -- synthesizing requirement text for 150 node(s) (chunk 1 of 3)'),
    ).toEqual({ chunkIndex: 1, chunkCount: 3, passLabel: 'synthesizing text', nodeCount: 150 });
  });

  it('returns null for null/undefined/empty input', () => {
    expect(parseDeterministicSubtreeChunk(null)).toBeNull();
    expect(parseDeterministicSubtreeChunk(undefined)).toBeNull();
    expect(parseDeterministicSubtreeChunk('')).toBeNull();
  });

  it('returns null when the label has no chunk marker', () => {
    expect(parseDeterministicSubtreeChunk('some unrelated label')).toBeNull();
  });

  it('still parses chunk/pass info when the node count is missing from the label', () => {
    expect(parseDeterministicSubtreeChunk('synthesizing requirement text (chunk 1 of 2)')).toEqual({
      chunkIndex: 1,
      chunkCount: 2,
      passLabel: 'synthesizing text',
      nodeCount: null,
    });
  });
});

describe('formatDeterministicSubtreePassSubLabel', () => {
  it('labels the synthesis pass as pass 1 of 2', () => {
    expect(
      formatDeterministicSubtreePassSubLabel({ chunkIndex: 1, chunkCount: 2, passLabel: 'synthesizing text', nodeCount: 150 }),
    ).toBe('pass 1 of 2 · synthesizing text');
  });

  it('labels the title/tag pass as pass 2 of 2', () => {
    expect(
      formatDeterministicSubtreePassSubLabel({
        chunkIndex: 2,
        chunkCount: 2,
        passLabel: 'enhancing titles/tags',
        nodeCount: 3,
      }),
    ).toBe('pass 2 of 2 · enhancing titles/tags');
  });
});
