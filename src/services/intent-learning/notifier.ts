import type {IntentLearningService} from './service.ts';

/** One sender per bot process; delivery failure leaves the durable outbox pending. */
export function startLearningNotifier(
  service:IntentLearningService,
  send:(text:string)=>Promise<unknown>,
  isReady:()=>boolean,
  onFailure:()=>void,
):{close:()=>Promise<void>} {
  let pending:Promise<void>|undefined;
  const timer=setInterval(()=>{
    if(pending || !isReady())return;
    pending=service.drainOutbox(async notice=>{
      const lines=[notice.text];
      if(notice.proposalId) {
        lines.push(`/intent_review ${notice.proposalId}`);
        if(notice.hashPrefix)lines.push(`/intent_approve ${notice.proposalId} ${notice.hashPrefix}`);
        lines.push(`/intent_reject ${notice.proposalId}`);
      }
      await send(lines.join('\n\n').slice(0,4000));
    },3).then(()=>{},onFailure).finally(()=>{pending=undefined;});
  },30000);
  timer.unref();
  return {close:async()=>{clearInterval(timer);await pending;}};
}
