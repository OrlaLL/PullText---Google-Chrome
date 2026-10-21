// Injetado na página pelo service worker. Expõe window.__pullText com:
//   extract() -> { markdown, meta, title }
// O texto é convertido para Markdown respeitando a ordem visual: dentro de
// containers flex/grid os itens são ordenados por linha (de cima para baixo)
// e, dentro de cada linha, por coluna (da esquerda para a direita).
(() => {
  if (window.__pullText) return;

  const SKIP = new Set([
    'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title',
    'iframe', 'frame', 'frameset', 'object', 'embed', 'canvas', 'video', 'audio',
    'map', 'input', 'select', 'textarea', 'option', 'datalist', 'svg', 'math', 'source', 'track'
  ]);

  const block = (s) => {
    const t = (s || '').trim();
    return t ? `\n\n${t}\n\n` : '';
  };

  const countNl = (s) => (s.match(/\n/g) || []).length;

  // Concatena partes colapsando espaços/quebras na junção.
  function join(parts) {
    let out = '';
    for (const p of parts) {
      if (!p) continue;
      const a = out.match(/\s+$/);
      const b = p.match(/^\s+/);
      if (a && b) {
        const nl = Math.min(2, Math.max(countNl(a[0]), countNl(b[0])));
        out = out.slice(0, out.length - a[0].length) + (nl ? '\n'.repeat(nl) : ' ') + p.slice(b[0].length);
      } else {
        out += p;
      }
    }
    return out;
  }

  function childNodesOf(el) {
    if (el.shadowRoot) return [...el.shadowRoot.childNodes];
    if (el.localName === 'slot') {
      const assigned = el.assignedNodes({ flatten: true });
      return assigned.length ? assigned : [...el.childNodes];
    }
    return [...el.childNodes];
  }

  function rectOf(node) {
    let r;
    if (node.nodeType === Node.TEXT_NODE) {
      const range = document.createRange();
      range.selectNodeContents(node);
      r = range.getBoundingClientRect();
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      r = node.getBoundingClientRect();
    }
    if (!r || (r.width === 0 && r.height === 0)) return null;
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }

  // Ordena os filhos de um container flex/grid por linhas e depois colunas.
  function visualOrder(nodes, rtl) {
    const items = nodes
      .filter((n) => !(n.nodeType === Node.TEXT_NODE && !n.data.trim()))
      .map((n, i) => ({ n, i, r: rectOf(n) }));
    let last = { top: -1e9, bottom: -1e9, left: -1e9, right: -1e9 };
    for (const it of items) {
      if (it.r) last = it.r;
      else it.r = last; // sem caixa própria: acompanha o item anterior
    }
    const sorted = [...items].sort((a, b) => a.r.top - b.r.top || a.i - b.i);
    const rows = [];
    for (const it of sorted) {
      const row = rows[rows.length - 1];
      if (row && it.r.top < row.bottom - 1) {
        row.items.push(it);
        row.bottom = Math.max(row.bottom, it.r.bottom);
      } else {
        rows.push({ items: [it], bottom: Math.max(it.r.bottom, it.r.top + 1) });
      }
    }
    const out = [];
    for (const row of rows) {
      row.items.sort((a, b) =>
        (rtl ? b.r.right - a.r.right : a.r.left - b.r.left) || a.r.top - b.r.top || a.i - b.i
      );
      for (const it of row.items) out.push(it.n);
    }
    return out;
  }

  function isRendered(el, cs) {
    if (cs.display === 'none') return false;
    if (cs.display === 'contents') return true;
    if (el.checkVisibility && !el.checkVisibility()) return false; // sem caixa (ex.: <details> fechado)
    const r = el.getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1) {
      // Texto "somente leitor de tela" (sr-only) e similares
      if (cs.overflow !== 'visible' || cs.clip !== 'auto' || cs.clipPath !== 'none') return false;
    }
    if (r.width > 0 || r.height > 0) {
      const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
      const left = r.left + window.scrollX;
      const right = r.right + window.scrollX;
      const bottom = r.bottom + window.scrollY;
      if (right <= 0 || left >= docW || bottom <= 0) return false; // fora da tela
    }
    return true;
  }

  const isInlineDisplay = (d) => d.startsWith('inline') || d === 'contents' || d.startsWith('ruby');

  function convertChildren(el, ctx, cs) {
    let nodes = childNodesOf(el);
    if (cs && /(flex|grid)/.test(cs.display) && !ctx.pre) {
      nodes = visualOrder(nodes, cs.direction === 'rtl');
    }
    return join(nodes.map((n) => convertNode(n, ctx)));
  }

  function wrapInline(inner, mark) {
    const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!m[2] || m[2].includes('\n')) return inner;
    return `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
  }

  const cleanUrl = (u) => u.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');

  function convertList(el, ctx, cs) {
    const ordered = el.localName === 'ol';
    let n = ordered ? parseInt(el.getAttribute('start'), 10) || 1 : 0;
    const lines = [];
    let nodes = childNodesOf(el);
    if (/(flex|grid)/.test(cs.display)) nodes = visualOrder(nodes, cs.direction === 'rtl');
    for (const child of nodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.localName === 'li') {
        const ccs = getComputedStyle(child);
        if (!isRendered(child, ccs)) continue;
        const content = convertChildren(child, ctx, ccs).trim().replace(/\n{2,}/g, '\n');
        if (!content) continue;
        const marker = ordered ? `${n++}. ` : '- ';
        const [first, ...rest] = content.split('\n');
        lines.push(marker + first + rest.map((l) => '\n' + (l ? ' '.repeat(marker.length) + l : '')).join(''));
      } else {
        const t = convertNode(child, ctx).trim();
        if (t) lines.push(t);
      }
    }
    return block(lines.join('\n'));
  }

  function convertTable(el, ctx, cs) {
    const rows = [...el.rows].filter((r) => isRendered(r, getComputedStyle(r)));
    if (!rows.length) return '';
    const isLayout =
      el.querySelector('table') ||
      el.getAttribute('role') === 'presentation' ||
      rows.every((r) => r.cells.length <= 1);
    if (isLayout) return block(convertChildren(el, ctx, cs));

    const grid = rows.map((r) => {
      const cells = [];
      for (const c of r.cells) {
        const ccs = getComputedStyle(c);
        if (ccs.display === 'none') continue;
        const txt = convertChildren(c, { ...ctx, inTable: true }, ccs)
          .trim()
          .replace(/\s*\n+\s*/g, '<br>')
          .replace(/\|/g, '\\|');
        cells.push(txt);
        for (let k = 1; k < (c.colSpan || 1); k++) cells.push('');
      }
      return cells;
    });
    const cols = Math.max(...grid.map((r) => r.length));
    if (!cols) return '';
    for (const r of grid) while (r.length < cols) r.push('');
    const line = (cells) => `| ${cells.join(' | ')} |`;
    const out = [line(grid[0]), line(new Array(cols).fill('---')), ...grid.slice(1).map(line)];
    let caption = '';
    if (el.caption) caption = el.caption.innerText.trim();
    return block((caption ? `**${caption}**\n\n` : '') + out.join('\n'));
  }

  function convertNode(node, ctx) {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement || (node.parentNode && node.parentNode.host);
      if (parent && getComputedStyle(parent).visibility !== 'visible') return '';
      if (ctx.pre) return node.data;
      return node.data.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node;
    const tag = el.localName;
    if (SKIP.has(tag)) return '';
    const cs = getComputedStyle(el);
    if (!isRendered(el, cs)) return '';

    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const text = convertChildren(el, ctx, cs).replace(/\s*\n+\s*/g, ' ').trim();
        if (!text) return '';
        if (ctx.inTable) return `**${text}**`;
        return block('#'.repeat(Number(tag[1])) + ' ' + text);
      }
      case 'br':
        return '\n';
      case 'hr':
        return block('---');
      case 'a': {
        const inner = convertChildren(el, { ...ctx, inLink: true }, cs);
        const href = el.getAttribute('href');
        if (!inner.trim()) return '';
        if (!href || ctx.inLink || href.startsWith('#') || /^javascript:/i.test(href)) return inner;
        const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
        if (m[2].includes('\n')) return inner;
        return `${m[1]}[${m[2]}](${cleanUrl(el.href)})${m[3]}`;
      }
      case 'img': {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return '';
        const alt = (el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
        const src = el.currentSrc || el.src;
        if (!src || src.startsWith('data:')) return alt ? ` ${alt} ` : '';
        return ` ![${alt.replace(/[[\]]/g, '')}](${cleanUrl(src)}) `;
      }
      case 'strong': case 'b':
        return wrapInline(convertChildren(el, ctx, cs), '**');
      case 'em': case 'i': case 'cite':
        return wrapInline(convertChildren(el, ctx, cs), '*');
      case 'del': case 's': case 'strike':
        return wrapInline(convertChildren(el, ctx, cs), '~~');
      case 'code':
      case 'kbd':
        if (ctx.pre) return el.textContent;
        return wrapInline(el.textContent.replace(/\s+/g, ' '), '`');
      case 'pre': {
        const text = el.innerText.replace(/\n+$/, '');
        if (!text.trim()) return '';
        if (ctx.inTable) return '`' + text.replace(/\s+/g, ' ') + '`';
        const i = ctx.code.push('```\n' + text + '\n```') - 1;
        return block(`\u0000CODE${i}\u0000`);
      }
      case 'ul': case 'ol':
        return convertList(el, ctx, cs);
      case 'li': // li fora de lista
        return block('- ' + convertChildren(el, ctx, cs).trim());
      case 'blockquote': {
        const inner = convertChildren(el, ctx, cs).trim().replace(/\n{3,}/g, '\n\n');
        if (!inner) return '';
        return block(inner.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n'));
      }
      case 'table':
        return convertTable(el, ctx, cs);
      case 'dt':
        return block(wrapInline(convertChildren(el, ctx, cs).trim(), '**'));
      default: {
        const inner = convertChildren(el, ctx, cs);
        if (isInlineDisplay(cs.display)) {
          // inline-block/inline-flex lado a lado precisam de separação
          return cs.display === 'inline' || cs.display === 'contents' ? inner : ` ${inner} `;
        }
        return block(inner);
      }
    }
  }

  function toMarkdown() {
    const ctx = { pre: false, inLink: false, inTable: false, code: [] };
    const root = document.body || document.documentElement;
    let md = convertChildren(root, ctx, getComputedStyle(root));
    md = md
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    md = md.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => ctx.code[Number(i)]);
    return md;
  }

  function extractMeta() {
    const attrs = (el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
    const metaTags = [...document.querySelectorAll('meta')].map(attrs);

    const byKey = {};
    for (const m of metaTags) {
      const key = m.name || m.property || m['http-equiv'] || m.itemprop;
      if (!key || !('content' in m)) continue;
      if (key in byKey) byKey[key] = [].concat(byKey[key], m.content);
      else byKey[key] = m.content;
    }

    const skipRel = /^(stylesheet|preload|prefetch|modulepreload|dns-prefetch|preconnect|prerender)$/i;
    const links = [...document.querySelectorAll('link[rel]')]
      .filter((l) => !l.rel.split(/\s+/).filter(Boolean).every((r) => skipRel.test(r)))
      .map((l) => ({ ...attrs(l), href: l.href }));

    const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => {
      try { return JSON.parse(s.textContent); } catch { return s.textContent.trim(); }
    });

    const pick = (...keys) => {
      for (const k of keys) if (byKey[k] != null) return byKey[k];
      return null;
    };
    const canonical = document.querySelector('link[rel~="canonical"]');
    const prefixed = (prefix) =>
      Object.fromEntries(Object.entries(byKey).filter(([k]) => k.toLowerCase().startsWith(prefix)));

    return {
      url: location.href,
      title: document.title,
      lang: document.documentElement.lang || null,
      charset: document.characterSet,
      summary: {
        description: pick('description'),
        keywords: pick('keywords'),
        robots: pick('robots'),
        viewport: pick('viewport'),
        author: pick('author'),
        generator: pick('generator'),
        theme_color: pick('theme-color'),
        canonical: canonical ? canonical.href : null,
        open_graph: prefixed('og:'),
        twitter: prefixed('twitter:')
      },
      meta_tags: metaTags,
      links,
      json_ld: jsonLd
    };
  }

  window.__pullText = {
    extract() {
      return { markdown: toMarkdown(), meta: extractMeta(), title: document.title };
    }
  };
})();
