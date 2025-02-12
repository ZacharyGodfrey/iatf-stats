import { parseMetadata, renderMustache, renderMarkdown } from '../lib/render.js';
import { logError, imageToWebp } from '../lib/miscellaneous.js';
import { matchStatus } from '../lib/database.js';

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

const fetchPlayerData = async (page, profileId) => {
  await page.goto(`https://axescores.com/player/${profileId}`, { waitUntil: 'networkidle2' });
  await page.waitForNetworkIdle();

  const state = await reactPageState(page);

  return state.player.playerData;
};

const fetchMatchData = async (page, profileId, matchId) => {
  const url = `https://axescores.com/player/${profileId}/${matchId}`;
  const apiUrl = `https://api.axescores.com/match/${matchId}/${profileId}`;

  const [apiResponse] = await Promise.all([
    page.waitForResponse(isDesiredResponse('GET', 200, apiUrl), { timeout: TIMEOUT }),
    page.goto(url)
  ]);

  const rawMatch = await apiResponse.json();
  const players = rawMatch.players.map(({ id, name, forfeit }) => ({
    profileId: id,
    name,
    forfeit,
    invalid: false,
    throws: []
  }));

  const result = {
    unplayed: players.length === 0,
    forfeit: players.some(x => x.forfeit),
    profile: players.find(x => x.profileId === profileId) || null,
    opponent: players.find(x => x.profileId !== profileId) || null,
  };

  if (result.unplayed || result.forfeit) {
    return result;
  }

  for (const player of players.filter(x => !x.forfeit)) {
    const rounds = rawMatch.rounds.flatMap(x => x.games).filter(x => x.player === player.profileId);
    const invalidRoundCount = ![3, 4].includes(rounds.length);
    const invalidThrowCount = rounds.slice(0, 3).some(x => x.Axes.length !== 5);

    if (invalidRoundCount || invalidThrowCount) {
      player.invalid = true;
      continue;
    }

    for (const { order: roundId, Axes } of rounds) {
      for (const { order: throwId, score, clutchCalled } of Axes) {
        player.throws.push({
          matchId,
          roundId,
          throwId,
          tool: roundId === 4 ? TOOL_BIG_AXE : TOOL_HATCHET,
          target: clutchCalled ? TARGET_CLUTCH : TARGET_BULLSEYE,
          score
        });
      }
    }
  }

  return result;
};

export const fetchProfileImage = async (profileId) => {
  console.log(`===== Fetch Image ${profileId}`);

  const response = await fetch(`https://admin.axescores.com/pic/${profileId}`);
  const originalBuffer = await response.arrayBuffer();
  const webpBuffer = await imageToWebp(originalBuffer);

  console.log('Done.');

  return webpBuffer;
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

  const newMatches = db.rows(`
    SELECT matchId
    FROM matches
    WHERE status = ${matchStatus.new}
  `);

  console.log(`Found ${newMatches.length} new matches.`);

  let progress = 0;

  for (const { matchId } of newMatches) {
    progress++;

    console.log(`Processing match ${matchId} (${progress} / ${newMatches.length})...`);

    let match = null;

    try {
      match = await fetchMatchData(page, profileId, matchId);

      if (match.unplayed) {
        db.run(`
          UPDATE matches
          SET status = :status
          WHERE matchId = :matchId
        `, { matchId, status: matchStatus.unplayed });

        continue;
      }

      if (match.forfeit) {
        db.run(`
          UPDATE matches
          SET status = :status
          WHERE matchId = :matchId
        `, { matchId, status: match.profile.forfeit ? matchStatus.forfeit : matchStatus.invalid });

        continue;
      }

      db.run(`
        UPDATE matches
        SET opponentId = :opponentId
        WHERE matchId = :matchId
      `, { matchId, opponentId: match.opponent.profileId });

      db.run(`
        INSERT INTO profiles (profileId, name)
        VALUES (:profileId, :name)
        ON CONFLICT (profileId) DO UPDATE
        SET name = :name
      `, match.opponent);

      if (match.profile.invalid) {
        db.run(`
          UPDATE matches
          SET status = :status
          WHERE matchId = :matchId
        `, { matchId, status: matchStatus.invalid });

        continue;
      }

      for (const row of match.profile.throws) {
        db.run(`
          INSERT INTO throws (matchId, roundId, throwId, tool, target, score)
          VALUES (:matchId, :roundId, :throwId, :tool, :target, :score)
          ON CONFLICT (matchId, roundId, throwId) DO UPDATE
          SET tool = :tool, target = :target, score = :score
        `, row);
      }
    } catch (error) {
      logError(error, { match });
    }
  }

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

  console.log('Throws Count:');
  console.log(db.row(`SELECT COUNT(*) AS count FROM throws`).count);

  console.log('Last 15 Throws:');
  console.table(db.rows(`
    SELECT *
    FROM throws
    ORDER BY matchId DESC, roundId DESC, throwId DESC
    LIMIT 15
  `));

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