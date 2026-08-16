// The board's Markdown renderer, asserted as what it is: a string in, a string out.
//
// It used to live in the page's inline script, where the only way to ask it anything was to mount a
// whole board in happy-dom, click a card and read the DOM back. The table parser and the escaping
// rules are the two things worth pinning precisely, and both were being tested through the widest
// surface the viewer has.

import { describe, expect, test } from "bun:test";
import { renderInlineMarkdown, renderMarkdown } from "../src/core/board/markdown.ts";

describe("inline Markdown", () => {
  test("renders code, bold and italic, and nothing else", () => {
    expect(renderInlineMarkdown("**Bold** and `code` and *emphasis*")).toBe(
      "<b>Bold</b> and <code>code</code> and <i>emphasis</i>",
    );
  });

  test("a bold run keeps the italic inside it", () => {
    expect(renderInlineMarkdown("**bold with *some* stress**")).toBe(
      "<b>bold with <i>some</i> stress</b>",
    );
  });

  test("double backticks fence a span that contains a backtick", () => {
    expect(renderInlineMarkdown("``a ` tick``")).toBe("<code>a ` tick</code>");
  });

  test("escapes first, so the text's own markup stays text", () => {
    expect(renderInlineMarkdown('<b>not</b> & "quoted"')).toBe(
      "&lt;b&gt;not&lt;/b&gt; &amp; &quot;quoted&quot;",
    );
  });

  test("a tag inside a code span is still text", () => {
    expect(renderInlineMarkdown("`<i>even</i>`")).toBe("<code>&lt;i&gt;even&lt;/i&gt;</code>");
  });

  test("leaves a lone asterisk alone rather than opening an italic", () => {
    expect(renderInlineMarkdown("2 * 3 and a trailing *")).toBe("2 * 3 and a trailing *");
  });
});

describe("block Markdown", () => {
  test("a body with nothing in it renders as no blocks at all", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("\n  \n")).toBe("");
  });

  test("headings start at h3, so a body cannot outrank the panel's own title", () => {
    expect(renderMarkdown("# Top\n\n## Second\n\n### Third\n\n#### Fourth")).toBe(
      "<h3>Top</h3><h4>Second</h4><h5>Third</h5><h6>Fourth</h6>",
    );
  });

  test("a blank line separates paragraphs, and a rule is its own block", () => {
    expect(renderMarkdown("one\n\ntwo\n\n---\n\nafter")).toBe(
      "<p>one</p><p>two</p><hr><p>after</p>",
    );
  });

  test("a bullet list is a list, and a numbered one is ordered", () => {
    expect(renderMarkdown("- one\n- two\n\n1. first\n2. second")).toBe(
      "<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>",
    );
  });

  test("a wrapped bullet stays one item rather than becoming a paragraph", () => {
    expect(renderMarkdown("- one line\n  and its continuation\n- two")).toBe(
      "<ul><li>one line\nand its continuation</li><li>two</li></ul>",
    );
  });

  test("a blockquote is its own block, and a wrapped line stays in it", () => {
    expect(renderMarkdown("> quoted\ncontinued\n\nafter")).toBe(
      "<blockquote>quoted\ncontinued</blockquote><p>after</p>",
    );
  });

  test("a fenced block keeps its lines, and nothing inside it is Markdown", () => {
    expect(renderMarkdown("```\nservant ticket show 82\n- not a bullet\n```")).toBe(
      '<pre class="scrolls"><code>servant ticket show 82\n- not a bullet</code></pre>',
    );
  });

  test("a fence nobody closed still renders, rather than swallowing the rest of the body", () => {
    expect(renderMarkdown("```\nstill open")).toBe(
      '<pre class="scrolls"><code>still open</code></pre>',
    );
  });
});

// The parser that had no surface of its own: three shapes, and each one was a paragraph run before.
describe("pipe tables", () => {
  const table = (rows: string) => renderMarkdown(rows);

  test("the alignment row is what makes the first row a header, and is never a row itself", () => {
    expect(table("| req | effect |\n|---|---|\n| **4** | the window |\n| 6 | retry |")).toBe(
      '<div class="tablewrap scrolls"><table>' +
        "<thead><tr><th>req</th><th>effect</th></tr></thead>" +
        "<tbody>" +
        "<tr><td><b>4</b></td><td>the window</td></tr>" +
        "<tr><td>6</td><td>retry</td></tr>" +
        "</tbody></table></div>",
    );
  });

  test("a colon-aligned rule reads as a rule too", () => {
    expect(table("| a | b |\n| :--- | ---: |\n| 1 | 2 |")).toContain(
      "<thead><tr><th>a</th><th>b</th></tr></thead>",
    );
  });

  test("without a rule there is no header — every row is data", () => {
    expect(table("| a | b |\n| c | d |")).toBe(
      '<div class="tablewrap scrolls"><table><tbody>' +
        "<tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr>" +
        "</tbody></table></div>",
    );
  });

  test("a table closes when the prose resumes, and the prose is not in it", () => {
    expect(table("| a |\n|---|\n| 1 |\n\nafter")).toContain("</table></div><p>after</p>");
  });
});

// The one property the whole module exists to hold: the tags on the page are the ones written
// here, never the ones a ticket body spelled out (ADR-0012).
describe("escaping", () => {
  test("a body's own markup renders as the characters someone typed", () => {
    expect(renderMarkdown("<script>alert(1)</script>\n\nand a <b>bold</b> tag")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p>and a &lt;b&gt;bold&lt;/b&gt; tag</p>",
    );
  });

  test("a heading, a list item and a cell are escaped like everything else", () => {
    expect(renderMarkdown("# <img src=x>\n\n- <img src=x>\n\n| <img src=x> |")).toBe(
      "<h3>&lt;img src=x&gt;</h3>" +
        "<ul><li>&lt;img src=x&gt;</li></ul>" +
        '<div class="tablewrap scrolls"><table><tbody><tr><td>&lt;img src=x&gt;</td></tr></tbody></table></div>',
    );
  });

  test("a fenced block is escaped, so it cannot close its own <pre>", () => {
    expect(renderMarkdown("```\n</code></pre><img src=x>\n```")).toBe(
      '<pre class="scrolls"><code>&lt;/code&gt;&lt;/pre&gt;&lt;img src=x&gt;</code></pre>',
    );
  });
});
