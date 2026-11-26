/* Version autonome du Journal calories : tout est enregistré dans ce navigateur (localStorage).
   Ce fichier fournit seulement ce que l'artefact Claude fournissait : l'estimation par Claude (clé API facultative),
   une section Réglages (clé, sauvegarde) et le service worker pour l'usage hors ligne. */
(function(){
  window.STANDALONE=true;
  var KEY="journal-calories-apikey";
  var MODELS={quick:"claude-haiku-5-5","default":"claude-sonnet-5-5",complex:"claude-opus-5-5"};
  var getKey=function(){try{return localStorage.getItem(KEY)||"";}catch(e){return "";}};

  function toB64(blob){
    return new Promise(function(res,rej){
      var r=new FileReader();
      r.onload=function(){res(String(r.result).split(",")[1]||"");};
      r.onerror=function(){rej({code:"image_rejected"});};
      r.readAsDataURL(blob);
    });
  }
  async function call(input,opts){
    opts=opts||{};
    var key=getKey();
    if(!key) throw {code:"not_granted"};
    var content=[];
    for(var blob of (opts.images||[])){
      content.push({type:"image",source:{type:"base64",media_type:blob.type||"image/jpeg",data:await toB64(blob)}});
    }
    content.push({type:"text",text:typeof input==="string"?input:JSON.stringify(input)});
    var resp;
    try{
      resp=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",signal:opts.signal,
        headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
        body:JSON.stringify({model:opts.model||MODELS[opts.modelTier||"default"]||MODELS["default"],max_tokens:opts.maxTokens||4096,messages:[{role:"user",content:content}]})
      });
    }catch(e){
      if(e&&e.name==="AbortError") throw {code:"cancelled"};
      throw {code:"network",message:"Pas de connexion."};
    }
    if(!resp.ok){
      var msg="";try{msg=(await resp.json()).error.message||"";}catch(e){}
      if(resp.status===401||resp.status===403) throw {code:"not_granted",message:msg};
      if(resp.status===429||resp.status===529) throw {code:"rate_limited",message:msg};
      if(/image/i.test(msg)) throw {code:"image_rejected",message:msg};
      throw {code:"failed",message:msg||("Erreur "+resp.status)};
    }
    var data=await resp.json();
    var text=(data.content||[]).filter(function(b){return b.type==="text";}).map(function(b){return b.text;}).join("");
    return {text:text,truncated:data.stop_reason==="max_tokens"};
  }
  function parseJSON(text){
    var t=String(text||"").replace(/```(?:json)?/gi,"").trim();
    var a=t.indexOf("{"),b=t.lastIndexOf("}");
    if(a<0||b<a) throw {code:"invalid_json"};
    try{return JSON.parse(t.slice(a,b+1));}catch(e){throw {code:"invalid_json"};}
  }
  function makeSample(){
    var s=function(input,opts){return call(input,opts);};
    s.json=async function(input,opts){var r=await call(input,opts);return parseJSON(r.text);};
    s.limits=async function(){return {images:{maxCount:4,maxInputBytes:5000000,mediaTypes:["image/jpeg","image/png","image/webp","image/gif"]}};};
    return s;
  }
  // Même interface que dans Claude : use("sample") vaut null tant qu'aucune clé n'est enregistrée,
  // et "user" / "db" valent null : l'appli enregistre alors dans ce navigateur.
  window.claude={use:async function(name){return name==="sample"&&getKey()?makeSample():null;}};

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
    box.append(el("h3",{text:"Estimation par Claude"}));
    box.append(el("p",{class:"hint",style:"margin:0",text:"Pour estimer calories et macros à partir d’un texte ou d’une photo, l’appli appelle l’API d’Anthropic avec ta propre clé. L’usage est facturé sur ton compte Anthropic (quelques centimes par jour en général). Sans clé, tout le reste fonctionne : tu ajoutes les lignes à la main."}));
    var inp=el("input",{type:"password",autocomplete:"off",placeholder:getKey()?"Clé enregistrée (••••"+getKey().slice(-4)+")":"sk-ant-…","aria-label":"Clé API Anthropic"});
    var msg=el("div",{class:"hint",style:"margin:0",role:"status"});
    var save=el("button",{type:"button",class:"btn primary",text:"Enregistrer la clé",onclick:function(){
      var v=inp.value.trim();
      if(!/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(v)){msg.textContent="Cette clé ne ressemble pas à une clé Anthropic (elle commence par sk-ant-).";return;}
      try{localStorage.setItem(KEY,v);}catch(e){msg.textContent="Impossible d’enregistrer dans ce navigateur.";return;}
      inp.value="";inp.placeholder="Clé enregistrée (••••"+v.slice(-4)+")";msg.textContent="Clé enregistrée sur cet appareil.";onKeyChange&&onKeyChange();
    }});
    var test=el("button",{type:"button",class:"btn",text:"Tester",onclick:async function(){
      msg.textContent="Test en cours…";
      try{await call("Réponds seulement : ok",{modelTier:"quick",maxTokens:10});msg.textContent="La clé fonctionne.";}
      catch(e){msg.textContent=e&&e.code==="not_granted"?"Clé refusée ou absente.":e&&e.code==="rate_limited"?"Limite atteinte ou crédit insuffisant sur ton compte Anthropic.":("Échec du test"+(e&&e.message?" : "+e.message:"."));}
    }});
    var del=el("button",{type:"button",class:"btn",text:"Retirer la clé",onclick:function(){
      try{localStorage.removeItem(KEY);}catch(e){}
      inp.placeholder="sk-ant-…";msg.textContent="Clé retirée.";onKeyChange&&onKeyChange();
    }});
    box.append(el("label",{class:"f"},[el("span",{text:"Clé API Anthropic"}),inp]));
    box.append(el("div",{class:"row",style:"gap:8px;flex-wrap:wrap"},[save,test,getKey()?del:null]));
    box.append(msg);

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
