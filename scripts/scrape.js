import { database } from '../lib/database.js';
import { launchBrowser, userAgent } from '../lib/browser.js';
import {
  PROFILE_ID,
  discoverMatches,
  processMatches,
  tearDown
} from '../app/index.js';

console.log('Scraping data...');

const start = Date.now();
const db = database();
const browser = await launchBrowser();
const page = await browser.newPage();

await page.setUserAgent(userAgent);

await discoverMatches(db, page, PROFILE_ID);

await processMatches(db, page, PROFILE_ID);

await tearDown(start, db, browser);