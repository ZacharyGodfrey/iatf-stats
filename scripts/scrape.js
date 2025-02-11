import { database } from '../lib/database.js';
import { launchBrowser, userAgent } from '../lib/browser.js';
import { PROFILE_ID, tearDown } from '../app/index.js';

console.log('Scraping data...');

const start = Date.now();
const db = database();
const browser = await launchBrowser();
const page = await browser.newPage();

await page.setUserAgent(userAgent);

await tearDown(start, db, browser);

console.log('Done.');