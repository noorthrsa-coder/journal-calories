/* Version autonome du Journal calories : tout est enregistré dans ce navigateur (localStorage).
   Ce fichier fournit seulement ce que l'artefact Claude fournissait : l'estimation par Claude (clé API facultative),
   une section Réglages (clé, sauvegarde) et le service worker pour l'usage hors ligne. */
(function(){
  window.STANDALONE=true;
  // Profils proposés dès la première ouverture (nom, couleur, icône seulement : aucune donnée personnelle).
  window.DEFAULT_PROFILES=[
    {id:"main",name:"Noor",color:"turquoise",icon:"🥕"},
    {id:"pvibd31",name:"Khalled",color:"bleu",icon:"🐱"}
  ];
  var K_ANTH="journal-calories-apikey", K_GEM="journal-calories-gkey", K_PROV="journal-calories-provider", K_MODEL="journal-calories-gmodels";
  var ls={get:function(k){try{return localStorage.getItem(k)||"";}catch(e){return "";}},set:function(k,v){try{localStorage.setItem(k,v);return true;}catch(e){return false;}},del:function(k){try{localStorage.removeItem(k);}catch(e){}}};
  var provider=function(){var p=ls.get(K_PROV);return p==="claude"||p==="gemini"?p:"gemini";};
  var keyOf=function(p){return ls.get(p==="claude"?K_ANTH:K_GEM);};
  var ANTH_MODELS={quick:"claude-haiku-5-5","default":"claude-sonnet-5-5",complex:"claude-opus-5-5"};

  function toB64(blob){
    return new Promise(function(res,rej){
      var r=new FileReader();
      r.onload=function(){res(String(r.result).split(",")[1]||"");};
      r.onerror=function(){rej({code:"image_rejected"});};
      r.readAsDataURL(blob);
    });
  }
  function netErr(e){
    if(e&&e.name==="AbortError") return {code:"cancelled"};
    return {code:"network",message:"Pas de connexion."};
  }

  /* ----- Claude (API Anthropic, payante) ----- */
  async function callClaude(input,opts){
    var key=keyOf("claude");
    if(!key) throw {code:"not_granted"};
    var content=[];
    for(var blob of (opts.images||[])){
      content.push({type:"image",source:{type:"base64",media_type:blob.type||"image/jpeg",data:await toB64(blob)}});
    }
    content.push({type:"text",text:input});
    var resp;
    try{
      resp=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",signal:opts.signal,
        headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
        body:JSON.stringify({model:ANTH_MODELS[opts.modelTier||"default"]||ANTH_MODELS["default"],max_tokens:opts.maxTokens||4096,messages:[{role:"user",content:content}]})
      });
    }catch(e){throw netErr(e);}
    if(!resp.ok){
      var msg="";try{msg=(await resp.json()).error.message||"";}catch(e){}
      if(resp.status===401||resp.status===403) throw {code:"not_granted",message:msg};
      if(resp.status===429||resp.status===529) throw {code:"rate_limited",message:msg};
      if(/image/i.test(msg)) throw {code:"image_rejected",message:msg};
      throw {code:"failed",message:msg||("Erreur "+resp.status)};
    }
    var data=await resp.json();
    return (data.content||[]).filter(function(b){return b.type==="text";}).map(function(b){return b.text;}).join("");
  }

  /* ----- Gemini (API Google, offre gratuite) : le nom du modèle est détecté, car Google le change souvent ----- */
  var GBASE="https://generativelanguage.googleapis.com/v1beta/";
  function pickModels(list){
    var ok=[];
    (list||[]).forEach(function(m){
      var name=String(m.name||"").replace(/^models\//,"");
      if(!/^gemini-\d+(?:\.\d+)?-flash(?:-lite)?(?:-preview(?:-[\w-]+)?)?$/.test(name)) return;
      if(/image|tts|live|audio|embedding|thinking|robotics|computer|native|exp/.test(name)) return;
      if(m.supportedGenerationMethods&&m.supportedGenerationMethods.indexOf("generateContent")<0) return;
      var v=parseFloat(name.match(/^gemini-(\d+(?:\.\d+)?)/)[1]);
      ok.push({name:name,v:v,lite:/-lite/.test(name),preview:/preview/.test(name)});
    });
    var best=function(lite){
      var c=ok.filter(function(x){return x.lite===lite;});
      c.sort(function(a,b){return b.v-a.v||(a.preview-b.preview);});
      return c[0]&&c[0].name;
    };
    return {main:best(false)||best(true),lite:best(true)||best(false)};
  }
  async function gemModels(force){
    if(!force){try{var c=JSON.parse(ls.get(K_MODEL)||"null");if(c&&c.main&&Date.now()-c.t<7*864e5) return c;}catch(e){}}
    var resp;
    try{resp=await fetch(GBASE+"models?pageSize=200",{headers:{"x-goog-api-key":keyOf("gemini")}});}catch(e){throw netErr(e);}
    if(!resp.ok) throw await gemError(resp);
    var data=await resp.json(),p=pickModels(data.models);
    if(!p.main) throw {code:"failed",message:"Aucun modèle Gemini gratuit trouvé pour cette clé."};
    p.t=Date.now();ls.set(K_MODEL,JSON.stringify(p));
    return p;
  }
  async function gemError(resp){
    var msg="",status="";try{var j=(await resp.json()).error||{};msg=j.message||"";status=j.status||"";}catch(e){}
    if(resp.status===429||status==="RESOURCE_EXHAUSTED") return {code:"rate_limited",message:msg};
    if(resp.status===401||resp.status===403||/API key/i.test(msg)) return {code:"not_granted",message:msg};
    if(resp.status===404) return {code:"model_missing",message:msg};
    if(/image|mime/i.test(msg)) return {code:"image_rejected",message:msg};
    return {code:"failed",message:msg||("Erreur "+resp.status)};
  }
  async function callGemini(input,opts,wantJson,retried){
    if(!keyOf("gemini")) throw {code:"not_granted"};
    var models=await gemModels(false);
    var model=(opts.modelTier==="quick"?models.lite:models.main)||models.main;
    var parts=[];
    for(var blob of (opts.images||[])){
      parts.push({inline_data:{mime_type:blob.type||"image/jpeg",data:await toB64(blob)}});
    }
    parts.push({text:input});
    var gen={maxOutputTokens:opts.maxTokens||8192};
    if(wantJson) gen.responseMimeType="application/json";
    var resp;
    try{
      resp=await fetch(GBASE+"models/"+model+":generateContent",{
        method:"POST",signal:opts.signal,
        headers:{"content-type":"application/json","x-goog-api-key":keyOf("gemini")},
        body:JSON.stringify({contents:[{role:"user",parts:parts}],generationConfig:gen})
      });
    }catch(e){throw netErr(e);}
    if(!resp.ok){
      var err=await gemError(resp);
      if(err.code==="model_missing"&&!retried){ls.del(K_MODEL);return callGemini(input,opts,wantJson,true);}
      throw err;
    }
    var data=await resp.json();
    var cand=(data.candidates||[])[0];
    if(!cand){throw {code:"refused",message:(data.promptFeedback&&data.promptFeedback.blockReason)||""};}
    return ((cand.content&&cand.content.parts)||[]).map(function(p){return p.text||"";}).join("");
  }

  async function call(input,opts,wantJson){
    opts=opts||{};
    input=typeof input==="string"?input:JSON.stringify(input);
    return provider()==="claude"?callClaude(input,opts):callGemini(input,opts,wantJson,false);
  }
  function parseJSON(text){
    var t=String(text||"").replace(/```(?:json)?/gi,"").trim();
    var a=t.indexOf("{"),b=t.lastIndexOf("}");
    if(a<0||b<a) throw {code:"invalid_json"};
    try{return JSON.parse(t.slice(a,b+1));}catch(e){throw {code:"invalid_json"};}
  }
  function makeSample(){
    var s=async function(input,opts){return {text:await call(input,opts,false)};};
    s.json=async function(input,opts){return parseJSON(await call(input,opts,true));};
    s.limits=async function(){return {images:{maxCount:4,maxInputBytes:5000000,mediaTypes:["image/jpeg","image/png","image/webp","image/gif"]}};};
    return s;
  }
  // Même interface que dans Claude : use("sample") vaut null tant qu'aucune clé n'est enregistrée,
  // et "user" / "db" valent null : l'appli enregistre alors dans ce navigateur.
  window.claude={use:async function(name){return name==="sample"&&keyOf(provider())?makeSample():null;}};
  window.__standaloneApi={pickModels:pickModels};

  /* ---------- Section Réglages propre à l'app autonome ---------- */
  function el(tag,attrs,kids){
    var e=document.createElement(tag);
    Object.keys(attrs||{}).forEach(function(k){
      if(k==="class") e.className=attrs[k];
      else if(k==="text") e.textContent=attrs[k];
      else if(k.indexOf("on")===0) e.addEventListener(k.slice(2),attrs[k]);
      else e.setAttribute(k,attrs[k]);
    });
    (kids||[]).forEach(function(c){if(c) e.append(c);});
    return e;
  }
  var toast=function(m){var t=document.getElementById("toast");if(!t) return;t.textContent=m;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(function(){t.hidden=true;},3500);};

  async function importFile(ev){
    var f=ev.target.files[0];ev.target.value="";if(!f) return;
    try{
      var d=JSON.parse(await f.text());
      if(!d||typeof d["journal-calories-v2"]!=="string") throw new Error("format");
      JSON.parse(d["journal-calories-v2"]);
      if(!confirm("Remplacer les données de cet appareil par cette sauvegarde ?")) return;
      localStorage.setItem("journal-calories-v2",d["journal-calories-v2"]);
      if(d["journal-calories-pid"]) localStorage.setItem("journal-calories-pid",d["journal-calories-pid"]);
      location.reload();
    }catch(e){toast("Ce fichier n’est pas une sauvegarde valide.");}
  }
  // Bouton « Importer une sauvegarde » affiché sur l'écran « Qui est-ce ? »
  window.standaloneImportButton=function(){
    var file=el("input",{type:"file",accept:"application/json,.json",hidden:"",onchange:function(ev){importFile(ev);}});
    var btn=el("button",{type:"button",class:"btn",text:"Importer une sauvegarde",onclick:function(){file.click();}});
    return el("div",{style:"display:flex;justify-content:center;margin-top:10px"},[btn,file]);
  };
  window.standaloneSettings=function(onKeyChange){
    var box=el("div",{style:"margin-top:22px;border-top:1px solid var(--line);padding-top:16px;display:flex;flex-direction:column;gap:10px"});
    box.append(el("h3",{text:"Estimation par IA"}));
    box.append(el("p",{class:"hint",style:"margin:0",text:"Pour estimer calories et macros à partir d’un texte ou d’une photo, l’appli appelle une IA avec ta propre clé. Gemini (Google) propose une offre gratuite, Claude (Anthropic) est payant. Sans clé, tout le reste fonctionne : tu ajoutes les lignes à la main."}));
    var cur=provider();
    var msg=el("div",{class:"hint",style:"margin:0",role:"status"});
    var inp=el("input",{type:"password",autocomplete:"off","aria-label":"Clé API"});
    var seg=el("div",{class:"seg",role:"group",style:"margin:0"});
    var rebuild=function(){
      var p=cur,k=keyOf(p);
      Array.prototype.forEach.call(seg.children,function(c){c.classList.toggle("on",c.dataset.p===p);c.setAttribute("aria-pressed",String(c.dataset.p===p));});
      inp.value="";inp.placeholder=k?"Clé enregistrée (••••"+k.slice(-4)+")":(p==="gemini"?"Clé Gemini":"Clé Claude (sk-ant-…)");
      help.textContent=p==="gemini"?"Crée une clé gratuite sur aistudio.google.com/apikey (compte Google), puis colle-la ici. L’offre gratuite a une limite d’usage par jour, et Google peut utiliser les textes envoyés pour améliorer ses produits : évite d’y mettre des infos sensibles.":"Crée une clé sur console.anthropic.com (API keys). L’usage est facturé sur ton compte Anthropic : fixe une limite de dépense mensuelle dans la console.";
      delBtn.hidden=!k;
    };
    ["gemini","claude"].forEach(function(p){
      seg.append(el("button",{type:"button",class:"pill","data-p":p,text:p==="gemini"?"Gemini (gratuit)":"Claude (payant)",onclick:function(){cur=p;ls.set(K_PROV,p);rebuild();msg.textContent="";onKeyChange&&onKeyChange();}}));
    });
    var help=el("p",{class:"hint",style:"margin:0"});
    var valid=function(p,v){return p==="gemini"?/^[A-Za-z0-9._-]{30,}$/.test(v):/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(v);};
    var save=el("button",{type:"button",class:"btn primary",text:"Enregistrer la clé",onclick:function(){
      var v=inp.value.trim();
      if(!valid(cur,v)){msg.textContent=cur==="gemini"?"Cette clé ne ressemble pas à une clé Gemini (pas d’espace, au moins 30 caractères).":"Cette clé ne ressemble pas à une clé Anthropic (elle commence par sk-ant-).";return;}
      if(!ls.set(cur==="claude"?K_ANTH:K_GEM,v)){msg.textContent="Impossible d’enregistrer dans ce navigateur.";return;}
      ls.set(K_PROV,cur);ls.del(K_MODEL);rebuild();msg.textContent="Clé enregistrée sur cet appareil.";onKeyChange&&onKeyChange();
    }});
    var test=el("button",{type:"button",class:"btn",text:"Tester",onclick:async function(){
      msg.textContent="Test en cours…";
      try{await call("Réponds seulement : ok",{modelTier:"quick",maxTokens:20},false);msg.textContent="La clé fonctionne.";}
      catch(e){msg.textContent=e&&e.code==="not_granted"?"Clé refusée ou absente.":e&&e.code==="rate_limited"?(cur==="gemini"?"Limite gratuite atteinte pour le moment. Réessaie plus tard.":"Limite atteinte ou crédit insuffisant sur ton compte Anthropic."):e&&e.code==="network"?"Pas de connexion.":("Échec du test"+(e&&e.message?" : "+e.message:"."));}
    }});
    var delBtn=el("button",{type:"button",class:"btn",text:"Retirer la clé",onclick:function(){
      ls.del(cur==="claude"?K_ANTH:K_GEM);ls.del(K_MODEL);rebuild();msg.textContent="Clé retirée.";onKeyChange&&onKeyChange();
    }});
    box.append(seg);box.append(help);
    box.append(el("label",{class:"f"},[el("span",{text:"Clé API"}),inp]));
    box.append(el("div",{class:"row",style:"gap:8px;flex-wrap:wrap"},[save,test,delBtn]));
    box.append(msg);
    rebuild();

    box.append(el("h3",{style:"margin-top:14px",text:"Sauvegarde des données"}));
    box.append(el("p",{class:"hint",style:"margin:0",text:"Tes données sont enregistrées dans ce navigateur seulement. Si tu vides les données du site, elles disparaissent : exporte une sauvegarde de temps en temps, ou pour passer sur un autre appareil."}));
    var exp=el("button",{type:"button",class:"btn",text:"Exporter une sauvegarde",onclick:function(){
      var data={};
      ["journal-calories-v2","journal-calories-pid"].forEach(function(k){try{var v=localStorage.getItem(k);if(v!==null) data[k]=v;}catch(e){}});
      var a=document.createElement("a");
      a.href=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:"application/json"}));
      a.download="journal-calories-sauvegarde-"+new Date().toISOString().slice(0,10)+".json";
      document.body.append(a);a.click();a.remove();
    }});
    var file=el("input",{type:"file",accept:"application/json,.json",hidden:"",onchange:function(ev){importFile(ev);}});
    var imp=el("button",{type:"button",class:"btn",text:"Importer une sauvegarde",onclick:function(){file.click();}});
    box.append(el("div",{class:"row",style:"gap:8px;flex-wrap:wrap"},[exp,imp,file]));
    return box;
  };

  if("serviceWorker" in navigator&&/^https?:$/.test(location.protocol)){
    window.addEventListener("load",function(){navigator.serviceWorker.register("sw.js").catch(function(){});});
  }
})();
