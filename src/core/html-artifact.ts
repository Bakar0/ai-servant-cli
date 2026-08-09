// The one mechanism behind every self-contained offline page servant ships — the workspace
// dashboard, the insights `--deep` dashboard, and the Call log. Each is one hand-written HTML asset
// carrying a single JSON sentinel; the renderer fills that sentinel and adds no markup of its own,
// so the template owns all styling and layout and the page never reaches the network.

/**
 * Fill a template's single JSON slot.
 *
 * Two escapes matter here, and both are easy to get wrong at a call site:
 * `</` is broken so a `</script>` inside any embedded string cannot close the tag early
 * (`<\/script>` is still valid JSON), and the replacement goes through a function so a `$&` or
 * `$'` in the data is inserted literally rather than read as a replacement pattern.
 */
export function fillDataSlot(template: string, slot: string, data: unknown): string {
  if (!template.includes(slot)) {
    throw new Error(`html template is missing the ${slot} data slot`);
  }
  const encoded = JSON.stringify(data).replace(/<\//g, "<\\/");
  return template.replace(slot, () => encoded);
}
