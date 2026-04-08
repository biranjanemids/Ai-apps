const MAX_BYTES = 10_000

// Strip HTML tags and collapse whitespace to get readable text
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, '\n')
    .trim()
}

export async function fetchUrl(args: { url: string }): Promise<string> {
  const { url } = args
  if (!url?.startsWith('http')) return 'Error: url must start with http:// or https://'

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ai-code/1.0 (terminal coding assistant)' },
      signal:  AbortSignal.timeout(15_000),
    })
    if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText}`

    const ct   = res.headers.get('content-type') ?? ''
    const text = await res.text()

    const content = ct.includes('html') ? stripHtml(text) : text
    return content.length > MAX_BYTES
      ? content.slice(0, MAX_BYTES) + `\n\n[...truncated at ${MAX_BYTES} chars]`
      : content
  } catch (e: any) {
    return `Error fetching URL: ${e.message}`
  }
}
