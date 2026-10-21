"""Maakt de Pi-versie (index.html voor de add-on) uit de Netlify-versie van de app.
Gebruik: python3 build_pi.py <netlify-html> <uit/index.html>
Wat er verandert:
- Google-scripts eruit; een 'shim' beantwoordt Drive- en AI-aanroepen via de eigen server.
- Schoonmaakrooster gaat direct naar Home Assistant (geen webhook).
- AI-sleutel staat in de add-on, niet in de browser.
- Back-up downloaden / terugzetten in Instellingen.
- Persoonlijke gegevens (telefoon, e-mail) uit de code.
"""
import re, sys
src, out = sys.argv[1], sys.argv[2]
h = open(src, encoding='utf-8').read()

def rep(old, new, count=1):
    global h
    n = h.count(old)
    assert n == count, (old[:90], n)
    h = h.replace(old, new)

PRE = r"""<script>
// ═══ HOEVE-SERVER SHIM: Drive- en AI-aanroepen gaan naar de eigen server op de Pi ═══
(function(){
  const of=window.fetch.bind(window);
  window.fetch=function(u,o){
    if(typeof u==='string'){
      if(u.startsWith('https://www.googleapis.com/')) u=u.slice('https://www.googleapis.com/'.length);
      else if(u.startsWith('https://api.anthropic.com/v1/messages')){u='api/ai/messages';o=Object.assign({},o,{headers:{'content-type':'application/json'}});}
    }
    return of(u,o);
  };
  const j=async r=>{const t=await r.json().catch(()=>({}));if(!r.ok)throw {result:t,status:r.status};return {result:t};};
  window.gapi={load:(n,cb)=>setTimeout(cb,0),client:{init:async()=>{},setToken:()=>{},drive:{files:{
    list:p=>of('drive/v3/files?'+new URLSearchParams({q:(p&&p.q)||''})).then(j),
    create:p=>of('drive/v3/files',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify((p&&p.resource)||{})}).then(j)}}}};
  window.google={accounts:{oauth2:{initTokenClient:o=>({requestAccessToken:()=>setTimeout(()=>o.callback({access_token:'hoeve-server',expires_in:315360000}),0)})}}};
  try{localStorage.setItem('hoeve-drive-token',JSON.stringify({token:'hoeve-server',expiresAt:Date.now()+3153600000000}));localStorage.setItem('hoeve-drive-was-connected','1');}catch(e){}
})();
const HB_AI='via-server';
</script>
"""

POST = r"""<script>
// ═══ HOEVE-SERVER: aanpassingen na het laden van de app ═══
function smLoad(){try{const r=localStorage.getItem(SCHOONMAAK_KEY);if(r)schoonmaak={...schoonmaak,...JSON.parse(r)};}catch(e){}schoonmaak.webhook='https://hoeve-server/api/webhook/lokaal';}
function smPost(url){
  return fetch('api/ha/rooster',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(smPayloadVoorHA())})
    .then(async r=>{if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error((j.error&&j.error.message)||('HTTP '+r.status));}
      schoonmaak.laatstVerstuurd=new Date().toISOString();smSave();});
}
async function hbRestore(file){
  if(!file)return;
  if(!confirm('Alle gegevens op de Hoeve-server vervangen door deze back-up?\n\nDe huidige gegevens blijven als "vorige" bewaard op de server.'))return;
  const r=await fetch('api/restore',{method:'POST',headers:{'content-type':'application/gzip'},body:file});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){alert('Terugzetten mislukt: '+((j.error&&j.error.message)||r.status));return;}
  ['hoeve-appdata-v1','hoeve-projects-v1','hoeve-photos-v1','hoeve-tommy-info'].forEach(k=>{try{localStorage.removeItem(k);}catch(e){}});
  try{localStorage.removeItem(APPDATA_STORAGE_KEY);localStorage.removeItem(PROJECTS_STORAGE_KEY);localStorage.removeItem(PHOTOS_STORAGE_KEY);}catch(e){}
  alert('Back-up teruggezet ('+j.files+' bestanden). De app wordt opnieuw geladen.');
  location.reload();
}
</script>
"""

