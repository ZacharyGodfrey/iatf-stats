import { database } from '../lib/database.js';
import { launchBrowser, userAgent } from '../lib/browser.js';
import { writeFile } from '../lib/file.js';
import { logError } from '../lib/miscellaneous.js';
import {
	PROFILE_ID,
	updateProfileImages,
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

await updateProfileImages(db);

await discoverMatches(db, page, PROFILE_ID);

await processMatches(db, page, PROFILE_ID);

exportFlattenedMatches(db);

exportCareerData(db);

await tearDown(start, db, browser);