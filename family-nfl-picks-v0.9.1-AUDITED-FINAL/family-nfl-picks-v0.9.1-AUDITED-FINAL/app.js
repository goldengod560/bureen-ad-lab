import { PLAYERS, resolveGameChecks } from './logic.mjs?v=0913';
import { backend, isConfigured } from './api.mjs?v=0913';
import { buildWeeklyReportFromSnapshot } from './report.mjs?v=0913';

const SESSION_KEY='family-nfl-session-v06';
const APP_VERSION='0.9.1';
const RESULT_DISMISS_PREFIX='family-nfl-result-seen';
let session=loadSession();
let state=null;
let screen='home';
let historyWeek=null;
let drafts={};
let busy=false;
let lastScheduleSource='Supabase';
let serverOffsetMs=0;
let celebration=null;
let celebrationTimer=null;
let stateRefreshing=false;
let nflRefreshing=false;
let nflRefreshQueued=false;
let nflQueuedForce=false;
let lastNflRefreshAt=0;
let reportRetryAt=0;
const detailOpenState=new Map();
const pickSaveTimers=new Map();

function detailOpenAttr(key,defaultOpen=false){
  const isOpen=detailOpenState.has(key)?detailOpenState.get(key):defaultOpen;
  return isOpen?' open':'';
}
function captureDetailOpenState(){
  document.querySelectorAll('#app details[data-detail-key]').forEach(d=>{
    detailOpenState.set(d.dataset.detailKey,d.open);
  });
}

function loadSession(){try{return JSON.parse(localStorage.getItem(SESSION_KEY)||'null')}catch{return null}}
function saveSession(){if(session)localStorage.setItem(SESSION_KEY,JSON.stringify(session));else localStorage.removeItem(SESSION_KEY)}
function viewer(){return state?.viewer||null}
function playerById(id){return (state?.players||PLAYERS).find(p=>p.id===id)}
function esc(s=''){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function fmtKickoff(s){return new Date(s).toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
function fmtClock(s){return s?new Date(s).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):'—'}
function nowMs(){return Date.now()+serverOffsetMs}
function allSubmitted(){
  const progress=state?.progress||[];
  return PLAYERS.every(p=>{
    const x=progress.find(v=>v.playerId===p.id);
    return Boolean(x?.submitted) && Number(x?.total)>0 && Number(x?.picked)===Number(x?.total);
  });
}
function submitted(id){
  const x=(state?.progress||[]).find(v=>v.playerId===id);
  return Boolean(x?.submitted) && Number(x?.total)>0 && Number(x?.picked)===Number(x?.total);
}
function gameById(id){return (state?.games||[]).find(g=>g.id===id)}
function visiblePick(playerId,gameId){return (state?.visiblePicks||[]).find(x=>x.playerId===playerId&&x.gameId===gameId)}
function ownPick(gameId){return visiblePick(viewer()?.id,gameId)}
function progressFor(id){return (state?.progress||[]).find(x=>x.playerId===id)||{playerId:id,picked:0,total:(state?.games||[]).length,submitted:false}}
function currentWeekScored(){return Array.isArray(state?.currentScores)&&state.currentScores.length>0}
function finalCount(){return (state?.games||[]).filter(g=>g.final).length}

function activeOverride(gameId){
  return (state?.overrides?.activeForViewer||[]).find(o=>o.gameId===gameId && (!o.expiresAt || new Date(o.expiresAt).getTime()>nowMs()));
}
function isGameLocked(g){
  if(g.final) return true;
  if(activeOverride(g.id)) return false;
  return allSubmitted() || nowMs()>=new Date(g.kickoff).getTime();
}
function revealedForPlayers(g){return allSubmitted() || nowMs()>=new Date(g.kickoff).getTime()}
function timeToKickoff(g){return new Date(g.kickoff).getTime()-nowMs()}
function fmtRemaining(ms){
  if(ms<=0)return '0:00';
  const sec=Math.ceil(ms/1000);
  if(sec<600){const m=Math.floor(sec/60),s=sec%60;return `${m}:${String(s).padStart(2,'0')}`;}
  const min=Math.ceil(sec/60);
  if(min<60)return `${min}m`;
  const h=Math.floor(min/60),m=min%60;return m?`${h}h ${m}m`:`${h}h`;
}
function ownCompletePick(gid){const p=ownPick(gid);return Boolean(p?.team&&Number(p.margin)>0)}
function gameStatus(g){
  const ov=activeOverride(g.id);
  if(g.final)return {label:'FINAL',cls:'good'};
  if(ov)return {label:'OVERRIDE OPEN',cls:'warn',until:ov.expiresAt};
  const kicked=timeToKickoff(g)<=0;
  if(kicked && !ownCompletePick(g.id))return {label:'MISSED',cls:'bad'};
  if(g.status==='in')return {label:'LIVE',cls:'live'};
  if(allSubmitted())return {label:'LOCKED',cls:''};
  if(kicked)return {label:'LOCKED',cls:''};
  return {label:`LOCKS IN ${fmtRemaining(timeToKickoff(g))}`,cls:'',until:g.kickoff,kind:'game'};
}
function toast(msg){alert(msg)}
function submissionToast(){
  const old=document.querySelector('.submission-toast');
  if(old)old.remove();
  const el=document.createElement('div');
  el.className='submission-toast';
  el.setAttribute('role','status');
  el.setAttribute('aria-live','polite');
  el.innerHTML=`<div class="submission-toast-icon">✓</div><div><b>Week ${state?.currentWeek||1} picks submitted</b><span>Your picks are saved.</span></div>`;
  document.body.appendChild(el);
  requestAnimationFrame(()=>el.classList.add('show'));
  setTimeout(()=>{
    el.classList.remove('show');
    setTimeout(()=>el.remove(),220);
  },3200);
}
function setBusy(v){busy=v;render()}

function historySortedAsc(){return [...(state?.history||[])].sort((a,b)=>Number(a.week)-Number(b.week))}
function totalsThroughWeek(week){
  const out=Object.fromEntries(PLAYERS.map(p=>[p.id,0]));
  for(const h of historySortedAsc()){
    if(Number(h.week)>Number(week))continue;
    for(const s of h.scores||[])out[s.playerId]=(out[s.playerId]||0)+Number(s.points||0);
  }
  return out;
}
function rankMap(totals){
  const sorted=PLAYERS.map(p=>({id:p.id,total:Number(totals[p.id]||0),name:p.name})).sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name));
  const ranks={};let last=null,rank=0;
  sorted.forEach((x,i)=>{if(last===null||x.total!==last)rank=i+1;ranks[x.id]=rank;last=x.total});
  return ranks;
}
function leaderboardForWeek(week){
  const h=(state?.history||[]).find(x=>Number(x.week)===Number(week));
  if(!h)return [];
  const weekPoints=Object.fromEntries((h.scores||[]).map(s=>[s.playerId,Number(s.points||0)]));
  const after=totalsThroughWeek(week),before=totalsThroughWeek(Number(week)-1);
  const afterRanks=rankMap(after),beforeRanks=rankMap(before);
  return PLAYERS.map(p=>({
    playerId:p.id,name:p.name,points:weekPoints[p.id]||0,total:after[p.id]||0,
    rank:afterRanks[p.id],prevRank:Number(week)>1?beforeRanks[p.id]:null,
    movement:Number(week)>1?(beforeRanks[p.id]-afterRanks[p.id]):null
  })).sort((a,b)=>a.rank-b.rank||b.total-a.total||a.name.localeCompare(b.name));
}
function movementText(m){if(m==null)return '—';if(m>0)return `↑${m}`;if(m<0)return `↓${Math.abs(m)}`;return '—'}
function movementClass(m){return m>0?'up':m<0?'down':''}