# 1. Google-scripts eruit, shim erin (vóór alle app-scripts)
rep('<script src="https://accounts.google.com/gsi/client" async defer></script>\n', '')
rep('<script src="https://apis.google.com/js/api.js" async defer></script>\n', PRE)
# 2. na-script aan het eind van body
i = h.rindex('</body>')
h = h[:i] + POST + h[i:]
# 3. AI-sleutel via server
h = re.sub(r"settings\.apiKey(?!\s*=[^=])", "HB_AI", h)
rep("""      <input type="password" class="settings-input" id="set-apikey" placeholder="sk-ant-api03-...">""",
    """      <input type="hidden" id="set-apikey" value=""><div class="settings-help" style="color:var(--text)">De API-sleutel staat veilig in Home Assistant: <strong>Instellingen → Apps → Hoeve Beheer → Configuratie</strong>. Hij komt niet in de browser.</div>""")
# 4. geen service worker (werkt niet achter Home Assistant)
rep("navigator.serviceWorker.register('sw.js')", "Promise.resolve()")
# 4b. logboekregels die via POST /api/logboek zijn toegevoegd niet overschrijven bij opslaan
rep("""    if(foundId) driveAppDataFileId = foundId;
    const cleanDocs = {};""",
    """    if(foundId) driveAppDataFileId = foundId;
    // Logboekregels die buiten de app zijn toegevoegd (POST /api/logboek) niet overschrijven
    if(driveAppDataFileId){
      const remote = await getDriveFileContent(driveAppDataFileId);
      if(remote && Array.isArray(remote.logboek)){
        const known = new Set(logboek.map(l=>l.id));
        const extra = remote.logboek.filter(l=>l && l.bron==='api' && !known.has(l.id));
        if(extra.length){logboek = extra.concat(logboek);try{renderLogboek();}catch(e){}}
      }
    }
    const cleanDocs = {};""")
# 5. account / teksten
rep("const DRIVE_ACCOUNT='coesjanssen@gmail.com';", "const DRIVE_ACCOUNT='hoeve-server';")
h = h.replace("coesjanssen@gmail.com", "de Hoeve-server")
for a, b in [("Gesynct met Google Drive", "Opgeslagen op de Hoeve-server"),
             ("NIET GESYNCT – niet verbonden met Google Drive", "NIET VERBONDEN met de Hoeve-server"),
             ("Synchroniseren met Google Drive…", "Opslaan op de Hoeve-server…"),
             ("Google Drive verbonden – nog niet gesynct in deze sessie.", "Verbonden met de Hoeve-server."),
             ("'☁️ Opgeslagen in Drive'", "'☁️ Opgeslagen op de server'"),
             ("Onderhoudsbeheer · Diepenveenseweg 17, Olst", "Onderhoudsbeheer · Hoeve-server (Pi)"),
             (">Drive</button>", ">Server</button>"),
             ("Tommy-export bewaard in Drive", "Tommy-export bewaard op de server"),
             ("Sync geslaagd: Drive bevat precies dezelfde bezetting", "Opslaan geslaagd: de server bevat precies dezelfde bezetting"),
             ("Laatste Tommy-export staat ook in Drive", "Laatste Tommy-export staat ook op de server")]:
    assert a in h, a
    h = h.replace(a, b)
# 6. persoonlijke gegevens uit de code
rep("Diederik Coes · 062943613 · dtcoes@gmail.com", "Hoeve Wetermans")
# 7. webhook-blok vervangen: dit gaat direct
h = re.sub(r'<p>Het webhook-adres is geheim.*?</p>\s*<div style="display:flex;gap:8px;flex-wrap:wrap">\s*<input type="password" id="sm-webhook".*?</div>',
           '<p>Deze versie draait in Home Assistant zelf en stuurt het rooster direct door. Er is geen webhook-adres nodig.</p><input type="hidden" id="sm-webhook">',
           h, count=1, flags=re.S)
assert 'Deze versie draait in Home Assistant zelf' in h
# 8. back-up in Instellingen
rep("""      <div class="settings-label">Synchronisatie</div>""",
    """      <div class="settings-label">💾 Back-up</div>
      <div class="settings-help">Alle gegevens (taken, bezetting, projecten, foto's, documenten, Tommy-exports) staan op de Hoeve-server. Ze zitten ook in de back-ups van Home Assistant.</div>
      <div style="display:flex;gap:6px;margin:10px 0 18px;flex-wrap:wrap">
        <a class="btn btn-green" style="padding:7px 13px;font-size:12px;text-decoration:none" href="api/backup" download>⬇️ Download back-up</a>
        <label class="btn btn-blue" style="padding:7px 13px;font-size:12px;cursor:pointer">⬆️ Back-up terugzetten<input type="file" accept=".gz,.tgz,application/gzip" style="display:none" onchange="hbRestore(this.files[0]);this.value=''"></label>
      </div>
      <div class="settings-label">Synchronisatie</div>""")
open(out, 'w', encoding='utf-8').write(h)
print('ok', len(h))
