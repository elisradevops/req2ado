// "1 figure", "2 figures": the count first, the noun agreeing with it. Use this instead of writing "figure(s)" in user-visible text.
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}
