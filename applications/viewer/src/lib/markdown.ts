/**
 * A deliberately small Markdown-to-HTML converter for the three legal
 * documents at the repo root.
 *
 * No dependency: it covers exactly the constructs those files use - headings,
 * bold, emphasis, inline code, unordered and ordered lists, one table,
 * horizontal rules, autolinks and paragraphs - and nothing else. The input is
 * trusted repo content, not user input, so the bar here is rendering
 * correctly, not surviving hostile Markdown. It still escapes HTML, because
 * getting that wrong in a document whose entire purpose is to be publicly
 * readable is not worth the saved line.
 *
 * ponytail: a subset converter. Anything it does not know - nested lists,
 * reference links, images, code fences - degrades to plain text rather than
 * breaking. `tests/legal.test.ts` asserts that no visible text from the real
 * documents is ever dropped, which is the property that actually matters for
 * a legally required disclosure. Upgrade path if the documents grow features:
 * add `marked` as a viewer dependency and delete this file, rather than
 * growing this into a general Markdown parser.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One ordered-alternation pass rather than a chain of `.replace` calls, so
 * that code spans win over everything inside them: `container:<name>` in
 * backticks stays literal text instead of being read as an autolink, and
 * asterisks inside a code span are not emphasis. A chain would have needed
 * placeholder tokens to get the same result.
 */
const INLINE =
  /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|<(https?:\/\/[^>\s]+)>|<([^\s@<>]+@[^\s@<>]+)>|\*([^*\n]+)\*/g;

function renderInline(text: string): string {
  let result = '';
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE)) {
    result += escapeHtml(text.slice(lastIndex, match.index));

    const [full, code, bold, linkText, linkHref, url, email, emphasis] = match;
    if (code !== undefined) {
      result += '<code>' + escapeHtml(code) + '</code>';
    } else if (bold !== undefined) {
      result += '<strong>' + escapeHtml(bold) + '</strong>';
    } else if (linkText !== undefined && linkHref !== undefined) {
      result +=
        '<a href="' +
        escapeHtml(linkHref) +
        '" rel="noopener noreferrer">' +
        escapeHtml(linkText) +
        '</a>';
    } else if (url !== undefined) {
      result +=
        '<a href="' + escapeHtml(url) + '" rel="noopener noreferrer">' + escapeHtml(url) + '</a>';
    } else if (email !== undefined) {
      result += '<a href="mailto:' + escapeHtml(email) + '">' + escapeHtml(email) + '</a>';
    } else if (emphasis !== undefined) {
      result += '<em>' + escapeHtml(emphasis) + '</em>';
    }

    lastIndex = match.index + full.length;
  }

  return result + escapeHtml(text.slice(lastIndex));
}

function tableRow(line: string, cell: 'th' | 'td'): string {
  const cells = line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((value) => '<' + cell + '>' + renderInline(value.trim()) + '</' + cell + '>');
  return '<tr>' + cells.join('') + '</tr>';
}

/** A table's `| --- | --- |` separator carries no content and is dropped. */
function isTableDivider(line: string): boolean {
  return /^\|[\s|:-]+\|$/.test(line.trim());
}

export function renderMarkdown(markdown: string): string {
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let inTable = false;

  const closeParagraph = (): void => {
    if (paragraph.length > 0) {
      html.push('<p>' + renderInline(paragraph.join(' ')) + '</p>');
      paragraph = [];
    }
  };
  const closeList = (): void => {
    if (list !== null) {
      html.push('</' + list + '>');
      list = null;
    }
  };
  const closeTable = (): void => {
    if (inTable) {
      html.push('</tbody></table>');
      inTable = false;
    }
  };
  const closeAll = (): void => {
    closeParagraph();
    closeList();
    closeTable();
  };

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd();

    if (line.trim().length === 0) {
      closeAll();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null && heading[1] !== undefined && heading[2] !== undefined) {
      closeAll();
      const level = heading[1].length;
      html.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(line.trim())) {
      closeAll();
      html.push('<hr />');
      continue;
    }

    if (line.trimStart().startsWith('|')) {
      if (isTableDivider(line)) continue;
      closeParagraph();
      closeList();
      if (!inTable) {
        // The first row of a table is its header; these documents have no
        // headerless tables.
        html.push('<table><thead>' + tableRow(line.trim(), 'th') + '</thead><tbody>');
        inTable = true;
        continue;
      }
      html.push(tableRow(line.trim(), 'td'));
      continue;
    }
    closeTable();

    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (unordered !== null && unordered[1] !== undefined) {
      closeParagraph();
      if (list !== 'ul') {
        closeList();
        html.push('<ul>');
        list = 'ul';
      }
      html.push('<li>' + renderInline(unordered[1]) + '</li>');
      continue;
    }

    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ordered !== null && ordered[1] !== undefined) {
      closeParagraph();
      if (list !== 'ol') {
        closeList();
        html.push('<ol>');
        list = 'ol';
      }
      html.push('<li>' + renderInline(ordered[1]) + '</li>');
      continue;
    }

    // A wrapped line inside a list continues the previous item. Without this,
    // the second line of a wrapped bullet would become its own paragraph and
    // read as if it were a separate statement.
    if (list !== null) {
      const previous = html.pop() ?? '';
      html.push(previous.replace(/<\/li>$/, '') + ' ' + renderInline(line.trim()) + '</li>');
      continue;
    }

    paragraph.push(line.trim());
  }

  closeAll();
  return html.join('\n');
}

/** Wraps rendered body HTML in a complete, readable standalone page. */
export function renderDocumentPage(title: string, lang: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: dark; }
body {
  margin: 0 auto; padding: 3rem 1.5rem 6rem; max-width: 46rem;
  background: #0b0d10; color: #d7dce3;
  font: 16px/1.7 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
h1, h2, h3, h4 { line-height: 1.25; margin: 2.5rem 0 0.75rem; color: #f2f5f9; }
h1 { margin-top: 0; font-size: 1.9rem; }
h2 { font-size: 1.35rem; }
h3 { font-size: 1.1rem; }
a { color: #7cc4ff; }
code {
  font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 0.9em;
  background: #161a20; padding: 0.1em 0.35em; border-radius: 3px;
}
table { border-collapse: collapse; width: 100%; margin: 1.25rem 0; }
th, td { border: 1px solid #2a3039; padding: 0.5rem 0.65rem; text-align: left; vertical-align: top; }
th { background: #161a20; }
hr { border: 0; border-top: 1px solid #2a3039; margin: 2.5rem 0; }
li { margin: 0.35rem 0; }
nav { margin-bottom: 2.5rem; font-size: 0.9rem; }
nav a { margin-right: 1rem; }
</style>
</head>
<body>
<nav><a href="/">mona</a><a href="/impressum">Impressum</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
${bodyHtml}
</body>
</html>
`;
}
