import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRssItems, buildContent, fetchArticleBody } from '../../rss';
import { stubGlobalFetch } from '../helpers/test-env';

const RSS_XML = `<?xml version="1.0"?>
<rss><channel>
<title>Feed</title>
<item>
  <title>Item A</title>
  <link>https://example.com/a</link>
  <description><![CDATA[<p>Desc A text</p><img src="https://img.example.com/a.jpg"/>]]></description>
  <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
</item>
<item>
  <title>Item B</title>
  <link>https://example.com/b</link>
  <description>Plain desc B</description>
  <pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate>
</item>
</channel></rss>`;

test('fetchRssItems parses items (title/link/description/CDATA/imageUrl) and respects limit', async () => {
  const restore = stubGlobalFetch(async () => new Response(RSS_XML, { status: 200 }));
  try {
    const items = await fetchRssItems('https://8.8.8.8/feed.rss', 10);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, 'Item A');
    assert.equal(items[0].link, 'https://example.com/a');
    assert.equal(items[0].description, '<p>Desc A text</p><img src="https://img.example.com/a.jpg"/>');
    assert.equal(items[0].imageUrl, 'https://img.example.com/a.jpg');
    assert.equal(items[1].title, 'Item B');
    assert.equal(items[1].imageUrl, undefined);
  } finally {
    restore();
  }
});

test('fetchRssItems honors the limit argument', async () => {
  const restore = stubGlobalFetch(async () => new Response(RSS_XML, { status: 200 }));
  try {
    const items = await fetchRssItems('https://8.8.8.8/feed.rss', 1);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Item A');
  } finally {
    restore();
  }
});

test('fetchRssItems throws on non-ok feed response', async () => {
  const restore = stubGlobalFetch(async () => new Response('nope', { status: 502 }));
  try {
    await assert.rejects(() => fetchRssItems('https://8.8.8.8/feed.rss'), /HTTP 502/);
  } finally {
    restore();
  }
});

test('buildContent uses articleBody when provided', () => {
  const out = buildContent({ title: 'Tiêu đề', link: 'https://x/y', description: 'ignored desc', pubDate: '' }, 'Nội dung bài đầy đủ');
  const parts = out.split('\n\n');
  assert.equal(parts[0], 'Tiêu đề');
  assert.equal(parts[1], 'Nội dung bài đầy đủ');
  assert.equal(parts[2], 'Nguồn: https://x/y');
});

test('buildContent falls back to a <=500-char teaser from description', () => {
  const longDesc = 'z'.repeat(600);
  const out = buildContent({ title: 'T', link: 'https://x/y', description: longDesc, pubDate: '' });
  const parts = out.split('\n\n');
  assert.equal(parts[0], 'T');
  assert.equal(parts[1].length, 500, 'teaser capped at 500');
  assert.equal(parts[2], 'Nguồn: https://x/y');
});

test('buildContent strips HTML from the teaser', () => {
  const out = buildContent({ title: 'T', link: 'L', description: '<p>Hello <b>world</b></p>', pubDate: '' });
  assert.ok(out.includes('Hello world'), out);
  assert.ok(!out.includes('<p>'), 'html stripped');
});

test('fetchArticleBody extracts <p class="Normal|description"> and filters boilerplate', async () => {
  const html = `<html><body>
    <p class="description">Lead paragraph here</p>
    <p class="Normal">Body paragraph one</p>
    <p class="Normal">đóng trang web trên máy tính</p>
    <script>var x=1</script>
  </body></html>`;
  const restore = stubGlobalFetch(async () => new Response(html, { status: 200 }));
  try {
    const body = await fetchArticleBody('https://8.8.8.8/art');
    assert.ok(body);
    assert.ok(body!.includes('Lead paragraph here'));
    assert.ok(body!.includes('Body paragraph one'));
    assert.ok(!body!.includes('đóng trang web trên'), 'boilerplate filtered');
    assert.ok(!body!.includes('var x=1'), 'script stripped');
  } finally {
    restore();
  }
});

test('fetchArticleBody returns null on non-ok response', async () => {
  const restore = stubGlobalFetch(async () => new Response('', { status: 404 }));
  try {
    assert.equal(await fetchArticleBody('https://8.8.8.8/missing'), null);
  } finally {
    restore();
  }
});

test('fetchArticleBody returns null for empty url', async () => {
  assert.equal(await fetchArticleBody(''), null);
});
