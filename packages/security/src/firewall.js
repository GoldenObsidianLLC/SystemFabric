'use strict';
const net = require('node:net');
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
function ipToInt(ip) { if (!IPV4_RE.test(ip)) return null; const octets=ip.split('.').map(Number); if (octets.some(n=>n<0||n>255)) return null; return (((octets[0]<<24)>>>0) | (octets[1]<<16) | (octets[2]<<8) | octets[3])>>>0; }
function validateIpPattern(scope, pattern) {
  if (typeof pattern !== 'string' || pattern.length > 500) return false;
  if (scope === 'ip') return net.isIP(pattern) !== 0;
  if (scope === 'cidr') { const [address,bits,extra] = pattern.split('/'); if (extra !== undefined || net.isIP(address)!==4) return false; const n=Number(bits); return Number.isInteger(n)&&n>=0&&n<=32&&ipToInt(address)!==null; }
  if (scope === 'path') return pattern.startsWith('/') && !pattern.includes('..') && !/[?#\r\n]/.test(pattern);
  if (scope === 'user_agent') return pattern.length >= 3 && !/[\r\n]/.test(pattern);
  return false;
}
function cidrContains(ip, cidr) { const [address,bitsRaw]=cidr.split('/'); const a=ipToInt(ip), b=ipToInt(address), bits=Number(bitsRaw); if (a===null||b===null||!Number.isInteger(bits)) return false; if (bits===0) return true; const mask=(0xffffffff << (32-bits))>>>0; return (a&mask)===(b&mask); }
function ruleMatches(rule, request) {
  if (!rule.enabled) return false;
  if (rule.scope==='ip') return String(request.ip||'')===rule.pattern;
  if (rule.scope==='cidr') return cidrContains(String(request.ip||''),rule.pattern);
  if (rule.scope==='path') return String(request.path||'')===rule.pattern || String(request.path||'').startsWith(rule.pattern.endsWith('*') ? rule.pattern.slice(0,-1) : `${rule.pattern.replace(/\/$/,'')}/`);
  if (rule.scope==='user_agent') return String(request.userAgent||'').toLowerCase().includes(rule.pattern.toLowerCase());
  return false;
}
function createFirewall({ pool = null, env = process.env, cacheTtlMs = 5000 } = {}) {
  let cacheUntil = 0; let cached = []; let refreshing = null;
  const staticDeny = String(env.SYSTEMFABRIC_FIREWALL_DENY_CIDRS || '').split(',').map(x=>x.trim()).filter(Boolean).filter(x=>validateIpPattern(x.includes('/')?'cidr':'ip',x));
  async function refresh() {
    if (!pool) return;
    if (refreshing) return refreshing;
    refreshing = pool.query("SELECT id,site_id,action,scope,pattern,reason,enabled FROM firewall_rules WHERE enabled=true AND scope IN ('ip','cidr','path','user_agent') ORDER BY created_at ASC")
      .then(result=>{ cached=result.rows; cacheUntil=Date.now()+cacheTtlMs; }).catch(()=>{ cacheUntil=Date.now()+Math.min(cacheTtlMs,1000); }).finally(()=>{ refreshing=null; });
    return refreshing;
  }
  return Object.freeze({
    async evaluate(request) {
      if (Date.now() >= cacheUntil) await refresh();
      for (const cidr of staticDeny) if ((cidr.includes('/')&&cidrContains(String(request.ip||''),cidr)) || (!cidr.includes('/')&&String(request.ip||'')===cidr)) return { action:'deny', reason:'deployment-deny-list', ruleId:null };
      const matches=cached.filter(rule=>ruleMatches(rule,request) && (!rule.site_id || rule.site_id===request.siteId));
      const deny=matches.find(rule=>rule.action==='deny'); if (deny) return { action:'deny', reason:deny.reason||'firewall-rule', ruleId:deny.id };
      const challenge=matches.find(rule=>rule.action==='challenge'); if (challenge) return { action:'challenge', reason:challenge.reason||'firewall-rule', ruleId:challenge.id };
      const rateLimit=matches.find(rule=>rule.action==='rate_limit'); if (rateLimit) return { action:'rate_limit', reason:rateLimit.reason||'firewall-rule', ruleId:rateLimit.id };
      const allow=matches.find(rule=>rule.action==='allow'); return { action:allow?'allow':'pass', reason:allow?.reason||null, ruleId:allow?.id||null };
    },
    async rules(siteId) { if (Date.now() >= cacheUntil) await refresh(); return cached.filter(r=>!r.site_id||r.site_id===siteId); },
    clearCache() { cacheUntil=0; }
  });
}
module.exports = { createFirewall, validateIpPattern, cidrContains, ruleMatches, ipToInt };
