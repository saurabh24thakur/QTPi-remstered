// ================================================================
// FILE: src/tools/web/extractor.js
// PURPOSE: Turn raw HTML into clean, readable text + metadata.
//
// Pipeline:
//   1. Load HTML with cheerio.
//   2. Strip noise: <script>, <style>, <noscript>, <nav>, <header>,
//      <footer>, <aside>, <form>, <iframe>, comments, hidden nodes.
//   3. Pick the "main content" container using a readability-style
//      scoring heuristic (text density + paragraph count).
//   4. Extract <title>, meta description, and outbound links.
//   5. Convert the chosen node to plain text (or Markdown via turndown).
//
// No external readability/trafilatura dependency — we implement a
// compact scoring heuristic that works well for docs/blog pages.
// ================================================================

import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

// Tags that never contain article content.
const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas',
  'nav', 'header', 'footer', 'aside', 'form', 'iframe',
  'button', 'input', 'select', 'textarea',
  '[aria-hidden="true"]', '[hidden]', '[role="navigation"]',
  '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
  '.sidebar', '.nav', '.navbar', '.menu', '.footer', '.header',
  '.advertisement', '.ads', '.ad', '.cookie', '.popup', '.modal',
];

// Containers that are likely to hold the main article.
const CANDIDATE_SELECTORS = [
  'article', 'main', '[role="main"]',
  '.post', '.article', '.content', '.entry-content', '.post-content',
  '#content', '#main', '.markdown-body', '.documentation',
];


// ─────────────────────────────────────────────────────────────
// extract(html, { url, format })
// Returns:
//   {
//     title, description, content, links: [{ text, url }],
//     wordCount, truncated
//   }
// format: 'text' (default) | 'markdown'
// ─────────────────────────────────────────────────────────────
export function extract(html, { url = '', format = 'text' } = {}) {
  const $ = cheerio.load(html);

  // ── Metadata (grab before we strip anything) ──
  const title = cleanText(
    $('meta[property="og:title"]').attr('content') ||
    $('title').first().text() ||
    $('h1').first().text()
  );

  const description = cleanText(
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    ''
  );

  // ── Collect outbound links BEFORE stripping nav/footer ──
  const links = collectLinks($, url);

  // ── Strip noise ──
  $(NOISE_SELECTORS.join(',')).remove();
  $('*').contents().filter((_, n) => n.type === 'comment').remove();

  // ── Choose the main content node ──
  const mainNode = pickMainContent($);

  // ── Convert to text / markdown ──
  const content = format === 'markdown'
    ? toMarkdown($, mainNode)
    : toPlainText($, mainNode);

  const wordCount = content ? content.split(/\s+/).filter(Boolean).length : 0;

  return { title, description, content, links, wordCount, truncated: false };
}


// ─────────────────────────────────────────────────────────────
// pickMainContent($)
// Scores candidate containers and returns the best cheerio node.
// Falls back to <body> when nothing scores well.
// ─────────────────────────────────────────────────────────────
function pickMainContent($) {
  let best = null;
  let bestScore = 0;

  for (const selector of CANDIDATE_SELECTORS) {
    $(selector).each((_, el) => {
      const node = $(el);
      const score = scoreNode(node);
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    });
  }

  // Require a minimum score, otherwise the whole body is the content.
  if (best && bestScore >= 20) return best;
  return $('body').length ? $('body') : $.root();
}


// ─────────────────────────────────────────────────────────────
// scoreNode(node)
// Readability-lite: reward paragraph text, penalize link density.
// ─────────────────────────────────────────────────────────────
function scoreNode(node) {
  const text = node.text() || '';
  const textLength = text.replace(/\s+/g, ' ').trim().length;
  if (textLength === 0) return 0;

  const paragraphs = node.find('p').length;
  const linkText = node.find('a').text().replace(/\s+/g, ' ').trim().length;
  const linkDensity = textLength > 0 ? linkText / textLength : 1;

  // Base score from text volume + paragraph structure.
  let score = textLength / 25 + paragraphs * 3;

  // Heavily penalize link farms (navs, indexes).
  score *= (1 - Math.min(linkDensity, 0.9));

  return score;
}


// ─────────────────────────────────────────────────────────────
// toPlainText($, node)
// Collapse the node's text into tidy paragraphs.
// ─────────────────────────────────────────────────────────────
function toPlainText($, node) {
  // Insert newlines around block elements so paragraphs survive.
  node.find('br').replaceWith('\n');
  node.find('p, div, section, li, h1, h2, h3, h4, h5, h6, tr, pre, blockquote')
    .each((_, el) => {
      $(el).append('\n');
    });

  const raw = node.text() || '';
  return raw
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


// ─────────────────────────────────────────────────────────────
// toMarkdown($, node)
// Convert the main node to Markdown (preserves headings, lists,
// code blocks, links) using turndown.
// ─────────────────────────────────────────────────────────────
function toMarkdown($, node) {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });

  // Drop images (noisy in a terminal) but keep their alt text out too.
  turndown.addRule('dropImages', {
    filter: 'img',
    replacement: () => '',
  });

  const html = $.html(node);
  return turndown.turndown(html).replace(/\n{3,}/g, '\n\n').trim();
}


// ─────────────────────────────────────────────────────────────
// collectLinks($, baseUrl)
// Returns absolute, de-duplicated outbound links.
// ─────────────────────────────────────────────────────────────
function collectLinks($, baseUrl) {
  const seen = new Set();
  const links = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = cleanText($(el).text());
    const absolute = toAbsoluteUrl(href, baseUrl);
    if (!absolute || seen.has(absolute)) return;
    seen.add(absolute);
    links.push({ text: text.slice(0, 120), url: absolute });
  });

  return links;
}


// ─────────────────────────────────────────────────────────────
// toAbsoluteUrl(href, baseUrl)
// Resolves relative links; drops non-http(s) schemes.
// ─────────────────────────────────────────────────────────────
export function toAbsoluteUrl(href, baseUrl) {
  if (!href) return null;
  const trimmed = href.trim();
  if (/^(mailto:|tel:|javascript:|#|data:)/i.test(trimmed)) return null;
  try {
    return new URL(trimmed, baseUrl || undefined).toString();
  } catch {
    return null;
  }
}


function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}
