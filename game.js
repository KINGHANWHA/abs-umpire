/* =========================================================
   ABS 심판 미니게임 — 포수 뒤 심판 시점 스트라이크/볼 판정
   순수 정적 SPA (외부 의존성 없음)
   ========================================================= */
(() => {
'use strict';

/* ---------- 캔버스 & 논리 좌표 ---------- */
const cv = document.getElementById('field');
const ctx = cv.getContext('2d');
const W = 560, H = 860;            // 논리 해상도 (세로 화면)
let DPR = 1;

function resize(){
  const r = cv.getBoundingClientRect();
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(r.width * DPR);
  cv.height = Math.round(r.height * DPR);
}
window.addEventListener('resize', resize);

/* 논리좌표(W,H) → 실제 픽셀 스케일 */
function applyTransform(){
  const sx = cv.width / W, sy = cv.height / H;
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
}

/* ---------- 장면 기준 좌표 (논리 W×H 기준) ---------- */
const SCENE = {
  horizon: 300,
  moundX: W/2, moundY: 330,         // 공 릴리스 지점
  plateX: W/2, plateY: 720,         // 홈플레이트 중심
  zoneCX: W/2,
  zoneHalfW: 96,                    // 존 좌우 반폭(px) — 홈플레이트 폭에 해당
  ballR: 16,                        // 플레이트 도달 시 공 반지름(px) ≈ 존폭 대비 KBO 실제 비율
  ballStartR: 4
};
const ZONE_L = SCENE.zoneCX - SCENE.zoneHalfW;
const ZONE_R = SCENE.zoneCX + SCENE.zoneHalfW;

/* ---------- 타자 데이터 (신장 → 존 상하) ---------- */
// KBO ABS: 상단 = 키 56.35%, 하단 = 27.64%. 화면상 존 높이를 키에 비례시켜 표현.
const BATTERS = [
  { name:'이정후형 거포', side:'L', h:185 },
  { name:'교타자', side:'R', h:178 },
  { name:'장신 슬러거', side:'L', h:190 },
  { name:'리드오프', side:'R', h:172 },
  { name:'베테랑 타자', side:'L', h:180 },
  { name:'신인 타자', side:'R', h:176 },
  { name:'단신 교타자', side:'R', h:168 },
];
// 키 168~190 → 존 중심/높이 매핑
function zoneForBatter(b){
  const t = (b.h - 168) / (190 - 168);          // 0~1
  const zoneH = 150 + t * 60;                    // 존 높이 150~210px
  const center = SCENE.plateY - 250 - t * 30;    // 큰 타자일수록 존이 위로
  return { top: center - zoneH/2, bot: center + zoneH/2 };
}

/* ---------- 구종 ---------- */
const PITCHES = [
  { name:'포심 패스트볼', vmin:142, vmax:156, break:{x:0,y:0},  flight:0.62 },
  { name:'투심 패스트볼', vmin:140, vmax:150, break:{x:18,y:6}, flight:0.66 },
  { name:'슬라이더',     vmin:132, vmax:143, break:{x:-34,y:10},flight:0.70 },
  { name:'커브',         vmin:116, vmax:128, break:{x:14,y:34}, flight:0.80 },
  { name:'체인지업',     vmin:126, vmax:138, break:{x:10,y:22}, flight:0.74 },
  { name:'스플리터',     vmin:130, vmax:140, break:{x:-6,y:30}, flight:0.74 },
];

/* ---------- 게임 상태 ---------- */
const CRED_MAX = 5;
let state = 'idle';     // idle | ready | pitching | decide | result
let score=0, combo=0, maxCombo=0, calls=0, correct=0, cred=CRED_MAX;
let pitch=null;         // 현재 투구 객체
let tStart=0;           // 애니메이션 타임스탬프
let decideStart=0, decideDur=0;
let readyStart=0, readyDur=0;
let resultStart=0, resultInfo=null;

/* ---------- 타석/카운트 ---------- */
let balls=0, strikes=0;          // 현재 타석의 볼-스트라이크 카운트
let curBatter=null, curZone=null;// 한 타석 동안 유지되는 타자/존
let newAtBatNext=true;           // 다음 투구에서 새 타석 시작 여부
let strikeouts=0, walks=0;       // 통계

/* ---------- DOM ---------- */
const el = id => document.getElementById(id);
const $score=el('score'), $combo=el('combo'), $acc=el('accuracy'), $calls=el('calls'), $cred=el('credibility');
const $ptype=el('pitch-type'), $pspeed=el('pitch-speed'), $bname=el('batter-name'), $bheight=el('batter-height');
const $banner=el('call-banner'), $verdict=el('verdict');
const $btnBall=el('btn-ball'), $btnStrike=el('btn-strike');
const $timerWrap=el('timer-wrap'), $timerBar=el('timer-bar');

/* ---------- 오디오 엔진 ---------- */
let actx=null, noiseBuf=null;
function ac(){
  actx = actx || new (window.AudioContext||window.webkitAudioContext)();
  if(actx.state==='suspended'){ try{ actx.resume(); }catch(e){} }
  return actx;
}
function beep(freq, dur=0.08, type='square', vol=0.06){
  try{
    const a=ac();
    const o=a.createOscillator(), g=a.createGain();
    o.type=type; o.frequency.value=freq; o.connect(g); g.connect(a.destination);
    g.gain.setValueAtTime(vol, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime+dur);
    o.start(); o.stop(a.currentTime+dur);
  }catch(e){}
}
// 주파수 슬라이드 톤 (스윕/스탭용)
function tone(t0, f0, f1, dur, type, vol){
  const a=ac();
  const o=a.createOscillator(), g=a.createGain();
  o.type=type;
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(1,f1), t0+dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0+0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
  o.connect(g); g.connect(a.destination);
  o.start(t0); o.stop(t0+dur+0.03);
}
// 밴드패스 화이트노이즈 버스트 (타격/펀치음)
function noiseHit(t0, dur, freq, q, vol){
  const a=ac();
  if(!noiseBuf){
    const n=Math.floor(a.sampleRate*0.6);
    noiseBuf=a.createBuffer(1,n,a.sampleRate);
    const d=noiseBuf.getChannelData(0);
    for(let i=0;i<n;i++) d[i]=Math.random()*2-1;
  }
  const s=a.createBufferSource(); s.buffer=noiseBuf;
  const bp=a.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=freq; bp.Q.value=q;
  const g=a.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
  s.connect(bp); bp.connect(g); g.connect(a.destination);
  s.start(t0); s.stop(t0+dur+0.02);
}
function chordStab(t0, freqs, dur, type, vol){ freqs.forEach(f=>tone(t0,f,f*0.992,dur,type,vol)); }

/* ---------- TTS 콜 음성 (남성으로 통일) ----------
   기기마다 기본 음성 성별이 달라(데스크톱 남성/모바일 여성) 남성 음성을 우선 선택.
   우선순위: ① 한국어 남성  ② 영어 남성  ③ 한국어(성별불명) → 피치 다운으로 남성화 */
let VOICE=null, ttsOK=('speechSynthesis' in window);
const MALE_KO=['injoon','minjun','minsu','jihun','hyunwoo','sanghoon','seoyeon-male','남성','남자','male','man'];
const MALE_EN=['david','mark','guy','christopher','eric','daniel','arthur','aaron','fred','alex','rishi','tom','oliver','google uk english male','male'];
function selectVoice(){
  const vs=speechSynthesis.getVoices(); if(!vs.length) return null;
  const ko=vs.filter(v=>/^ko/i.test(v.lang));
  const en=vs.filter(v=>/^en/i.test(v.lang));
  const byHint=(list,hints)=>list.find(v=>{const n=v.name.toLowerCase(); return hints.some(h=>n.includes(h));});
  let v=byHint(ko,MALE_KO); if(v) return {voice:v,lang:'ko',male:true};   // 한국어 남성
  v=byHint(en,MALE_EN);     if(v) return {voice:v,lang:'en',male:true};   // 영어 남성
  if(ko[0]) return {voice:ko[0],lang:'ko',male:false};                    // 한국어(여성 추정)→피치다운
  return {voice:vs[0],lang:/^ko/i.test(vs[0].lang)?'ko':'en',male:false};
}
function loadVoices(){ if(ttsOK) VOICE=selectVoice(); }
if(ttsOK){ loadVoices(); speechSynthesis.onvoiceschanged=loadVoices; }
function mkUtter(koText, enText, rate, pitch){
  const u=new SpeechSynthesisUtterance();
  if(VOICE&&VOICE.voice){ u.voice=VOICE.voice; u.lang=VOICE.voice.lang; u.text=(VOICE.lang==='ko')?koText:enText; }
  else { u.lang='ko-KR'; u.text=koText; }
  u.rate=rate;
  // 확실한 남성 음성이 아니면(여성 추정) 피치를 크게 낮춰 남성에 가깝게
  u.pitch = (VOICE&&VOICE.male) ? pitch : Math.max(0.3, pitch*0.6);
  u.volume=1;
  return u;
}
function say(koText, enText, rate, pitch){
  if(!ttsOK) return;
  try{ speechSynthesis.cancel(); speechSynthesis.speak(mkUtter(koText,enText,rate,pitch)); }catch(e){}
}

/* 콜 종류별 — 효과음 + 흥분된 음성 */
function playCall(kind){   // 'strike' | 'ball' | 'out' | 'walk'
  try{ _playCall(kind); }catch(e){}
}
function _playCall(kind){
  const a=ac(), t=a.currentTime;
  if(kind==='strike'){
    // 날카로운 '딱' + 밝은 상승 스탭 → 흥분된 외침
    noiseHit(t, 0.05, 2400, 7, 0.45);
    tone(t+0.01, 700, 1500, 0.13, 'square', 0.13);
    chordStab(t+0.02, [880,1320], 0.12, 'square', 0.07);
    say('스트라이크!', 'Strike!', 1.1, 0.9);     // 빠르게(에너지) + 남성 음역(낮은 피치)
  }
  else if(kind==='ball'){
    // 차분한 저음 — 볼은 담담하게
    tone(t, 320, 190, 0.16, 'sine', 0.16);
    say('볼', 'Ball', 0.98, 0.82);
  }
  else if(kind==='out'){
    playStrikeout();
  }
  else if(kind==='walk'){
    tone(t, 520, 360, 0.16, 'sine', 0.14);
    tone(t+0.12, 360, 300, 0.18, 'sine', 0.12);
    say('볼넷', 'Ball four', 1.0, 0.88);
  }
}

/* 삼진아웃: 긴장 빌드업 → 폭발 펀치 → 승리의 brass → "삼진…아웃!" 2단 폭발 */
function playStrikeout(){
  const a=ac(), t=a.currentTime;
  // 1) 빌드업 상승 스윕(긴장)
  tone(t, 220, 1300, 0.34, 'sawtooth', 0.10);
  noiseHit(t+0.05, 0.30, 900, 1.2, 0.08);
  // 2) 폭발 펀치 (t+0.34)
  const h = t+0.34;
  tone(h, 180, 55, 0.45, 'sine', 0.55);          // 저음 붐
  noiseHit(h, 0.20, 1700, 1.6, 0.55);            // 펀치 노이즈
  noiseHit(h, 0.05, 5000, 3, 0.30);              // 고역 '쨍'
  // 3) 승리의 brass 스탭 (장조 코드)
  chordStab(h+0.02, [392,523,659], 0.5, 'sawtooth', 0.12);   // G-B-D
  chordStab(h+0.18, [523,659,784], 0.45, 'sawtooth', 0.10);  // 한 계단 상승
  // 4) 음성 2단 폭발: "삼진" → (사이) → "아웃!"
  if(ttsOK){
    try{ speechSynthesis.cancel(); }catch(e){}
    setTimeout(()=>{ try{ speechSynthesis.speak(mkUtter('삼진','Strike three', 0.98, 0.82)); }catch(e){} }, 360);
    setTimeout(()=>{ try{ speechSynthesis.speak(mkUtter('아웃!',"You're out", 1.02, 0.95)); }catch(e){} }, 980);
  }
}

/* ---------- 난이도 ---------- */
function difficulty(){ return Math.min(calls / 36, 1); }  // 0~1

/* ---------- 판정: 공(원)이 존(사각형)에 닿으면 스트라이크 ---------- */
function isStrike(cx, cy, zone){
  const nx = Math.max(ZONE_L, Math.min(cx, ZONE_R));
  const ny = Math.max(zone.top, Math.min(cy, zone.bot));
  const d = Math.hypot(cx-nx, cy-ny);
  return d <= SCENE.ballR;
}
// 경계까지의 부호거리 (음수=존 안쪽 깊이, 양수=존 밖 거리) — 결과 표시용
function edgeDistance(cx, cy, zone){
  const nx = Math.max(ZONE_L, Math.min(cx, ZONE_R));
  const ny = Math.max(zone.top, Math.min(cy, zone.bot));
  const inside = (cx>=ZONE_L&&cx<=ZONE_R&&cy>=zone.top&&cy<=zone.bot);
  const outDist = Math.hypot(cx-nx, cy-ny);
  if(inside){
    const din = Math.min(cx-ZONE_L, ZONE_R-cx, cy-zone.top, zone.bot-cy);
    return -din;
  }
  return outDist;
}

/* ---------- 투구 생성 ---------- */
function rand(a,b){ return a + Math.random()*(b-a); }
function pick(arr){ return arr[(Math.random()*arr.length)|0]; }

// 새 타석 시작: 타자/존 선택, 카운트 리셋
function newAtBat(){
  curBatter = pick(BATTERS);
  curZone = zoneForBatter(curBatter);
  balls=0; strikes=0;
  updateCount();
}

function newPitch(){
  if(!curBatter) newAtBat();
  const b = curBatter;
  const zone = curZone;
  const ptype = pick(PITCHES);
  const d = difficulty();
  const speed = Math.round(rand(ptype.vmin, ptype.vmax) + d*4);

  // 목표 위치(공 중심) 결정
  const r = SCENE.ballR;
  const pBorder = 0.28 + d*0.42;        // 보더라인 확률 증가
  let cx, cy, kind;

  if(Math.random() < pBorder){
    kind = 'border';
    // 한 변을 골라 그 경계 근처(±(r+여유)) 에 배치
    const edge = (Math.random()*4)|0;
    const jitter = rand(-(r+7), r+7);
    if(edge===0){ cx = ZONE_L + jitter; cy = rand(zone.top+10, zone.bot-10); }
    else if(edge===1){ cx = ZONE_R + jitter; cy = rand(zone.top+10, zone.bot-10); }
    else if(edge===2){ cy = zone.top + jitter; cx = rand(ZONE_L+10, ZONE_R-10); }
    else { cy = zone.bot + jitter; cx = rand(ZONE_L+10, ZONE_R-10); }
    // 코너 보더라인 가끔
    if(Math.random()<0.25){
      cx = (Math.random()<0.5?ZONE_L:ZONE_R) + rand(-(r+5), r+5);
      cy = (Math.random()<0.5?zone.top:zone.bot) + rand(-(r+5), r+5);
    }
  } else if(Math.random() < 0.5){
    kind='clear-strike';
    cx = rand(ZONE_L + r + 8, ZONE_R - r - 8);
    cy = rand(zone.top + r + 8, zone.bot - r - 8);
  } else {
    kind='clear-ball';
    const side=(Math.random()*4)|0, off=rand(r+20, r+58);
    if(side===0){ cx=ZONE_L-off; cy=rand(zone.top-20, zone.bot+20); }
    else if(side===1){ cx=ZONE_R+off; cy=rand(zone.top-20, zone.bot+20); }
    else if(side===2){ cy=zone.top-off; cx=rand(ZONE_L-20, ZONE_R+20); }
    else { cy=zone.bot+off; cx=rand(ZONE_L-20, ZONE_R+20); }
  }

  // 화면 밖 과도 이탈 방지
  cx = Math.max(ZONE_L-80, Math.min(ZONE_R+80, cx));
  cy = Math.max(zone.top-90, Math.min(zone.bot+90, cy));

  const truth = isStrike(cx, cy, zone);
  const flight = Math.max(0.46, ptype.flight - d*0.16);    // 빨라짐
  decideDur = Math.max(620, 1500 - d*820);                  // 판정시간 짧아짐(ms)

  // 변화구 시각적 제어점 (날아오는 도중 휘는 모양)
  const bx = ptype.break.x * rand(0.7,1.2) * (Math.random()<0.5?1:-0.4);
  const by = ptype.break.y * rand(0.7,1.2);

  pitch = { b, zone, ptype, speed, cx, cy, truth, flight, kind,
            breakX:bx, breakY:by };
}

/* 콜에 따라 카운트 진행 → 콜 종류 반환 */
function applyCount(){
  let kind;
  if(pitch.truth){ strikes++; kind = (strikes>=3)?'out':'strike'; }
  else { balls++; kind = (balls>=4)?'walk':'ball'; }
  updateCount();
  if(kind==='out'){ strikeouts++; newAtBatNext=true; }
  else if(kind==='walk'){ walks++; newAtBatNext=true; }
  else { newAtBatNext=false; }
  return kind;
}

/* ---------- 투구 시작 ---------- */
function startPitch(){
  if(newAtBatNext){ newAtBat(); newAtBatNext=false; }
  newPitch();
  // 투구 전: 존을 보여주며 기억하게 하는 준비 단계 (난이도↑ 일수록 짧아짐)
  state='ready';
  readyStart = performance.now();
  readyDur = Math.max(550, 1300 - difficulty()*650);
  $ptype.textContent = pitch.ptype.name;
  $pspeed.textContent = '--';
  $bname.textContent = pitch.b.name + (pitch.b.side==='L'?' (좌타)':' (우타)');
  $bheight.textContent = '키 ' + pitch.b.h + 'cm';
  $banner.className='hidden'; $verdict.className='hidden';
  setButtons(false);
  $timerWrap.classList.remove('show');
  kick();
}

/* ---------- 판정 입력 ---------- */
function makeCall(callStrike){
  if(state!=='decide') return;
  state='result';
  resultStart = performance.now();
  calls++;
  const ok = (callStrike === pitch.truth);
  const callKind = applyCount();            // 카운트 진행 + 콜 종류(strike/ball/out/walk)
  if(ok){
    correct++; combo++; maxCombo=Math.max(maxCombo,combo);
    const base = (pitch.kind==='border') ? 150 : 100;
    const gain = base + combo*10;
    score += gain;
    resultInfo = { ok:true, gain, callKind };
  } else {
    combo=0; cred--;
    beep(180,0.18,'sawtooth',0.09);         // 오심 버저
    resultInfo = { ok:false, gain:0, callKind };
  }
  playCall(callKind);                        // ABS 콜 음성 + 효과음(실제 판정 기준)
  (callStrike?$btnStrike:$btnBall).classList.add('flash');
  setTimeout(()=>{$btnStrike.classList.remove('flash');$btnBall.classList.remove('flash');},300);
  setButtons(false);
  $timerWrap.classList.remove('show');
  showResultUI(callStrike, ok);
  updateHUD();
}

function timeoutCall(){
  if(state!=='decide') return;
  state='result'; resultStart=performance.now(); calls++; combo=0; cred--;
  const callKind = applyCount();
  beep(140,0.25,'sawtooth',0.09);
  playCall(callKind);
  resultInfo={ ok:false, gain:0, timeout:true, callKind };
  setButtons(false); $timerWrap.classList.remove('show');
  showResultUI(null, false);
  updateHUD();
}

/* ---------- 결과 UI ---------- */
function showResultUI(callStrike, ok){
  const k = resultInfo.callKind;
  const word = k==='out'?'삼진 아웃!' : k==='walk'?'볼넷!' : k==='strike'?'스트라이크!' : '볼!';
  $banner.textContent = word;
  const big = (k==='out'||k==='walk') ? ' big' : '';
  $banner.className = (pitch.truth?'strike':'ball') + big + ' show';
  let line, sub;
  if(resultInfo.timeout){ line='판정 지연!'; sub='시간 초과 — 콜을 놓쳤습니다'; }
  else if(ok){ line='정확한 판정 ✓'; sub='+' + resultInfo.gain + '점' + (pitch.kind==='border'?' · 보더라인 보너스':''); }
  else { line='오심! ✗'; sub='당신의 콜: ' + (callStrike?'스트라이크':'볼') + ' · 신뢰도 -1'; }
  if(k==='out') sub += ' · 삼진아웃!';
  else if(k==='walk') sub += ' · 볼넷';
  $verdict.innerHTML = line + '<span class="sub">'+sub+'</span>';
  $verdict.className = (ok?'good':'bad');
}

/* ---------- 카운트 전광판 ---------- */
function updateCount(){
  const bd=el('ball-dots'), sd=el('strike-dots');
  if(!bd||!sd) return;
  let bh=''; for(let i=0;i<3;i++) bh+='<i class="dot'+(i<balls?' b-on':'')+'"></i>';
  let sh=''; for(let i=0;i<2;i++) sh+='<i class="dot'+(i<strikes?' s-on':'')+'"></i>';
  bd.innerHTML=bh; sd.innerHTML=sh;
}

/* ---------- HUD ---------- */
function updateHUD(){
  $score.textContent = score;
  $combo.textContent = combo;
  $calls.textContent = calls;
  $acc.textContent = calls? Math.round(correct/calls*100)+'%' : '—';
  // 신뢰도 세그먼트
  $cred.innerHTML='';
  for(let i=0;i<CRED_MAX;i++){
    const s=document.createElement('span');
    s.className='seg'+(i<cred?' on':' lost');
    $cred.appendChild(s);
  }
}

function setButtons(on){
  $btnBall.disabled=!on; $btnStrike.disabled=!on;
}

/* =========================================================
   렌더링
   ========================================================= */
function drawField(){
  // 하늘/조명 (크롬 인디고 톤으로 페이스플레이트와 조화)
  let g=ctx.createLinearGradient(0,0,0,SCENE.horizon);
  g.addColorStop(0,'#191d34'); g.addColorStop(1,'#33407e');
  ctx.fillStyle=g; ctx.fillRect(0,0,W,SCENE.horizon);
  // 외야 잔디
  g=ctx.createLinearGradient(0,SCENE.horizon,0,SCENE.plateY);
  g.addColorStop(0,'#1d6b3a'); g.addColorStop(1,'#2f8f4f');
  ctx.fillStyle=g; ctx.fillRect(0,SCENE.horizon,W,SCENE.plateY-SCENE.horizon);
  // 내야 흙 (사다리꼴)
  ctx.fillStyle='#7a4a28';
  ctx.beginPath();
  ctx.moveTo(W/2-60,SCENE.horizon+40);
  ctx.lineTo(W/2+60,SCENE.horizon+40);
  ctx.lineTo(W+120, H); ctx.lineTo(-120,H); ctx.closePath();
  ctx.fill();
  // 전경 흙 그라데이션
  g=ctx.createLinearGradient(0,SCENE.plateY-120,0,H);
  g.addColorStop(0,'#8a5630'); g.addColorStop(1,'#5e3a1f');
  ctx.fillStyle=g; ctx.fillRect(0,SCENE.plateY-40,W,H-(SCENE.plateY-40));

  // 마운드
  ctx.fillStyle='#8a5630';
  ctx.beginPath();
  ctx.ellipse(SCENE.moundX, SCENE.moundY+18, 46, 14, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.fillStyle='#d8c7b0';
  ctx.fillRect(SCENE.moundX-9, SCENE.moundY+14, 18, 5); // 투수판

  // 배터박스/홈플레이트 라인
  ctx.strokeStyle='rgba(255,255,255,.55)'; ctx.lineWidth=3;
  ctx.strokeRect(W/2-150, SCENE.plateY-70, 110, 150);
  ctx.strokeRect(W/2+40, SCENE.plateY-70, 110, 150);

  drawPlate();
}

function drawPlate(){
  const x=SCENE.plateX, y=SCENE.plateY+44;
  ctx.fillStyle='#f3f3f3';
  ctx.beginPath();
  ctx.moveTo(x-52,y-26); ctx.lineTo(x+52,y-26);
  ctx.lineTo(x+52,y+4); ctx.lineTo(x,y+30); ctx.lineTo(x-52,y+4);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle='rgba(0,0,0,.25)'; ctx.lineWidth=2; ctx.stroke();
}

/* 입체 스트라이크 존 (앞면 + 중간면, KBO ABS 컨셉) */
function drawZone(zone, opts={}){
  const L=ZONE_L, R=ZONE_R, T=zone.top, B=zone.bot;
  // 뒤(중간)면은 원근상 위/안쪽으로 약간 축소·이동
  const dpx=22, dpy=-30, shrink=0.16;
  const bL=L+(R-L)*shrink/2 + dpx, bR=R-(R-L)*shrink/2 + dpx;
  const bT=T+(B-T)*shrink/2 + dpy, bB=B-(B-T)*shrink/2 + dpy;

  // 연결선 (부피)
  ctx.strokeStyle='rgba(255,255,255,.18)'; ctx.lineWidth=1.5;
  [[L,T,bL,bT],[R,T,bR,bT],[L,B,bL,bB],[R,B,bR,bB]].forEach(s=>{
    ctx.beginPath(); ctx.moveTo(s[0],s[1]); ctx.lineTo(s[2],s[3]); ctx.stroke();
  });
  // 뒤(중간)면
  ctx.strokeStyle='rgba(255,255,255,.22)'; ctx.lineWidth=1.5;
  ctx.strokeRect(bL,bT,bR-bL,bB-bT);

  // 앞면 채움 (옅게)
  const acc = opts.highlight ? 'rgba(255,106,0,' : 'rgba(120,200,255,';
  ctx.fillStyle = acc + '0.06)';
  ctx.fillRect(L,T,R-L,B-T);
  // 3x3 그리드
  ctx.strokeStyle='rgba(255,255,255,.16)'; ctx.lineWidth=1;
  for(let i=1;i<3;i++){
    const gx=L+(R-L)*i/3, gy=T+(B-T)*i/3;
    ctx.beginPath(); ctx.moveTo(gx,T); ctx.lineTo(gx,B); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(L,gy); ctx.lineTo(R,gy); ctx.stroke();
  }
  // 앞면 외곽
  ctx.strokeStyle = opts.highlight ? 'rgba(255,150,60,.95)' : 'rgba(255,255,255,.65)';
  ctx.lineWidth = opts.highlight ? 3 : 2;
  ctx.strokeRect(L,T,R-L,B-T);
}

/* 타자 실루엣 */
function drawBatter(b){
  const left = (b.side==='L');
  const x = left ? W/2-96 : W/2+96;
  const baseY = SCENE.plateY+30;
  const topY = SCENE.plateY+30 - (220 + (b.h-168)*3.2); // 키 반영
  ctx.fillStyle='rgba(8,12,20,.92)';
  // 몸통
  ctx.beginPath();
  ctx.moveTo(x-20, baseY);
  ctx.lineTo(x-22, topY+40);
  ctx.quadraticCurveTo(x, topY+10, x+22, topY+44);
  ctx.lineTo(x+20, baseY);
  ctx.closePath(); ctx.fill();
  // 머리+헬멧
  ctx.beginPath(); ctx.arc(x, topY+18, 18, 0, Math.PI*2); ctx.fill();
  // 배트
  ctx.strokeStyle='rgba(20,16,10,.9)'; ctx.lineWidth=6; ctx.lineCap='round';
  const bx = left ? x+18 : x-18, by=topY+40;
  ctx.beginPath(); ctx.moveTo(bx, by);
  ctx.lineTo(left? bx+70 : bx-70, by-80); ctx.stroke();
  ctx.lineCap='butt';
}

/* 포수 실루엣 (전경 하단) */
function drawCatcher(){
  const x=W/2, y=H+30;
  ctx.fillStyle='#0a0f18';
  ctx.beginPath();
  ctx.ellipse(x, y, 150, 130, 0, 0, Math.PI*2); ctx.fill();
  // 헬멧
  ctx.fillStyle='#12202f';
  ctx.beginPath(); ctx.arc(x, H-92, 46, Math.PI, 0); ctx.fill();
  ctx.fillStyle='#0a0f18';
  ctx.fillRect(x-46, H-92, 92, 60);
  // 미트 (한쪽)
  ctx.fillStyle='#5a3416';
  ctx.beginPath(); ctx.arc(x-104, H-70, 30, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle='#6e431d';
  ctx.beginPath(); ctx.arc(x-104, H-70, 22, 0, Math.PI*2); ctx.fill();
}

/* 공 */
function drawBall(x,y,r,withTrail,tx,ty){
  // 그림자
  ctx.fillStyle='rgba(0,0,0,.25)';
  ctx.beginPath(); ctx.ellipse(x, SCENE.plateY+40, r*0.9, r*0.32, 0,0,Math.PI*2); ctx.fill();
  if(withTrail){
    ctx.strokeStyle='rgba(255,255,255,.18)'; ctx.lineWidth=Math.max(1,r*0.5);
    ctx.beginPath(); ctx.moveTo(tx,ty); ctx.lineTo(x,y); ctx.stroke();
  }
  const g=ctx.createRadialGradient(x-r*0.3,y-r*0.3,r*0.2, x,y,r);
  g.addColorStop(0,'#ffffff'); g.addColorStop(1,'#d9dde2');
  ctx.fillStyle=g;
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
  // 실밥
  if(r>7){
    ctx.strokeStyle='#d23b3b'; ctx.lineWidth=Math.max(1,r*0.09);
    ctx.beginPath(); ctx.arc(x-r*0.35, y, r*0.85, -0.9, 0.9); ctx.stroke();
    ctx.beginPath(); ctx.arc(x+r*0.35, y, r*0.85, Math.PI-0.9, Math.PI+0.9); ctx.stroke();
  }
}

/* 베지어 경로 위치 */
function ballAt(t){
  const sx=SCENE.moundX, sy=SCENE.moundY, ex=pitch.cx, ey=pitch.cy;
  // 제어점: 변화구 휨 + 중력 아치
  const mx=(sx+ex)/2 + pitch.breakX;
  const my=(sy+ey)/2 - 40 + pitch.breakY;   // 살짝 위로 떴다가 떨어짐
  const u=1-t;
  const x = u*u*sx + 2*u*t*mx + t*t*ex;
  const y = u*u*sy + 2*u*t*my + t*t*ey;
  const r = SCENE.ballStartR + (SCENE.ballR-SCENE.ballStartR)*Math.pow(t,1.6);
  return {x,y,r};
}

/* ---------- 메인 루프 ---------- */
function render(now){
  applyTransform();
  ctx.clearRect(0,0,W,H);
  drawField();

  if(pitch){
    drawBatter(pitch.b);
    // 존은 '준비'와 '결과'에서만 표시 — 투구 순간 사라짐
    const showZone = (state==='ready' || state==='result');
    if(showZone){
      const hl = (state==='result');
      drawZone(pitch.zone, {highlight: hl && resultInfo && resultInfo.ok});
    }

    if(state==='ready'){
      const p = ballAt(0);                 // 마운드 위 대기 중인 공
      drawBall(p.x, p.y, p.r, false);
      const left = readyDur - (now - readyStart);
      drawReadyCue(Math.max(0, left/readyDur));
      if(left <= 0){ state='pitching'; tStart = now; }
    }
    else if(state==='pitching'){
      const t = Math.min(1,(now - tStart)/(pitch.flight*1000));
      // 구속 카운트업
      $pspeed.textContent = Math.round(pitch.speed * (0.3+0.7*t));
      const prev = ballAt(Math.max(0,t-0.06));
      const p = ballAt(t);
      drawBall(p.x,p.y,p.r,true,prev.x,prev.y);
      if(t>=1){
        $pspeed.textContent = pitch.speed;
        state='decide'; decideStart=now; setButtons(true);
        $timerWrap.classList.add('show'); $timerBar.style.transform='scaleX(1)';
      }
    }
    else if(state==='decide'){
      const p=ballAt(1); drawBall(p.x,p.y,p.r,false);
      const frac = 1 - (now-decideStart)/decideDur;
      $timerBar.style.transform = 'scaleX('+Math.max(0,frac)+')';
      if(frac<=0) timeoutCall();
    }
    else if(state==='result'){
      drawResultFrame();
      const dur = (resultInfo && (resultInfo.callKind==='out'||resultInfo.callKind==='walk')) ? 2200 : 1500;
      if(now - resultStart > dur){
        if(cred<=0) gameOver();
        else startPitch();
      }
    }
  } else {
    // 대기 화면 배경
    drawBatter(BATTERS[0]);
  }

  drawCatcher();
}

/* 애니메이션 루프 — 상시 가동(게임 표준). 검증 시 paused로 일시정지 가능 */
let rafId=null, paused=false;
function loop(now){
  render(now);
  rafId = paused ? null : requestAnimationFrame(loop);
}
function kick(){ if(!rafId && !paused) rafId=requestAnimationFrame(loop); }
function drawOnce(){ render(performance.now()); }

/* 준비 단계 큐: "존을 기억하라" + 사라지기까지 남은 시간 바 */
function drawReadyCue(frac){
  ctx.save();
  ctx.textAlign='center';
  ctx.fillStyle='rgba(255,225,180,'+(0.55+0.45*frac)+')';
  ctx.font='700 22px "Pretendard","Malgun Gothic",sans-serif';
  ctx.fillText('존을 기억하세요', W/2, SCENE.horizon-46);
  ctx.font='600 12px "Pretendard","Malgun Gothic",sans-serif';
  ctx.fillStyle='rgba(255,255,255,.5)';
  ctx.fillText('투구와 동시에 존이 사라집니다', W/2, SCENE.horizon-26);
  // 남은 시간 바
  const bw=160, bx=W/2-bw/2, by=SCENE.horizon-16;
  ctx.fillStyle='rgba(255,255,255,.15)'; ctx.fillRect(bx,by,bw,5);
  ctx.fillStyle='#ff8a3d'; ctx.fillRect(bx,by,bw*frac,5);
  ctx.restore();
}

/* 결과 프레임: 공 위치 + 가장 가까운 경계점 표시 */
function drawResultFrame(){
  const cx=pitch.cx, cy=pitch.cy, z=pitch.zone;
  drawBall(cx,cy,SCENE.ballR,false);
  const nx=Math.max(ZONE_L,Math.min(cx,ZONE_R));
  const ny=Math.max(z.top,Math.min(cy,z.bot));
  ctx.strokeStyle = pitch.truth ? 'rgba(255,80,80,.9)' : 'rgba(80,170,255,.9)';
  ctx.setLineDash([5,4]); ctx.lineWidth=2;
  ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(nx,ny); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle=ctx.strokeStyle;
  ctx.beginPath(); ctx.arc(nx,ny,4,0,Math.PI*2); ctx.fill();
}

/* ---------- 게임 흐름 ---------- */
function startGame(){
  score=0;combo=0;maxCombo=0;calls=0;correct=0;cred=CRED_MAX;
  balls=0;strikes=0;strikeouts=0;walks=0;curBatter=null;curZone=null;newAtBatNext=true;
  updateHUD(); updateCount();
  el('start-screen').classList.add('hidden');
  el('over-screen').classList.add('hidden');
  if(actx && actx.state==='suspended') actx.resume();
  // TTS는 사용자 제스처 후 활성화 — 무음 발화로 워밍업
  if(ttsOK){ try{ speechSynthesis.cancel(); speechSynthesis.resume(); }catch(e){} }
  startPitch();
}

function gameOver(){
  state='idle'; pitch=null;
  const acc = calls? Math.round(correct/calls*100):0;
  el('final-score').textContent=score;
  el('final-acc').textContent=acc+'%';
  el('final-calls').textContent=calls;
  el('final-combo').textContent=maxCombo;
  // 등급
  let grade='C', color='#8ea0b6';
  if(acc>=95&&score>=2500){grade='S 심판';color='#ffd23b';}
  else if(acc>=90){grade='A 심판';color='#22c98a';}
  else if(acc>=80){grade='B 심판';color='#2f9bff';}
  else if(acc>=70){grade='C 심판';color='#ffa14d';}
  else {grade='연수 대상';color='#ff6a6a';}
  const $g=el('grade'); $g.textContent=grade; $g.style.color=color;
  // 최고기록 저장
  saveBest(score, acc);
  el('over-screen').classList.remove('hidden');
}

/* ---------- 로컬 최고기록 ---------- */
function loadBest(){
  let s=0,a=0;
  try{ s=+localStorage.getItem('abs_best_score')||0; a=+localStorage.getItem('abs_best_acc')||0; }catch(e){}
  el('best-score').textContent=s;
  el('best-acc').textContent=a?a+'%':'—';
}
function saveBest(s,a){
  try{
    if(s>(+localStorage.getItem('abs_best_score')||0)) localStorage.setItem('abs_best_score',s);
    if(a>(+localStorage.getItem('abs_best_acc')||0)) localStorage.setItem('abs_best_acc',a);
  }catch(e){}
}

/* ---------- 이벤트 ---------- */
el('btn-start').addEventListener('click', startGame);
el('btn-restart').addEventListener('click', startGame);
$btnBall.addEventListener('click', ()=>makeCall(false));
$btnStrike.addEventListener('click', ()=>makeCall(true));
el('rules-toggle').addEventListener('click', ()=>el('rules-screen').classList.remove('hidden'));
el('btn-close-rules').addEventListener('click', ()=>el('rules-screen').classList.add('hidden'));

window.addEventListener('keydown', e=>{
  if(e.repeat) return;
  const k=e.key.toLowerCase();
  if(k==='f'||k==='arrowleft'){ makeCall(false); }
  else if(k==='j'||k==='arrowright'){ makeCall(true); }
  else if(k===' '||k==='enter'){
    if(!el('start-screen').classList.contains('hidden')) startGame();
    else if(!el('over-screen').classList.contains('hidden')) startGame();
  }
});

/* ---------- 부팅 ---------- */
resize();
loadBest();
updateHUD();
kick();

/* ---------- 디버그/검증 훅 ----------
   운영(배포) 환경에는 노출하지 않음. localhost 이거나 URL에 ?debug 가 있을 때만 활성화 */
if (location.hostname==='localhost' || location.hostname==='127.0.0.1' || location.search.includes('debug'))
window.ABSDEBUG = {
  state:()=>({state,score,combo,maxCombo,calls,correct,cred,balls,strikes,strikeouts,walks,newAtBatNext}),
  pitch:()=>pitch&&{kind:pitch.kind,truth:pitch.truth,speed:pitch.speed,type:pitch.ptype.name,
                    batter:pitch.b.name,cx:Math.round(pitch.cx),cy:Math.round(pitch.cy),
                    top:Math.round(pitch.zone.top),bot:Math.round(pitch.zone.bot)},
  // 검증용: 준비 프레임(존 노출)을 만들어 화면 정지
  freezeReady(kindWanted){
    paused=true; if(rafId){cancelAnimationFrame(rafId); rafId=null;}
    do{ newPitch(); }while(kindWanted && pitch.kind!==kindWanted);
    state='ready'; readyStart=performance.now(); readyDur=99999;
    $ptype.textContent=pitch.ptype.name; $pspeed.textContent='--';
    $bname.textContent=pitch.b.name; $bheight.textContent='키 '+pitch.b.h+'cm';
    setButtons(false); $timerWrap.classList.remove('show');
    drawOnce();
    return this.pitch();
  },
  // 검증용: 결정 프레임을 만들어 화면 정지(공이 플레이트 도달한 모습)
  freezeDecide(kindWanted){
    paused=true; if(rafId){cancelAnimationFrame(rafId); rafId=null;}
    do{ newPitch(); }while(kindWanted && pitch.kind!==kindWanted);
    state='decide'; decideStart=performance.now();
    $ptype.textContent=pitch.ptype.name; $pspeed.textContent=pitch.speed;
    $bname.textContent=pitch.b.name; $bheight.textContent='키 '+pitch.b.h+'cm';
    setButtons(true); $timerWrap.classList.add('show'); $timerBar.style.transform='scaleX(0.7)';
    drawOnce();
    return this.pitch();
  },
  // 검증용: 현재 투구에 대해 콜 적용(렌더 정지 유지)
  call(strike){
    makeCall(!!strike);
    if(rafId){cancelAnimationFrame(rafId); rafId=null;}
    drawOnce();
    return {result:resultInfo, state:state, score, cred, combo};
  },
  resume(){ paused=false; kick(); }
};

})();