function syncCelebrationFromState(){
  const a=state?.resultAlert;if(!a?.week||!viewer())return;
  const key=`${RESULT_DISMISS_PREFIX}-${state.season}-${a.week}-${viewer().id}`;
  if(localStorage.getItem(key)==='1')return;
  if(!celebration||Number(celebration.week)!==Number(a.week)){
    celebration={week:Number(a.week),stage:'winner'};
    if(celebrationTimer){clearTimeout(celebrationTimer);celebrationTimer=null;}
  }
}
async function dismissCelebration(goHistory=false){
  if(!celebration)return;
  const w=celebration.week;
  localStorage.setItem(`${RESULT_DISMISS_PREFIX}-${state.season}-${w}-${viewer().id}`,'1');
  celebration=null;if(celebrationTimer){clearTimeout(celebrationTimer);celebrationTimer=null;}
  if(goHistory){historyWeek=w;screen='history';}
  render();
  try{await backend.markWeekResultSeen(session.token,w);await loadSnapshot();}catch{}
  render();
}

function renderConfettiBurst(week){
  const colors=['#A28A5A','#C7B07A','#F7F3EA','#FFFFFF','#D9C89E'];
  let seed=(Number(week)||1)*7919+37;
  const rand=()=>{
    seed=(seed*1664525+1013904223)>>>0;
    return seed/4294967296;
  };
  return `<div class="confetti-layer" aria-hidden="true">${Array.from({length:72},(_,i)=>{
    const bx=Math.round((rand()*2-1)*330);
    const by=Math.round(-55-rand()*210);
    const drift=Math.round((rand()*2-1)*180);
    const spin=Math.round((rand()*2-1)*900);
    const delay=(rand()*.32).toFixed(2);
    const dur=(2.9+rand()*1.15).toFixed(2);
    const w=Math.round(7+rand()*7);
    const h=Math.round(10+rand()*10);
    const c=colors[i%colors.length];
    const radius=rand()>.72?'50%':'2px';
    return `<i class="confetti-piece" style="--burst-x:${bx}px;--burst-y:${by}px;--drift-x:${drift}px;--spin:${spin}deg;--delay:${delay}s;--dur:${dur}s;--cw:${w}px;--ch:${h}px;--cc:${c};--cr:${radius}"></i>`;
  }).join('')}</div>`;
}
function renderCelebration(){
  if(!celebration)return '';
  const lb=leaderboardForWeek(celebration.week);if(!lb.length)return '';
  const maxPts=Math.max(...lb.map(x=>x.points));
  const winners=lb.filter(x=>x.points===maxPts);
  if(celebration.stage==='winner'){
    const names=winners.map(x=>x.name).join(winners.length===2?' & ':', ');
    const title=maxPts===0?'Week Complete!':winners.length===1?`Congrats, ${names}!`:`Congrats, ${names}!`;
    const sub=maxPts===0?'Everyone tied this week':winners.length===1?`Week ${celebration.week} Winner`:`Week ${celebration.week} Winners`;
    return `<div class="result-overlay">${renderConfettiBurst(celebration.week)}<div class="result-modal celebration"><button class="result-close" data-result-close aria-label="Close">×</button><div class="confetti">🎉 🏈 🎉</div><div class="result-kicker">WEEK ${celebration.week} COMPLETE</div><div class="result-title">${esc(title)}</div><div class="result-sub">${esc(sub)}</div><div class="result-points">+${maxPts} <span>point${maxPts===1?'':'s'}</span></div></div></div>`;
  }
  return `<div class="result-overlay"><div class="result-modal"><button class="result-close" data-result-close aria-label="Close">×</button><div class="result-kicker">UPDATED LEADERBOARD</div><div class="result-title small">Week ${celebration.week} Final Standings</div><div class="leader-list">${lb.map(x=>`<div class="leader-row"><span class="leader-rank">${x.rank}</span><span class="movement ${movementClass(x.movement)}">${movementText(x.movement)}</span><span class="leader-name">${esc(x.name)}</span><span class="leader-week">+${x.points}</span><b>${x.total} Total</b></div>`).join('')}</div><button class="btn" data-result-history>View Week ${celebration.week} Results →</button></div></div>`;
}
function startCelebrationTimer(){
  if(!celebration||celebration.stage!=='winner'||celebrationTimer)return;
  celebrationTimer=setTimeout(()=>{celebrationTimer=null;if(celebration){celebration.stage='leaderboard';render();}},4000);
}

async function loadSnapshot(){
  if(!session?.token)return;
  try{
    state=await backend.snapshot(session.token);
    if(!state?.viewer)throw new Error('Invalid session.');
    if(state.serverNow)serverOffsetMs=new Date(state.serverNow).getTime()-Date.now();
    session.playerId=state.viewer.id;saveSession();hydrateDrafts();syncCelebrationFromState();
    maybeSendWeeklyEmail().catch(()=>{});
  }catch(e){
    if(String(e.message||'').toLowerCase().includes('session')){session=null;drafts={};saveSession();state=null;screen='home';}
    else throw e;
  }
}
function hydrateDrafts(){
  for(const g of state?.games||[]){
    const p=ownPick(g.id);
    const existing=drafts[g.id]||{};
    drafts[g.id]={
      team:p?.team||existing.team||'',
      margin:p?.margin??existing.margin??'',
      saved:Boolean(p?.team&&Number(p?.margin)>0)
    };
  }
}

