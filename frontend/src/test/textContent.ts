// A getByText matcher for a sentence split across elements, as one with an AnimatedNumber in it is (the number sits in its own
// visually hidden span). Matches the innermost element whose whole text is `text`, so ancestors with the same text do not match too.
export function fullText(text: string | RegExp) {
  const matches = (value: string | null | undefined): boolean =>
    value != null && (typeof text === 'string' ? value === text : text.test(value));
  return (_content: string, element: Element | null): boolean =>
    !!element && matches(element.textContent) && !Array.from(element.children).some((child) => matches(child.textContent));
}
