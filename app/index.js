import { logError, imageToWebp, round } from '../lib/miscellaneous.js';
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
    SELECT matchId FROM matches
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
          UPDATE matches SET status = :status
          WHERE matchId = :matchId
        `, { matchId, status: enums.matchStatus.unplayed });

        continue;
      }

      if (match.profile.forfeit) {
        db.run(`
          UPDATE matches SET status = :status
          WHERE matchId = :matchId
        `, { matchId, status: enums.matchStatus.forfeit });

        continue;
      }

      if (match.profile.invalid) {
        db.run(`
          UPDATE matches SET status = :status
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
        UPDATE matches SET status = :status, opponentId = :opponentId, score = :score
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
    SELECT * FROM rounds
    ORDER BY matchId DESC, roundId DESC
    LIMIT 12
  `));

  console.log('Throws Count:');
  console.log(db.row(`SELECT COUNT(*) AS count FROM throws`).count);

  console.log('Last 15 Throws:');
  console.table(db.rows(`
    SELECT * FROM throws
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

function scorePerAxe(score, attempts) {
  return round(3, score / Math.max(1, attempts));
};

function hitPercent(hits, attempts) {
  return round(3, 100 * hits / Math.max(1, attempts));
};

function getStats(throws) {
  const result = {
    overall: {
      attempts: 0,
      totalScore: 0,
      scorePerAxe: 0
    },
    hatchet: {
      overall: {
        attempts: 0,
        totalScore: 0,
        scorePerAxe: 0
      },
      bullseye: {
        attempts: 0,
        totalScore: 0,
        scorePerAxe: 0,
        count: {
          0: 0,
          1: 0,
          3: 0,
          5: 0
        },
        percent: {
          0: 0,
          1: 0,
          3: 0,
          5: 0
        }
      },
      clutch: {
        attempts: 0,
        totalScore: 0,
        scorePerAxe: 0,
        count: {
          0: 0,
          5: 0,
          7: 0
        },
        percent: {
          0: 0,
          5: 0,
          7: 0
        }
      }
    },
    bigAxe: {
      overall: {
        attempts: 0,
        totalScore: 0,
        scorePerAxe: 0
      },
      bullseye: {
        attempts: 0,
        totalScore: 0,
        scorePerAxe: 0,
        count: {
          0: 0,
          1: 0,
          3: 0,
          5: 0
        },
        percent: {
          0: 0,
          1: 0,
          3: 0,
          5: 0
        }
      },
      clutch: {
        attempts: 0,
        totalScore: 0,
        scorePerAxe: 0,
        count: {
          0: 0,
          5: 0,
          7: 0
        },
        percent: {
          0: 0,
          5: 0,
          7: 0
        }
      }
    }
  };

  for (const { tool, target, score } of throws) {
    result.overall.attempts += 1;
    result.overall.totalScore += score;

    if (tool === TOOL_HATCHET) {
      result.hatchet.overall.attempts += 1;
      result.hatchet.overall.totalScore += score;

      if (target === TARGET_BULLSEYE) {
        result.hatchet.bullseye.attempts += 1;
        result.hatchet.bullseye.totalScore += score;
        result.hatchet.bullseye.count[score] += 1;
      } else if (target === TARGET_CLUTCH) {
        result.hatchet.clutch.attempts += 1;
        result.hatchet.clutch.totalScore += score;
        result.hatchet.clutch.count[score] += 1;
      }
    } else if (tool === TOOL_BIG_AXE) {
      result.bigAxe.overall.attempts += 1;
      result.bigAxe.overall.totalScore += score;

      if (target === TARGET_BULLSEYE) {
        result.bigAxe.bullseye.attempts += 1;
        result.bigAxe.bullseye.totalScore += score;
        result.bigAxe.bullseye.count[score] += 1;
      } else if (target === TARGET_CLUTCH) {
        result.bigAxe.clutch.attempts += 1;
        result.bigAxe.clutch.totalScore += score;
        result.bigAxe.clutch.count[score] += 1;
      }
    }
  }

  result.overall.scorePerAxe = scorePerAxe(result.overall.totalScore, result.overall.attempts);
  result.hatchet.overall.scorePerAxe = scorePerAxe(result.hatchet.overall.totalScore, result.hatchet.overall.attempts);
  result.bigAxe.overall.scorePerAxe = scorePerAxe(result.bigAxe.overall.totalScore, result.bigAxe.overall.attempts);

  result.hatchet.bullseye.scorePerAxe = scorePerAxe(result.hatchet.bullseye.totalScore, result.hatchet.bullseye.attempts);
  result.hatchet.bullseye.percent[0] = hitPercent(result.hatchet.bullseye.count[0], result.hatchet.bullseye.attempts);
  result.hatchet.bullseye.percent[1] = hitPercent(result.hatchet.bullseye.count[1], result.hatchet.bullseye.attempts);
  result.hatchet.bullseye.percent[3] = hitPercent(result.hatchet.bullseye.count[3], result.hatchet.bullseye.attempts);
  result.hatchet.bullseye.percent[5] = hitPercent(result.hatchet.bullseye.count[5], result.hatchet.bullseye.attempts);

  result.hatchet.clutch.scorePerAxe = scorePerAxe(result.hatchet.clutch.totalScore, result.hatchet.clutch.attempts);
  result.hatchet.clutch.percent[0] = hitPercent(result.hatchet.clutch.count[0], result.hatchet.clutch.attempts);
  result.hatchet.clutch.percent[5] = hitPercent(result.hatchet.clutch.count[5], result.hatchet.clutch.attempts);
  result.hatchet.clutch.percent[7] = hitPercent(result.hatchet.clutch.count[7], result.hatchet.clutch.attempts);

  result.bigAxe.bullseye.scorePerAxe = scorePerAxe(result.bigAxe.bullseye.totalScore, result.bigAxe.bullseye.attempts);
  result.bigAxe.bullseye.percent[0] = hitPercent(result.bigAxe.bullseye.count[0], result.bigAxe.bullseye.attempts);
  result.bigAxe.bullseye.percent[1] = hitPercent(result.bigAxe.bullseye.count[1], result.bigAxe.bullseye.attempts);
  result.bigAxe.bullseye.percent[3] = hitPercent(result.bigAxe.bullseye.count[3], result.bigAxe.bullseye.attempts);
  result.bigAxe.bullseye.percent[5] = hitPercent(result.bigAxe.bullseye.count[5], result.bigAxe.bullseye.attempts);

  result.bigAxe.clutch.scorePerAxe = scorePerAxe(result.bigAxe.clutch.totalScore, result.bigAxe.clutch.attempts);
  result.bigAxe.clutch.percent[0] = hitPercent(result.bigAxe.clutch.count[0], result.bigAxe.clutch.attempts);
  result.bigAxe.clutch.percent[5] = hitPercent(result.bigAxe.clutch.count[5], result.bigAxe.clutch.attempts);
  result.bigAxe.clutch.percent[7] = hitPercent(result.bigAxe.clutch.count[7], result.bigAxe.clutch.attempts);

  return result;
}

