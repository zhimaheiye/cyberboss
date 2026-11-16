import React from 'react';

export function safeHref(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) return '';
  try {
    const url = new URL(value, 'http://localhost/');
    if (['http:', 'https:', 'mailto:'].includes(url.protocol)) return value;
    if (url.protocol === 'obsidian:' && url.hostname.toLowerCase() === 'open' && !url.username && !url.password && !url.port
      && ['', '/'].includes(url.pathname) && [...url.searchParams.keys()].every(key => ['vault', 'file', 'path', 'paneType'].includes(key))) return value;
  } catch { /* Unrecognized paths remain plain text. */ }
  return '';
}
export function WorkspaceLink({ href, children, ...props }) {
  const safe = safeHref(href), local = /^obsidian:/i.test(safe);
  return safe ? <a {...props} href={safe} target={local ? undefined : '_blank'} rel="noreferrer noopener">{children}</a> : <span>{children}</span>;
}
function pieces(text) {
  const pattern = /(?:obsidian:\/\/open\?|https?:\/\/)[^\s<>"'`\[\]()，。；！？）】》]+/gi;
  const parts = []; let offset = 0;
  for (const match of String(text).matchAll(pattern)) {
    if (!safeHref(match[0])) continue;
    parts.push({ text: text.slice(offset, match.index) });
    const url = new URL(match[0]);
    const file = url.protocol === 'obsidian:' ? url.searchParams.get('file') || url.searchParams.get('path') : null;
    parts.push({ text: file ? `在 Obsidian 中打开「${file}」` : match[0], href: match[0] });
    offset = match.index + match[0].length;
  }
  parts.push({ text: text.slice(offset) }); return parts;
}
export function LinkText({ text = '' }) {
  return pieces(text).map((part, index) => part.href ? <WorkspaceLink key={index} href={part.href} title={part.href}>{part.text}</WorkspaceLink> : <React.Fragment key={index}>{part.text}</React.Fragment>);
}
// Add bare URI links to Markdown, leaving code and existing links unchanged.
export function remarkWorkspaceLinks() {
  return tree => {
    const visit = node => {
      if (['link', 'image', 'code', 'inlineCode', 'html'].includes(node.type) || !node.children) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text') { visit(child); return [child]; }
        return pieces(child.value).filter(part => part.text).map(part => part.href
          ? { type: 'link', url: part.href, children: [{ type: 'text', value: part.text }] }
          : { type: 'text', value: part.text });
      });
    };
    visit(tree);
  };
}
