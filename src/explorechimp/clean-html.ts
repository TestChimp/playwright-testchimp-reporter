/**
 * DOM snapshot reduction for ExploreChimp uploads — aligned with scriptservice {@code utils/html-utils.ts} {@code cleanHtml}.
 * Strips scripts/styles, prunes hidden/empty nodes, keeps a small allowlist of attributes, then truncates.
 */

import * as cheerio from 'cheerio';
import type { AnyNode, Element, Text as TextNode } from 'domhandler';

export function cleanHtml(rawHtml: string, maxLength = 50000): string {
  if (!rawHtml) return '';

  const $ = cheerio.load(rawHtml);

  $('script, style, meta, link, svg, canvas, noscript').remove();

  const allowedAttributes = new Set([
    'data-synthetic-id',
    'role',
    'type',
    'placeholder',
    'checked',
    'disabled',
    'aria-label',
    'aria-describedby',
    'aria-hidden',
    'value',
    'tabindex',
  ]);

  function isElementVisible($el: cheerio.Cheerio<Element>): boolean {
    return (
      $el.attr('aria-hidden') !== 'true' &&
      $el.css('display') !== 'none' &&
      $el.css('visibility') !== 'hidden'
    );
  }

  function computeEffectiveVisibility($el: cheerio.Cheerio<Element>): boolean {
    let current: cheerio.Cheerio<Element> | null = $el;
    while (current?.length) {
      if (!isElementVisible(current)) return false;
      current = current.parent() as cheerio.Cheerio<Element> | null;
    }
    return true;
  }

  function isInteractable(el: Element): boolean {
    const tag = el.name.toLowerCase();
    const interactiveTags = ['button', 'input', 'select', 'textarea', 'a'];
    return interactiveTags.includes(tag) || $(el).attr('tabindex') !== undefined;
  }

  $('*').each((_: number, raw: AnyNode) => {
    if (raw.type !== 'tag') return;
    const el = raw as Element;
    const $el = $(el);

    const visible = computeEffectiveVisibility($el);
    if (!visible) {
      $el.remove();
      return;
    }

    $el.attr('data-visible', 'true');
    $el.attr('data-interactable', isInteractable(el) ? 'true' : 'false');

    Object.keys($el.attr() || {}).forEach((attr) => {
      if (!allowedAttributes.has(attr)) {
        $el.removeAttr(attr);
      }
    });

    $el.contents().each((__: number, child: AnyNode) => {
      if (child.type === 'text') {
        const textNode = child as TextNode;
        if (textNode.data) {
          textNode.data = textNode.data.trim().slice(0, 80);
        }
      }
    });

    const tag = el.name.toLowerCase();
    if (tag === 'img' || tag === 'video') {
      $el.removeAttr('src');
    }

    if (!$el.attr('data-synthetic-id') && !$el.text().trim() && !isInteractable(el)) {
      $el.remove();
    }
  });

  let cleanedHTML = $('body').html()?.trim() || '';

  return cleanedHTML.length > maxLength
    ? cleanedHTML.slice(0, maxLength).replace(/<\/?[^>]*$/g, '')
    : cleanedHTML;
}