export function getAllData(db) {
  const profiles = db.rows(`
    SELECT * FROM profiles
    ORDER BY name ASC
  `);

  const result = {
    profile: profiles.find(p => p.profileId === PROFILE_ID),
  };

  for (const ruleset of Object.values(enums.ruleset)) {
    const career = result[ruleset] = {
      stats: {},
      seasons: []
    };

    const seasons = db.rows(`
      SELECT * FROM seasons
      WHERE ruleset = :ruleset
    `, { ruleset });

    for (const s of seasons) {
      const season = {
        ...s,
        stats: {},
        weeks: []
      };

      const weeks = db.rows(`
        SELECT DISTINCT weekId FROM matches
        WHERE seasonId = :seasonId
        ORDER BY weekId ASC
      `, { seasonId: s.seasonId });

      for (const { weekId } of weeks) {
        const week = {
          weekId,
          stats: {},
          matches: []
        };

        const matches = db.rows(`
          SELECT * FROM matches
          WHERE status = :status AND seasonId = :seasonId AND weekId = :weekId
          ORDER BY matchID ASC
        `, { status: enums.matchStatus.processed, seasonId: s.seasonId, weekId });

        for (const m of matches) {
          const match = {
            ...m,
            opponentName: profiles[m.opponentId].name,
            stats: {},
            rounds: []
          };

          const rounds = db.rows(`
            SELECT * FROM rounds
            WHERE matchId = :matchId
            ORDER BY roundId ASC
          `, { matchId: m.matchId });

          for (const r of rounds) {
            const round = {
              ...r,
              throws: []
            };

            const throws = db.rows(`
              SELECT * FROM throws
              WHERE matchId = :matchId, roundId = :roundId
              ORDER BY throwId ASC
            `, { matchId: m.matchId, roundId: r.roundId });

            for (const { tool, target, score } of throws) {
              round.throws.push({ tool, target, score});
            }

            match.rounds.push(round);
          }

          match.stats = getStats(match.rounds.flatMap(r => r.throws));

          week.matches.push(match);
        }

        week.stats = getStats(week.matches.flatMap(m => m.rounds.flatMap(r => r.throws)));

        season.weeks.push(week);
      }

      season.stats = getStats(season.weeks.flatMap(w => w.matches.flatMap(m => m.rounds.flatMap(r => r.throws))));

      career.seasons.push(season);
    }

    career.stats = getStats(career.seasons.flatMap(s => s.weeks.flatMap(w => w.matches.flatMap(m => m.rounds.flatMap(r => r.throws)))));
  }

  return result;
};