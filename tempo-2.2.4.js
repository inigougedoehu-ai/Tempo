
"use strict";
const API="https://script.google.com/macros/s/AKfycbySnnJn5uhX2WOdqGd2gpQd6N5kFFc6JQWa25gNwvlKs7q1MFKc4TWJjwscwtxH1PuU/exec";
const TZ="Europe/Madrid", KEY="tempo.session.v1", PREF="tempo.prefs.v1", DB="tempo-calendar-v1", POS="tempo.position.v1";
const $=id=>document.getElementById(id);
function el(tag,cls,txt){const n=document.createElement(tag);if(cls)n.className=cls;if(txt!==undefined)n.textContent=txt;return n;}
function load(key,fallback){try{return JSON.parse(localStorage.getItem(key))||fallback;}catch{return fallback;}}
function store(key,val){try{localStorage.setItem(key,JSON.stringify(val));return true;}catch{return false;}}
function remove(key){try{localStorage.removeItem(key);}catch{}}
let pref=load(PREF,{theme:"auto",view:"week",hidden:[]});if(!Array.isArray(pref.hidden))pref.hidden=[];if(!["google","calendar","ehu","custom"].includes(pref.colorMode))pref.colorMode="ehu";if(!pref.customColors||typeof pref.customColors!=="object"||Array.isArray(pref.customColors))pref.customColors={};
let session=null, persistent=false, mainData=null, extraData=null, syncBusy=false, generation=0, pending=false, pendingForce=false, statusText="", warn=true, dbPromise=null, ownerFingerprint=null, syncFailures=0, retryAt=0, lastLatency=0, cacheError=false,cacheEpoch=0;const requestControllers=new Set(),rangeRequests=new Map();
const CALENDAR_VIEWS=["day","three","week","month","agenda"];const VIEWS=[...CALENDAR_VIEWS,"summary","availability","stats"];
if(!pref.aliases||typeof pref.aliases!=="object"||Array.isArray(pref.aliases))pref.aliases={};
pref.dayStart=Number.isInteger(pref.dayStart)?Math.max(0,Math.min(23,pref.dayStart)):0;
pref.dayEnd=Number.isInteger(pref.dayEnd)?Math.max(pref.dayStart+1,Math.min(24,pref.dayEnd)):24;
pref.pastFade=Number.isFinite(pref.pastFade)?Math.max(0,Math.min(75,pref.pastFade)):40;
if(!["day","week","month"].includes(pref.statsPeriod))pref.statsPeriod="week";if(![30,60,120,300].includes(pref.syncSeconds))pref.syncSeconds=60;
let view=VIEWS.includes(pref.startupView)?pref.startupView:pref.startupView==="last"&&VIEWS.includes(pref.view)?pref.view:"summary";let calendarView=CALENDAR_VIEWS.includes(pref.calendarView)?pref.calendarView:CALENDAR_VIEWS.includes(pref.view)?pref.view:"week";
let hourHeight=Math.max(24,Math.min(120,Number(pref.hourHeight)||54)),pinchActive=false,renderAfterPinch=false;
document.documentElement.style.setProperty("--hour",hourHeight+"px");
const partsFmt=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
function parts(t){return Object.fromEntries(partsFmt.formatToParts(t).filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));}
function civil(t=new Date()){const p=parts(t);return p.year+"-"+p.month+"-"+p.day;}
function utc(d){return new Date(d+"T00:00:00Z");}
function add(d,n){const t=utc(d);t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10);}
function midnight(d){let guess=utc(d).getTime();for(let i=0;i<3;i++){const p=parts(new Date(guess));const actual=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);guess+=utc(d).getTime()-actual;}return new Date(guess).toISOString();}
function weekStart(d){return add(d,-((utc(d).getUTCDay()+6)%7));}
function monthStart(d){return d.slice(0,7)+"-01";}
function shiftMonth(d,n){const t=utc(monthStart(d));t.setUTCMonth(t.getUTCMonth()+n);return t.toISOString().slice(0,10);}
function fmt(d,opts){return new Intl.DateTimeFormat("es-ES",{timeZone:"UTC",...opts}).format(utc(d));}
function clock(t){return new Intl.DateTimeFormat("es-ES",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(t));}
let selected=civil(),calendarDate=selected,statsDate=selected;
function windowRange(){const t=civil();return {from:add(t,-30),to:add(t,91)};}
function visibleRange(){if(view==="summary")return {from:civil(),to:add(civil(),2)};if(view==="availability")return {from:civil(),to:add(civil(),1)};if(view==="stats"){if(pref.statsPeriod==="day")return {from:selected,to:add(selected,1)};if(pref.statsPeriod==="month"){const f=monthStart(selected);return {from:f,to:shiftMonth(f,1)};}const f=weekStart(selected);return {from:f,to:add(f,7)};}if(view==="day")return {from:selected,to:add(selected,1)};if(view==="three")return {from:selected,to:add(selected,3)};if(view==="week"){const f=weekStart(selected);return {from:f,to:add(f,7)};}if(view==="month"){const f=weekStart(monthStart(selected));return {from:f,to:add(f,42)};}return {from:selected,to:add(selected,30)};}
function covers(data,r){return !!data&&data.from<=r.from&&data.to>=r.to;}
function savePref(){pref.view=view;if(CALENDAR_VIEWS.includes(view)){calendarView=view;calendarDate=selected;}else if(view==="stats")statsDate=selected;pref.calendarView=calendarView;store(PREF,pref);}
function theme(){document.documentElement.dataset.theme=pref.theme==="dark"||(pref.theme==="auto"&&matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light";$("theme").value=pref.theme;applyAccent();}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change",theme);theme();
function db(){if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{const req=indexedDB.open(DB,1);req.onupgradeneeded=()=>req.result.createObjectStore("data");req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});return dbPromise;}
async function cacheOp(mode,action){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction("data",mode),req=action(tx.objectStore("data"));let val;req.onsuccess=()=>val=req.result;tx.oncomplete=()=>resolve(val);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
const readCache=()=>cacheOp("readonly",s=>s.get("window"));
const writeCache=x=>cacheOp("readwrite",s=>s.put(x,"window"));
const clearCache=()=>cacheOp("readwrite",s=>s.clear());
function token(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("");}
async function api(data){
 const ctl=new AbortController(),timeout=setTimeout(()=>ctl.abort(),data.accion==="eventos"?45000:25000);requestControllers.add(ctl);
 try{const r=await fetch(API,{method:"POST",headers:{"Content-Type":"text/plain;charset=UTF-8"},credentials:"omit",cache:"no-store",redirect:"follow",signal:ctl.signal,body:JSON.stringify(data)});if(!r.ok)throw Error("HTTP "+r.status);const j=await r.json();if(!j.ok)throw Error(j.error||"ERROR_SERVIDOR");return j;}
 finally{clearTimeout(timeout);requestControllers.delete(ctl);}
}
function status(s,w=false){statusText=s;warn=w;$("status").textContent=s;$("dot").classList.toggle("warn",w);if($("syncSettingsStatus"))$("syncSettingsStatus").textContent=s;updateAvailability();}
function stamp(data){return data?.sincronizado?new Intl.DateTimeFormat("es-ES",{timeZone:TZ,day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(new Date(data.sincronizado)):"";}
function dataFor(r){return covers(mainData,r)?mainData:covers(extraData,r)?extraData:null;}
async function fingerprint(t){const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t));return Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,"0")).join("");}
function cacheOwner(){return ownerFingerprint;}
function validSession(s){return !!s&&typeof s.token==="string"&&/^[a-f0-9]{64}$/.test(s.token)&&Number.isFinite(Number(s.expiracion))&&Number(s.expiracion)>Date.now();}
function cacheAAD(owner){return new TextEncoder().encode("Tempo/cache/v2/"+owner);}
async function cacheKey(t,salt){
 const material=await crypto.subtle.importKey("raw",new TextEncoder().encode(t),"HKDF",false,["deriveKey"]);
 return crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",salt,info:new TextEncoder().encode("Tempo encrypted calendar cache v2")},material,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
async function sealCache(t,owner,data,extra){
 const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await cacheKey(t,salt);
 const plaintext=new TextEncoder().encode(JSON.stringify({data,extra}));
 const ciphertext=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:cacheAAD(owner),tagLength:128},key,plaintext);
 return {version:2,owner,salt,iv,ciphertext};
}
async function unsealCache(record,t,owner){
 if(record.version!==2||record.owner!==owner||!(record.salt instanceof Uint8Array)||record.salt.length!==16||!(record.iv instanceof Uint8Array)||record.iv.length!==12||!(record.ciphertext instanceof ArrayBuffer))throw Error("CACHE_INVALIDA");
 const key=await cacheKey(t,record.salt),clear=await crypto.subtle.decrypt({name:"AES-GCM",iv:record.iv,additionalData:cacheAAD(owner),tagLength:128},key,record.ciphertext);
 return JSON.parse(new TextDecoder().decode(clear));
}
function validSnapshot(d){return !!d&&validDate(d.from)&&validDate(d.to)&&d.from<d.to&&Array.isArray(d.eventos)&&Array.isArray(d.calendarios)&&Number.isFinite(Date.parse(d.sincronizado));}
function canPersist(g,epoch){return g===generation&&epoch===cacheEpoch&&validSession(session)&&persistent&&pref.offlineCache!==false&&!!ownerFingerprint;}
function sessionStillLocal(){
 if(!validSession(session)){if(session){resetLocal();$("loginStatus").textContent="Sesión caducada. Introduce tu clave.";}return false;}
 if(persistent&&load(KEY,null)?.token!==session.token){resetLocal(false);$("loginStatus").textContent="La sesión se cerró en otra ventana.";return false;}
 return true;
}
function overlaps(e,d){if(e.diaCompleto)return e.inicio<=d&&e.fin>d;return Date.parse(e.inicio)<Date.parse(midnight(add(d,1)))&&Date.parse(e.fin)>Date.parse(midnight(d));}
function prune(data,r){if(!data)return null;const a=midnight(r.from),b=midnight(r.to);return {...data,from:data.from>r.from?data.from:r.from,to:data.to<r.to?data.to:r.to,eventos:data.eventos.filter(e=>e.diaCompleto?e.inicio<r.to&&e.fin>r.from:Date.parse(e.inicio)<Date.parse(b)&&Date.parse(e.fin)>Date.parse(a))};}
async function resetLocal(removeStored=true){generation++;cacheEpoch++;for(const c of requestControllers)c.abort();rangeRequests.clear();session=null;persistent=false;ownerFingerprint=null;mainData=null;extraData=null;pending=false;pendingForce=false;syncFailures=0;retryAt=0;calendarScroll=null;restorePosition=null;quickEvent=null;clearQuickContent();if(removeStored){remove(KEY);remove(POS);}$("calendar").replaceChildren();$("filters").replaceChildren();$("settingsFilters").replaceChildren();$("colorSettings").replaceChildren();clearSearch();detailCopy="";$("eventCalendar").replaceChildren();$("eventMap").removeAttribute("href");$("copyStatus").textContent="";$("calendarAliases").replaceChildren();$("availabilityContent").replaceChildren();for(const d of document.querySelectorAll("dialog"))if(d.open)d.close();$("eventTitle").textContent="";$("eventDescription").textContent="";$("eventLocation").textContent="";$("eventMeta").textContent="";$("app").hidden=true;$("login").hidden=false;status("Sesión cerrada",true);if(removeStored)try{await clearCache();}catch{}}
async function signOut(){const old=session;await resetLocal();$("loginStatus").textContent="Sesión cerrada.";if(old)try{await api({accion:"logout",token:old.token});}catch{$("loginStatus").textContent="Sesión local cerrada. No se pudo revocar el token remoto."}}
async function fetchRange(r,t){
 const key=generation+":"+r.from+":"+r.to;if(rangeRequests.has(key))return rangeRequests.get(key);
 const promise=(async()=>{const j=await api({accion:"eventos",token:t,desde:midnight(r.from),hasta:midnight(r.to)});if(!Array.isArray(j.eventos)||!Array.isArray(j.calendarios)||!Number.isFinite(Date.parse(j.sincronizado)))throw Error("RESPUESTA_INVALIDA");return {...j,from:r.from,to:r.to};})();
 rangeRequests.set(key,promise);try{return await promise;}finally{if(rangeRequests.get(key)===promise)rangeRequests.delete(key);}
}
function syncAge(data){return data&&Number.isFinite(Date.parse(data.sincronizado))?Math.max(0,Date.now()-Date.parse(data.sincronizado)):Infinity;}
function freshEnough(data){return syncAge(data)<pref.syncSeconds*1000;}
function retryDelay(n){return Math.min(300000,15000*2**Math.max(0,n-1));}
function expandedRange(r){return {from:add(r.from,-7),to:add(r.to,7)};}
function explainSyncError(e){if(e.name==="AbortError")return "La consulta superó el tiempo de espera";if(/HTTP (429|503)/.test(e.message))return "Servidor temporalmente ocupado";if(e.message==="RESPUESTA_INVALIDA")return "Respuesta del servidor no válida";if(!navigator.onLine)return "Sin conexión";return "No se pudo contactar con el servidor";}
async function persistSnapshot(g){
 const epoch=cacheEpoch;if(!canPersist(g,epoch)||!validSnapshot(mainData))return;
 const t=session.token,owner=cacheOwner(),data=mainData,extra=extraData;
 try{
  const encrypted=await sealCache(t,owner,data,extra);
  if(!canPersist(g,epoch)||owner!==cacheOwner())return;
  await writeCache(encrypted);if(g===generation&&epoch===cacheEpoch)cacheError=false;
 }catch{if(g===generation&&epoch===cacheEpoch)cacheError=true;}
 if(g===generation)updateSyncDiagnostics();
}
async function sync(force=false){
 if(!session)return;
 if(!sessionStillLocal())return;
 if(syncBusy){pending=true;pendingForce=pendingForce||force;return;}
 const v=visibleRange(),r=windowRange();
 if(!navigator.onLine){status("Sin conexión · "+(stamp(dataFor(v))||"sin datos guardados"),true);render();return;}
 if(!force&&Date.now()<retryAt){updateSyncDiagnostics();return;}
 const needMain=force||!covers(mainData,r)||!freshEnough(mainData);
 const needExtra=!covers(mainData,v)&&(force||!covers(extraData,v)||!freshEnough(extraData));
 if(!needMain&&!needExtra){updateSyncDiagnostics();return;}
 syncBusy=true;const g=generation,t=session.token,start=Date.now();$("refresh").disabled=true;updateSyncDiagnostics();
 try{
  if(needMain){const fresh=await fetchRange(r,t);if(g!==generation)return;mainData=fresh;render();}
  if(g!==generation)return;
  const current=visibleRange();
  if(!covers(mainData,current)&&(force||!covers(extraData,current)||!freshEnough(extraData))){const fresh=await fetchRange(expandedRange(current),t);if(g!==generation)return;extraData=fresh;}
  if(g!==generation)return;
  syncFailures=0;retryAt=0;lastLatency=Date.now()-start;
  const d=dataFor(visibleRange());status(d?"Actualizado · "+stamp(d):"Consultando fechas…",!d);
  await persistSnapshot(g);
 }catch(e){
  if(g!==generation)return;
  if(e.message==="NO_AUTORIZADO"||e.message==="HTTP 401"||e.message==="HTTP 403"){await resetLocal();$("loginStatus").textContent="La sesión ya no es válida. Introduce tu clave.";}
  else{syncFailures++;retryAt=Date.now()+retryDelay(syncFailures);const d=dataFor(visibleRange());status(explainSyncError(e)+" · "+(d?"datos guardados":"sin datos guardados"),true);}
 }finally{
  syncBusy=false;$("refresh").disabled=false;
  if(g===generation&&session){render();updateAvailability();updateSyncDiagnostics();}
  if(pending){const f=pendingForce;pending=false;pendingForce=false;if(session)sync(f);}
 }
}
async function enter(s,remember,restore){
 if(!validSession(s)){remove(KEY);try{await clearCache();}catch{}$("loginStatus").textContent="Sesión no válida. Introduce tu clave.";return;}
 focusNowOnRender=true;session=s;persistent=remember;generation++;cacheEpoch++;const g=generation,epoch=cacheEpoch;mainData=null;extraData=null;ownerFingerprint=null;syncFailures=0;retryAt=0;cacheError=false;
 if(remember&&restore&&pref.rememberPosition!==false)loadPosition();
 $("login").hidden=true;$("app").hidden=false;status("Conectando…",true);render();
 if(remember){
  try{
   const hash=await fingerprint(s.token);if(g!==generation)return;ownerFingerprint=hash;
   if(restore&&pref.offlineCache!==false){
    const c=await readCache();if(!canPersist(g,epoch))return;
    if(c){
     let snapshot=null,legacy=false;
     try{
      if(c.version===2)snapshot=await unsealCache(c,s.token,hash);
      else if(c.owner===hash||c.owner===s.token){snapshot={data:c.data,extra:c.extra};legacy=true;}
      if(!canPersist(g,epoch))return;
      if(!validSnapshot(snapshot?.data))throw Error("CACHE_INVALIDA");
      mainData=prune(snapshot.data,windowRange());if(validSnapshot(snapshot.extra))extraData=snapshot.extra;
      if(legacy){try{await clearCache();}catch{cacheError=true;}if(!canPersist(g,epoch))return;await persistSnapshot(g);}
      if(g!==generation)return;status("Datos guardados · "+stamp(mainData),true);render();
     }catch{if(g!==generation||epoch!==cacheEpoch)return;cacheError=true;try{await clearCache();}catch{}}
    }
   }else if(pref.offlineCache===false){try{await clearCache();}catch{cacheError=true;}}
  }catch{if(g===generation)cacheError=true;}
 }
 if(g===generation)sync(true);
}
$("loginForm").addEventListener("submit",async e=>{e.preventDefault();$("loginButton").disabled=true;$("loginStatus").textContent="Conectando…";const t=token(),clave=$("key").value.trim();$("key").value="";try{const j=await api({accion:"login",clave,token:t});const s={token:t,expiracion:Number(j.expiracion)};if(!validSession(s))throw Error("SESION_INVALIDA");let remember=$("remember").checked;if(remember)remember=store(KEY,s);else remove(KEY);try{await clearCache();}catch{}await enter(s,remember,false);}catch(e){$("loginStatus").textContent=e.message==="CREDENCIALES_INVALIDAS"?"Clave incorrecta.":"No se pudo conectar. Comprueba tu conexión e inténtalo otra vez.";}finally{$("loginButton").disabled=false;}});
function displayEvent(e){
 if(e.diaCompleto||!e.inicio||!e.fin)return e;
 const start=new Date(e.inicio),end=new Date(e.fin);
 if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start)return e;
 const a=parts(start),b=parts(end),first=civil(start),last=civil(end);
 const startsAtMidnight=a.hour==="00"&&a.minute==="00"&&a.second==="00";
 const endsAtDayEnd=b.hour==="23"&&b.minute==="59";
 const endsAtNextMidnight=b.hour==="00"&&b.minute==="00"&&b.second==="00"&&last>first;
 if(!startsAtMidnight||(!endsAtDayEnd&&!endsAtNextMidnight))return e;
 return {...e,diaCompleto:true,inicio:first,fin:endsAtDayEnd?add(last,1):last};
}
function visibleEvents(data){const q=$("search").value.trim().toLocaleLowerCase("es");return (data?.eventos||[]).filter(e=>!pref.hidden.includes(e.calendarioId)&&(!q||[e.titulo,e.ubicacion,e.descripcion].some(s=>String(s||"").toLocaleLowerCase("es").includes(q)))).map(displayEvent);}
function safeColor(c){return /^#[0-9a-f]{6}$/i.test(c||"")?c:"#dce1ff";}

const EHU_COLORS=[
 ["Uniberdea","#5FD790"],["Berde leuna","#B0FBC1"],
 ["Egunsentia","#FE8B66"],["Zerua","#7E8EFE"],
 ["Argia","#E4F568"],["Behe lainoa","#C6ACF5"],
 ["Lurra","#EEECE9"],["Egurra","#B1AB9F"],["Haritz zuria","#FFFFFF"]
];
function currentCalendars(){
 return dataFor(visibleRange())?.calendarios||mainData?.calendarios||extraData?.calendarios||[];
}
function ehuDefault(c){
 const name=String(c.nombre||"").toLocaleLowerCase("es");
 if(name.includes("2023-2026"))return "#B1AB9F";
 if(name.startsWith("exámenes"))return "#E4F568";
 if(name.startsWith("horario"))return "#7E8EFE";
 if(name.startsWith("personal"))return "#C6ACF5";
 if(name.startsWith("consejo"))return "#FE8B66";
 return EHU_COLORS[0][1];
}
function calendarColor(c){
 if(pref.colorMode==="ehu")return ehuDefault(c);
 if(pref.colorMode==="custom")return /^#[0-9a-f]{6}$/i.test(pref.customColors[c.id]||"")?pref.customColors[c.id]:ehuDefault(c);
 return safeColor(c.color);
}
function eventColor(e){
 if(pref.colorMode==="google")return safeColor(e.color);
 const c=currentCalendars().find(c=>c.id===e.calendarioId);
 return c?calendarColor(c):safeColor(e.color);
}
function contrastingText(color){
 const rgb=safeColor(color).slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
 const lum=rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
 return lum>0.179?"#000000":"#ffffff";
}

function eventEndTime(e){
 if(e.diaCompleto)return Date.parse(midnight(e.fin));
 return Date.parse(e.fin);
}
function fadedEventColor(hex){
 const c=safeColor(hex).slice(1).match(/../g).map(x=>parseInt(x,16));
 return "#"+c.map(v=>Math.round(v+(255-v)*pref.pastFade/100).toString(16).padStart(2,"0")).join("");
}
function applyEventAppearance(node,now=Date.now()){
 const base=node.dataset.eventColor;
 const end=Number(node.dataset.eventEnd);
 const past=Number.isFinite(end)&&end<=now;
 const color=past?fadedEventColor(base):base;
 node.classList.toggle("pastEvent",past);
 if(node.classList.contains("agendaitem")){
  const dot=node.querySelector(".swatch");
  if(dot)dot.style.backgroundColor=color;
 }else{
  node.style.setProperty("--event",color);
  node.style.color=contrastingText(color);
 }
}
function bindEventAppearance(node,e,swatch){
 const end=eventEndTime(e);
 node.dataset.eventEnd=Number.isFinite(end)?String(end):"NaN";
 node.dataset.eventColor=eventColor(e);
 if(swatch){swatch.style.backgroundColor=end<=Date.now()?fadedEventColor(node.dataset.eventColor):node.dataset.eventColor;node.classList.toggle("pastEvent",end<=Date.now());}
 else applyEventAppearance(node);
}
function updatePastEvents(){
 const now=Date.now();
 for(const node of $("calendar").querySelectorAll("[data-event-end]")){
  const past=Number(node.dataset.eventEnd)<=now;
  if(node.classList.contains("pastEvent")!==past)applyEventAppearance(node,now);
 }
}

function renderColorSettings(){
 const mode=pref.colorMode,root=$("colorSettings");
 $("colorMode").value=mode;
 $("colorModeHint").textContent={
 google:"Respeta también los colores individuales de los eventos.",
 calendar:"Cada evento usa el color original de su calendario.",
 ehu:"Usa la paleta corporativa de la EHU por calendario.",
 custom:"Elige un color de la paleta EHU o cualquier otro color para cada calendario."
 }[mode];
 root.replaceChildren();
 $("resetColors").hidden=mode!=="custom";
 if(mode!=="ehu"&&mode!=="custom")return;
 for(const c of currentCalendars()){
  const row=el("div","colorRow"),dot=el("span","colorPreview"),name=el("span","colorName",calendarName(c)),value=calendarColor(c);
  dot.style.backgroundColor=value;row.append(dot,name);
  if(mode==="custom"){
   const select=el("select","colorChoice");
   select.setAttribute("aria-label","Color de "+c.nombre);
   for(const [label,hex] of EHU_COLORS){const o=el("option","",label);o.value=hex;select.append(o);}
   const other=el("option","","Otro color");other.value="other";select.append(other);
   const picker=el("input","customColorInput");picker.type="color";picker.value=value;picker.setAttribute("aria-label","Color personalizado de "+c.nombre);
   select.value=EHU_COLORS.find(([,hex])=>hex.toLowerCase()===value.toLowerCase())?.[1]||"other";
   function setColor(hex){
    pref.customColors[c.id]=hex;savePref();
    dot.style.backgroundColor=hex;picker.value=hex;
    select.value=EHU_COLORS.find(([,h])=>h.toLowerCase()===hex.toLowerCase())?.[1]||"other";render();
   }
   select.onchange=()=>{if(select.value==="other"){picker.focus();picker.click();}else setColor(select.value);};
   picker.onchange=()=>setColor(picker.value);
   row.append(select,picker);
  }else{
   row.append(el("small","colorCode",EHU_COLORS.find(([,hex])=>hex===value)?.[0]||value));
  }
  root.append(row);
 }
}
$("colorMode").onchange=e=>{pref.colorMode=e.target.value;savePref();renderColorSettings();render();};
$("resetColors").onclick=()=>{pref.customColors={};savePref();renderColorSettings();render();};

let detailCopy="";
function showEvent(e){
 const c=currentCalendars().find(c=>c.id===e.calendarioId),name=c?calendarName(c):"",d=$("eventCalendar");d.replaceChildren();const dot=el("span","swatch");dot.style.background=eventColor(e);d.append(dot,document.createTextNode(name||"Calendario"));
 $("eventTitle").textContent=e.titulo;
 const start=e.diaCompleto?e.inicio:civil(new Date(e.inicio)),end=e.diaCompleto?add(e.fin,-1):civil(new Date(e.fin));
 const dayText=fmt(start,{dateStyle:"full"})+(start!==end?" – "+fmt(end,{dateStyle:"full"}):"");
 const timeText=e.diaCompleto?"Todo el día":clock(e.inicio)+" – "+clock(e.fin)+" · "+durationText(Date.parse(e.fin)-Date.parse(e.inicio));
 $("eventMeta").textContent=dayText+"\n"+timeText;
 $("eventRecurrence").hidden=!e.recurrente;$("eventLocationRow").hidden=!e.ubicacion;$("eventDescriptionRow").hidden=!e.descripcion;
 $("eventLocation").textContent=e.ubicacion||"";$("eventDescription").textContent=e.descripcion||"";
 if(e.ubicacion)$("eventMap").href="https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(e.ubicacion);else $("eventMap").removeAttribute("href");
 detailCopy=[e.titulo,dayText,timeText,name,e.ubicacion,e.descripcion].filter(Boolean).join("\n");$("copyStatus").textContent="";
 openPanel("detail");
}
$("copyEvent").onclick=async()=>{try{await navigator.clipboard.writeText(detailCopy);$("copyStatus").textContent="Detalles copiados.";}catch{$("copyStatus").textContent="No se pudo copiar. Puedes seleccionar el texto de la ficha.";}};

function eventButton(e,withTime=false){const n=el("button","event");n.append(el("span","eventName",e.titulo));bindEventAppearance(n,e);if(withTime&&!e.diaCompleto&&pref.showEventTimes!==false)n.append(el("small","",clock(e.inicio)+" – "+clock(e.fin)));n.addEventListener("click",()=>showEvent(e));bindQuickActions(n,e);n.title=e.titulo;return n;}
function dayJump(d){selected=d;view="day";savePref();navigate();}
function filters(data){const cals=data?.calendarios||mainData?.calendarios||extraData?.calendarios||[];$("filters").replaceChildren();$("settingsFilters").replaceChildren();for(const c of cals){const b=el("button","chip"+(pref.hidden.includes(c.id)?" off":""));const dot=el("span","swatch");dot.style.background=calendarColor(c);b.append(dot,document.createTextNode(calendarName(c)));b.setAttribute("aria-pressed",String(!pref.hidden.includes(c.id)));const toggle=()=>{pref.hidden=pref.hidden.includes(c.id)?pref.hidden.filter(x=>x!==c.id):[...pref.hidden,c.id];savePref();render();};b.onclick=toggle;$("filters").append(b);const l=el("label","check"),i=el("input");i.type="checkbox";i.checked=!pref.hidden.includes(c.id);i.onchange=toggle;l.append(i,document.createTextNode(calendarName(c)));$("settingsFilters").append(l);}}
function minutes(t){const p=parts(new Date(t));return +p.hour*60 + +p.minute;}
function renderWeek(r,events,container){const days=[];for(let d=r.from;d<r.to;d=add(d,1))if(view!=="week"||!pref.workweek||utc(d).getUTCDay()%6!==0)days.push(d);const sc=el("div","scroll"),w=el("div","week"+(days.length===1?" one":days.length===3?" three":""));const grid="var(--time-col,44px) repeat("+days.length+",minmax(0,1fr))";const head=el("div","weekhead");head.style.gridTemplateColumns=grid;head.append(el("div"));for(const d of days){const h=el("button","dayhead"+(d===civil()?" today":""));h.append(el("small","",fmt(d,{weekday:"short"})),el("strong","",String(+d.slice(-2))));h.onclick=()=>dayJump(d);head.append(h);}w.append(head);const ar=el("div","allrow allSpan");ar.style.gridTemplateColumns=grid;fillAllDayGrid(ar,days,events,1);w.append(ar);const timed=el("div","timed");timed.style.gridTemplateColumns=grid;timed.style.setProperty("--day-hours",String(pref.dayEnd-pref.dayStart));const hours=el("div","hours");for(let h=pref.dayStart;h<pref.dayEnd;h++)hours.append(el("div","hour",String(h).padStart(2,"0")+":00"));timed.append(hours);for(const d of days){const col=el("div","daycol");const items=events.filter(e=>!e.diaCompleto&&overlaps(e,d)).map(e=>({e,start:civil(new Date(e.inicio))<d?0:minutes(e.inicio),end:civil(new Date(e.fin))>d?1440:minutes(e.fin)})).filter(x=>x.end>pref.dayStart*60&&x.start<pref.dayEnd*60).map(x=>({...x,start:Math.max(pref.dayStart*60,x.start),end:Math.min(pref.dayEnd*60,x.end)})).map(x=>({...x,end:Math.min(pref.dayEnd*60,Math.max(x.start+15,x.end))})).sort((a,b)=>a.start-b.start||b.end-a.end);let cluster=[],end=-1;function flush(){if(!cluster.length)return;const lanes=[];for(const x of cluster){let lane=lanes.findIndex(y=>y<=x.start);if(lane<0)lane=lanes.length;lanes[lane]=x.end;x.lane=lane;}for(const x of cluster){const b=eventButton(x.e,true);if(lanes.length>1)b.classList.add("overlapEvent");b.style.top=((x.start-pref.dayStart*60)/((pref.dayEnd-pref.dayStart)*60)*100)+"%";b.style.height=((x.end-x.start)/((pref.dayEnd-pref.dayStart)*60)*100)+"%";b.style.left=(x.lane/lanes.length*100)+"%";b.style.width="calc("+100/lanes.length+"% - 2px)";col.append(b);}cluster=[];end=-1;}for(const x of items){if(x.start>=end)flush();cluster.push(x);end=Math.max(end,x.end);}flush();timed.append(col);}if(days.includes(civil())){const line=el("div","nowline");line.append(el("span","nowlabel"));timed.append(line);updateNowLine(timed);}w.append(timed);sc.append(w);container.append(sc);ar.style.top=head.offsetHeight+"px";bindVerticalZoom(sc,timed);return sc;}

function spanLayout(days,events){
 const first=days[0],end=add(days[days.length-1],1);
 const spans=events.filter(e=>e.diaCompleto&&e.inicio<end&&e.fin>first)
 .map(e=>({e,start:Math.max(0,Math.round((utc(e.inicio)-utc(first))/86400000)),end:Math.min(days.length,Math.round((utc(e.fin)-utc(first))/86400000))}))
 .filter(x=>x.end>x.start).sort((a,b)=>a.start-b.start||b.end-a.end||a.e.titulo.localeCompare(b.e.titulo));
 const lanes=[];
 for(const x of spans){let lane=lanes.findIndex(y=>y<=x.start);if(lane<0)lane=lanes.length;lanes[lane]=x.end;x.lane=lane;}
 return {spans,count:lanes.length};
}
function spanButton(x,days){
 const b=eventButton(x.e);b.classList.add("spanEvent");
 if(x.e.inicio<days[0])b.classList.add("continuesLeft");
 if(x.e.fin>add(days[days.length-1],1))b.classList.add("continuesRight");
 return b;
}
function fillAllDayGrid(ar,days,events,offset){
 const {spans,count}=spanLayout(days,events);
 const rows=Math.max(1,count);ar.style.gridTemplateRows="repeat("+rows+",minmax(19px,auto))";
 const label=el("div","label","Todo el día");label.style.gridColumn="1";label.style.gridRow="1 / "+(rows+1);ar.append(label);
 for(let i=0;i<days.length;i++){const bg=el("div","allDayBackground");bg.style.gridColumn=String(i+1+offset);bg.style.gridRow="1 / "+(rows+1);ar.append(bg);}
 for(const x of spans){const b=spanButton(x,days);b.style.gridColumn=(x.start+1+offset)+" / "+(x.end+1+offset);b.style.gridRow=String(x.lane+1);ar.append(b);}
}
function renderMonth(r,events,container){
 const m=el("div","month");for(const d of ["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"])m.append(el("div","monthlabel",d));
 for(let start=r.from;start<r.to;start=add(start,7)){
  const days=Array.from({length:7},(_,i)=>add(start,i)),week=el("div","monthWeek");
  const {spans,count}=spanLayout(days,events),shown=Math.min(count,3),lastRow=shown+2;
  week.style.gridTemplateRows="25px "+(shown?"repeat("+shown+",18px) ":"")+"minmax(42px,auto)";
  days.forEach((date,i)=>{
   const dim=date.slice(0,7)!==selected.slice(0,7),today=date===civil(),bg=el("div","monthBg"+(dim?" dim":""));
   bg.style.gridColumn=String(i+1);bg.style.gridRow="1 / "+(lastRow+1);week.append(bg);
   const n=el("button","monthNum"+(today?" today":"")+(dim?" dim":""),String(+date.slice(-2)));n.style.gridColumn=String(i+1);n.style.gridRow="1";n.onclick=()=>dayJump(date);week.append(n);
   const cell=el("div","monthEvents"+(dim?" dim":""));cell.style.gridColumn=String(i+1);cell.style.gridRow=String(lastRow);
   const items=events.filter(e=>!e.diaCompleto&&overlaps(e,date));for(const e of items.slice(0,3))cell.append(eventButton(e));
   const extra=Math.max(0,items.length-3)+spans.filter(x=>x.lane>=shown&&x.start<=i&&i<x.end).length;
   if(extra){const more=el("button","more","+"+extra+" más");more.onclick=()=>dayJump(date);cell.append(more);}
   week.append(cell);
  });
  for(const x of spans.filter(x=>x.lane<shown)){const b=spanButton(x,days);b.style.gridColumn=(x.start+1)+" / "+(x.end+1);b.style.gridRow=String(x.lane+2);week.append(b);}
  m.append(week);
 }
 container.append(m);
}
function renderAgenda(r,events,container){const a=el("div","agenda");let count=0;for(let d=r.from;d<r.to;d=add(d,1)){const items=events.filter(e=>overlaps(e,d));if(!items.length)continue;a.append(el("h3","",fmt(d,{dateStyle:"full"})));for(const e of items){count++;const b=el("button","agendaitem"),s=el("span","swatch"),info=el("div");bindEventAppearance(b,e,s);info.append(el("strong","",e.titulo),el("small","",e.diaCompleto?"Todo el día":clock(e.inicio)+" – "+clock(e.fin)));b.append(s,info);b.onclick=()=>showEvent(e);bindQuickActions(b,e);a.append(b);}}if(!count)a.append(el("div","empty","No hay eventos en este periodo."));container.append(a);}

function updateScaleControl(){
 $("hourScale").value=String(hourHeight);
 $("hourScaleValue").textContent=hourHeight<45?"Compacta":hourHeight>68?"Extendida":"Normal";
}
function applyHourHeight(value,sc,timed,anchorHours,clientY){
 hourHeight=Math.max(24,Math.min(120,Math.round(value)));
 document.documentElement.style.setProperty("--hour",hourHeight+"px");
 if(sc&&timed&&Number.isFinite(anchorHours)&&Number.isFinite(clientY)){
  const desired=timed.getBoundingClientRect().top+anchorHours*hourHeight-clientY;
  sc.scrollTop+=desired;
 }
 updateScaleControl();
}
function persistHourHeight(){pref.hourHeight=hourHeight;savePref();}
function changeScale(value){
 const sc=$("calendar").querySelector(".scroll"),timed=sc?.querySelector(".timed");
 const y=sc?sc.getBoundingClientRect().top+sc.clientHeight/2:0;
 const anchor=timed?(y-timed.getBoundingClientRect().top)/hourHeight:0;
 applyHourHeight(value,sc,timed,anchor,y);persistHourHeight();
}
$("hourScale").addEventListener("input",e=>changeScale(Number(e.target.value)));
$("resetScale").onclick=()=>changeScale(54);
function bindVerticalZoom(sc,timed){
 let gesture=null,suppressUntil=0;
 const distance=ts=>Math.hypot(ts[0].clientX-ts[1].clientX,ts[0].clientY-ts[1].clientY);
 const center=ts=>(ts[0].clientY+ts[1].clientY)/2;
 function begin(e){
  if(e.touches.length!==2||gesture)return;
  if(e.cancelable)e.preventDefault();
  const y=center(e.touches);
  gesture={distance:Math.max(12,distance(e.touches)),height:hourHeight,anchor:Math.max(0,Math.min(pref.dayEnd-pref.dayStart,(y-timed.getBoundingClientRect().top)/hourHeight))};
  pinchActive=true;
 }
 sc.addEventListener("touchstart",begin,{passive:false});
 sc.addEventListener("touchmove",e=>{
  if(e.touches.length===2){
   if(!gesture)begin(e);
   if(!gesture)return;
   if(e.cancelable)e.preventDefault();
   const ratio=distance(e.touches)/gesture.distance;
   applyHourHeight(gesture.height*ratio,sc,timed,gesture.anchor,center(e.touches));
  }else if(gesture&&e.cancelable)e.preventDefault();
 },{passive:false});
 function finish(e){
  if(!gesture)return;
  if(e.cancelable)e.preventDefault();
  if(e.touches.length&&e.type!=="touchcancel")return;
  gesture=null;pinchActive=false;suppressUntil=Date.now()+350;persistHourHeight();
  if(renderAfterPinch){renderAfterPinch=false;render();}
 }
 sc.addEventListener("touchend",finish,{passive:false});
 sc.addEventListener("touchcancel",finish,{passive:false});
 for(const name of ["gesturestart","gesturechange","gestureend"])sc.addEventListener(name,e=>{if(e.cancelable)e.preventDefault();},{passive:false});
 sc.addEventListener("click",e=>{if(gesture||Date.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation();}},true);
}

let lastRangeKey="",focusNowOnRender=true;
function containsToday(r){const t=civil();return r.from<=t&&t<r.to;}
function updateNowLine(root=$("calendar")){
 const line=root.querySelector(".nowline");if(!line)return;
 const now=new Date();
 const minute=minutes(now),start=pref.dayStart*60,end=pref.dayEnd*60;line.hidden=minute<start||minute>=end;line.style.top=(minute-start)/(end-start)*100+"%";
 line.querySelector(".nowlabel").textContent=clock(now);
}
function centerCurrentHour(sc){
 const timed=sc.querySelector(".timed");if(!timed)return;
 const line=timed.querySelector(".nowline");if(!line)return;
 const headers=(sc.querySelector(".weekhead")?.offsetHeight||0)+(sc.querySelector(".allrow")?.offsetHeight||0);
 const viewportTop=sc.getBoundingClientRect().top;
 const targetY=viewportTop+headers+Math.max(0,sc.clientHeight-headers)/2;
 sc.scrollTop+=timed.getBoundingClientRect().top+(minutes(new Date())/60-pref.dayStart)*hourHeight-targetY;
 sc.scrollLeft=0;
}
setInterval(()=>{if(session&&!document.hidden){updateNowLine();updatePastEvents();updateAvailability();if((view==="summary"||view==="availability")&&!document.querySelector("dialog[open]"))render();}},15000);
let lastRenderSignature="";
function render(){if(!session||!sessionStillLocal())return;if(pinchActive){renderAfterPinch=true;return;}const r=visibleRange(),data=dataFor(r),container=$("calendar"),old=container.querySelector(".scroll"),key=view+r.from+r.to,oldTop=old?.scrollTop,oldLeft=old?.scrollLeft;$("period").textContent=view==="month"?fmt(selected,{month:"long",year:"numeric"}):(view==="day"||view==="summary")?fmt(selected,{weekday:"short",day:"numeric",month:"long"}):fmt(r.from,{day:"numeric",month:"short"})+" – "+fmt(add(r.to,-1),{day:"numeric",month:"short",year:"numeric"});updateNavigation();$("app").classList.toggle("timedView",isTimedView());const events=data?visibleEvents(data):[];const signature=JSON.stringify([key,data?events:null,data?.calendarios||[],pref.hidden,pref.colorMode,pref.customColors,pref.aliases,pref.workweek,pref.dayStart,pref.dayEnd,pref.showEventTimes,pref.pastFade,pref.statsPeriod,(view==="summary"||view==="availability")?[Math.floor(Date.now()/15000),data?.sincronizado]:null,hourHeight,data?null:[navigator.onLine,syncFailures]]);if(signature===lastRenderSignature&&container.firstChild&&!(focusNowOnRender&&isTimedView()&&containsToday(r))){updatePastEvents();updateNowLine();return;}lastRenderSignature=signature;const finishedOpen=!!container.querySelector(".finishedEvents[open]");const priorScroll=container.scrollTop;filters(data);container.replaceChildren();if(!data){const load=el("div","loading");if(syncFailures&&navigator.onLine){load.append(el("p","","No se pudo cargar este periodo. No hay datos guardados para estas fechas."));const b=el("button","icon","Reintentar");b.onclick=()=>sync(true);load.append(b);}else if(navigator.onLine){const skeleton=el("div","skeleton");for(let i=0;i<3;i++)skeleton.append(el("div"));load.append(skeleton,el("p","","Consultando calendario…"));}else load.append(el("p","","Fechas no guardadas. Conéctate para consultarlas."));container.append(load);return;}if(view==="summary")renderSummary(r,events,container);else if(view==="availability"){const root=el("div","reportView availabilityPage");root.append(el("h2","","Disponibilidad"));renderAvailability(root,availabilityData());container.append(root);}else if(view==="stats")renderStats(r,events,container);else if(view==="month")renderMonth(r,events,container);else if(view==="agenda")renderAgenda(r,events,container);else{const s=renderWeek(r,events,container);if(containsToday(r)&&(focusNowOnRender||key!==lastRangeKey||!old)){centerCurrentHour(s);}else if(key===lastRangeKey&&old){s.scrollTop=oldTop;s.scrollLeft=0;}else{s.scrollTop=Math.max(0,7-pref.dayStart)*hourHeight;s.scrollLeft=0;}if(restorePosition?.key===view+selected&&pref.rememberPosition!==false){s.scrollTop=restorePosition.top;restorePosition=null;}attachPositionListener(s);focusNowOnRender=false;}if(view==="summary"){const finished=container.querySelector(".finishedEvents");if(finished&&finishedOpen)finished.open=true;}if(!isTimedView()&&key===lastRangeKey)container.scrollTop=priorScroll;lastRangeKey=key;}
function isTimedView(){return view==="day"||view==="three"||view==="week";}
function navigate(){if(CALENDAR_VIEWS.includes(view))calendarDate=selected;else if(view==="stats")statsDate=selected;const d=dataFor(visibleRange());const fresh=!!d&&navigator.onLine&&syncAge(d)<Math.max(90000,pref.syncSeconds*1000+30000)&&!warn;status(d?(fresh?"Actualizado · ":"Datos guardados · ")+stamp(d):"Consultando fechas…",!fresh);render();sync();}
function movePeriod(direction){if(view==="summary"||view==="availability")return;haptic();const step=view==="day"||view==="summary"||view==="stats"&&pref.statsPeriod==="day"?1:view==="three"?3:view==="week"||view==="stats"&&pref.statsPeriod==="week"?7:30;selected=view==="month"||view==="stats"&&pref.statsPeriod==="month"?shiftMonth(selected,direction):add(selected,step*direction);navigate();}
$("prev").onclick=()=>movePeriod(-1);$("next").onclick=()=>movePeriod(1);
$("period").onclick=()=>{$("jumpDate").value=selected;openPanel("dateDialog");};
$("jumpGo").onclick=()=>{const d=$("jumpDate").value;if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(utc(d).getTime()))return;selected=d;focusNowOnRender=true;closePanel($("dateDialog"));navigate();};$("today").onclick=()=>{selected=civil();restorePosition=null;calendarScroll=null;focusNowOnRender=true;navigate();};$("views").onchange=e=>{if(VIEWS.includes(e.target.value)){view=e.target.value;savePref();navigate();}};$("searchToggle").onclick=openGlobalSearch;$("refresh").onclick=()=>{status("Actualizando…",true);sync(true);};$("settings").onclick=()=>{updateCacheSettings();updateScaleControl();renderColorSettings();renderUpdateStatus();updateAdvancedSettings();showPrefsPage(null);openPanel("prefs");};$("theme").onchange=e=>{pref.theme=e.target.value;savePref();theme();};$("clear").onclick=async()=>{if(syncBusy){$("cacheInfo").textContent="Hay una sincronización en curso. Inténtalo cuando termine.";return;}cacheEpoch++;mainData=null;extraData=null;try{await clearCache();$("cacheInfo").textContent="Caché borrada. Se descargará nuevamente al actualizar.";}catch{$("cacheInfo").textContent="No se pudo borrar la caché. Inténtalo otra vez.";}render();};
$("offlineCache").onchange=async e=>{pref.offlineCache=e.target.checked;cacheEpoch++;savePref();if(!pref.offlineCache){try{await clearCache();cacheError=false;}catch{cacheError=true;}}else if(session){await persistSnapshot(generation);}updateCacheSettings();};$("logout").onclick=signOut;
document.addEventListener("visibilitychange",()=>{
 if(document.hidden){savePosition();return;}if(!session||!sessionStillLocal())return;
 updatePastEvents();updateNowLine();updateAvailability();if(pref.rememberPosition===false&&isTimedView()&&containsToday(visibleRange())&&!pinchActive){const sc=$("calendar").querySelector(".scroll");if(sc&&sc.querySelector(".nowline"))centerCurrentHour(sc);}
 render();if(!syncBusy)sync(true);
});
addEventListener("pagehide",savePosition);
addEventListener("pageshow",e=>{if(e.persisted&&session&&sessionStillLocal()){render();sync(true);}});
addEventListener("online",()=>{retryAt=0;sync(true);});
addEventListener("offline",()=>{if(session){status("Sin conexión · "+(stamp(dataFor(visibleRange()))||"sin datos guardados"),true);render();}});
setInterval(()=>{if(session&&!document.hidden)sync();},10000);
addEventListener("storage",e=>{
 if(e.key===PREF){let next=null;try{next=JSON.parse(e.newValue);}catch{}if(next&&pref.offlineCache!==next.offlineCache){pref.offlineCache=next.offlineCache;cacheEpoch++;if(pref.offlineCache===false)clearCache().catch(()=>{});updateCacheSettings();}}
 if((e.key===KEY||e.key===null)&&persistent&&session)sessionStillLocal();
});
const APP_VERSION="2.2.4";
let availableVersion=null, dismissedVersion=null, updateChecking=false, lastUpdateCheck=0, updateMessage="";
function isNewerVersion(candidate,current){
 const a=candidate.split(".").map(Number),b=current.split(".").map(Number);
 for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}
 return false;
}
function renderUpdateStatus(){
 $("updateBanner").hidden=!availableVersion||dismissedVersion===availableVersion;
 $("updateBannerText").textContent=availableVersion?"Versión "+availableVersion+" disponible":"";
 $("versionInfo").textContent="Versión "+APP_VERSION+(availableVersion?" · Nueva versión "+availableVersion+" disponible":updateMessage?" · "+updateMessage:"");
 $("installUpdateSettings").hidden=!availableVersion;
 $("checkUpdate").disabled=updateChecking;
}
async function checkForUpdate(manual=false){
 if(updateChecking||!navigator.onLine||(!manual&&Date.now()-lastUpdateCheck<60000)){
  if(manual&&!navigator.onLine){updateMessage="Sin conexión";renderUpdateStatus();}
  return;
 }
 updateChecking=true;lastUpdateCheck=Date.now();if(manual){updateMessage="Buscando…";renderUpdateStatus();}
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);
 try{
  const url=new URL("index.html",location.href);url.searchParams.set("_version",String(Date.now()));
  const response=await fetch(url,{cache:"no-store",credentials:"omit",signal:controller.signal});
  if(!response.ok)throw Error("HTTP "+response.status);
  const html=await response.text();
  const match=html.match(/<meta name="tempo-version" content="(\d+\.\d+\.\d+)">/);
  if(!match)throw Error("Versión no identificada");
  if(isNewerVersion(match[1],APP_VERSION)){availableVersion=match[1];updateMessage="";}else if(!availableVersion){updateMessage="Tienes la última versión";}
 }catch{if(manual)updateMessage="No se pudo comprobar la versión";}
 finally{clearTimeout(timeout);updateChecking=false;renderUpdateStatus();}
}
function installLatest(){
 if(!availableVersion)return;
 const url=new URL(location.href);
 url.searchParams.set("v",availableVersion);
 url.searchParams.set("_reload",String(Date.now()));
 location.replace(url.href);
}
$("checkUpdate").onclick=()=>checkForUpdate(true);
$("installUpdate").onclick=installLatest;
$("installUpdateSettings").onclick=installLatest;
$("dismissUpdate").onclick=()=>{dismissedVersion=availableVersion;renderUpdateStatus();};
document.addEventListener("visibilitychange",()=>{if(!document.hidden)checkForUpdate();});
addEventListener("online",()=>checkForUpdate());
setInterval(()=>{if(!document.hidden)checkForUpdate();},300000);
renderUpdateStatus();checkForUpdate();


