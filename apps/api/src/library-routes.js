'use strict';

const { optimizeImage, optimizeVideoToWebm } = require('../../../packages/media/src/optimizer');

/**
 * Handle the site-scoped library and media route family.
 *
 * The API composition layer authenticates the request and supplies site and
 * capability checks. This module owns the HTTP behavior for asset upload,
 * metadata/version operations, private downloads, and optional derivatives.
 * Storage consistency remains in the library store and its reconciliation
 * workflow; PostgreSQL and object storage are not treated as one transaction.
 */
async function handleLibraryRoute(ctx) {
  const {
    req, res, url, actor, siteIdFor, requireCapability, readJson, sendJson,
    fail, requestId, localPool, libraryStore, identity, maxBody,
    maxLibraryBody, maxOptimizerBytes
  } = ctx;
  const pathName = url.pathname;
  const method = req.method;
  const libraryCollection=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/library\/items$/i);
  const libraryItem=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/library\/items\/([0-9a-f-]{36})(?:\/(versions|optimize|download))?$/i);
  if ((libraryCollection&&['GET','POST'].includes(method))||(libraryItem&&['GET','PATCH','DELETE','POST','PUT'].includes(method))) {
    if(!libraryStore||!localPool) throw fail(503,'ERR_VIRGOSCORPIO_HUB_LIBRARY_DISABLED','File and document libraries require PostgreSQL and configured storage.');
    const siteId=libraryCollection?.[1]||libraryItem[1]; const body=['POST','PATCH','PUT','DELETE'].includes(method)&&libraryItem?.[3]!=='download'?await readJson(req,maxLibraryBody||maxBody):{};
    await siteIdFor({ req, url, body, actor, routeSiteId: siteId }); await requireCapability(actor,siteId,method==='GET'?'library:manage':'library:manage');
    if(libraryCollection){
      if(method==='GET') return sendJson(res,200,{items:await libraryStore.list({siteId,category:url.searchParams.get('category')||'all',query:url.searchParams.get('q')||'',limit:url.searchParams.get('limit')||50,offset:url.searchParams.get('offset')||0}),libraryKinds:['image','video','audio','document','file','font'],requestId});
      const category=body.category;
      const asset=await libraryStore.upload({siteId,actorId:actor.user.id,category,dataBase64:body.dataBase64,mimeType:body.mimeType,fileName:body.fileName,displayName:body.displayName,altText:body.altText||'',caption:body.caption||'',description:body.description||'',isPublic:body.isPublic===true,metadata:body.metadata||{}});
      await identity?.audit({siteId,actorId:actor.user.id,action:'library.asset_uploaded',targetType:'library-asset',targetId:asset.id,requestId,details:{kind:asset.asset_kind,mimeType:asset.mime_type,byteSize:asset.byte_size,sha256:asset.sha256}});
      return sendJson(res,201,{item:asset,url:asset.is_public?`/library/public/${asset.id}`:null,requestId});
    }
    const id=libraryItem[2], action=libraryItem[3];
    if(method==='GET'&&action==='download'){const value=await libraryStore.getBufferById({siteId,id});if(!value)throw fail(404,'ERR_VIRGOSCORPIO_HUB_LIBRARY_NOT_FOUND','Library asset not found.');const safeName=String(value.asset.original_name||'download').replace(/[\r\n\"\\]/g,'_').slice(0,240);res.writeHead(200,{'content-type':value.asset.mime_type,'content-length':value.data.length,'content-disposition':`attachment; filename="${safeName}"`,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});res.end(value.data);return true;}
    if(method==='PUT'&&!action){const item=await libraryStore.replaceVersion({siteId,id,actorId:actor.user.id,expectedVersion:body.expectedVersion,dataBase64:body.dataBase64,mimeType:body.mimeType,fileName:body.fileName});await identity?.audit({siteId,actorId:actor.user.id,action:'library.asset_version_replaced',targetType:'library-asset',targetId:id,requestId,details:{version:item.version,mimeType:item.mime_type,sha256:item.sha256}});return sendJson(res,200,{item,requestId});}
    if(method==='GET'&&action==='versions'){const history=await libraryStore.history({siteId,id});if(!history)throw fail(404,'ERR_VIRGOSCORPIO_HUB_LIBRARY_NOT_FOUND','Library asset not found.');return sendJson(res,200,{versions:history,requestId});}
    if(method==='POST'&&action==='optimize'){
      const value=await libraryStore.getBufferById({siteId,id});if(!value)throw fail(404,'ERR_VIRGOSCORPIO_HUB_LIBRARY_NOT_FOUND','Library asset not found.');
      await libraryStore.markOptimization({siteId,id,status:'processing',details:{requestedAt:new Date().toISOString()}});
      try {
        let result;
        if(value.asset.asset_kind==='image') result=await optimizeImage(value.data);
        else if(value.asset.asset_kind==='video'&&value.asset.mime_type==='video/mp4') result=await optimizeVideoToWebm(value.data,{maxBytes:maxOptimizerBytes||100*1024*1024});
        else { await libraryStore.markOptimization({siteId,id,status:'skipped',details:{optimizationReason:'no-optimizer-for-this-media-type'}});return sendJson(res,200,{optimization:{status:'skipped',reason:'no-optimizer-for-this-media-type'},requestId}); }
        if(!result.optimized){const status='skipped';await libraryStore.markOptimization({siteId,id,status,details:{optimizationReason:result.reason,bytesSaved:result.bytesSaved||0}});return sendJson(res,200,{optimization:{status,reason:result.reason,bytesSaved:result.bytesSaved||0},requestId});}
        const variant=await libraryStore.createVariant({siteId,id,variantKey:result.mimeType==='image/webp'?'webp-optimized':'webm-optimized',data:result.buffer,mimeType:result.mimeType});
        await libraryStore.markOptimization({siteId,id,status:'optimized',details:{optimizationReason:result.reason,bytesSaved:result.bytesSaved,variantId:variant.id}});
        return sendJson(res,200,{optimization:{status:'optimized',variant,bytesSaved:result.bytesSaved},requestId});
      } catch(error){await libraryStore.markOptimization({siteId,id,status:error.code==='ERR_VIRGOSCORPIO_HUB_OPTIMIZER_UNAVAILABLE'?'skipped':'failed',details:{optimizationReason:error.code||'optimizer-failed'}});if(error.statusCode)throw error;return sendJson(res,200,{optimization:{status:error.code==='ERR_VIRGOSCORPIO_HUB_OPTIMIZER_UNAVAILABLE'?'skipped':'failed',reason:error.code||'optimizer-failed'},requestId});}
    }
    if(method==='GET'){const item=await libraryStore.get({siteId,id});if(!item)throw fail(404,'ERR_VIRGOSCORPIO_HUB_LIBRARY_NOT_FOUND','Library asset not found.');return sendJson(res,200,{item,versions:await libraryStore.history({siteId,id}),requestId});}
    if(method==='PATCH'){const item=await libraryStore.updateMetadata({siteId,id,actorId:actor.user.id,expectedVersion:body.expectedVersion,patch:body.patch});return sendJson(res,200,{item,requestId});}
    if(method==='DELETE'){const deleted=await libraryStore.delete({siteId,id,expectedVersion:body.expectedVersion});return sendJson(res,200,{deleted:true,...deleted,requestId});}
  }
  return false;
}

module.exports = { handleLibraryRoute };