async function fetchEspnGames(requestedWeek=null){
  const season=state?.season||2026,week=Number(requestedWeek??state?.currentWeek??1);
  const url=`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`;
  const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error('NFL schedule could not be loaded.');
  const d=await r.json();if(!Array.isArray(d.events)||!d.events.length)throw new Error('No NFL games returned for this week.');
  return d.events.map(e=>{
    const c=e.competitions?.[0],comps=c?.competitors||[];const h=comps.find(x=>x.homeAway==='home'),a=comps.find(x=>x.homeAway==='away');
    const status=e.status?.type?.state||'pre',final=Boolean(e.status?.type?.completed||status==='post');
    return {id:String(e.id),away:a?.team?.abbreviation||'AWY',awayName:a?.team?.displayName||'Away',awayRecord:a?.records?.find(r=>r.type==='total')?.summary||a?.records?.[0]?.summary||'',home:h?.team?.abbreviation||'HME',homeName:h?.team?.displayName||'Home',homeRecord:h?.records?.find(r=>r.type==='total')?.summary||h?.records?.[0]?.summary||'',kickoff:e.date,status,final,awayScore:a?.score==null?null:Number(a.score),homeScore:h?.score==null?null:Number(h.score),round:'regular'};
  });
}
async function syncSchedule({quiet=false,retry=true}={}){
  if(!session?.token||!state)return;
  const requestedWeek=Number(state.currentWeek||1);
  try{
    const games=await fetchEspnGames(requestedWeek);
    const synced=await backend.syncGamesForWeek(session.token,requestedWeek,games);
    lastNflRefreshAt=Date.now();
    if(synced?.status==='stale-week'){
      await loadSnapshot();
      if(retry)return syncSchedule({quiet,retry:false});
      return render();
    }
    const finish=await backend.finishAndAdvanceWeek(session.token);
    lastScheduleSource='NFL live feed';
    await loadSnapshot();
    const newWeek=Number(state.currentWeek||requestedWeek);
    if(newWeek!==requestedWeek){
      try{
        const nextGames=await fetchEspnGames(newWeek);
        await backend.syncGamesForWeek(session.token,newWeek,nextGames);
        await loadSnapshot();
      }catch{}
      if(!quiet)toast(`Week ${requestedWeek} is complete. Week ${newWeek} is now active.`);
    }else if(!quiet)toast('NFL schedule, records, and scores refreshed.');
  }catch(e){
    lastScheduleSource='Last saved schedule';
    const msg=String(e?.message||e||'');
    if(msg.includes('family_sync_games_for_week')){
      await loadSnapshot().catch(()=>{});
      if(!quiet)toast('Schedule button still needs the latest Supabase SQL fix. The page stayed on your saved schedule.');
    }else if(!quiet)toast(`Schedule refresh failed: ${e.message}`);
  }
  render();
}
async function maybeSendWeeklyEmail(){
  const url=String(window.APP_CONFIG?.reportWebhookUrl||'').trim();
  if(!url||!state?.resultAlert?.week||Date.now()<reportRetryAt)return;
  const week=Number(state.resultAlert.week);const sentKey=`family-nfl-report-sent-${state.season}-${week}`;
  if(localStorage.getItem(sentKey)==='1')return;
  const report=buildWeeklyReportFromSnapshot(state,week);if(!report)return;
  try{
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({season:state.season,week,report})});
    if(!r.ok)throw new Error(`Report HTTP ${r.status}`);
    localStorage.setItem(sentKey,'1');
  }catch{reportRetryAt=Date.now()+15*60*1000;}
}

function shell(content,active='home'){
  const u=viewer(),backendLabel=isConfigured()?'Shared online':'Not connected';
  return `<div class="shell"><div class="topbar"><div><div class="brand">🏈 Family NFL Picks</div><div class="sub">${state?.season||2026} Season · Week ${state?.currentWeek||1} · v${APP_VERSION} · ${backendLabel}</div></div>${u?`<button class="btn secondary compact" data-act="logout">${esc(u.name)} ↗</button>`:''}</div><div class="page-divider"></div>${content}</div>${u?`<div class="nav"><div class="nav-inner"><button data-nav="picks" class="${active==='picks'?'active':''}">Picks</button><button data-nav="standings" class="${active==='standings'?'active':''}">Standings</button><button data-nav="history" class="${active==='history'?'active':''}">History</button><button data-nav="predictions" class="${active==='predictions'?'active':''}">Predictions</button><button data-nav="commissioner" class="${active==='commissioner'?'active':''}">${u.admin?'Commish':'Status'}</button></div></div>`:''}${renderCelebration()}`;
}
function renderHome(){
  const warn=!isConfigured()?`<div class="notice warn">Supabase is not configured yet.</div>`:'';
  return shell(`<div class="card"><div class="title">Who’s picking?</div><p class="sub">Choose your name and enter your 4-digit PIN.</p><div class="grid">${PLAYERS.map(p=>`<button class="player ${p.admin?'admin':''}" data-player="${p.id}" ${busy?'disabled':''}>${p.name}</button>`).join('')}</div></div>${warn}<div class="notice"><b>v${APP_VERSION} shared mode:</b> all four phones share picks, progress, standings, History, and transparent commissioner overrides.</div>`);
}
function revealedBlock(g){
  if(!revealedForPlayers(g))return '';
  let checks={};
  if(g.final&&Number.isFinite(Number(g.homeScore))&&Number.isFinite(Number(g.awayScore))){
    const picksByUser={};
    PLAYERS.forEach(p=>{
      const x=visiblePick(p.id,g.id);
      if(x)picksByUser[p.id]={team:x.team,margin:x.margin};
    });
    checks=resolveGameChecks({
      picksByUser,
      homeTeam:g.home,
      awayTeam:g.away,
      homeScore:Number(g.homeScore),
      awayScore:Number(g.awayScore)
    });
  }
  return `<div class="divider"></div><div class="tiny"><b>Revealed picks</b></div>${PLAYERS.map(p=>{const x=visiblePick(p.id,g.id);return `<div class="row between pick-reveal"><span>${p.name}${checks[p.id]?' ✅':''}</span><b>${x?`${esc(x.team)} by ${x.margin}`:'No pick'}</b></div>`}).join('')}`;
}
function renderPicks(){
  const u=viewer(),games=state?.games||[],prog=progressFor(u.id);
  if(!games.length)return shell(`<div class="row between"><div><div class="title">Week ${state.currentWeek} Picks</div><div class="sub">No games loaded yet.</div></div><button class="btn secondary" data-act="refresh-schedule">↻ Schedule</button></div><div class="notice">Press Schedule to load this week's NFL games.</div>`,'picks');
  const cards=games.map(g=>{
    const p=ownPick(g.id),d=drafts[g.id]||{team:p?.team||'',margin:p?.margin||''},locked=isGameLocked(g),ov=activeOverride(g.id),st=gameStatus(g);
    const missing=!ownCompletePick(g.id),near=missing&&timeToKickoff(g)>0&&timeToKickoff(g)<=60*60*1000;
    const liveLine=g.final?`<div class="score-line final">FINAL · ${g.away} ${g.awayScore} · ${g.home} ${g.homeScore}</div>`:(g.status==='in'&&Number.isFinite(Number(g.awayScore))&&Number.isFinite(Number(g.homeScore))?`<div class="score-line live">LIVE · ${g.away} ${g.awayScore} · ${g.home} ${g.homeScore}</div>`:'');
    const rec=(name,abbr,record)=>`${esc(name)}<span class="record-line">${esc(abbr)}${record?` · ${esc(record)}`:''}</span>`;
    const statusAttr=st.until?` data-countdown-until="${esc(st.until)}" data-countdown-type="${st.kind||'override'}"`:'';
    return `<div class="game ${locked?'lock':''} ${near?'urgent':''}"><div class="game-head"><span>${fmtKickoff(g.kickoff)}</span><span class="status-pill ${st.cls}"${statusAttr}>${esc(st.label)}</span></div>${near?`<div class="notice warn mini"><b>Pick needed soon.</b> This game locks at kickoff.</div>`:''}${st.label==='MISSED'?`<div class="notice bad mini"><b>Missed pick.</b> It stays a loss unless Yasin authorizes a 5-minute late-pick override.</div>`:''}${ov?`<div class="notice warn mini"><b>Yasin reopened this game.</b> Save your team + margin before <span data-override-inline="${esc(ov.expiresAt)}">${fmtRemaining(new Date(ov.expiresAt).getTime()-nowMs())}</span>. It relocks as soon as the late pick is saved.</div>`:''}<div class="teams"><button class="team ${d.team===g.away?'selected':''}" data-pick="${g.id}|${g.away}" ${locked||busy?'disabled':''}>${rec(g.awayName,g.away,g.awayRecord)}</button><button class="team ${d.team===g.home?'selected':''}" data-pick="${g.id}|${g.home}" ${locked||busy?'disabled':''}>${rec(g.homeName,g.home,g.homeRecord)}</button></div><div class="margin-wrap"><span><b>Margin</b></span><input class="margin" type="number" min="1" max="99" inputmode="numeric" data-margin="${g.id}" value="${esc(d.margin)}" ${locked||busy?'disabled':''}></div>${!locked&&d.team&&Number(d.margin)>0&&draftDiffersFromSaved(g.id)?`<div class="tiny pick-save-state">Saving pick…</div>`:''}${liveLine}${revealedBlock(g)}</div>`;
  }).join('');
  const complete=Number(prog.picked)===Number(prog.total)&&Number(prog.total)>0;
  return shell(`<div class="row between picks-heading"><div><div class="title">Week ${state.currentWeek} Picks</div><div class="sub">${games.length} games · ${lastScheduleSource}</div></div><button class="btn secondary compact schedule-btn" data-act="refresh-schedule" ${busy?'disabled':''}>↻ Schedule</button></div><div class="progress-card"><div class="row between"><b>Your progress</b><b>${prog.picked} / ${prog.total} picked</b></div><div class="progress-track"><span style="width:${prog.total?Math.min(100,(prog.picked/prog.total)*100):0}%"></span></div></div>${cards}${submitted(u.id)?`<div class="notice good-note submission-note">Submitted ✓ ${allSubmitted()?'Everyone is in, so all games are locked.':'Future games can still be updated until their kickoff or until everyone submits.'}</div>`:''}<button class="btn submit-btn" data-act="submit-week" ${!complete||busy?'disabled':''}>${submitted(u.id)?'Update Submission':'Submit Week'}</button>`,'picks');
}