function setupPrefsMenu(){
 const dialog=$("prefs"),menu=$("prefsMenu"),sections=Array.from(dialog.querySelectorAll(".setting"));
 const groups=[
 {key:"appearance",title:"Apariencia",icon:"◐",desc:"Tema y colores",items:[0,1]},
 {key:"calendars",title:"Calendarios",icon:"▦",desc:"Calendarios visibles",items:[3]},
 {key:"display",title:"Visualización",icon:"↕",desc:"Altura de las horas",items:[2]},
 {key:"sync",title:"Sincronización",icon:"↻",desc:"Estado y actualización",items:[]},
 {key:"storage",title:"Almacenamiento",icon:"▣",desc:"Caché y datos locales",items:[4]},
 {key:"security",title:"Seguridad",icon:"⌑",desc:"Sesión y acceso",items:[6]},
 {key:"about",title:"Acerca de Tempo",icon:"ⓘ",desc:"Versión y actualizaciones",items:[5]}
 ];
 for(const g of groups){
  const b=el("button","prefsLink"),symbol=el("span","prefsSymbol",g.icon),copy=el("span","prefsCopy"),arrow=el("span","prefsArrow","›");
  copy.append(el("strong","",g.title),el("small","",g.desc));b.append(symbol,copy,arrow);b.onclick=()=>showPrefsPage(g.key);menu.append(b);
  const page=el("section","prefsPage");page.dataset.key=g.key;page.dataset.title=g.title;page.hidden=true;
  for(const i of g.items)page.append(sections[i]);
  if(g.key==="sync"){const p=el("p","","La actualización automática funciona mientras Tempo está abierto. Si falla la conexión, los reintentos se espacian progresivamente.");const state=el("p");state.id="syncSettingsStatus";const refresh=el("button","icon","Actualizar calendario");refresh.onclick=()=>{status("Actualizando…",true);sync(true);};const label=el("label","prefExtra","Frecuencia de actualización"),select=el("select");select.id="syncFrequency";label.htmlFor=select.id;for(const [v,t] of [[30,"Cada 30 segundos"],[60,"Cada minuto"],[120,"Cada 2 minutos"],[300,"Cada 5 minutos"]]){const o=el("option","",t);o.value=String(v);select.append(o);}select.value=String(pref.syncSeconds);select.onchange=()=>{pref.syncSeconds=+select.value;savePref();updateSyncDiagnostics();sync();};const diag=el("p","availabilityNote");diag.id="syncDiagnostics";page.append(p,state,label,select,diag,refresh);}
  dialog.append(page);
 }
 $("prefsBack").onclick=()=>showPrefsPage(null);
}
function showPrefsPage(key){updateSyncDiagnostics();
 $("prefsMenu").hidden=!!key;$("prefsBack").hidden=!key;
 for(const p of $("prefs").querySelectorAll(".prefsPage")){p.hidden=p.dataset.key!==key;if(!p.hidden)$("prefsTitle").textContent=p.dataset.title;}
 if(!key)$("prefsTitle").textContent="Ajustes";
 if($("syncSettingsStatus"))$("syncSettingsStatus").textContent=statusText||"Sin información";
 $("prefs").scrollTop=0;
}
function bindSwipeNavigation(){
 const target=$("calendar");let start=null,blocked=false,suppress=0;
 target.addEventListener("touchstart",e=>{
  if(e.touches.length!==1){start=null;blocked=true;return;}
  if(blocked)return;
  const t=e.touches[0];start={x:t.clientX,y:t.clientY,at:Date.now(),horizontal:false};
 },{passive:true});
 target.addEventListener("touchmove",e=>{
  if(e.touches.length!==1||pinchActive){start=null;blocked=true;return;}
  if(!start||blocked)return;
  const t=e.touches[0],dx=t.clientX-start.x,dy=t.clientY-start.y;
  if(!start.horizontal&&Math.abs(dy)>18&&Math.abs(dy)>Math.abs(dx)){start=null;return;}
  if(Math.abs(dx)>18&&Math.abs(dx)>Math.abs(dy)*1.5)start.horizontal=true;
  if(start.horizontal&&e.cancelable)e.preventDefault();
 },{passive:false});
 target.addEventListener("touchend",e=>{
  if(e.touches.length)return;
  if(start&&!blocked&&!pinchActive&&start.horizontal){
   const t=e.changedTouches[0],dx=t.clientX-start.x,dy=t.clientY-start.y;
   if(Math.abs(dx)>55&&Math.abs(dx)>Math.abs(dy)*1.45&&Date.now()-start.at<1600){
    suppress=Date.now()+450;if(e.cancelable)e.preventDefault();movePeriod(dx<0?1:-1);
   }
  }
  start=null;blocked=false;
 },{passive:false});
 target.addEventListener("touchcancel",()=>{start=null;blocked=false;},{passive:true});
 target.addEventListener("click",e=>{if(Date.now()<suppress){e.preventDefault();e.stopImmediatePropagation();}},true);
}
setupPrefsMenu();bindSwipeNavigation();


