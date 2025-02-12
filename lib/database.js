import Database from 'better-sqlite3';

import { createFolder } from './file.js';

export const outcome = {
  win: 'w',
  loss: 'l',
  tie: 't',
  otl: 'otl',
  tbd: 'tbd'
};

export const matchStatus = {
  new: 0, // discovered, not analyzed yet
  unplayed: 1, // no throw data available yet
  invalid: 2, // incorrect throw count, may be fixed in the future
  processed: 3, // successfully analyzed
};

export const database = (options = {}) => {
  createFolder('data');

  const db = new Database('data/database.db', options);

  db.pragma('journal_mode = WAL');

  db.prepare(`CREATE TABLE IF NOT EXISTS profiles (
    profileId INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT 'Unknown',

    PRIMARY KEY (profileId)
  ) WITHOUT ROWID;`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS seasons (
    seasonId INTEGER NOT NULL,
    name TEXT NOT NULL,
    year INTEGER NOT NULL DEFAULT 0,
    seasonRank INTEGER NOT NULL DEFAULT 0,
    playoffRank INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (seasonId)
  ) WITHOUT ROWID;`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS matches (
    seasonId INTEGER NOT NULL,
    weekId INTEGER NOT NULL,
    matchId INTEGER NOT NULL,
    opponentId INTEGER NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL DEFAULT '${outcome.tbd}',
    status INTEGER NOT NULL DEFAULT ${matchStatus.new},

    PRIMARY KEY (matchId)
  ) WITHOUT ROWID;`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS throws (
    matchId INTEGER NOT NULL,
    roundId INTEGER NOT NULL,
    throwId INTEGER NOT NULL,
    tool TEXT NOT NULL,
    target TEXT NOT NULL,
    score INTEGER NOT NULL,

    PRIMARY KEY (matchId, roundId, throwId)
  ) WITHOUT ROWID;`).run();

  return {
    run: (sql, params = []) => db.prepare(sql).run(params),
    row: (sql, params = []) => db.prepare(sql).get(params),
    rows: (sql, params = []) => db.prepare(sql).all(params),
    close: () => {
      db.prepare('VACUUM').run();
      db.close();
    }
  };
};