function checkCountsFromCurrentGames(){
  const counts=Object.fromEntries(PLAYERS.map(p=>[p.id,0]));
  const games=state?.games||[];
  for(const g of games){
    if(!g.final)continue;
    const picksByUser={};
    PLAYERS.forEach(p=>{
      const x=visiblePick(p.id,g.id);
      if(x)picksByUser[p.id]={team:x.team,margin:x.margin};
    });
    const checks=resolveGameChecks({
      picksByUser,
      homeTeam:g.home,
      awayTeam:g.away,
      homeScore:Number(g.homeScore),
      awayScore:Number(g.awayScore)
    });
    PLAYERS.forEach(p=>{if(checks[p.id])counts[p.id]+=1;});
  }
  return counts;
}

function checkCountsFromHistoryWeek(h){
  const counts=Object.fromEntries(PLAYERS.map(p=>[p.id,0]));
  for(const g of h?.games||[]){
    const picksByUser={};
    for(const x of g.picks||[])picksByUser[x.playerId]={team:x.team,margin:x.margin};
    const checks=resolveGameChecks({
      picksByUser,
      homeTeam:g.home,
      awayTeam:g.away,
      homeScore:Number(g.homeScore),
      awayScore:Number(g.awayScore)
    });
    PLAYERS.forEach(p=>{if(checks[p.id])counts[p.id]+=1;});
  }
  return counts;
}

function rankedWeeklyChecks(counts){
  const rows=PLAYERS
    .map(p=>({playerId:p.id,name:p.name,wins:Number(counts[p.id]||0)}))
    .sort((a,b)=>b.wins-a.wins||a.name.localeCompare(b.name));
  let lastWins=null,rank=0;
  rows.forEach((x,i)=>{
    if(lastWins===null||x.wins!==lastWins)rank=i+1;
    x.rank=rank;
    lastWins=x.wins;
  });
  return rows;
}

function weeklyLiveStandingsModel(){
  const currentWeek=Number(state?.currentWeek||1);
  const currentGames=state?.games||[];
  const latestHistory=[...(state?.history||[])].sort((a,b)=>Number(b.week)-Number(a.week))[0]||null;
  const firstKickoff=currentGames
    .map(g=>new Date(g.kickoff).getTime())
    .filter(Number.isFinite)
    .sort((a,b)=>a-b)[0]||null;

  // After a week finishes, keep its final weekly standings visible.
  // Reset to the new week exactly 24 hours before the new week's first kickoff.
  const keepPrevious=Boolean(
    latestHistory &&
    Number(latestHistory.week)===currentWeek-1 &&
    (!firstKickoff || nowMs()<firstKickoff-(24*60*60*1000))
  );

  if(keepPrevious){
    const counts=checkCountsFromHistoryWeek(latestHistory);
    return {
      week:Number(latestHistory.week),
      rows:rankedWeeklyChecks(counts),
      final:Number(latestHistory.games?.length||0),
      total:Number(latestHistory.games?.length||0),
      completed:true,
      nextWeek:currentWeek,
      resetAt:firstKickoff?firstKickoff-(24*60*60*1000):null
    };
  }

  const counts=checkCountsFromCurrentGames();
  const final=(currentGames||[]).filter(g=>g.final).length;
  return {
    week:currentWeek,
    rows:rankedWeeklyChecks(counts),
    final,
    total:currentGames.length,
    completed:Boolean(currentGames.length&&final===currentGames.length),
    nextWeek:currentWeek+1,
    resetAt:null
  };
}