let searchRun=0;
function clearSearch(){
 searchRun++;$("globalQuery").value="";$("searchStatus").textContent="";$("searchResults").replaceChildren();$("searchSubmit").disabled=false;
}
function openGlobalSearch(){
 clearSearch();const r=windowRange();$("searchFrom").value=r.from;$("searchTo").value=add(r.to,-1);openPanel("searchDialog");
}
$("searchDialog").addEventListener("close",clearSearch);
function normalized(s){return String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("es");}
$("globalSearchForm").addEventListener("submit",async e=>{
 e.preventDefault();if(!session)return;
 const q=normalized($("globalQuery").value.trim()),from=$("searchFrom").value,last=$("searchTo").value;
 if(!q||!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(last)||last<from){$("searchStatus").textContent="Introduce un texto y fechas válidas.";return;}
 const to=add(last,1),range={from,to},days=(utc(to)-utc(from))/86400000;
 if(days>366){$("searchStatus").textContent="Selecciona hasta 366 días por búsqueda. Puedes consultar cualquier año.";return;}
 const run=++searchRun,g=generation,t=session.token;const valid=()=>run===searchRun&&g===generation&&!!session&&$("searchDialog").open;
 $("searchSubmit").disabled=true;$("searchResults").replaceChildren();$("searchStatus").textContent="Buscando…";
 const matches=new Map(),names=new Map();let incomplete=false, cached=false;
 try{
  for(let f=from;f<to;){
   const next=add(f,120),chunk={from:f,to:next<to?next:to};let d=dataFor(chunk);
   if(d)cached=true;
   if(!d&&navigator.onLine){d=await fetchRange(chunk,t);if(!valid())return;}
   if(!d){incomplete=true;d=mainData;}
   const a=Date.parse(midnight(chunk.from)),b=Date.parse(midnight(chunk.to));
   for(const c of d?.calendarios||[])names.set(c.id,calendarName(c));
   for(const raw of d?.eventos||[]){
    const ev=displayEvent(raw);
    const inside=ev.diaCompleto?ev.inicio<chunk.to&&ev.fin>chunk.from:Date.parse(ev.inicio)<b&&Date.parse(ev.fin)>a;
    if(inside&&[ev.titulo,ev.descripcion,ev.ubicacion].some(v=>normalized(v).includes(q)))matches.set(ev.calendarioId+"|"+ev.id+"|"+ev.inicio,ev);
   }
   f=chunk.to;
  }
  if(!valid())return;
  const items=[...matches.values()].sort((a,b)=>a.inicio.localeCompare(b.inicio));
  $("searchStatus").textContent=items.length+" resultado"+(items.length===1?"":"s")+(incomplete?" · Búsqueda parcial sin conexión":cached?" · Incluye datos de la última sincronización":"")+(items.length>300?" · Se muestran los primeros 300":"");
  for(const ev of items.slice(0,300)){
   const b=el("button","agendaitem searchResult"),dot=el("span","swatch"),info=el("div");dot.style.background=eventColor(ev);
   info.append(el("strong","",ev.titulo),el("small","",fmt(ev.diaCompleto?ev.inicio:civil(new Date(ev.inicio)),{dateStyle:"medium"})+" · "+(ev.diaCompleto?"Todo el día":clock(ev.inicio))+" · "+(names.get(ev.calendarioId)||"")));
   b.append(dot,info);b.onclick=()=>{selected=ev.diaCompleto?ev.inicio:civil(new Date(ev.inicio));view="day";savePref();navigate();showEvent(ev);};bindQuickActions(b,ev);$("searchResults").append(b);
  }
 }catch(err){
  if(!valid())return;
  if(err.message==="NO_AUTORIZADO"){await resetLocal();$("loginStatus").textContent="La sesión ya no es válida.";return;}
  $("searchStatus").textContent="No se pudo completar la búsqueda. Inténtalo otra vez.";
 }finally{if(valid())$("searchSubmit").disabled=false;}
});
function availabilityData(){
 const day=civil(),range={from:day,to:add(day,1)},data=dataFor(range);
 if(!data)return null;
 const begin=Date.parse(midnight(day)),finish=Date.parse(midnight(range.to)),now=Date.now();
 const events=(data.eventos||[]).map(displayEvent).filter(e=>!e.diaCompleto&&overlaps(e,day));
 const intervals=events.map(e=>({start:Math.max(begin,Date.parse(e.inicio)),end:Math.min(finish,Date.parse(e.fin)),e})).filter(x=>x.end>x.start).sort((a,b)=>a.start-b.start);
 const merged=[];
 for(const x of intervals){const last=merged[merged.length-1];if(last&&x.start<=last.end)last.end=Math.max(last.end,x.end);else merged.push({start:x.start,end:x.end});}
 const occupied=merged.find(x=>x.start<=now&&now<x.end),next=intervals.find(x=>x.start>now),active=intervals.filter(x=>x.start<=now&&now<x.end);
 const free=[];let cursor=begin;for(const x of merged){if(x.start>cursor)free.push({start:cursor,end:x.start});cursor=Math.max(cursor,x.end);}if(cursor<finish)free.push({start:cursor,end:finish});
 return {data,day,begin,finish,now,intervals,merged,occupied,next,active,free};
}
function durationText(ms){const m=Math.max(0,Math.ceil(ms/60000)),h=Math.floor(m/60),r=m%60;return (h?h+" h ":"")+(r||!h?r+" min":"");}
function intervalText(x,finish){return clock(x.start)+" – "+(x.end===finish?"24:00":clock(x.end));}
function availabilityLabel(a){return !a?"Sin datos de hoy":a.occupied?"Ocupado":"Sin eventos";}
function availabilityClass(a){return !a?"unknown":a.occupied?"busy":"free";}
function updateAvailability(){
 const button=$("availability");if(!button)return;
 const a=session?availabilityData():null;
 $("availabilityDot").className="availabilityDot "+availabilityClass(a);
 button.title=availabilityLabel(a);
 button.setAttribute("aria-label",button.title+" · Ver disponibilidad de hoy");
 if($("availabilityDialog").open){$("availabilityContent").replaceChildren();renderAvailability($("availabilityContent"),a);}
}
function renderAvailability(root,a){
 if(!a){root.append(el("p","","No hay datos de hoy disponibles."));return;}
 root.append(el("div","availabilityTitle"+(a.occupied?" busy":""),availabilityLabel(a)));
 if(a.occupied)root.append(el("p","","Eventos en curso hasta las "+(a.occupied.end===a.finish?"24:00":clock(a.occupied.end))+" · faltan "+durationText(a.occupied.end-a.now)));
 for(const x of a.active)root.append(el("p","availabilityEvent",x.e.titulo));
 if(a.next){root.append(el("h3","","Próximo evento"),el("div","availabilityEvent",a.next.e.titulo),el("p","",intervalText(a.next,a.finish)+" · en "+durationText(a.next.start-a.now)));}
 else root.append(el("p","","No quedan eventos con hora por comenzar hoy."));
 const bar=el("div","availabilityTrack");for(const x of a.merged){const span=el("span");span.style.left=(x.start-a.begin)/(a.finish-a.begin)*100+"%";span.style.width=(x.end-x.start)/(a.finish-a.begin)*100+"%";bar.append(span);}const now=el("i");now.style.left=(a.now-a.begin)/(a.finish-a.begin)*100+"%";bar.append(now);
 root.append(el("h3","","Ocupación del día"),bar);const legend=el("div","trackLabels");legend.append(el("span","","00:00"),el("span","","12:00"),el("span","","24:00"));root.append(legend,el("h3","","Huecos sin eventos restantes"));
 const gaps=a.free.filter(x=>x.end>a.now);
 if(!gaps.length)root.append(el("p","","No hay huecos restantes."));
 for(const x of gaps){const start=Math.max(x.start,a.now);root.append(el("div","availabilityGap",intervalText({start,end:x.end},a.finish)+" · "+durationText(x.end-start)));}
 root.append(el("p","availabilityNote","Solo refleja eventos con hora de los calendarios autorizados, incluso si están ocultos en la vista. No confirma la disponibilidad real. Los eventos de día completo no se cuentan."));
}
$("availability").onclick=()=>switchTab("availability");
if("serviceWorker" in navigator){navigator.serviceWorker.register("./sw.js",{scope:"./",updateViaCache:"none"}).catch(()=>{});}


