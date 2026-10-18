/** Owner control only. Calls the existing importer; never computes or edits a bundle. */
function appOfflineBatchReceipt_(state,r,ref,proofSha) {
  const q=appProvisionalReadJson_(appOfflineReceiptKey_(state,r.reservationKey));
  if(!q)return null;
  appOfflineAssert_(q.reservationKey===r.reservationKey&&q.planId===r.planId&&q.runId===r.runId&&q.bundleSha256===ref.sha256&&q.canaryProofSha256===proofSha&&['WRITING','DONE'].indexOf(q.status)>=0,'batch receipt binding mismatch');
  if(q.status==='DONE')appOfflineAssert_(q.completionMode==='verified_offline_bundle','batch completion mode mismatch');
  return q;
}
function appOfflineBatchCurrent_(ctx,input,m) {
  const s=appOfflineState_(),b=appProvisionalState_();
  appOfflineAssert_(s&&s.requestedBy===ctx.actor&&s.manifestId===input.manifestId&&s.batchId===m.batchId&&s.sourceManifest&&s.sourceManifest.sha256===input.sourceManifestSha256&&['EXPORTED','IMPORTING'].indexOf(s.status)>=0,'batch export state changed');
  appOfflineAssert_(b&&b.id===m.batchId&&b.requestedBy===ctx.actor&&!b.active&&!b.current&&b.offlineHandoff&&b.offlineHandoff.manifestId===m.manifestId,'batch must remain inactive');
  appOfflineRequireIdle_(); // Pending journals are recovered through the original one-file action.
  return s;
}
/** 200s admission budget, <=4 imports, 90s reserve; not an interruption deadline. */
function appOfflineImportBatch_(ctx,input) {
  const started=Date.now();ctx=appOfflineOwner_(ctx);input=input||{};
  appOfflineAssert_(typeof input.manifestId==='string'&&input.manifestId&&appOfflineHex_(input.sourceManifestSha256)&&typeof input.canaryProofFileId==='string'&&input.canaryProofFileId&&appOfflineHex_(input.canaryProofSha256),'batch manifest/proof IDs and SHA required');
  appOfflineAssert_(Array.isArray(input.files)&&input.files.length>0&&input.files.length<=38,'batch files must contain1..38 entries');
  const refs=input.files.map(x=>{appOfflineAssert_(x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===3&&typeof x.reservationKey==='string'&&x.reservationKey&&typeof x.fileId==='string'&&x.fileId&&appOfflineHex_(x.sha256),'invalid batch file reference');return {reservationKey:x.reservationKey,fileId:x.fileId,sha256:x.sha256};});
  ['reservationKey','fileId','sha256'].forEach(k=>appOfflineAssert_(new Set(refs.map(r=>r[k])).size===refs.length,'duplicate batch file '+k));
  const m=appWithLock_(()=>{
    const s=appOfflineState_();appOfflineAssert_(s&&s.sourceManifest&&s.manifestId===input.manifestId&&s.sourceManifest.sha256===input.sourceManifestSha256,'batch manifest pin mismatch');
    const v=appOfflineReadFile_(s.sourceManifest.fileId,input.sourceManifestSha256);
    appOfflineAssert_(v.manifestId===input.manifestId&&v.actor===ctx.actor&&Array.isArray(v.reservations)&&v.reservations.length>0,'batch manifest owner/reservations mismatch');
    ['reservationKey','planId','runId'].forEach(k=>appOfflineAssert_(v.reservations.every(r=>typeof r[k]==='string'&&r[k])&&new Set(v.reservations.map(r=>r[k])).size===v.reservations.length,'duplicate/invalid manifest reservation '+k));
    refs.forEach(ref=>appOfflineAssert_(v.reservations.some(r=>r.reservationKey===ref.reservationKey),'foreign batch reservation'));
    appOfflineBatchCurrent_(ctx,input,v);appRequireOpenYear_(v.fy);
    appOfflineAssert_(appOfflineSame_(v.contract,appOfflineContract_()),'batch runtime/schema drift');
    if(v.sourceId)appOfflineAssert_(appOfflineSourceStamp_(v.sourceId)===v.sourceModifiedAt,'batch source changed');
    const proof=appOfflineReadFile_(input.canaryProofFileId,input.canaryProofSha256);
    appOfflineAssert_(proof.format==='OFFLINE_NATIVE_CANARY_PROOF_V1'&&proof.pass===true&&proof.manifestId===v.manifestId&&proof.sourceManifestSha256===input.sourceManifestSha256,'batch proof scope mismatch');
    refs.forEach(ref=>appOfflineBatchReceipt_(s,v.reservations.find(r=>r.reservationKey===ref.reservationKey),ref,input.canaryProofSha256));
    return v;
  });
  const out={manifestId:m.manifestId,sourceManifestSha256:input.sourceManifestSha256,filesSha256:appOfflineHash_(refs),requested:refs.length,manifestReservations:m.reservations.length,imported:[],skipped:[],reason:'ALL_REQUESTED_DONE'};
  for(let i=0;i<refs.length;i++){
    const ref=refs[i],r=m.reservations.find(x=>x.reservationKey===ref.reservationKey);
    const step=appWithLock_(()=>{
      const s=appOfflineBatchCurrent_(ctx,input,m),prior=appOfflineBatchReceipt_(s,r,ref,input.canaryProofSha256);
      if(prior&&prior.status==='DONE')return {skipped:true}; // Receipt acknowledgement, not fresh live-row equality.
      if(out.imported.length>=4)return {stop:'IMPORT_COUNT_LIMIT'};
      const elapsed=Date.now()-started;appOfflineAssert_(isFinite(elapsed)&&elapsed>=0,'batch clock moved backwards');
      if(elapsed+90000>200000)return {stop:'ADMISSION_BUDGET'};
      const bundle=appOfflineReadFile_(ref.fileId,ref.sha256);
      appOfflineAssert_(bundle.format==='OFFLINE_NEW_MEASURE_BUNDLE_V1'&&bundle.manifestId===m.manifestId&&bundle.sourceManifestSha256===input.sourceManifestSha256&&Array.isArray(bundle.plans)&&bundle.plans.length===1&&bundle.plans[0].reservationKey===r.reservationKey,'batch file must contain exactly its reserved plan');
      const afterRead=Date.now()-started;appOfflineAssert_(isFinite(afterRead)&&afterRead>=0,'batch clock moved backwards');if(afterRead+90000>200000)return {stop:'ADMISSION_BUDGET'};
      // No catch/continue: the original importer owns every calculation/persistence guard.
      appOfflineImport_(ctx,{fileId:ref.fileId,sha256:ref.sha256,canaryProofFileId:input.canaryProofFileId,canaryProofSha256:input.canaryProofSha256});
      appOfflineAssert_(!appJournalPending_(),'batch native journal remains pending');
      const done=appOfflineBatchReceipt_(appOfflineState_(),r,ref,input.canaryProofSha256);appOfflineAssert_(done&&done.status==='DONE','batch native completion receipt missing');
      return {imported:true};
    });
    if(step.stop){out.reason=step.stop;break;}
    if(step.skipped)out.skipped.push({reservationKey:r.reservationKey,status:'receipt_already_done'});
    if(step.imported)out.imported.push({reservationKey:r.reservationKey,planId:r.planId,runId:r.runId});
  }
  out.remainingRequested=appWithLock_(()=>{appOfflineBatchCurrent_(ctx,input,m);return refs.filter(ref=>{const q=appOfflineBatchReceipt_(appOfflineState_(),m.reservations.find(r=>r.reservationKey===ref.reservationKey),ref,input.canaryProofSha256);return !q||q.status!=='DONE';}).length;});
  out.doneForRequestedFiles=out.remainingRequested===0;out.elapsedMs=Date.now()-started;
  return out;
}