function renderStandings(){
  const latest=[...(state?.history||[])].sort((a,b)=>Number(b.week)-Number(a.week))[0];
  const lb=latest?leaderboardForWeek(latest.week):(state?.standings||[]).map((x,i)=>({playerId:x.playerId,name:x.name,total:Number(x.total||0),rank:i+1,points:0,movement:null}));

  const live=weeklyLiveStandingsModel();
  const liveTitle=`Week ${live.week} ${live.completed?'Final':'Live'} Standings`;
  const liveRows=live.rows.map(x=>`<tr><td>${x.rank}</td><td>${esc(x.name)}${x.playerId==='yasin'?' 🛡️':''}</td><td class="right"><b class="live-win-number">${x.wins}${x.wins>0?'<span class="live-win-check">✅</span>':''}</b></td></tr>`).join('');
  const liveNote=live.completed
    ? (live.resetAt
        ? `These stay here until 24 hours before Week ${live.nextWeek}'s first game, then the live standings reset to 0.`
        : `Week ${live.week} is complete. The next week's live standings will start at 0.`)
    : `Updates automatically as games go FINAL. Season points are still awarded only after the entire week is complete.`;

  const liveBlock=`<div class="section-title">${liveTitle}</div>
    <div class="card standings-card live-week-standings">
      <div class="row between live-week-head">
        <b>${live.final} of ${live.total} games final</b>
        <span class="pill">${live.completed?'FINAL':'LIVE'}</span>
      </div>
      <table>
        <thead><tr><th>#</th><th>Player</th><th class="right">Wins</th></tr></thead>
        <tbody>${liveRows}</tbody>
      </table>
      <div class="tiny live-week-note">${liveNote}</div>
    </div>`;

  return shell(`<div class="title">Season Standings</div><div class="card standings-card"><table><thead><tr><th>#</th><th></th><th>Player</th><th class="right">Last week</th><th class="right">Total</th></tr></thead><tbody>${lb.map(x=>`<tr><td>${x.rank}</td><td class="movement ${movementClass(x.movement)}">${movementText(x.movement)}</td><td>${esc(x.name)}${x.playerId==='yasin'?' 🛡️':''}</td><td class="right">+${x.points||0}</td><td class="right"><b>${x.total||0}</b></td></tr>`).join('')}</tbody></table></div>${liveBlock}`,'standings');
}
function checksForHistoryGame(g){const map={};for(const p of g.picks||[])map[p.playerId]={team:p.team,margin:p.margin};return resolveGameChecks({picksByUser:map,homeTeam:g.home,awayTeam:g.away,homeScore:Number(g.homeScore),awayScore:Number(g.awayScore)});}
function overrideDescription(o,games){
  const p=playerById(o.playerId),g=(games||[]).find(x=>x.id===o.gameId)||gameById(o.gameId),match=g?`${g.away} @ ${g.home}`:'Game';
  const type=o.kind==='commissioner_edit'?'Commissioner Edit':'Late Pick';
  let detail='';
  if(o.kind==='commissioner_edit'&&o.oldTeam&&o.newTeam)detail=`${o.oldTeam} by ${o.oldMargin} → ${o.newTeam} by ${o.newMargin}`;
  else if(o.kind==='late_pick'&&o.status==='used'&&o.newTeam)detail=`${o.newTeam} by ${o.newMargin}`;
  return {p,match,type,detail};
}
function renderOverrideLog(events,games,{history=false}={}){
  if(!events?.length)return `<div class="notice">No commissioner overrides ${history?'were used this week.':'this week.'}</div>`;
  return `<div class="override-list">${events.map(o=>{const d=overrideDescription(o,games);const status=o.status==='active'?'ACTIVE':o.status==='used'?'USED':o.status==='expired'?'EXPIRED':'CANCELLED';return `<div class="override-card"><div class="row between"><b>⚠️ ${esc(d.p?.name||o.playerId)} · ${esc(d.type)}</b><span class="pill ${o.status==='active'?'warn':''}">${status}</span></div><div class="tiny override-meta">${esc(d.match)} · Authorized ${fmtClock(o.authorizedAt)}${o.usedAt?` · Submitted/edited ${fmtClock(o.usedAt)}`:''}</div>${o.status==='active'&&o.expiresAt?`<div class="override-countdown">Window closes in <b data-countdown-until="${esc(o.expiresAt)}" data-countdown-type="override">${fmtRemaining(new Date(o.expiresAt).getTime()-nowMs())}</b></div>`:''}${d.detail?`<div class="override-detail"><b>${esc(d.detail)}</b></div>`:''}${o.note?`<div class="tiny">Reason: ${esc(o.note)}</div>`:''}</div>`}).join('')}</div>`;
}
function renderHistory(){
  const hist=state?.history||[];if(!hist.length)return shell(`<div class="title">History</div><div class="notice">Completed weeks will appear here automatically after all games are final and the week is scored.</div>`,'history');
  const selected=hist.find(h=>String(h.week)===String(historyWeek))||hist[0];historyWeek=selected.week;
  const scoreMap=Object.fromEntries((selected.scores||[]).map(s=>[s.playerId,s])),lb=leaderboardForWeek(selected.week);
  const games=(selected.games||[]).map(g=>{const checks=checksForHistoryGame(g);return `<div class="game history-game"><div class="game-head"><span>FINAL</span><span>${esc(g.away)} @ ${esc(g.home)}</span></div><div class="history-score"><span>${esc(g.awayName)} <b>${g.awayScore}</b></span><span>${esc(g.homeName)} <b>${g.homeScore}</b></span></div><div class="divider"></div>${PLAYERS.map(p=>{const x=(g.picks||[]).find(q=>q.playerId===p.id);return `<div class="history-pick row between"><span>${p.name}${checks[p.id]?' ✅':''}${x?.lateOverride?' ⚠️':''}</span><b>${x?`${esc(x.team)} by ${x.margin}`:'No pick'}</b></div>`}).join('')}</div>`}).join('');
  return shell(`<div class="row between"><div><div class="title">History</div><div class="sub">Everyone can review every completed week.</div></div><span class="pill">${selected.overrideCount||0} override${Number(selected.overrideCount||0)===1?'':'s'}</span></div><div class="week-tabs">${hist.map(h=>`<button class="week-chip ${String(h.week)===String(selected.week)?'active':''}" data-history-week="${h.week}">Week ${h.week}</button>`).join('')}</div><div class="card"><div class="row between"><b>Week ${selected.week} leaderboard</b><span class="pill">×${selected.multiplier||1}</span></div><table><thead><tr><th>#</th><th></th><th>Player</th><th class="right">Checks</th><th class="right">Week</th><th class="right">Total</th></tr></thead><tbody>${lb.map(x=>`<tr><td>${x.rank}</td><td class="movement ${movementClass(x.movement)}">${movementText(x.movement)}</td><td>${x.name}</td><td class="right">${scoreMap[x.playerId]?.checks||0}</td><td class="right">+${x.points}</td><td class="right"><b>${x.total}</b></td></tr>`).join('')}</tbody></table></div><div class="section-title">Every game</div>${games}<div class="section-title">Override details</div>${renderOverrideLog(selected.overrides||[],selected.games||[],{history:true})}`,'history');
}
function renderPredictions(){
  const locked=state.currentWeek>state.predictionLockWeek,pr=state.predictions||{},c=pr.conference||[],s=pr.superBowl||[];
  return shell(`<div class="title">Week 12 Predictions</div><div class="notice ${locked?'warn':''}">${locked?'Predictions are locked after Week 12 unless Yasin uses a commissioner override.':'You can edit these anytime through Week 12.'}</div><div class="card"><div class="section-title">Conference Championship · +2 each</div><p class="sub">Choose 4 teams, separated by commas.</p><textarea id="confPred" rows="4" class="text-area" ${locked?'disabled':''}>${esc(c.join(', '))}</textarea><div class="section-title">Super Bowl · +3 each</div><p class="sub">Choose 2 teams, separated by commas.</p><textarea id="sbPred" rows="2" class="text-area" ${locked?'disabled':''}>${esc(s.join(', '))}</textarea>${!locked?`<button class="btn" style="margin-top:14px" data-act="save-predictions" ${busy?'disabled':''}>Save Predictions</button>`:''}</div>`,'predictions');
}
function statusRows(){
  return PLAYERS.map(p=>{
    const x=progressFor(p.id),complete=Number(x.picked)===Number(x.total)&&Number(x.total)>0,isSubmitted=submitted(p.id);
    return `<div class="status-row"><div><b>${p.name}</b><div class="tiny">${x.picked} / ${x.total} picked</div></div><span class="pill ${isSubmitted?'good':complete?'':'warn'}">${isSubmitted?'Submitted ✓':`${x.picked}/${x.total}`}</span></div>`;
  }).join('');
}
function renderOverrideControls(g){
  if(g.final)return '';
  const locked=allSubmitted()||nowMs()>=new Date(g.kickoff).getTime();if(!locked)return '';
  const rows=PLAYERS.map(p=>{
    const has=visiblePick(p.id,g.id),active=(state.overrides?.all||[]).find(o=>o.playerId===p.id&&o.gameId===g.id&&o.status==='active'&&(!o.expiresAt||new Date(o.expiresAt).getTime()>nowMs()));
    if(has)return `<div class="row between override-control-row"><span>${p.name} · ${has.team} by ${has.margin}</span><button class="btn secondary mini-btn" data-edit-pick="${p.id}|${g.id}" ${busy?'disabled':''}>Commissioner Edit</button></div>`;
    if(nowMs()<new Date(g.kickoff).getTime())return `<div class="row between override-control-row"><span>${p.name}</span><span class="tiny">No saved pick</span></div>`;
    return `<div class="row between override-control-row"><span>${p.name}</span>${active?`<span class="pill warn">Open <b data-countdown-until="${esc(active.expiresAt)}" data-countdown-type="override">${fmtRemaining(new Date(active.expiresAt).getTime()-nowMs())}</b></span>`:`<button class="btn secondary mini-btn" data-late="${p.id}|${g.id}" ${busy?'disabled':''}>Allow Late Pick</button>`}</div>`;
  }).join('');
  return `<div class="divider"></div><div class="tiny"><b>Override controls</b></div>${rows}`;
}
function renderCommissioner(){
  const u=viewer(),admin=u.admin,overrideLog=renderOverrideLog(state.overrides?.all||[],state.games||[]),wideDefault=window.innerWidth>520;
  if(!admin)return shell(`<div class="title">Week ${state.currentWeek} Status</div><div class="card status-card"><div class="status-card-title viewer-status-title">Week ${state.currentWeek} Status</div>${statusRows()}</div><details class="compact-details" data-detail-key="status-overrides"${detailOpenAttr('status-overrides',wideDefault)}><summary>Override Activity <span class="pill">${state.overrides?.count||0}</span></summary><p class="sub">Visible to everyone for fairness.</p>${overrideLog}</details>`,'commissioner');
  const allowInspect=submitted('yasin');
  const review=allowInspect?`<details class="compact-details review-details" data-detail-key="commish-review"${detailOpenAttr('commish-review',wideDefault)}><summary>Commissioner Review</summary><div class="details-body">${(state.games||[]).map(g=>`<div class="game review-game"><div class="row between"><b>${g.away} @ ${g.home}</b><span class="tiny">${fmtKickoff(g.kickoff)}</span></div>${PLAYERS.map(p=>{const x=visiblePick(p.id,g.id);return `<div class="row between review-pick"><span>${p.name}</span><span>${x?`${x.team} by ${x.margin}${x.lateOverride?' ⚠️':''}`:'—'}</span></div>`}).join('')}${renderOverrideControls(g)}</div>`).join('')}</div></details>`:`<div class="notice warn">You can see everyone's progress, but you cannot inspect their actual picks until <b>you submit your own Week ${state.currentWeek} picks</b>.</div>`;
  const scoreStatus=currentWeekScored()?'Week scored automatically ✓':`${finalCount()} of ${(state.games||[]).length} games final`;
  return shell(`<div class="title">Commissioner Dashboard</div><div class="card status-card"><div class="row between status-card-top"><div class="status-card-title">Week ${state.currentWeek} Status</div><span class="pill">${state.overrides?.count||0} override${Number(state.overrides?.count||0)===1?'':'s'}</span></div>${statusRows()}</div>${review}<details class="compact-details" data-detail-key="commish-overrides"${detailOpenAttr('commish-overrides',wideDefault)}><summary>Override Activity <span class="pill">${state.overrides?.count||0}</span></summary><div class="details-body"><p class="sub">Everyone can see these same override records on their Status page.</p>${overrideLog}</div></details><details class="compact-details" data-detail-key="commish-tools"${detailOpenAttr('commish-tools',wideDefault)}><summary>Commissioner Tools</summary><div class="details-body"><div class="notice"><b>${scoreStatus}</b><br>When every NFL game is FINAL, the week scores automatically and the next regular-season week becomes active.</div><div class="row tool-row"><button class="btn secondary" data-act="refresh-schedule" ${busy?'disabled':''}>Refresh NFL Data</button><button class="btn secondary" data-act="reset-pin" ${busy?'disabled':''}>Reset Player PIN</button></div><p class="tiny">Late Pick opens one missed game for exactly 5 minutes and relocks immediately after the player saves the pick. Commissioner Edit changes an already locked pick and requires a reason. Both are permanently visible.</p></div></details>`,'commissioner');
}
function render(){
  captureDetailOpenState();
  let html;if(!session?.token||!state)html=renderHome();else if(screen==='standings')html=renderStandings();else if(screen==='history')html=renderHistory();else if(screen==='predictions')html=renderPredictions();else if(screen==='commissioner')html=renderCommissioner();else html=renderPicks();
  document.querySelector('#app').innerHTML=html;bind();startCelebrationTimer();updateCountdownLabels();
}

