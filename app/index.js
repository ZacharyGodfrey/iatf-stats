import { parseMetadata, renderMustache, renderMarkdown } from '../lib/render.js';

export const PROFILE_ID = 1207260;

export const renderPage = (shell, pageFile, data = {}, partials = {}) => {
  const { meta: page, content: raw } = parseMetadata(pageFile);
  const html = renderMustache(shell, { ...data, page }, { ...partials, content: renderMarkdown(raw) });

  return html;
};

export const tearDown = async (start, db, browser) => {
  if (browser) {
    await browser.close();
  }

  if (db) {
    db.close();
  }

  if (start) {
    const duration = Math.round((Date.now() - start) / 1000);

    console.log(`Total Runtime: ${duration} seconds`);
  }
};