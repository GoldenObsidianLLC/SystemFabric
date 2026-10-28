'use strict';
function cleanText(value, max = 10000) { if(typeof value!=='string') return null; const text=value.replace(/\u0000/g,'').trim(); return text && text.length<=max ? text : null; }
function validateProfile(body) {
  const errors=[]; if(!body||typeof body!=='object'||Array.isArray(body)) return {valid:false,errors:['profile must be an object']};
  if(typeof body.displayName!=='string'||!body.displayName.trim()||body.displayName.length>180) errors.push('displayName must contain 1–180 characters');
  if(body.bio!==undefined&&(typeof body.bio!=='string'||body.bio.length>4000)) errors.push('bio must be up to 4000 characters');
  if(body.visibility!==undefined&&!['public','members','private'].includes(body.visibility)) errors.push('visibility is invalid');
  if(body.websiteUrl!==undefined&&body.websiteUrl!==null) { try { const u=new URL(body.websiteUrl); if(!['http:','https:'].includes(u.protocol)||u.username||u.password) errors.push('websiteUrl must be an HTTP(S) URL'); } catch { errors.push('websiteUrl must be an HTTP(S) URL'); } }
  return {valid:errors.length===0,errors};
}
function validateGroup(body) {
  const errors=[]; if(typeof body?.slug!=='string'||!/^[a-z0-9][a-z0-9-]{0,100}$/.test(body.slug)) errors.push('slug is invalid');
  if(typeof body?.name!=='string'||!body.name.trim()||body.name.length>180) errors.push('name must contain 1–180 characters');
  if(body?.description!==undefined&&(typeof body.description!=='string'||body.description.length>8000)) errors.push('description is too long');
  if(body?.privacy!==undefined&&!['public','private','hidden'].includes(body.privacy)) errors.push('privacy is invalid');
  return {valid:errors.length===0,errors};
}
module.exports = { cleanText, validateProfile, validateGroup };
