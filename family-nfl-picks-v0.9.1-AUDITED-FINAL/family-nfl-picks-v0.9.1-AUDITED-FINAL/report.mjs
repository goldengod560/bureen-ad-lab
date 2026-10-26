import { PLAYERS, resolveGameChecks } from './logic.mjs';

function totalsThrough(history, week){
  const totals=Object.fromEntries(PLAYERS.map(p=>[p.id,0]));
  for(const h of [...(history||[])].sort((a,b)=>Number(a.week)-Number(b.week))){
    if(Number(h.week)>Number(week))continue;
    for(const s of h.scores||[])totals[s.playerId]=(totals[s.playerId]||0)+Number(s.points||0);
  }
  return totals;
}

export function buildWeeklyReportFromSnapshot(state, weekNumber){
  const week=(state?.history||[]).find(h=>Number(h.week)===Number(weekNumber));
  if(!week)return null;
  const totals=totalsThrough(state.history,weekNumber);
  const scoreMap=Object.fromEntries((week.scores||[]).map(s=>[s.playerId,s]));
  const games=(week.games||[]).map(g=>{
    const map={};for(const p of g.picks||[])map[p.playerId]={team:p.team,margin:p.margin};
    const checks=resolveGameChecks({picksByUser:map,homeTeam:g.home,awayTeam:g.away,homeScore:Number(g.homeScore),awayScore:Number(g.awayScore)});
    const winner=Number(g.homeScore)===Number(g.awayScore)?null:(Number(g.homeScore)>Number(g.awayScore)?g.home:g.away);
    return {
      id:g.id,away:g.away,awayName:g.awayName,awayScore:Number(g.awayScore),home:g.home,homeName:g.homeName,homeScore:Number(g.homeScore),winner,
      picks:PLAYERS.map(p=>{const x=(g.picks||[]).find(q=>q.playerId===p.id);return {playerId:p.id,playerName:p.name,team:x?.team||null,margin:x?.margin??null,check:Boolean(checks[p.id]),override:Boolean(x?.lateOverride)}})
    };
  });
  const weekly=PLAYERS.map(p=>({playerId:p.id,playerName:p.name,checks:Number(scoreMap[p.id]?.checks||0),points:Number(scoreMap[p.id]?.points||0),total:Number(totals[p.id]||0)}));
  const leaderboard=[...weekly].sort((a,b)=>b.total-a.total||a.playerName.localeCompare(b.playerName));
  return {season:Number(state.season),week:Number(weekNumber),multiplier:Number(week.multiplier||1),scoredAt:week.scoredAt,overrideCount:Number(week.overrideCount||0),overrides:week.overrides||[],games,weekly,leaderboard};
}
