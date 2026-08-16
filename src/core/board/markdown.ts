// Markdown → HTML for the board, rendered here rather than on the page.
//
// Ticket bodies and the wayfinder map's prose are Markdown, because they are written to be read in
// a terminal as well as in the viewer. Turning that into markup is a pure string → string
// transform, so it lives in TypeScript for the same reason the view model does (see `view.ts`'s
// opening note) — it can be asserted directly, instead of only through what a DOM ends up holding.
//
// Deliberately not a Markdown implementation: no links, no images, no nesting. Those would each be
// a rule to get subtly wrong, and none of them is what makes a body unreadable.
//
// The one safety property this module owns: escaping runs *first*, so every tag that reaches the
// page comes from a literal below rather than from the text. A body containing `<script>` or `<b>`
// renders as the characters someone typed, and there is no path by which a ticket body becomes
// markup (ADR-0012).

// `esc`, `html` and `flatten` below are a second copy of the page's own — board.html:382-407 —
// and stay that way on purpose. The page is served as one unbundled text asset with an inline
// script (ADR-0012), so it can import nothing; and it still interpolates titles, sessions and
// labels that are not renderer output, so it cannot give its copy up either. Two copies of twenty
// lines beats a build step for the viewer. They are twins, not a shared abstraction: a fix to the
// escaping bargain has to be made in both.

/** Markup that has already been escaped — the only thing `html` interpolates verbatim. */
interface Html {
  __html: string;
}

type Value = Html | string | Value[];

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

const esc = (text: string): string => text.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);

/**
 * Markup with escaping on by default: every interpolated value is escaped unless it is itself the
 * output of `html`, and arrays join themselves. Hand-concatenation escaped correctly too, but only
 * for as long as every future edit remembered to call `esc()` — the default was unsafe and the
 * safety was a habit. The page's twin also takes `null`/`undefined`/`false`, which it needs for its
 * conditional fragments; every value reaching this one is typed, so it does not.
 *
 * A newline and its indentation collapse to one space, exactly as HTML itself would collapse them,
 * so a template can be laid out over several lines.
 */
function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = fmt(strings[0] ?? "");
  for (const [i, value] of values.entries()) out += flatten(value) + fmt(strings[i + 1] ?? "");
  return { __html: out };
}

const fmt = (chunk: string): string => chunk.replace(/\s*\n\s*/g, " ");

function flatten(value: Value): string {
  if (typeof value === "string") return esc(value);
  if (Array.isArray(value)) return value.map(flatten).join("");
  return value.__html;
}

/**
 * The inline half: code, bold, italic, and nothing else — no links, no headings, no HTML passed
 * through. This is what the map's prose gets, because there each section is a line at a time.
 *
 * Without it the section reads as its own source: `- **A capability** — the right fix…`.
 */
export function renderInlineMarkdown(text: string): string {
  return (
    esc(text)
      .replace(/``(.+?)``/g, "<code>$1</code>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      // Bold before italic, and lazily: a bold run routinely contains an italic one, which a
      // `[^*]+` body would refuse to match and leave on the page as its own asterisks.
      .replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
  );
}

const inline = (text: string): Html => ({ __html: renderInlineMarkdown(text) });

/**
 * The block half of the same deal. A ticket body is a whole document, so it needs headings, lists,
 * fenced code, tables and paragraphs, or it reads as its own source: a wall of `##` and `-` with no
 * shape. Empty in, empty out — a body with nothing in it renders as no blocks at all.
 */
export function renderMarkdown(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: Html[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];
  let code: string[] | null = null;
  let table: string[] | null = null;

  const flushPara = () => {
    if (para.length === 0) return;
    out.push(html`<p>${inline(para.join("\n"))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list === null) return;
    const items = list.items.map((item) => html`<li>${inline(item)}</li>`);
    out.push(list.ordered ? html`<ol>${items}</ol>` : html`<ul>${items}</ul>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    out.push(html`<blockquote>${inline(quote.join("\n"))}</blockquote>`);
    quote = [];
  };
  /**
   * A pipe table. Real bodies use them for exactly what a table is for — a requirement against what
   * it now means — and as a run of paragraphs they are the least readable thing on the page.
   * The alignment row is a separator, not data: its presence is what makes the first row a header.
   */
  const flushTable = () => {
    if (table === null) return;
    const rows = table;
    const isRule = (row: string) => /^[\s|:-]+$/.test(row) && row.includes("-");
    const cells = (row: string) => row.split("|").map((c) => c.trim());
    const second = rows[1];
    const headed = second !== undefined && isRule(second);
    const head: Value = headed
      ? html`<thead><tr>${cells(rows[0] ?? "").map((c) => html`<th>${inline(c)}</th>`)}</tr></thead>`
      : "";
    const body = rows
      .filter((row, i) => !isRule(row) && !(headed && i === 0))
      .map((row) => html`<tr>${cells(row).map((c) => html`<td>${inline(c)}</td>`)}</tr>`);
    // No whitespace inside <table>: the parser fosters a stray text node out of the element.
    out.push(
      html`<div class="tablewrap scrolls"><table>${head}<tbody>${body}</tbody></table></div>`,
    );
    table = null;
  };
  const flushText = () => {
    flushPara();
    flushList();
    flushQuote();
  };
  const flush = () => {
    flushText();
    flushTable();
  };

  for (const line of lines) {
    // Inside a fence nothing is Markdown, not even the blank line that ends every other block.
    if (code !== null) {
      if (/^\s*```/.test(line)) {
        out.push(html`<pre class="scrolls"><code>${code.join("\n")}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      flush();
      code = [];
      continue;
    }

    const row = /^\s*\|(.*)\|\s*$/.exec(line);
    if (row) {
      flushText();
      (table ??= []).push(row[1] ?? "");
      continue;
    }
    flushTable();

    if (line.trim() === "") {
      flush();
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push(html`<hr>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(headingHtml((heading[1] ?? "").length, heading[2] ?? ""));
      continue;
    }

    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      flushPara();
      flushList();
      quote.push(quoted[1] ?? "");
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      flushQuote();
      const ordered = bullet === null;
      if (list === null || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)?.[1] ?? "");
      continue;
    }
    // A line under an open list is that item wrapping, not a paragraph of its own.
    if (list !== null) {
      const items = list.items;
      const last = items.length - 1;
      items[last] = `${items[last] ?? ""}\n${line.trim()}`;
      continue;
    }
    if (quote.length > 0) {
      quote.push(line.trim());
      continue;
    }
    para.push(line);
  }
  if (code !== null) out.push(html`<pre class="scrolls"><code>${code.join("\n")}</code></pre>`);
  flush();
  return out.map((block) => block.__html).join("");
}

/**
 * A body's headings start at h3 — the detail panel's own `<h1>` is the ticket's title, and a body
 * that opened with an h1 of its own would outrank it. Written as four branches rather than one
 * interpolated tag name so every tag this can emit is visible in the source.
 */
function headingHtml(level: number, text: string): Html {
  const inner = inline(text);
  if (level <= 1) return html`<h3>${inner}</h3>`;
  if (level === 2) return html`<h4>${inner}</h4>`;
  if (level === 3) return html`<h5>${inner}</h5>`;
  return html`<h6>${inner}</h6>`;
}
