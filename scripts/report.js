import { database } from '../lib/database.js';
import { databaseReport, tearDown } from '../app/index.js';

const start = Date.now();
const db = database();

databaseReport(db);

await tearDown(start, db);