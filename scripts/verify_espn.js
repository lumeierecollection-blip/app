/**
 * Amendment E live verifier (Task E2): hit ESPN's key-less scoreboard
 * endpoint for one or more leagues, print the normalized result, and exit
 * non-zero on a real failure. The parser itself is covered by committed
 * fixtures (backend/test/espn.test.js); this proves the live endpoint
 * still matches the adapter's assumptions -- run it whenever a league
 * slug is added or a fetch starts returning odd results.
 *
 *   node scripts/verify_espn.js [league [league ...]]
 *   # defaults: eng.1
 */

import { fetchScoreboard, upcomingFixtures, settledMatches, resultPayload } from '../backend/lib/espn.js';

const leagues = process.argv.slice(2);
if (leagues.length === 0) leagues.push('eng.1');

let failed = false;
for (const league of leagues) {
  try {
    const now = await fetchScoreboard({ league });
    const upcoming = upcomingFixtures(now.events);
    const oddsEvents = now.events.filter((e) => e.odds !== null);
    console.log(`${league}: ${now.events.length} event(s), ${now.skipped} skipped, ${upcoming.length} upcoming, ${oddsEvents.length} with odds`);
    for (const e of now.events.slice(0, 3)) {
      const line = `${e.home.abbreviation} vs ${e.away.abbreviation} @ ${e.date} [${e.status.name}]`;
      const odds = e.odds ? `ML ${e.odds.moneyline.home.close?.toFixed(3)}/${e.odds.moneyline.draw.close?.toFixed(3)}/${e.odds.moneyline.away.close?.toFixed(3)}` : 'no odds';
      console.log(`  ${line} | ${odds}`);
    }
  } catch (err) {
    failed = true;
    console.error(`${league}: FAILED -- ${err?.message ?? err}`);
  }
}

// One finished-day sanity check per league if available.
for (const league of leagues) {
  try {
    const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const day = await fetchScoreboard({ league, date: yesterday });
    const settled = settledMatches(day.events);
    for (const e of settled.slice(0, 2)) {
      console.log(`  result ${e.home.abbreviation} ${e.home.score}-${e.away.score} ${e.away.abbreviation} -> ${JSON.stringify(resultPayload(e))}`);
    }
  } catch (err) {
    failed = true;
    console.error(`${league} (past-day check): FAILED -- ${err?.message ?? err}`);
  }
}

process.exit(failed ? 1 : 0);
