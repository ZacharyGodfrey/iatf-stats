import { logError, imageToWebp, round, sum } from '../lib/miscellaneous.js';
import { enums } from '../lib/database.js';
import { writeFile } from '../lib/file.js';
import {
	PROFILE_ID,
	TOOL_HATCHET,
	TOOL_BIG_AXE,
	TARGET_BULLSEYE,
	TARGET_CLUTCH,
	TIMEOUT
} from './constants.js';
import {
	reactPageState,
	isDesiredResponse,
	fetchPlayerData,
	fetchMatchData,
	fetchProfileImage,
	getCareerData
} from './helpers.js';

export async function updateProfileImages(db) {
	const profiles = db.rows(`SELECT profileId FROM profiles`);

	for (const { profileId } of profiles) {
		await fetchProfileImage(profileId).then((image) => {
			writeFile(`client/public/images/${profileId}.webp`, image, null);
		}).catch((error) => {
			logError(error, { profileId });
		});
	}
}

export async function discoverMatches(db, page, profileId) {
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
}

export async function processMatches(db, page, profileId) {
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
					INSERT INTO throws (profileId, matchId, roundId, throwId, tool, target, score)
					VALUES (:profileId, :matchId, :roundId, :throwId, :tool, :target, :score)
					ON CONFLICT (profileId, matchId, roundId, throwId) DO UPDATE
					SET tool = :tool, target = :target, score = :score
				`, { ...row, profileId: match.profile.profileId });
			}

			for (const row of match.opponent.throws) {
				db.run(`
					INSERT INTO throws (profileId, matchId, roundId, throwId, tool, target, score)
					VALUES (:profileId, :matchId, :roundId, :throwId, :tool, :target, :score)
					ON CONFLICT (profileId, matchId, roundId, throwId) DO UPDATE
					SET tool = :tool, target = :target, score = :score
				`, { ...row, profileId: match.opponent.profileId });
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
}

export function exportFlattenedMatches(db) {
	const profiles = db.rows(`
		SELECT * FROM profiles
	`).reduce((map, profile) => {
		map[profile.profileId] = profile;

		return map;
	}, {});

	const seasons = db.rows(`
		SELECT * FROM seasons
	`).reduce((map, season) => {
		map[season.seasonId] = season;

		return map;
	}, {});

	const matches = db.rows(`
		SELECT * FROM matches
		WHERE status = '${enums.matchStatus.processed}'
	`);

	const result = [];

	const outcomes = {
		[enums.outcome.win]: 'Win',
		[enums.outcome.loss]: 'Loss',
	};

	for (const match of matches) {
		try {
			const { seasonId, weekId, matchId, opponentId, score, outcome } = match;
			const { year, ruleset, seasonRank, playoffRank, name: seasonName } = seasons[seasonId];
			const { name: opponentName } = profiles[opponentId];

			const rounds = db.rows(`
				SELECT * FROM rounds
				WHERE matchId = ${matchId}
			`);

			const throws = db.rows(`
				SELECT * FROM throws
				WHERE profileId = ${PROFILE_ID}
				AND matchId = ${matchId}
				ORDER BY roundId ASC, throwId ASC
			`);

			const opponentThrows = db.rows(`
				SELECT * FROM throws
				WHERE profileId = ${opponentId}
				AND matchId = ${matchId}
				ORDER BY roundId ASC, throwId ASC
			`);

			result.push({
				ruleset,
				year,
				seasonId,
				seasonName,
				seasonRank,
				playoffRank,
				weekId,
				matchId,
				opponentId,
				opponentName,
				overtime: throws.some(x => x.tool === TOOL_BIG_AXE),
				outcome: outcomes[outcome] ?? outcome,
				roundOutcomes: rounds.map(x => x.outcome),
				total: score,
				roundTotals: rounds.map(x => x.score),
				throws: throws.map(x => x.score),
				opponentTotal: sum(opponentThrows.map(x => x.score).slice(0, 15)),
				opponentRoundTotals: rounds.map(x => sum(opponentThrows.filter(y => y.roundId === x.roundId).map(y => y.score))),
				opponentThrows: opponentThrows.map(x => x.score),
			});
		} catch (error) {
			logError(error, { match })
		}
	}

	writeFile('client/public/matches.json', JSON.stringify(result, null, 2));
}

export function exportCareerData(db) {
	const career = getCareerData(db);

	writeFile('client/public/career.json', JSON.stringify(career, null, 2));
}

export function databaseReport(db) {
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

	console.log('My Throws Count:');
	console.log(db.row(`SELECT COUNT(*) AS count FROM throws WHERE profileId = ?`, [PROFILE_ID]).count);

	console.log('Opponents Throws Count:');
	console.log(db.row(`SELECT COUNT(*) AS count FROM throws WHERE profileId != ?`, [PROFILE_ID]).count);

	console.log('Last 15 Throws:');
	console.table(db.rows(`
		SELECT * FROM throws
		ORDER BY matchId DESC, roundId DESC, throwId DESC
		LIMIT 15
	`));

	console.log('Done.');
}

export async function tearDown(start, db, browser) {
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
}