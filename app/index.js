import { parseMetadata, renderMustache, renderMarkdown } from '../lib/render.js';
import { imageToWebp } from '../lib/miscellaneous.js';

export const PROFILE_ID = 1207260;

const TOOL_HATCHET = 'hatchet';
const TOOL_BIG_AXE = 'big axe';

const TARGET_BULLSEYE = 'bullseye';
const TARGET_CLUTCH = 'clutch';

const RULESET = 'IATF Premier';
const TIMEOUT = 2000;

// Scrape

const reactPageState = (page) => {
  return page.evaluate(() => {
    return document.getElementById('root')
      ._reactRootContainer._internalRoot
      .current.memoizedState.element.props
      .store.getState();
  });
};

const isDesiredResponse = (method, status, url) => {
  return (response) => {
    return response.request().method() === method
      && response.status() === status
      && response.url() === url;
  };
};

const fetchProfileImage = async (profileId) => {
  const response = await fetch(`https://admin.axescores.com/pic/${profileId}`);
  const originalBuffer = await response.arrayBuffer();
  const webpBuffer = await imageToWebp(originalBuffer);

  return webpBuffer;
};

const fetchPlayerData = async (page, profileId) => {
  await page.goto(`https://axescores.com/player/${profileId}`, { waitUntil: 'networkidle2' });
  await page.waitForNetworkIdle();

  const state = await reactPageState(page);

  return state.player.playerData;
};

export const discoverMatches = async (db, page, profileId) => {
  console.log('|| Discover Matches ||');

  console.log('Done.');
};

export const processMatches = async (db, page, profileId) => {
  console.log('|| Process Matches ||');

  console.log('Done.');
};

export const tearDown = async (start, db, browser) => {
  console.log('|| Tear Down ||');

  if (browser) {
    await browser.close();
  }

  if (db) {
    db.close();
  }

  if (start) {
    const duration = Math.round((Date.now() - start) / 1000);

    console.log(`Total Runtime: ${duration || '<1'} seconds`);
  }

  console.log('Done.');
};

// Build

export const renderPage = (shell, pageFile, data = {}, partials = {}) => {
  const { meta: page, content: raw } = parseMetadata(pageFile);
  const html = renderMustache(shell, { ...data, page }, { ...partials, content: renderMarkdown(raw) });

  return html;
};