function pinModal(player){
  document.body.insertAdjacentHTML('beforeend',`<div class="modal"><div class="modal-box"><div class="title">${player.name} PIN</div><p class="sub">Enter your 4-digit code.</p><input class="pin" id="pinInput" maxlength="4" inputmode="numeric" type="password"><div class="row" style="margin-top:14px"><button class="btn" id="pinGo">Continue</button><button class="btn secondary" id="pinCancel">Cancel</button></div></div></div>`);
  const input=document.querySelector('#pinInput');input.focus();document.querySelector('#pinCancel').onclick=()=>document.querySelector('.modal').remove();
  const go=async()=>{const pin=input.value.trim();if(!/^\d{4}$/.test(pin))return toast('Enter exactly 4 digits.');const btn=document.querySelector('#pinGo');btn.disabled=true;btn.textContent='Signing in…';try{const res=await backend.login(player.id,pin);if(!res?.ok)throw new Error(res?.error||'Login failed.');session={token:res.token,playerId:res.player_id};drafts={};saveSession();screen='picks';await loadSnapshot();document.querySelector('.modal')?.remove();await syncSchedule({quiet:true});render();if(res.created_pin)toast(`${player.name}'s PIN was created.`);}catch(e){if(!state?.viewer){session=null;drafts={};state=null;saveSession();screen='home';}btn.disabled=false;btn.textContent='Continue';toast(e.message||String(e));}};
  document.querySelector('#pinGo').onclick=go;input.onkeydown=e=>{if(e.key==='Enter')go()};
}
function commissionerEditModal(player,game,pick){
  document.body.insertAdjacentHTML('beforeend',`<div class="modal"><div class="modal-box"><button class="result-close modal-x" id="editCancel">×</button><div class="title">Commissioner Edit</div><p class="sub">${esc(player.name)} · ${esc(game.away)} @ ${esc(game.home)}<br>Current: <b>${esc(pick.team)} by ${pick.margin}</b></p><label class="field-label">New team</label><select id="editTeam" class="field"><option value="${esc(game.away)}" ${pick.team===game.away?'selected':''}>${esc(game.awayName)} (${esc(game.away)})</option><option value="${esc(game.home)}" ${pick.team===game.home?'selected':''}>${esc(game.homeName)} (${esc(game.home)})</option></select><label class="field-label">New winning margin</label><input id="editMargin" class="field" type="number" min="1" max="99" value="${pick.margin}"><label class="field-label">Reason (required)</label><textarea id="editReason" class="field" rows="3" placeholder="Example: typo / phone issue"></textarea><div class="notice warn mini">Everyone will be able to see this edit and the reason.</div><button class="btn" id="editSave">Save Commissioner Edit</button></div></div>`);
  const close=()=>document.querySelector('.modal')?.remove();document.querySelector('#editCancel').onclick=close;
  document.querySelector('#editSave').onclick=async()=>{const team=document.querySelector('#editTeam').value,margin=Number(document.querySelector('#editMargin').value),reason=document.querySelector('#editReason').value.trim();if(!(margin>=1&&margin<=99))return toast('Margin must be 1–99.');if(reason.length<2)return toast('Enter a short reason.');const btn=document.querySelector('#editSave');btn.disabled=true;btn.textContent='Saving…';try{const r=await backend.commissionerEditPick(session.token,player.id,game.id,team,margin,reason);if(!r?.ok)throw new Error(r?.error||'Edit failed.');close();await loadSnapshot();toast(`${player.name}'s pick was updated and logged.`);render();}catch(e){btn.disabled=false;btn.textContent='Save Commissioner Edit';toast(e.message||String(e));}};
}
async function saveDraft(gid,{quiet=false}={}){
  const d=drafts[gid];
  if(!d?.team||!(Number(d.margin)>=1&&Number(d.margin)<=99))return false;
  if(!quiet)setBusy(true);
  try{
    const r=await backend.setPick(session.token,gid,d.team,Number(d.margin));
    if(!r?.ok)throw new Error(r?.error||'Pick could not be saved.');
    await loadSnapshot();
    const saved=ownPick(gid);
    if(!saved||saved.team!==d.team||Number(saved.margin)!==Number(d.margin)){
      throw new Error('The pick did not verify after saving. Please try again.');
    }
    drafts[gid]={team:saved.team,margin:saved.margin,saved:true};
    if(r.lateOverride)toast('Late pick saved. This game is locked again.');
    return true;
  }catch(e){
    toast(e.message||String(e));
    await loadSnapshot().catch(()=>{});
    return false;
  }finally{
    if(!quiet){busy=false;render();}
  }
}

