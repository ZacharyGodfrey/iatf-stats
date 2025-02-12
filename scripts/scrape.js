import { database } from '../lib/database.js';
import { launchBrowser, userAgent } from '../lib/browser.js';
import { writeFile } from '../lib/file.js';
import {
  PROFILE_ID,
  fetchProfileImage,
  discoverMatches,
  processMatches,
  databaseReport,
  tearDown
} from '../app/index.js';

const start = Date.now();
const db = database();
const browser = await launchBrowser();
const page = await browser.newPage();

await page.setUserAgent(userAgent);

await fetchProfileImage(PROFILE_ID).then((image) => {
  writeFile(`data/images/${PROFILE_ID}.webp`, image, null);
});

await discoverMatches(db, page, PROFILE_ID);

await processMatches(db, page, PROFILE_ID);

databaseReport(db);

await tearDown(start, db, browser);