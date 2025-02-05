export const PROFILE_ID = 1207260;

export const tearDown = async (start, db, browser) => {
  if (browser) {
    await browser.close();
  }

  if (db) {
    db.close();
  }

  if (start) {
    const duration = Math.round((Date.now() - start) / 1000);

    console.log(`Total Runtime: ${duration} seconds`);
  }
};