function draftDiffersFromSaved(gid){
  const d=drafts[gid]||{},p=ownPick(gid);
  if(!d?.team||!(Number(d.margin)>=1&&Number(d.margin)<=99))return false;
  return !p || p.team!==d.team || Number(p.margin)!==Number(d.margin);
}
function scheduleDraftSave(gid,delay=650){
  if(pickSaveTimers.has(gid))clearTimeout(pickSaveTimers.get(gid));
  const timer=setTimeout(async()=>{
    pickSaveTimers.delete(gid);
    if(draftDiffersFromSaved(gid)){
      await saveDraft(gid,{quiet:true});
      if(!document.querySelector('input:focus,textarea:focus,select:focus,.modal'))render();
    }
  },delay);
  pickSaveTimers.set(gid,timer);
}
async function flushPendingDrafts(){
  for(const [gid,timer] of pickSaveTimers.entries()){
    clearTimeout(timer);
    pickSaveTimers.delete(gid);
  }
  for(const g of state?.games||[]){
    if(isGameLocked(g))continue;
    if(draftDiffersFromSaved(g.id)){
      const ok=await saveDraft(g.id,{quiet:true});
      if(!ok)return false;
    }
  }
  await loadSnapshot();
  return true;
}
function bind(){
  document.querySelectorAll('details[data-detail-key]').forEach(d=>{
    d.addEventListener('toggle',()=>detailOpenState.set(d.dataset.detailKey,d.open));
  });
  document.querySelectorAll('[data-player]').forEach(b=>b.onclick=()=>pinModal(PLAYERS.find(p=>p.id===b.dataset.player)));
  document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{screen=b.dataset.nav;render()});
  document.querySelectorAll('[data-history-week]').forEach(b=>b.onclick=()=>{historyWeek=b.dataset.historyWeek;render()});
  document.querySelectorAll('[data-pick]').forEach(b=>b.onclick=async()=>{
    const [gid,team]=b.dataset.pick.split('|');
    drafts[gid]||={};
    drafts[gid].team=team;
    drafts[gid].saved=false;
    render();
    if(Number(drafts[gid].margin)>=1&&Number(drafts[gid].margin)<=99){
      await saveDraft(gid,{quiet:true});
      render();
    }
  });
  document.querySelectorAll('[data-margin]').forEach(i=>{
    let committing=false;
    const capture=()=>{
      const gid=i.dataset.margin;
      drafts[gid]||={};
      drafts[gid].margin=Number(i.value);
      drafts[gid].saved=false;
      if(Number(i.value)>=1&&Number(i.value)<=99)scheduleDraftSave(gid,650);
    };
    const commit=async()=>{
      if(committing)return;
      committing=true;
      const gid=i.dataset.margin;
      if(pickSaveTimers.has(gid)){clearTimeout(pickSaveTimers.get(gid));pickSaveTimers.delete(gid);}
      capture();
      try{
        if(draftDiffersFromSaved(gid))await saveDraft(gid,{quiet:true});
      }finally{
        committing=false;
        setTimeout(()=>{if(!document.querySelector('input:focus,textarea:focus,select:focus,.modal'))render();},0);
      }
    };
    i.oninput=capture;
    i.onchange=commit;
    i.onblur=commit;
  });
  document.querySelectorAll('[data-late]').forEach(b=>b.onclick=async()=>{const [pid,gid]=b.dataset.late.split('|');if(!confirm(`Open a 5-minute late-pick window for ${playerById(pid)?.name||pid}? Everyone will see the override in Status.`))return;setBusy(true);try{const r=await backend.authorizeLatePick(session.token,pid,gid);if(!r?.ok)throw new Error(r?.error||'Override failed.');await loadSnapshot();toast(`${playerById(pid)?.name||pid} has 5 minutes to save that late pick.`);}catch(e){toast(e.message||String(e))}finally{busy=false;render()}});
  document.querySelectorAll('[data-edit-pick]').forEach(b=>b.onclick=()=>{const [pid,gid]=b.dataset.editPick.split('|'),p=playerById(pid),g=gameById(gid),pick=visiblePick(pid,gid);if(p&&g&&pick)commissionerEditModal(p,g,pick)});
  document.querySelectorAll('[data-result-close]').forEach(b=>b.onclick=()=>dismissCelebration(false));
  document.querySelectorAll('[data-result-history]').forEach(b=>b.onclick=()=>dismissCelebration(true));
  document.querySelectorAll('[data-act]').forEach(b=>b.onclick=async()=>{
    const a=b.dataset.act;
    if(a==='logout'){try{await backend.logout(session.token)}catch{}session=null;drafts={};state=null;celebration=null;saveSession();screen='home';render();return;}
    if(a==='refresh-schedule'){setBusy(true);await syncSchedule({quiet:false});busy=false;render();return;}
    if(a==='submit-week'){setBusy(true);try{
      const flushed=await flushPendingDrafts();
      if(!flushed)throw new Error('One or more picks could not be saved. Please check them and try again.');
      const r=await backend.submitWeek(session.token);
      if(!r?.ok)throw new Error(r?.error||'Submission failed.');
      await loadSnapshot();
      submissionToast();
    }catch(e){toast(e.message||String(e))}finally{busy=false;render()}return;}
    if(a==='save-predictions'){const split=v=>v.split(',').map(x=>x.trim()).filter(Boolean),c=split(document.querySelector('#confPred').value),s=split(document.querySelector('#sbPred').value);setBusy(true);try{const r=await backend.savePredictions(session.token,c,s);if(!r?.ok)throw new Error(r?.error||'Could not save predictions.');await loadSnapshot();toast('Predictions saved.');}catch(e){toast(e.message||String(e))}finally{busy=false;render()}return;}
    if(a==='reset-pin'){const n=prompt('Reset whose PIN? Yasin, Yezan, Samer, or Limar'),p=PLAYERS.find(x=>x.name.toLowerCase()===String(n||'').trim().toLowerCase());if(!p)return toast('Player not found.');if(!confirm(`Reset ${p.name}'s PIN? They will create a new 4-digit PIN next login.`))return;setBusy(true);try{const r=await backend.resetPin(session.token,p.id);if(!r?.ok)throw new Error(r?.error||'PIN reset failed.');toast(`${p.name}'s PIN was reset.`);if(p.id===viewer().id){session=null;drafts={};state=null;saveSession();screen='home';}}catch(e){toast(e.message||String(e))}finally{busy=false;render()}return;}
  });
}

