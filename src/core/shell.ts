/**
 * Wrap a value in single quotes so it can be embedded as a single argument
 * inside a POSIX shell command line. Any embedded single quotes are escaped
 * by closing the quote, inserting an escaped quote, and reopening.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