function calendarName(c){const alias=pref.aliases[c.id];return typeof alias==="string"&&alias.trim()?alias.trim():c.nombre;}
function applyAccent(){
 const h=pref.accentColor,root=document.documentElement;
 if(!/^#[0-9a-f]{6}$/i.test(h||"")){root.style.removeProperty("--ui-accent");root.style.removeProperty("--ui-ink");root.style.removeProperty("--ui-text-accent");}
 else{root.style.setProperty("--ui-accent",h);root.style.setProperty("--ui-ink",contrastingText(h));root.style.setProperty("--ui-text-accent",readableAccent(h,root.dataset.theme==="dark"?"#1b1e27":"#ffffff"));}
 updateVisualControls();
}
function updateAdvancedSettings(){
 updateCacheSettings();
 $("startupView").value=VIEWS.includes(pref.startupView)?pref.startupView:pref.startupView==="last"?"last":"summary";$("workweek").checked=!!pref.workweek;$("showEventTimes").checked=pref.showEventTimes!==false;
 $("dayStart").value=String(pref.dayStart);$("dayEnd").value=String(pref.dayEnd);$("accentColor").value=pref.accentColor||"default";$("pastFade").value=String(pref.pastFade);$("pastFadeValue").textContent=pref.pastFade+" %";$("hapticToggle").checked=!!pref.haptics;$("rememberPosition").checked=pref.rememberPosition!==false;if($("syncFrequency"))$("syncFrequency").value=String(pref.syncSeconds);$("sessionInfo").textContent=session?"Sesión "+(persistent?"recordada en este dispositivo":"temporal")+" · caduca el "+fmt(civil(new Date(session.expiracion)),{dateStyle:"medium"})+".":"Sin sesión activa.";updateSyncDiagnostics();updateVisualControls();
 const root=$("calendarAliases");root.replaceChildren(el("p","availabilityNote","Nombres personalizados (solo en este dispositivo)"));
 for(const c of currentCalendars()){
  const l=el("label","aliasLabel",c.nombre),i=el("input","input");i.type="text";i.maxLength=60;i.placeholder=c.nombre;i.value=pref.aliases[c.id]||"";i.setAttribute("aria-label","Alias de "+c.nombre);
  i.onchange=()=>{pref.aliases[c.id]=i.value.trim();savePref();render();renderColorSettings();};l.append(i);root.append(l);
 }
}
function setupAdvancedSettings(){
 const ac=$("accentColor"),def=el("option","","Original de Tempo");def.value="default";ac.append(def);
 for(const [name,hex] of EHU_COLORS){const o=el("option","",name);o.value=hex;ac.append(o);}
 for(let h=0;h<=24;h++)for(const id of ["dayStart","dayEnd"]){if(id==="dayStart"&&h===24||id==="dayEnd"&&h===0)continue;const o=el("option","",String(h).padStart(2,"0")+":00");o.value=String(h);$(id).append(o);}
 $("startupView").onchange=e=>{pref.startupView=e.target.value;savePref();};
 $("workweek").onchange=e=>{pref.workweek=e.target.checked;savePref();render();};
 $("showEventTimes").onchange=e=>{pref.showEventTimes=e.target.checked;savePref();render();};
 function rangeChange(e){let start=+$("dayStart").value,end=+$("dayEnd").value;if(start>=end){if(e.target.id==="dayStart")end=start+1;else start=end-1;}pref.dayStart=start;pref.dayEnd=end;$("dayStart").value=String(start);$("dayEnd").value=String(end);savePref();focusNowOnRender=true;render();}
 $("dayStart").onchange=rangeChange;$("dayEnd").onchange=rangeChange;
 ac.onchange=e=>{pref.accentColor=e.target.value;savePref();applyAccent();};$("hapticToggle").onchange=e=>{pref.haptics=e.target.checked;savePref();haptic();};$("rememberPosition").onchange=e=>{pref.rememberPosition=e.target.checked;savePref();if(pref.rememberPosition)savePosition();else{remove(POS);restorePosition=null;}};$("resetPreferences").onclick=resetPreferences;
 $("pastFade").oninput=e=>{pref.pastFade=+e.target.value;$("pastFadeValue").textContent=pref.pastFade+" %";for(const n of $("calendar").querySelectorAll("[data-event-end]"))applyEventAppearance(n);};
 $("pastFade").onchange=savePref;
 updateAdvancedSettings();
}
function mergedDuration(intervals){
 const sorted=intervals.map(x=>({start:x.start,end:x.end})).sort((a,b)=>a.start-b.start),merged=[];
 for(const x of sorted){if(x.end<=x.start)continue;const last=merged[merged.length-1];if(last&&x.start<=last.end)last.end=Math.max(last.end,x.end);else merged.push(x);}
 return merged.reduce((a,x)=>a+x.end-x.start,0);
}
function rangeStats(r,events){
 const begin=Date.parse(midnight(r.from)),end=Date.parse(midnight(r.to));
 const relevant=events.filter(e=>e.diaCompleto?e.inicio<r.to&&e.fin>r.from:Date.parse(e.inicio)<end&&Date.parse(e.fin)>begin);
 const intervals=relevant.filter(e=>!e.diaCompleto).map(e=>({start:Math.max(begin,Date.parse(e.inicio)),end:Math.min(end,Date.parse(e.fin)),id:e.calendarioId})).filter(x=>x.end>x.start);
 return {relevant,intervals,busy:mergedDuration(intervals),total:end-begin};
}
function summaryMetric(label,value){const box=el("div","summaryMetric");box.append(el("small","",label),el("strong","",String(value)));return box;}
function listEvent(e){
 const b=el("button","agendaitem"),dot=el("span","swatch"),info=el("div");bindEventAppearance(b,e,dot);
 info.append(el("strong","",e.titulo),el("small","",e.diaCompleto?"Todo el día":clock(e.inicio)+" – "+clock(e.fin)));b.append(dot,info);b.onclick=()=>showEvent(e);bindQuickActions(b,e);return b;
}
function homeGroups(items,now){
 const sorted=items.slice().sort((a,b)=>a.inicio.localeCompare(b.inicio));
 return {allDay:sorted.filter(e=>e.diaCompleto),upcoming:sorted.filter(e=>!e.diaCompleto&&Date.parse(e.inicio)>now),finished:sorted.filter(e=>!e.diaCompleto&&Date.parse(e.fin)<=now)};
}
function homeSection(root,title,actionLabel,action){
 const section=el("section","homeSection"),head=el("div","homeSectionHeading");head.append(el("h3","",title));
 if(action){const b=el("button","homeTextButton",actionLabel+" ›");b.type="button";b.onclick=action;head.append(b);}
 section.append(head);root.append(section);return section;
}
function renderSummary(r,events,container){
 const today=civil(),tomorrow=add(today,1),root=el("div","reportView homeView"),now=Date.now(),availability=availabilityData();
 const heading=el("div","homeHeading"),headingText=el("div"),calendarButton=el("button","icon homeCalendarButton","Ver calendario ›");
 headingText.append(el("p","reportDate",fmt(today,{dateStyle:"full"})),el("h2","","Hoy"));calendarButton.type="button";calendarButton.onclick=()=>dayJump(today);heading.append(headingText,calendarButton);root.append(heading);
 const hero=el("section","homeHero"),state=el("div","homeState"),dot=el("span","availabilityDot "+availabilityClass(availability));
 state.append(dot,el("strong","",availabilityLabel(availability)));hero.append(state);
 if(availability?.occupied){
  hero.append(el("p","heroCountdown","Hasta las "+(availability.occupied.end===availability.finish?"24:00":clock(availability.occupied.end))+" · quedan "+durationText(availability.occupied.end-now)));
  for(const x of availability.active)hero.append(listEvent(x.e));
 }else if(availability?.next){hero.append(el("p","heroCountdown","Sin eventos durante "+durationText(availability.next.start-now)));}
 else if(availability){hero.append(el("p","heroCountdown","No quedan eventos con hora hoy."));}
 const more=el("button","homeLink","Ver disponibilidad ›");more.type="button";more.onclick=()=>switchTab("availability");hero.append(more);root.append(hero);
 const a=rangeStats({from:today,to:tomorrow},events),groups=homeGroups(a.relevant,now);
 if(groups.allDay.length){const section=homeSection(root,"Todo el día");for(const e of groups.allDay)section.append(listEvent(e));}
 if(groups.upcoming.length){
  const section=homeSection(root,"Próximos eventos");
  groups.upcoming.forEach((e,i)=>{const b=listEvent(e);if(i===0){b.classList.add("homeNextEvent");const badge=el("span","homeNextTag","Siguiente");b.append(badge);}section.append(b);});
 }
 if(groups.finished.length){
  const details=el("details","finishedEvents");details.append(el("summary","","Finalizados ("+groups.finished.length+")"));for(const e of groups.finished)details.append(listEvent(e));root.append(details);
 }
 const next=events.filter(e=>overlaps(e,tomorrow)).sort((a,b)=>a.inicio.localeCompare(b.inicio)),section=homeSection(root,"Mañana","Ver día",()=>dayJump(tomorrow));
 section.append(el("p","homeTomorrowDate",fmt(tomorrow,{weekday:"long",day:"numeric",month:"long"})));
 for(const e of next.slice(0,3))section.append(listEvent(e));
 if(!next.length)section.append(el("p","homeEmpty","Sin eventos"));
 if(next.length>3){const b=el("button","homeTextButton","Ver los "+(next.length-3)+" eventos restantes ›");b.onclick=()=>dayJump(tomorrow);section.append(b);}
 container.append(root);
}
function renderStats(r,events,container){
 const root=el("div","reportView"),a=rangeStats(r,events);root.append(el("h2","","Estadísticas"));
 const controls=el("div","reportTabs");
 for(const [v,label] of [["day","Día"],["week","Semana"],["month","Mes"]]){const b=el("button","icon"+(pref.statsPeriod===v?" active":""),label);b.onclick=()=>{pref.statsPeriod=v;savePref();navigate();};controls.append(b);}root.append(controls);
 const metrics=el("div","summaryMetrics");metrics.append(summaryMetric("Horas ocupadas",durationText(a.busy)),summaryMetric("Sin eventos",durationText(a.total-a.busy)),summaryMetric("Eventos",a.relevant.length),summaryMetric("Días completos",a.relevant.filter(e=>e.diaCompleto).length));root.append(metrics);
 root.append(el("h3","","Horas por calendario"));
 for(const c of currentCalendars().filter(c=>!pref.hidden.includes(c.id))){
  const ms=mergedDuration(a.intervals.filter(x=>x.id===c.id)),row=el("div","statRow"),label=el("div","statLabel");label.append(el("span","",calendarName(c)),el("strong","",durationText(ms)));
  const bar=el("div","statTrack"),fill=el("span");fill.style.width=(a.busy?ms/a.busy*100:0)+"%";fill.style.background=calendarColor(c);bar.append(fill);row.append(label,bar);root.append(row);
 }
 root.append(el("p","availabilityNote","Los totales por calendario pueden solaparse entre sí; las horas ocupadas del periodo se calculan sin duplicar ningún intervalo. Se excluyen eventos de día completo y calendarios ocultos."));
 root.append(el("h3","","Ocupación por día"));
 for(let d=r.from;d<r.to;d=add(d,1)){
  const day=rangeStats({from:d,to:add(d,1)},a.relevant),row=el("div","statRow"),label=el("div","statLabel"),b=el("button","statDate",fmt(d,{weekday:"short",day:"numeric",month:"short"}));b.onclick=()=>dayJump(d);label.append(b,el("strong","",durationText(day.busy)));const bar=el("div","statTrack"),fill=el("span");fill.style.width=day.busy/day.total*100+"%";fill.style.background="#5FD790";bar.append(fill);row.append(label,bar);root.append(row);
 }
 container.append(root);
}
setupAdvancedSettings();setupVisualControls();


function updateNavigation(){
 const tab=CALENDAR_VIEWS.includes(view)?"calendar":view;
 $("periodToolbar").hidden=tab==="summary"||tab==="availability";
 $("views").closest(".viewPicker").hidden=tab!=="calendar";
 $("views").value=calendarView=CALENDAR_VIEWS.includes(view)?view:calendarView;
 $("filters").classList.toggle("nonCalendar",tab!=="calendar");
 $("app").dataset.tab=tab;
 for(const b of $("mainNav").querySelectorAll("button")){const on=b.dataset.tab===tab;b.classList.toggle("active",on);if(on)b.setAttribute("aria-current","page");else b.removeAttribute("aria-current");}
}
let calendarScroll=null;
function switchTab(tab){
 if(!session)return;
 const currentTab=CALENDAR_VIEWS.includes(view)?"calendar":view;if(tab===currentTab)return;haptic();
 if(currentTab==="calendar"){const sc=$("calendar").querySelector(".scroll");calendarScroll=sc?{key:view+selected,top:sc.scrollTop}:null;}
 if(CALENDAR_VIEWS.includes(view)){calendarView=view;calendarDate=selected;}else if(view==="stats")statsDate=selected;
 if(tab==="calendar"){view=calendarView;selected=calendarDate;focusNowOnRender=true;}
 else if(tab==="stats"){view="stats";selected=statsDate;}
 else {view=tab;selected=civil();}
 savePref();navigate();animateScreen();$("calendar").scrollTop=0;if(tab==="calendar"&&calendarScroll?.key===view+selected){const sc=$("calendar").querySelector(".scroll");if(sc)sc.scrollTop=calendarScroll.top;}savePosition();
}
for(const b of $("mainNav").querySelectorAll("button"))b.onclick=()=>switchTab(b.dataset.tab);


function relativeLuminance(h){
 const v=h.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);
 return .2126*v[0]+.7152*v[1]+.0722*v[2];
}
function readableAccent(h,bg){
 const b=relativeLuminance(bg),rgb=h.slice(1).match(/../g).map(x=>parseInt(x,16)),target=b>.5?0:255;
 for(let f=0;f<=20;f++){const c="#"+rgb.map(v=>Math.round(v+(target-v)*f/20).toString(16).padStart(2,"0")).join("");const l=relativeLuminance(c);if((Math.max(l,b)+.05)/(Math.min(l,b)+.05)>=4.5)return c;}
 return target===0?"#000000":"#ffffff";
}
function haptic(){if(pref.haptics&&typeof navigator.vibrate==="function")try{navigator.vibrate(12);}catch{}}
function updateVisualControls(){
 const themes=$("themeCards"),colors=$("accentSwatches");if(!themes||!colors)return;
 for(const b of themes.querySelectorAll("button"))b.setAttribute("aria-pressed",String(b.dataset.themeValue===(pref.theme||"auto")));
 const selected=pref.accentColor||"default";
 for(const b of colors.querySelectorAll("button"))b.setAttribute("aria-pressed",String(b.dataset.color===selected));
 const label=Array.from(colors.querySelectorAll("button")).find(b=>b.dataset.color===selected)?.getAttribute("aria-label");$("accentName").textContent=label||"Original de Tempo";
}
function setupVisualControls(){
 for(const [v,label] of [["light","Claro"],["dark","Oscuro"],["auto","Automático"]]){
  const b=el("button","themeCard"),preview=el("span","themeMini "+v);b.type="button";b.dataset.themeValue=v;
  const heading=el("span","miniHeading"),grid=el("span","miniGrid");for(let i=0;i<3;i++){const col=el("span","miniColumn");col.append(el("i"));grid.append(col);}preview.append(heading,grid);b.append(preview,el("span","",label));b.onclick=()=>{pref.theme=v;savePref();theme();haptic();};$("themeCards").append(b);
 }
 for(const [label,value] of [["Original de Tempo","default"],...EHU_COLORS]){
  const b=el("button","accentSwatch");b.type="button";b.dataset.color=value;b.setAttribute("aria-label",label);b.title=label;b.style.setProperty("--swatch",value==="default"?"#485bd8":value);b.style.setProperty("--swatch-ink",contrastingText(value==="default"?"#485bd8":value));b.append(el("span","","✓"));b.onclick=()=>{pref.accentColor=value;savePref();applyAccent();$("accentColor").value=value;haptic();};$("accentSwatches").append(b);
 }
 updateVisualControls();
}
function updateCacheSettings(){
 const enabled=pref.offlineCache!==false;$("offlineCache").checked=enabled;$("offlineCache").disabled=!!session&&!persistent;
 $("cacheInfo").textContent=!persistent?"Sesión temporal: los eventos no se guardan en disco.":!enabled?"Almacenamiento de eventos desactivado. Se consultarán al abrir Tempo.":cacheError?"No se pudo leer o guardar la caché en este dispositivo.":mainData?"Caché cifrada · "+mainData.eventos.length+" eventos en la ventana principal.":"Caché cifrada · sin eventos descargados todavía.";
}
function resetPreferences(){
 if(!confirm("¿Restablecer los ajustes de apariencia, calendarios y visualización? Tu sesión y los eventos guardados se conservarán."))return;
 const offlineCache=pref.offlineCache;pref={offlineCache,theme:"auto",view:"summary",startupView:"summary",hidden:[],colorMode:"ehu",customColors:{},aliases:{},dayStart:0,dayEnd:24,pastFade:40,statsPeriod:"week",hourHeight:54,showEventTimes:true,workweek:false,haptics:false,syncSeconds:60,rememberPosition:true};remove(POS);restorePosition=null;
 view="summary";calendarView="week";selected=calendarDate=statsDate=civil();calendarScroll=null;hourHeight=54;document.documentElement.style.setProperty("--hour","54px");savePref();theme();updateScaleControl();renderColorSettings();updateAdvancedSettings();navigate();showPrefsPage(null);
}
function animateScreen(){const n=$("calendar");n.classList.remove("screenTransition");void n.offsetWidth;n.classList.add("screenTransition");}
let activePanel=null,historyClosing=false,panelOpenedAt=0,quickEvent=null;
function panelHistory(){return history.state?.tempoPanel===true;}
function pushPanelHistory(){if(panelHistory()||historyClosing)return;try{history.pushState({...history.state,tempoPanel:true},"",location.href);}catch{}}
function clearQuickContent(){quickEvent=null;$("quickTitle").textContent="";$("quickMeta").textContent="";$("quickCalendar").replaceChildren();$("quickMap").removeAttribute("href");$("quickMap").hidden=true;$("quickStatus").textContent="";}
function openPanel(id){
 const d=$(id);if(!d||d.open)return;
 const old=activePanel;activePanel=id;
 if(old&&$(old)?.open)$(old).close();
 pushPanelHistory();panelOpenedAt=Date.now();d.showModal();d.scrollTop=0;
}
function closePanel(d){
 if(!d?.open)return;
 if(activePanel===d.id){activePanel=null;if(panelHistory()){historyClosing=true;try{history.back();}catch{historyClosing=false;}}}
 d.close();
}
function setupPanels(){
 if(panelHistory()){const state={...history.state};delete state.tempoPanel;try{history.replaceState(state,"",location.href);}catch{}}
 for(const d of document.querySelectorAll("dialog")){
  const handle=el("button","sheetHandle");handle.type="button";handle.setAttribute("aria-label","Cerrar panel");handle.append(el("span"));d.prepend(handle);
  d.querySelector(".close").onclick=()=>closePanel(d);handle.onclick=()=>closePanel(d);
  d.addEventListener("cancel",e=>{e.preventDefault();closePanel(d);});
  d.addEventListener("close",()=>{if(d.open)return;if(d.id==="quickActions")clearQuickContent();if(activePanel===d.id){activePanel=null;if(panelHistory()){historyClosing=true;try{history.back();}catch{historyClosing=false;}}}});
  d.addEventListener("click",e=>{if(e.target!==d||Date.now()-panelOpenedAt<450)return;const rect=d.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)closePanel(d);});
  let y=null;
  handle.addEventListener("pointerdown",e=>{if(e.pointerType==="mouse")return;y=e.clientY;try{handle.setPointerCapture(e.pointerId);}catch{}});
  handle.addEventListener("pointerup",e=>{if(y!==null&&e.clientY-y>45)closePanel(d);y=null;});
  handle.addEventListener("pointercancel",()=>{y=null;});
 }
 addEventListener("popstate",()=>{
  if(historyClosing){historyClosing=false;if(activePanel)pushPanelHistory();return;}
  if(activePanel&&!panelHistory()){const id=activePanel;activePanel=null;if($(id)?.open)$(id).close();}
 });
}
function quickEventText(e){
 const date=e.diaCompleto?e.inicio:civil(new Date(e.inicio)),last=e.diaCompleto?add(e.fin,-1):civil(new Date(e.fin));
 const day=fmt(date,{dateStyle:"full"})+(last!==date?" – "+fmt(last,{dateStyle:"full"}):"");
 return day+" · "+(e.diaCompleto?"Todo el día":clock(e.inicio)+" – "+clock(e.fin));
}
function showQuickActions(e){
 if(!session)return;quickEvent=e;const c=currentCalendars().find(x=>x.id===e.calendarioId),root=$("quickCalendar"),dot=el("span","swatch");dot.style.background=eventColor(e);root.replaceChildren(dot,document.createTextNode(c?calendarName(c):"Calendario"));
 $("quickTitle").textContent=e.titulo;$("quickMeta").textContent=quickEventText(e);$("quickStatus").textContent="";
 $("quickMap").hidden=!e.ubicacion;if(e.ubicacion)$("quickMap").href="https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(e.ubicacion);else $("quickMap").removeAttribute("href");
 haptic();openPanel("quickActions");
}
function bindQuickActions(b,e){
 let timer=null,start=null,suppress=0;
 const cancel=()=>{if(timer!==null)clearTimeout(timer);timer=null;start=null;};
 const open=()=>{cancel();if(!b.isConnected||!session)return;suppress=Date.now()+1000;showQuickActions(e);};
 b.addEventListener("pointerdown",ev=>{cancel();if(ev.pointerType==="mouse"||!ev.isPrimary)return;start={x:ev.clientX,y:ev.clientY};timer=setTimeout(open,550);});
 b.addEventListener("pointermove",ev=>{if(start&&Math.hypot(ev.clientX-start.x,ev.clientY-start.y)>10)cancel();});
 for(const type of ["pointerup","pointercancel","pointerleave"])b.addEventListener(type,cancel);
 b.addEventListener("contextmenu",ev=>{ev.preventDefault();if(Date.now()>=suppress)open();});
 b.addEventListener("keydown",ev=>{if(ev.key==="ContextMenu"||ev.shiftKey&&ev.key==="F10"){ev.preventDefault();open();}});
 b.addEventListener("click",ev=>{if(Date.now()<suppress){ev.preventDefault();ev.stopImmediatePropagation();}},true);
}
$("quickDetails").onclick=()=>{const e=quickEvent;if(e)showEvent(e);};
$("quickDay").onclick=()=>{const e=quickEvent;if(e){closePanel($("quickActions"));dayJump(e.diaCompleto?e.inicio:civil(new Date(e.inicio)));}};
$("quickCopy").onclick=async()=>{const e=quickEvent;if(!e)return;try{const c=currentCalendars().find(x=>x.id===e.calendarioId);await navigator.clipboard.writeText([e.titulo,quickEventText(e),c?calendarName(c):"",e.ubicacion,e.descripcion].filter(Boolean).join("\n"));if(quickEvent===e)$("quickStatus").textContent="Detalles copiados.";}catch{if(quickEvent===e)$("quickStatus").textContent="No se pudo copiar. Abre los detalles para seleccionar el texto.";}};
setupPanels();