function updateCountdownLabels(){
  let expired=false;
  document.querySelectorAll('[data-countdown-until]').forEach(el=>{
    const until=new Date(el.dataset.countdownUntil).getTime(),left=until-nowMs();
    if(el.dataset.countdownType==='override'){
      if(left<=0){el.textContent='Expired';expired=true;}else if(el.classList.contains('status-pill'))el.textContent=`OVERRIDE OPEN · ${fmtRemaining(left)}`;else el.textContent=fmtRemaining(left);
    }else{
      if(left<=0){el.textContent='LOCKED';expired=true;}else el.textContent=`LOCKS IN ${fmtRemaining(left)}`;
    }
  });
  document.querySelectorAll('[data-override-inline]').forEach(el=>{const left=new Date(el.dataset.overrideInline).getTime()-nowMs();el.textContent=left<=0?'expired':fmtRemaining(left);if(left<=0)expired=true;});
  if(expired&&!stateRefreshing&&!nflRefreshing)setTimeout(()=>backgroundStateRefresh(true),250);
}
async function boot(){render();if(session?.token){try{await loadSnapshot();screen='picks';render();await syncSchedule({quiet:true});}catch(e){toast(`Could not connect to the shared database: ${e.message}`);session=null;drafts={};state=null;saveSession();render();}}}
function nflNeedsFastPolling(){
  const now=nowMs();
  return (state?.games||[]).some(g=>{
    if(g.final)return false;
    const kickoff=new Date(g.kickoff).getTime();
    return g.status==='in' || (Number.isFinite(kickoff)&&now>=kickoff-2*60*1000&&now<=kickoff+6*60*60*1000);
  });
}
async function backgroundStateRefresh(force=false){
  if(stateRefreshing||nflRefreshing||!session?.token||document.hidden)return;
  if(document.querySelector('input:focus,textarea:focus,select:focus,.modal'))return;
  stateRefreshing=true;
  try{
    await loadSnapshot();
    render();
  }catch{}finally{
    stateRefreshing=false;
    if(nflRefreshQueued){
      const forceNFL=nflQueuedForce;
      nflRefreshQueued=false;
      nflQueuedForce=false;
      setTimeout(()=>backgroundNFLRefresh(forceNFL),200);
    }
  }
}
async function backgroundNFLRefresh(force=false){
  if(nflRefreshing||!session?.token||document.hidden)return;
  if(document.querySelector('input:focus,textarea:focus,select:focus,.modal'))return;
  if(stateRefreshing){
    nflRefreshQueued=true;
    nflQueuedForce=nflQueuedForce||force;
    return;
  }
  const age=Date.now()-lastNflRefreshAt;
  if(!force&&!nflNeedsFastPolling()&&age<120000)return;
  nflRefreshing=true;
  try{
    await syncSchedule({quiet:true});
  }finally{
    nflRefreshing=false;
  }
}

if('serviceWorker' in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('./service-worker.js?v=0913').catch(()=>{});
boot();
setInterval(updateCountdownLabels,1000);
setInterval(()=>backgroundStateRefresh(false),15000);
setInterval(()=>backgroundNFLRefresh(false),30000);
window.addEventListener('focus',()=>{
  backgroundStateRefresh(true);
  setTimeout(()=>backgroundNFLRefresh(true),350);
});
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden)setTimeout(()=>backgroundNFLRefresh(true),350);
});
