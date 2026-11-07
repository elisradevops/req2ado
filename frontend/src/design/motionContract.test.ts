import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Ratchet for DESIGN.md section 8: "A new @keyframes requires a new row here."
// Every keyframe in index.css must be named in the motion contract, and the
// reduced-motion kill-switch (section 8.1) must still clamp animations and
// transitions. The kill-switch is what makes every CSS animation safe, so a
// keyframe that is not covered by it, or not in the contract, is a defect.
const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
const design = readFileSync(join(__dirname, '..', '..', '..', 'DESIGN.md'), 'utf8');
const motionSection = design.slice(design.indexOf('## §8 — Motion contract'), design.indexOf('## §9 — Elevation semantics'));

const keyframeNames = [...css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((match) => match[1]);

describe('motion contract', () => {
  it('finds the section and the keyframes it audits', () => {
    expect(motionSection.length).toBeGreaterThan(500);
    expect(keyframeNames.length).toBeGreaterThan(8);
  });

  it.each(keyframeNames)('names the %s keyframe in DESIGN.md section 8', (name) => {
    expect(motionSection).toContain(name);
  });

  it('keeps the reduced-motion kill-switch for animations and transitions', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(block).toMatch(/transition-duration:\s*0\.001ms\s*!important/);
    // a clamped duration still waits out its delay: a staggered row would sit at opacity 0 (backwards fill) for up to 168ms
    expect(block).toMatch(/animation-delay:\s*0s\s*!important/);
    expect(block).toMatch(/transition-delay:\s*0s\s*!important/);
    // CSS smooth scrolling is motion too; JS smooth scrolling is gated separately by scrollBehavior() in ui/motion.ts
    expect(block).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });

  it('no longer defines the looping or per-row keyframes the research removed', () => {
    expect(keyframeNames).not.toContain('pulse-ring');
    expect(keyframeNames).not.toContain('listItemIn');
  });

  // transition-duration is clamped under reduced motion, transition-property is
  // not: a pressed or hovered control would still jump to its scaled or shifted
  // state instantly (DESIGN.md section 8.1, clause 1). Any such utility in the
  // source needs a matching neutraliser in the reduced-motion block.
  it('neutralises every pointer-state scale or translate utility under reduced motion', () => {
    const srcDir = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) files.push(full);
      }
    };
    walk(srcDir);
    const used = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/(?<![\w-])(active|hover):-?(scale|translate)-/g)) used.add(`${match[1]}:${match[2]}`);
    }
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(used.size).toBeGreaterThan(0);
    for (const key of used) {
      const [state, property] = key.split(':');
      // hover lift goes through .liftable (clause 1); a pointer press needs its own rule
      if (state === 'hover') {
        // Tailwind 4 emits a lift as the `translate` property, which `transform: none` does not cancel
        expect(block).toMatch(/\.liftable\s*\{[^}]*transform:\s*none/);
        expect(block).toMatch(/\.liftable\s*\{[^}]*translate:\s*none\s*!important/);
      }
      else expect(block).toMatch(new RegExp(`:active[^{]*\\{[^}]*${property}:\\s*none\\s*!important`));
    }
  });

  // The transition-property list must name the property that actually moves: Tailwind 4 emits a press as `scale` and a lift as
  // `translate`, and `transform` in the list does not cover either, so a tuned duration would never be seen.
  it('lists scale and translate in the transitions of the press and the lift', () => {
    const button = readFileSync(join(__dirname, '..', 'ui', 'Button.tsx'), 'utf8');
    expect(button).toMatch(/transition-\[[^\]]*\bscale\b[^\]]*\]/);
    const liftable = css.match(/\.liftable\s*\{[^}]*\}/)?.[0] ?? '';
    expect(liftable).toMatch(/transition-\[[^\]]*\btranslate\b[^\]]*\]/);
  });

  it('cancels the hover lift under reduced motion by its real property, translate, not only transform', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/\.liftable\s*\{[^}]*translate:\s*none\s*!important/);
  });

  // Tailwind in this repo does not generate `duration-fast` and friends from the --duration-* tokens: without an explicit
  // @utility the class has no rule, and the transition silently runs at the 150ms default. Every token class used in
  // source must be defined, and must set its own token.
  it('defines every duration-<token> utility that source uses, each bound to its own token', () => {
    const srcDir = join(__dirname, '..');
    const used = new Set<string>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) {
          for (const match of readFileSync(full, 'utf8').matchAll(/(?<![\w-])duration-(micro|instant|fast|base|exit|medium|slow|progress)(?![\w-])/g)) used.add(match[1]);
        }
      }
    };
    walk(srcDir);
    expect(used.size).toBeGreaterThan(0);
    for (const token of used) {
      expect(css).toMatch(new RegExp(`@utility duration-${token}\\s*\\{\\s*transition-duration:\\s*var\\(--duration-${token}\\);?\\s*\\}`));
    }
  });

  // WCAG 2.2.2: motion that starts by itself, lasts more than five seconds and sits beside other content needs a way to stop it.
  // The two loops that sit beside usable content are bounded to under five seconds instead; loading placeholders and a
  // spinner inside the control that is busy stay as they are (see DESIGN.md section 8.3).
  const tokenMs = (name: string): number => {
    const value = css.match(new RegExp(`--duration-${name}:\\s*(\\d+)ms`));
    return value ? Number(value[1]) : NaN;
  };

  it('plays the confirm button attention once and settles on the attention state, instead of looping', () => {
    const rule = css.match(/\.cta-attention\s*\{[^}]*\}/)?.[0] ?? '';
    // `backwards`, not `forwards`: a filled animation would override the button's own hover and press shadows. The rule
    // itself already holds the attention shadow, so the end state is the resting state.
    expect(rule).toMatch(/animation:\s*ctaBreathe\s+var\(--duration-breathe\)\s+var\(--ease-in-out\)\s+1\s+backwards/);
    expect(rule).toMatch(/box-shadow:\s*var\(--shadow-cta-attention\)/);
    expect(rule).not.toContain('forwards');
    expect(rule).not.toContain('infinite');
    expect(tokenMs('breathe')).toBeLessThanOrEqual(5000);
    const keyframes = css.match(/@keyframes ctaBreathe\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(keyframes).toMatch(/to\s*\{[^}]*var\(--shadow-cta-attention\)/); // ends where the reduced-motion fallback already is
  });

  it('keeps the current-step spinner under five seconds in total', () => {
    const stepper = readFileSync(join(__dirname, '..', 'ui', 'Stepper.tsx'), 'utf8');
    const spin = stepper.match(/spin var\(--duration-spin\) linear (\d+)/);
    expect(spin).not.toBeNull();
    expect(tokenMs('spin') * Number(spin![1])).toBeLessThanOrEqual(5000);
    expect(stepper).not.toMatch(/spin[^']*infinite/);
  });

  it('takes the spinner and typing-dot durations from tokens, not literals', () => {
    for (const file of [['ui', 'Spinner.tsx'], ['components', 'ChatPanel.tsx']]) {
      const source = readFileSync(join(__dirname, '..', ...file), 'utf8');
      expect(source).not.toMatch(/\b(spin|typedot)[_ ]\d+(\.\d+)?m?s/);
    }
    expect(tokenMs('spin')).toBe(1000);
    expect(tokenMs('typedot')).toBe(1100);
  });
});
