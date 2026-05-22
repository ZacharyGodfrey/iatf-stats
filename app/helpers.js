import { imageToWebp, round } from '../lib/miscellaneous.js';
import { enums } from '../lib/database.js';
import {
	PROFILE_ID,
	TOOL_HATCHET,
	TOOL_BIG_AXE,
	TARGET_BULLSEYE,
	TARGET_CLUTCH,
	TIMEOUT
} from './constants.js';

export function reactPageState(page) {
	return page.evaluate(() => {
		return document.getElementById('root')
			._reactRootContainer._internalRoot
			.current.memoizedState.element.props
			.store.getState();
	});
}

export function isDesiredResponse(method, status, url) {
	return (response) => {
		const res = {
			method: response.request().method(),
			status: response.status(),
			url: response.url()
		};

		return res.method === method
			&& res.status === status
			&& res.url === url;
	};
}

export async function fetchPlayerData(page, profileId) {
	await page.goto(`https://axescores.com/player/${profileId}`, { waitUntil: 'networkidle2' });
	await page.waitForNetworkIdle();

	const state = await reactPageState(page);

	return state.player.playerData;
}

export async function fetchMatchData(page, profileId, matchId) {
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
}

export async function fetchProfileImage(profileId) {
	console.log(`Fetching image ${profileId}`);

	const response = await fetch(`https://admin.axescores.com/pic/${profileId}`);
	const originalBuffer = await response.arrayBuffer();
	const webpBuffer = await imageToWebp(originalBuffer);

	console.log('Done.');

	return webpBuffer;
}

export function getCareerData(db) {
	const career = {};

	const seasons = db.rows(`
		SELECT * FROM seasons
	`).reduce((map, season) => {
		map[season.seasonId] = season;

		return map;
	}, {});

	const matches = db.rows(`
		SELECT * FROM matches
		WHERE status = '${enums.matchStatus.processed}'
	`).reduce((map, match) => {
		map[match.matchId] = match;

		return map;
	}, {});

	const rounds = db.rows(`
		SELECT r.* FROM rounds AS r
		LEFT JOIN matches AS m ON m.matchId = r.matchId
		WHERE m.status = '${enums.matchStatus.processed}'
	`).reduce((map, round) => {
		map[`${round.matchId}-${round.roundId}`] = round;

		return map;
	}, {});

	const allThrows = db.rows(`
		SELECT s.ruleset, m.seasonId, m.weekId, m.opponentId, t.*
		FROM throws AS t
		LEFT JOIN matches AS m ON m.matchId = t.matchId
		LEFT JOIN seasons AS s ON s.seasonId = m.seasonId
		WHERE m.status = '${enums.matchStatus.processed}'
		AND t.profileId = ${PROFILE_ID}
		ORDER BY m.seasonId, m.weekId, t.matchId, t.roundId, t.throwId
	`);

	for (const t of allThrows) {
		const ruleset = career[t.ruleset] ?? (career[t.ruleset] = {
			throws: [],
			seasons: {}
		});

		ruleset.throws.push(t);

		const season = ruleset.seasons[t.seasonId] ?? (ruleset.seasons[t.seasonId] = {
			...seasons[t.seasonId],
			throws: [],
			weeks: {}
		});

		season.throws.push(t);

		const week = season.weeks[t.weekId] ?? (season.weeks[t.weekId] = {
			throws: [],
			matches: {}
		});

		week.throws.push(t);

		const match = week.matches[t.matchId] ?? (week.matches[t.matchId] = {
			...matches[t.matchId],
			throws: [],
			rounds: {}
		});

		match.throws.push(t);

		const round = match.rounds[t.roundId] ?? (match.rounds[t.roundId] = {
			...rounds[`${t.matchId}-${t.roundId}`],
			throws: []
		});

		round.throws.push(t);
	}

	for (const ruleset of Object.values(career)) {
		ruleset.stats = getStats(ruleset.throws);
		ruleset.seasons = Object.values(ruleset.seasons);

		delete ruleset.throws;

		for (const season of ruleset.seasons) {
			season.stats = getStats(season.throws);
			season.weeks = Object.values(season.weeks);

			delete season.throws;

			for (const week of season.weeks) {
				week.stats = getStats(week.throws);
				week.matches = Object.values(week.matches);

				delete week.throws;

				for (const match of week.matches) {
					match.stats = getStats(match.throws);
					match.rounds = Object.values(match.rounds);

					delete match.throws;
				}
			}
		}
	}

	return {
		profile: db.row(`
			SELECT * FROM profiles
			WHERE profileId = ${PROFILE_ID}
		`),
		...career
	};
}

export function scorePerAxe(score, attempts) {
	return round(3, score / Math.max(1, attempts));
};

export function hitPercent(hits, attempts) {
	return round(3, 100 * hits / Math.max(1, attempts));
};

export function getStats(throws) {
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