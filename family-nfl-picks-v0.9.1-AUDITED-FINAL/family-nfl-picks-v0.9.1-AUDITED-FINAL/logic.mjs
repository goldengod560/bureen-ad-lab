export const PLAYERS = [
  { id: 'yasin', name: 'Yasin', admin: true },
  { id: 'yezan', name: 'Yezan', admin: false },
  { id: 'samer', name: 'Samer', admin: false },
  { id: 'limar', name: 'Limar', admin: false },
];

export function resolveGameChecks({ picksByUser, homeTeam, awayTeam, homeScore, awayScore }) {
  const checks = Object.fromEntries(PLAYERS.map(p => [p.id, false]));
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore) || homeScore === awayScore) return checks;

  const winner = homeScore > awayScore ? homeTeam : awayTeam;
  const actualMargin = Math.abs(homeScore - awayScore);
  const validPicks = PLAYERS
    .map(p => ({ userId: p.id, ...(picksByUser?.[p.id] || {}) }))
    .filter(p => p.team);

  const winnerPicks = validPicks.filter(p => p.team === winner);
  if (!winnerPicks.length) return checks;

  // Margin contest only when 3+ players chose the actual winning team.
  if (winnerPicks.length >= 3) {
    const enriched = winnerPicks
      .filter(p => Number.isFinite(Number(p.margin)))
      .map(p => ({ ...p, margin: Number(p.margin), diff: Math.abs(Number(p.margin) - actualMargin) }));
    if (!enriched.length) return checks;
    const minDiff = Math.min(...enriched.map(p => p.diff));
    const closest = enriched.filter(p => p.diff === minDiff);
    const lowestClosestMargin = Math.min(...closest.map(p => p.margin));
    closest.filter(p => p.margin === lowestClosestMargin).forEach(p => { checks[p.userId] = true; });
    return checks;
  }

  // For 2-2, a lone correct picker in a 3-1 split, or missed-pick situations,
  // every correct picker receives the check unless 3+ correct picks triggered margin mode.
  winnerPicks.forEach(p => { checks[p.userId] = true; });
  return checks;
}

export function normalizeChecks(checkCounts, multiplier = 1) {
  // v0.8.8: legacy function name kept for compatibility.
  // Weekly points are now the player's actual checks × round multiplier.
  return Object.fromEntries(
    PLAYERS.map(p => [p.id, Number(checkCounts[p.id] || 0) * multiplier])
  );
}

export function playoffRoundMultiplier(round) {
  if (round === 'wildcard') return 2;
  if (round === 'divisional') return 2;
  if (round === 'conference') return 3;
  return 1;
}

export function predictionBonus(rawCorrectCounts, pointsEach) {
  // Prediction bonuses are also additive now; nobody's earned bonus is subtracted away.
  return Object.fromEntries(
    PLAYERS.map(p => [p.id, Number(rawCorrectCounts[p.id] || 0) * pointsEach])
  );
}

export function canAdminInspectPicks({ adminUserId, submissions }) {
  return Boolean(submissions?.[adminUserId]?.submittedAt);
}

export function shouldRevealToPlayers({ allSubmitted, kickoffAt, now = Date.now() }) {
  const kickedOff = kickoffAt ? now >= new Date(kickoffAt).getTime() : false;
  return Boolean(allSubmitted || kickedOff);
}

export function getSuperBowlField(totals) {
  const ranked = PLAYERS
    .map(p => ({ userId: p.id, total: Number(totals[p.id] || 0) }))
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId));
  const firstScore = ranked[0]?.total;
  const first = ranked.filter(r => r.total === firstScore);
  if (first.length !== 1) {
    return { status: 'first-place-tie', first, second: [] };
  }
  const secondScore = ranked.find(r => r.total < firstScore)?.total;
  const second = secondScore == null ? [] : ranked.filter(r => r.total === secondScore);
  return { status: 'ready', first: first[0], second };
}

export function resolveSuperBowlChampion({ firstUserId, firstTeam, secondUserIds, secondMargins, homeTeam, awayTeam, homeScore, awayScore }) {
  if (homeScore === awayScore) return { championUserIds: [], reason: 'nfl-tie' };
  const winner = homeScore > awayScore ? homeTeam : awayTeam;
  const margin = Math.abs(homeScore - awayScore);
  if (winner === firstTeam) return { championUserIds: [firstUserId], reason: 'first-place-team-won' };

  if (!secondUserIds?.length) return { championUserIds: [], reason: 'no-second-place-finalist' };
  if (secondUserIds.length === 1) return { championUserIds: [secondUserIds[0]], reason: 'second-place-team-won' };

  const eligible = secondUserIds
    .map(userId => ({ userId, margin: Number(secondMargins?.[userId]) }))
    .filter(x => Number.isFinite(x.margin));
  if (!eligible.length) return { championUserIds: [], reason: 'missing-margins' };
  const minDiff = Math.min(...eligible.map(x => Math.abs(x.margin - margin)));
  const closest = eligible.filter(x => Math.abs(x.margin - margin) === minDiff);
  const lower = Math.min(...closest.map(x => x.margin));
  return { championUserIds: closest.filter(x => x.margin === lower).map(x => x.userId), reason: 'second-place-margin' };
}
