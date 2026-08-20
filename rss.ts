/**
 * Minimal RSS 2.0 fetcher + parser. Zero dependencies — uses native fetch and
 * regex-based XML extraction (good enough for standard VnExpress / Tuổi Trẻ feeds).
 * All outbound fetches go through `safeFetchDownload` (SSRF guard + timeout + size cap).
 */

import { safeFetchDownload } from './safe-fetch';

export interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  imageUrl?: string;
}

export async function fetchRssItems(feedUrl: string, limit = 10): Promise<RssItem[]> {
  const r = await safeFetchDownload(feedUrl, {
    timeoutMs: 30000, // slow feeds ≥ slow scrape
    maxBytes: 2 * 1024 * 1024,
  });
  if (!r.ok)
    throw new Error(`Fetch RSS failed: HTTP ${r.status}`);
  return parseRssItems(r.text).slice(0, limit);
}

/** Build the post content for one RSS item: title + (full article body OR teaser) + source link. */
export function buildContent(item: RssItem, articleBody?: string): string {
  const text =
    articleBody ||
    stripHtml(decodeXml(stripCdata(item.description)))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  return [item.title, text, `Nguồn: ${item.link}`].filter(Boolean).join('\n\n');
}

/**
 * Fetch the full article body from a VnExpress article URL.
 * Extracts <div class="fck_detail"> → <p> paragraphs. Returns null on failure (caller falls back to teaser).
 */
export async function fetchArticleBody(url: string): Promise<string | null> {
  if (!url) return null;
  try {
    const r = await safeFetchDownload(url, {
      timeoutMs: 30000,
      maxBytes: 2 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (news-poster/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!r.ok) return null;
    let html = r.text;
    // strip scripts/styles/noscript (ads, tracking, anti-bot JS) so they don't pollute <p> extraction
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
    // VnExpress article body paragraphs: <p class="description"> (lead) + <p class="Normal"> (body).
    // Works across templates (fck_detail may not exist for briefs).
    const paragraphs =
      html.match(/<p[^>]*class="[^"]*(?:Normal|description)[^"]*"[^>]*>[\s\S]*?<\/p>/gi) || [];
    const seen = new Set<string>();
    const text = paragraphs
      .map((p) => {
        const inner = p.replace(/^<p[^>]*>/i, '').replace(/<\/p>\s*$/i, '');
        return decodeXml(stripCdata(inner)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      })
      .filter((t) => t && !/dấu tích xanh|đóng trang web trên|hoàn thành, bạn đọc/i.test(t))
      .filter((t) => {
        if (seen.has(t)) return false; // dedupe (VnExpress duplicates body in a hidden print_content block)
        seen.add(t);
        return true;
      })
      .join('\n\n');
    return text ? text.slice(0, 20000) : null;
  } catch {
    return null;
  }
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[0];
    items.push({
      title: pickTag(block, 'title'),
      link: pickTag(block, 'link'),
      description: pickTag(block, 'description'),
      pubDate: pickTag(block, 'pubDate'),
      imageUrl: pickImgSrc(pickTag(block, 'description')),
    });
  }
  return items;
}

function pickTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeXml(stripCdata(m[1])).trim() : '';
}

/** Extract the first <img src="..."> URL from an HTML string (description). */
function pickImgSrc(html: string): string | undefined {
  if (!html) return undefined;
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1].trim() : undefined;
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}
