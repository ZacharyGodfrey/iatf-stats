import { database } from '../lib/database.js';

console.log('Building web pages...');

const start = Date.now();
const db = database();

await tearDown(start, db);

console.log('Done.');