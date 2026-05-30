// Lightweight markdown → HTML converter shared between the template editor
// (src/app/dashboard/content/page.tsx) and any server-side caller that
// accepts user-entered template bodies (e.g. /api/candidates/bulk-email
// when saving as EmailTemplate or sending without one).
//
// Recruiters compose templates in plain text with a small set of inline
// markers — bold (**), italic (*), links ([text](url)), bullet/numbered
// lists, and auto-linked URLs / {{*_link}} merge tokens. Headings are NOT
// supported; lines like "### Section" render literally so users don't
// rely on an unstable subset.
//
// Pure string transforms (no DOM); safe to import from server routes.

export function applyInlineMarkdown(text: string): string {
  // 1. Markdown links [text](url) → <a href="url">text</a>. Done first so
  //    the URL inside isn't re-linked by the bare-URL pass below.
  let out = text.replace(/\[([^\]\n]+)\]\(([^)\n\s]+)\)/g, (_m, t, u) => `<a href="${u}">${t}</a>`)

  // 2. Bare URLs and {{*_link}} tokens — only outside existing <a>...</a>
  //    blocks so we don't double-wrap. Split keeps the delimiters.
  const segments = out.split(/(<a\s[^>]*>[\s\S]*?<\/a>)/g)
  for (let i = 0; i < segments.length; i += 2) {
    segments[i] = segments[i].replace(
      /(https?:\/\/[^\s<]+|\{\{[a-z_]*link\}\})/g,
      '<a href="$1">$1</a>'
    )
  }
  out = segments.join('')

  // 3. **bold** → <strong>bold</strong>  (must run before single-* italic)
  out = out.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, '<strong>$1</strong>')

  // 4. *italic* → <em>italic</em>  (negative lookarounds avoid eating ** edges)
  out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')

  return out
}

export function plainTextToHtml(text: string): string {
  if (!text.trim()) return ''
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const blocks = escaped.split(/\n\s*\n+/).map(b => b.replace(/\s+$/, '').replace(/^\s+/, '')).filter(Boolean)

  return blocks.map(block => {
    const lines = block.split('\n')
    if (lines.length > 0 && lines.every(l => /^-\s+/.test(l))) {
      const items = lines.map(l => `<li>${applyInlineMarkdown(l.replace(/^-\s+/, ''))}</li>`).join('')
      return `<ul>${items}</ul>`
    }
    if (lines.length > 0 && lines.every(l => /^\d+\.\s+/.test(l))) {
      const items = lines.map(l => `<li>${applyInlineMarkdown(l.replace(/^\d+\.\s+/, ''))}</li>`).join('')
      return `<ol>${items}</ol>`
    }
    const withBreaks = block.replace(/\n/g, '<br/>')
    return `<p>${applyInlineMarkdown(withBreaks)}</p>`
  }).join('\n')
}

export function htmlToPlainText(html: string): string {
  return html
    // <a href="X">text</a> → [text](X) so the link round-trips. When the
    // visible text is the same as the URL (auto-linked), collapse to bare URL.
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
      const clean = String(text).replace(/<[^>]+>/g, '').trim()
      return clean && clean !== href ? `[${clean}](${href})` : href
    })
    // Lists: numbered first so we can renumber, then bullet
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner) => {
      let i = 0
      return inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m2: string, c: string) =>
        `${++i}. ${c.replace(/<[^>]+>/g, '').trim()}\n`
      )
    })
    .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_m, inner) =>
      inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m2: string, c: string) =>
        `- ${c.replace(/<[^>]+>/g, '').trim()}\n`
      )
    )
    .replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**')
    .replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<\/?p[^>]*>/gi, '')
    .replace(/<\/?(span|div)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Detect: does this string already look like rendered HTML (block-level
// tags present) vs. raw plain text? Used by send paths so we don't
// double-escape already-converted bodies.
export function looksLikeHtml(s: string): boolean {
  return /<(p|div|br|ul|ol|li|strong|em|a|h[1-6]|table|tr|td)\b/i.test(s)
}