let restorePosition=null,positionTimer=null;
function validDate(d){return typeof d==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(utc(d).getTime());}
function loadPosition(){
 const pos=load(POS,null);if(!pos)return;
 if(validDate(pos.calendarDate))calendarDate=pos.calendarDate;if(validDate(pos.statsDate))statsDate=pos.statsDate;
 if(CALENDAR_VIEWS.includes(view))selected=calendarDate;else if(view==="stats")selected=statsDate;
 if(typeof pos.key==="string"&&Number.isFinite(pos.top)&&pos.top>=0&&pos.top<=10000){restorePosition={key:pos.key,top:pos.top};calendarScroll={...restorePosition};}
}
function savePosition(){
 if(!session||!persistent||pref.rememberPosition===false)return;
 const sc=$("calendar").querySelector(".scroll");
 if(CALENDAR_VIEWS.includes(view)&&sc&&lastRangeKey===view+visibleRange().from+visibleRange().to)calendarScroll={key:view+selected,top:sc.scrollTop};
 store(POS,{calendarDate,statsDate,key:calendarScroll?.key||"",top:calendarScroll?.top||0});
}
function attachPositionListener(sc){
 sc.addEventListener("scroll",()=>{clearTimeout(positionTimer);positionTimer=setTimeout(()=>{if(sc.isConnected)savePosition();},250);},{passive:true});
}
function updateSyncDiagnostics(){
 const n=$("syncDiagnostics");if(!n)return;
 const bits=[];
 if(syncBusy)bits.push("Sincronizando…");else if(retryAt>Date.now())bits.push("Reintento automático en "+Math.ceil((retryAt-Date.now())/1000)+" s");else if(lastLatency)bits.push("Última consulta: "+(lastLatency/1000).toFixed(1)+" s");
 if(mainData)bits.push("Caché principal: "+mainData.eventos.length+" eventos");
 if(extraData)bits.push("Periodo adicional: "+extraData.eventos.length+" eventos");
 if(cacheError)bits.push("No se pudo guardar la caché en este dispositivo");
 n.textContent=bits.join(" · ");
}

const remembered=load(KEY,null);if(validSession(remembered))enter(remembered,true,true);else{remove(KEY);clearCache().catch(()=>{});}
