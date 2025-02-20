import { logError, imageToWebp } from '../lib/miscellaneous.js';
import { enums } from '../lib/database.js';

export const PROFILE_ID = 1207260;

const TOOL_HATCHET = 'hatchet';
const TOOL_BIG_AXE = 'big axe';

const TARGET_BULLSEYE = 'bullseye';
const TARGET_CLUTCH = 'clutch';

const TIMEOUT = 2000;

// Helpers

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
  const players = rawMatch.players.map(({ id, name, forfeit, score }) => ({
    profileId: id,
    name,
    forfeit,
    invalid: false,
    score,
    rounds: [],
    throws: []
  }));

  const result = {
    unplayed: players.length === 0,
    profile: players.find(x => x.profileId === profileId) || null,
    opponent: players.find(x => x.profileId !== profileId) || null,
  };

  if (result.unplayed) {
    return result;
  }

  for (const player of players) {
    if (player.forfeit) {
      continue;
    }

    const hatchetRounds = rawMatch.rounds
      .filter(x => x.name !== 'Tie Break')
      .flatMap(x => x.games)
      .filter(x => x.player === player.profileId);

    const bigAxeRounds = rawMatch.rounds
      .filter(x => x.name === 'Tie Break')
      .flatMap(x => x.games)
      .filter(x => x.player === player.profileId);

    const invalidThrowCount = hatchetRounds.some(x => x.Axes.length !== 5);

    if (hatchetRounds.length !== 3 || bigAxeRounds.length > 1 || invalidThrowCount) {
      player.invalid = true;

      continue;
    }

    for (const { order: roundId, Axes } of hatchetRounds.concat(bigAxeRounds)) {
      player.rounds.push({
        roundId,
        outcome: '',
        score: Axes.reduce((total, { score }) => total + score, 0)
      });

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

  result.profile.rounds.forEach((round, i) => {
    const opponentScore = (result.opponent.rounds[i] || { score: 0 }).score;

    switch (true) {
      case round.score > opponentScore: round.outcome = enums.outcome.win; break;
      case round.score === opponentScore: round.outcome = enums.outcome.tie; break;
      case round.score < opponentScore: round.outcome = enums.outcome.loss; break;
    }
  });

  return result;
};

// Scrape

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

  let seasonCount = 0, matchCount = 0;

  try {
    const playerData = await fetchPlayerData(page, profileId);
    const { name, leagues } = playerData;

    db.run(`
      INSERT INTO profiles (profileId, name)
      VALUES (:profileId, :name)
      ON CONFLICT (profileId) DO UPDATE
      SET name = :name
    `, { profileId, name });

    for (const { id: seasonId, seasonWeeks, ...season } of leagues) {
      db.run(`
        INSERT INTO seasons (seasonId, year, ruleset, name, seasonRank, playoffRank)
        VALUES (:seasonId, :year, :ruleset, :name, :seasonRank, :playoffRank)
        ON CONFLICT (seasonId) DO UPDATE
        SET year = :year, ruleset = :ruleset, name = :name, seasonRank = :seasonRank, playoffRank = :playoffRank
      `, {
        seasonId,
        year: parseInt(season.date.split('-')[0]),
        ruleset: {
          'IATF Standard': enums.ruleset.standard,
          'IATF Premier': enums.ruleset.premier,
        }[season.performanceName] || enums.ruleset.unknown,
        name: `${season.name.trim()} ${season.shortName.trim()}`,
        seasonRank: season.seasonRank || 0,
        playoffRank: season.playoffRank || 0
      });

      seasonCount++;

      for (const { week: weekId, matches } of seasonWeeks) {
        for (const { id: matchId, result } of matches) {
          const outcome = {
            'F': enums.outcome.forfeit,
            'L': enums.outcome.loss,
            'OTL': enums.outcome.otl,
            'W': enums.outcome.win,
          }[result] || enums.outcome.tbd;

          db.run(`
            INSERT INTO matches (seasonId, weekId, matchId, outcome)
            VALUES (:seasonId, :weekId, :matchId, :outcome)
            ON CONFLICT (matchId) DO UPDATE
            SET weekId = :weekId, outcome = :outcome
          `, { seasonId, weekId, matchId, outcome });

          matchCount++;
        }
      }
    }
  } catch (error) {
    logError(error);
  }

  console.log(`Discovered ${matchCount} matches from ${seasonCount} seasons.`);

  console.log('Done.');
};

export const processMatches = async (db, page, profileId) => {
  console.log('===== Process Matches');

  const newMatches = db.rows(`
    SELECT matchId
    FROM matches
    WHERE status IN (:new, :unplayed)
  `, enums.matchStatus);

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
        `, { matchId, status: enums.matchStatus.unplayed });

        continue;
      }

      if (match.profile.forfeit) {
        db.run(`
          UPDATE matches
          SET status = :status
          WHERE matchId = :matchId
        `, { matchId, status: enums.matchStatus.forfeit });

        continue;
      }

      if (match.profile.invalid) {
        db.run(`
          UPDATE matches
          SET status = :status
          WHERE matchId = :matchId
        `, { matchId, status: enums.matchStatus.invalid });

        continue;
      }

      for (const { roundId, outcome, score } of match.profile.rounds) {
        db.run(`
          INSERT INTO rounds (matchId, roundId, outcome, score)
          VALUES (:matchId, :roundId, :outcome, :score)
          ON CONFLICT (matchId, roundId) DO UPDATE
          SET outcome = :outcome, score = :score
        `, { matchId, roundId, outcome, score });
      }

      for (const row of match.profile.throws) {
        db.run(`
          INSERT INTO throws (matchId, roundId, throwId, tool, target, score)
          VALUES (:matchId, :roundId, :throwId, :tool, :target, :score)
          ON CONFLICT (matchId, roundId, throwId) DO UPDATE
          SET tool = :tool, target = :target, score = :score
        `, row);
      }

      db.run(`
        UPDATE matches
        SET status = :status, opponentId = :opponentId, score = :score
        WHERE matchId = :matchId
      `, {
        matchId,
        status: enums.matchStatus.processed,
        opponentId: match.opponent.profileId,
        score: match.profile.score
      });

      db.run(`
        INSERT INTO profiles (profileId, name)
        VALUES (:profileId, :name)
        ON CONFLICT (profileId) DO UPDATE
        SET name = :name
      `, match.opponent);
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

  console.log('Rounds Count:');
  console.log(db.row(`SELECT COUNT(*) AS count FROM rounds`).count);

  console.log('Last 12 Rounds:');
  console.table(db.rows(`
    SELECT *
    FROM rounds
    ORDER BY matchId DESC, roundId DESC
    LIMIT 12
  `));

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

export const getAllData = (db) => {
  const result = {
    profile: {
      id: PROFILE_ID
    }
  };

  return result;
};