// Lightweight markdown → HTML converter shared between the template editor
// (src/app/dashboard/content/page.tsx) and any server-side caller that
// accepts user-entered template bodies (e.g. /api/candidates/bulk-email
// when saving as EmailTemplate or sending without one).
//
// Recruiters compose templates in plain text with a small set of inline
// markers — headings (# / ## / ###), bold (**), italic (*),
// links ([text](url)), bullet/numbered lists, and auto-linked URLs /
// {{*_link}} merge tokens.
//
// Pure string transforms (no DOM); safe to import from server routes.

// Inline style for button-styled anchor tags. Kept consistent with the
// recruiter's brand (orange like the dashboard primary). Email-safe:
// inline styles only, no external CSS, padding/border-radius supported
// across modern clients.
const BUTTON_STYLE = 'display:inline-block;padding:12px 28px;background:#FF9500;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;margin:8px 0'

export function applyInlineMarkdown(text: string): string {
  // 0. Button syntax: [[button|LABEL|URL]] → styled <a>. Inserted by the
  //    template editor's "Button" tool. Done before the markdown-link
  //    pass so its `[` characters don't get re-parsed as a link. URL may
  //    be a literal http(s) URL or a merge token like {{schedule_link:id}}
  //    — renderTemplate substitutes at send time.
  let out = text.replace(/\[\[button\|([^|\]\n]+)\|([^\]\n]+)\]\]/g, (_m, label, url) =>
    `<a href="${url}" style="${BUTTON_STYLE}" data-button="1">${label}</a>`
  )

  // 1. Markdown links [text](url) → <a href="url">text</a>. Done first so
  //    the URL inside isn't re-linked by the bare-URL pass below.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\n\s]+)\)/g, (_m, t, u) => `<a href="${u}">${t}</a>`)

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
    // Single-line heading block: # / ## / ### at the start of a line.
    // Mapped to <h3>/<h2>/<h1>-ish via the count. We cap at 3 # because
    // anything bigger is almost certainly a typo and email clients don't
    // give h4-h6 visible distinction anyway.
    if (lines.length === 1) {
      const m = /^(#{1,3})\s+(.+)$/.exec(lines[0])
      if (m) {
        const level = m[1].length // 1..3
        const tag = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3'
        return `<${tag}>${applyInlineMarkdown(m[2])}</${tag}>`
      }
    }
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
    // Button anchors (data-button="1") round-trip back to [[button|...|...]]
    // so the editor textarea shows the same syntax the toolbar inserted.
    // Run before the generic <a> handler so they don't get rewritten as
    // plain markdown links.
    .replace(/<a\s+[^>]*data-button=["']1["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
      const clean = String(text).replace(/<[^>]+>/g, '').trim()
      return `[[button|${clean}|${href}]]`
    })
    // Same as above but for <a href=... data-button=...> ordering — browsers
    // and HTML-escape passes don't guarantee attribute order.
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*data-button=["']1["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
      const clean = String(text).replace(/<[^>]+>/g, '').trim()
      return `[[button|${clean}|${href}]]`
    })
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
    // Headings round-trip back to #/##/### so the editor textarea shows
    // the same markdown the user originally typed.
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n')
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

// Public list of supported markdown syntax — shown verbatim in the
// template editor hint so the syntax stays in sync with what
// plainTextToHtml actually parses.
export const SUPPORTED_MARKDOWN_HINT =
  'Plain text by default — use the toolbar for bold, italic, links, or lists. ' +
  '# / ## / ### at the start of a line become headings. Blank line = new paragraph. ' +
  'URLs and {{...}} tokens become clickable automatically.'
