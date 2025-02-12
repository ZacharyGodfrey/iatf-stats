import { parseMetadata, renderMustache, renderMarkdown } from '../lib/render.js';
import { logError, imageToWebp } from '../lib/miscellaneous.js';

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
  console.log('===== Discover Matches');

  try {
    const playerData = await fetchPlayerData(page, profileId);
    const { name, leagues } = playerData;

    db.run(`
      INSERT INTO profiles (profileId, name)
      VALUES (:profileId, :name)
      ON CONFLICT (profileId) DO UPDATE
      SET name = :name
    `, { profileId, name });

    for (const { id: seasonId, seasonWeeks, performanceName, ...season } of leagues) {
      if (performanceName !== RULESET) {
        continue;
      }

      const name = `${season.name.trim()} ${season.shortName.trim()}`;
      const year = parseInt(season.date.split('-')[0]);
      const seasonRank = season.seasonRank || 0;
      const playoffRank = season.playoffRank || 0;

      db.run(`
        INSERT INTO seasons (seasonId, name, year, seasonRank, playoffRank)
        VALUES (:seasonId, :name, :year, :seasonRank, :playoffRank)
        ON CONFLICT (seasonId) DO UPDATE
        SET name = :name, year = :year, seasonRank = :seasonRank, playoffRank = :playoffRank
      `, { seasonId, name, year, seasonRank, playoffRank });

      for (const { week: weekId, matches } of seasonWeeks) {
        for (const { id: matchId } of matches) {
          db.run(`
            INSERT INTO matches (seasonId, weekId, matchId)
            VALUES (:seasonId, :weekId, :matchId)
            ON CONFLICT (matchId) DO UPDATE
            SET weekId = :weekId
          `, { seasonId, weekId, matchId });
        }
      }
    }
  } catch (error) {
    logError(error);
  }

  console.log('Done.');
};

export const processMatches = async (db, page, profileId) => {
  console.log('===== Process Matches');

  console.log('Done.');
};

export const databaseReport = (db) => {
  console.log('===== Database Report');

  console.log('Profiles:');
  console.table(db.rows(`SELECT * FROM profiles`));

  console.log('Seasons:');
  console.table(db.rows(`SELECT * FROM seasons`));

  console.log('Matches:');
  console.table(db.rows(`SELECT * FROM matches`));

  console.log('Throws:');
  console.log(db.row(`SELECT COUNT(*) AS count FROM throws`).count);

  console.log('Done.');
};

export const tearDown = async (start, db, browser) => {
  console.log('===== Tear Down');

  if (browser) {
    await browser.close();
  }

  if (db) {
    db.close();
  }

  if (start) {
    const duration = Math.ceil((Date.now() - start) / 1000);

    console.log(`Total Runtime: ${duration} seconds`);
  }

  console.log('Done.');
};

// Build

export const renderPage = (shell, pageFile, data = {}, partials = {}) => {
  const { meta: page, content: raw } = parseMetadata(pageFile);
  const html = renderMustache(shell, { ...data, page }, { ...partials, content: renderMarkdown(raw) });

  return html;
};