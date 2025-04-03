import { database } from '../lib/database.js';
import { launchBrowser, userAgent } from '../lib/browser.js';
import { writeFile } from '../lib/file.js';
import { logError } from '../lib/miscellaneous.js';
import {
	PROFILE_ID,
	fetchProfileImage,
	discoverMatches,
	processMatches,
	exportFlattenedMatches,
	exportCareerData,
	tearDown
} from '../app/index.js';

const start = Date.now();
const db = database();
const browser = await launchBrowser();
const page = await browser.newPage();

await page.setUserAgent(userAgent);

for (const { profileId } of db.rows(`SELECT profileId FROM profiles`)) {
	await fetchProfileImage(profileId).then((image) => {
		writeFile(`client/public/images/${profileId}.webp`, image, null);
	}).catch((error) => {
		logError(error, { profileId });
	});
}

await discoverMatches(db, page, PROFILE_ID);

await processMatches(db, page, PROFILE_ID);

exportFlattenedMatches(db);

exportCareerData(db);

await tearDown(start, db, browser);