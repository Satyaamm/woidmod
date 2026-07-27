/** Turn an adapter field key like `baseUrl` or `apiKey` into a readable label. */
export function humanizeField(field: string): string {
  const spaced = field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
