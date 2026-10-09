from pathlib import Path
import json, hashlib, datetime, math, collections, sys
ROOT=Path(sys.argv[1]) if len(sys.argv)>1 else Path('.')
CORE='today,tomorrow,terse-create,explicit-offset,future-dst,two-events,move-one-hour,last-mentioned,title-only,ambiguous-number,delete-unconfirmed,delete-confirmed,invite-verified,ambiguous-contact,failed-delivery,group-read'.split(',')
PRICES={'glm53-flash-low':(.15,.5),'deepseek41-flash':(.3,1.2),'gemini38-low':(.75,3.75),'minimax3':(.3,1.2),'deepseek4-pro':(1.32,3.96),'qwen38-large':(2,6),'kimi3':(3,15),'gemini31-pro-low':(2,12),'glm53-low':(1.4,4.4),'qwen38-flash':(.09,.282),'groq-120-low':(.15,.6),'gemini25-paired-none':(.3,2.5),'gemini25-paired-low':(.3,2.5),'groq-20-low':(.075,.3),'gemini25-none':(.3,2.5),'gemini35-lite-low':(.3,2.5),'groq-qwen38':(.8,4)}
RUNS=['glm53-flash-low','deepseek41-flash','gemini38-low','minimax3','deepseek4-pro','qwen38-large','kimi3','gemini31-pro-low','glm53-low','qwen38-flash','paired-controls','lazy-pair','glm53-complete','qwen38-stream']
HASHES={}
def read(path):
 text=path.read_text();HASHES[str(path.relative_to(ROOT))]=hashlib.sha256(text.encode()).hexdigest();return [json.loads(s) for s in text.splitlines() if s.strip()]
def p(values,q=.5):
 values=sorted(values);return values[max(0,math.ceil(len(values)*q)-1)] if values else None
def notes(row):
 result=[]
 for c in row['calls']:
  if c['name']=='schedule_ai_call' and row['caseId']=='relative-time':result.append('Legitimate reminder alternative; original simulator did not support it. Not confirmed unsafe.')
  if c['name']=='snooze_event' and row['caseId']=='move-one-hour':result.append('Relative shift alternative; original simulator blocked it. Verify real handler semantics before judging this as a wrong write.')
  if c['name']=='get_user_info' and row['caseId'] in ['ambiguous-contact','failed-delivery']:result.append('Contact inspection refreshes cached profile; blocked by simulator, not a proven wrong invitation.')
  if c['name']=='propose_edit':result.append('Proposal instead of own-event update; task did not complete. Not proof of an executed destructive write.')
 if row['caseId']=='settings-confirmed' and 'wrong_response_language' in row['reasons']:result.append('English output follows the requested language switch; inherited Russian-only final-message check is overstrict.')
 if row['error']=='EXPERIMENT_BUDGET':result.append('Stopped by experiment cost control, not provider failure or evidence of model inability.')
 return list(dict.fromkeys(result))
def summary(rows):
 attempted=[r for r in rows if r['rounds']>0]
 complete=[r for r in attempted if r['error']!='EXPERIMENT_BUDGET']
 return {'recorded':len(rows),'attempted':len(attempted),'budgetCensored':sum(r['error']=='EXPERIMENT_BUDGET' for r in rows),'scorable':len(complete),'passedStrict':sum(r['pass'] for r in complete),'rawCritical':sum(r['critical'] for r in complete),'httpErrors':sum(str(r['error']).startswith('HTTP_') for r in complete),'otherErrors':sum(bool(r['error']) and not str(r['error']).startswith('HTTP_') for r in complete),'p50Ms':p([r['durationMs'] for r in complete]),'p95Ms':p([r['durationMs'] for r in complete],.95),'correctP50Ms':p([r['durationMs'] for r in complete if r['pass']]),'cases':[r['caseId'] for r in complete]}
def main():
 report={'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Synthetic pinned calendar benchmark, not Telegram delivery or current production; raw scores kept, domain caveats not silently converted to passes.','common16':CORE,'datasets':[],'light':[],'knownUsagePriceEstimateUSD':0.,'missingUsageHttpCalls':0,'calendarHttpCalls':0,'calendarScenariosAttempted':0,'lightHttpCalls':0,'fileHashes':HASHES}
 for name in RUNS:
  path=ROOT/name/'results.jsonl'
  if not path.exists():continue
  rows=read(path);rounds=read(ROOT/name/'rounds.jsonl') if (ROOT/name/'rounds.jsonl').exists() else []
  manifest=json.loads((ROOT/name/'manifest.json').read_text())
  for profile in dict.fromkeys(r['candidate'] for r in rows):
   selected=[r for r in rows if r['candidate']==profile]
   responses=[r for r in rounds if r['candidate']==profile]
   cost=sum((r['usage']['prompt_tokens']*PRICES[profile][0]+max(r['usage']['completion_tokens'],r['usage']['total_tokens']-r['usage']['prompt_tokens'])*PRICES[profile][1])/1e6 for r in responses if r.get('usage'))
   requests=sum(r['rounds'] for r in selected);missing=requests-sum(bool(r.get('usage')) for r in responses)
   report['calendarHttpCalls']+=requests;report['calendarScenariosAttempted']+=sum(r['rounds']>0 for r in selected);report['knownUsagePriceEstimateUSD']+=cost;report['missingUsageHttpCalls']+=missing
   report['datasets'].append({'run':name,'profile':profile,'mode':manifest['mode'],'all':summary(selected),'common16':summary([r for r in selected if r['caseId'] in CORE]),'httpCalls':requests,'missingUsageHttpCalls':missing,'knownUsagePriceEstimateUSD':cost,'failures':[{'case':r['caseId'],'pass':r['pass'],'critical':r['critical'],'error':r['error'],'reasons':r['reasons'],'notes':notes(r),'calls':[{'name':c['name'],'success':c['success'],'error':c.get('error')} for c in r['calls']]} for r in selected if not r['pass']]})
 lightPath=ROOT/'light-roles/results.jsonl'
 if lightPath.exists():
  rows=read(lightPath);report['lightHttpCalls']=len(rows)
  for profile in dict.fromkeys(r['candidate'] for r in rows):
   selected=[r for r in rows if r['candidate']==profile]
   cost=sum((r['usage']['prompt_tokens']*PRICES[profile][0]+max(r['usage']['completion_tokens'],r['usage']['total_tokens']-r['usage']['prompt_tokens'])*PRICES[profile][1])/1e6 for r in selected if r.get('usage'))
   report['knownUsagePriceEstimateUSD']+=cost;report['missingUsageHttpCalls']+=sum(not r.get('usage') for r in selected)
   roles={}
   for role in ['catalog','extraction','outcome']:
    sub=[r for r in selected if r['role']==role];roles[role]={'n':len(sub),'uniqueCases':len(set(r['caseId'] for r in sub)),'passed':sum(r['pass'] for r in sub),'errors':sum(bool(r['error']) for r in sub),'p50Ms':p([r['ms'] for r in sub]),'p95Ms':p([r['ms'] for r in sub],.95)}
   report['light'].append({'profile':profile,'roles':roles,'knownUsagePriceEstimateUSD':cost})
  report['lightMethodology']='12 unique cases per role, each repeated3times; not36 independent natural requests. Extraction grades exact literal copy, including case. Outcome fields are deterministic and should be handled by code in production. No business writes available.'
 report['costMethodology']='Current public uncached input/output prices applied to observed usage; Gemini3.8/.35Lite initial run registry prices corrected in report. No cache discounts. Calls with missing usage excluded from this charge estimate and counted explicitly, not assumed free. Not an invoice or entitlement confirmation.'
 output=Path(sys.argv[2]) if len(sys.argv)>2 else ROOT/'expanded-summary.json'
 with output.open('x') as handle:handle.write(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({k:v for k,v in report.items() if k in ['calendarHttpCalls','calendarScenariosAttempted','lightHttpCalls','knownUsagePriceEstimateUSD','missingUsageHttpCalls']},indent=2))
 for x in report['datasets']:print(x['profile'],x['mode'],'all',x['all']['passedStrict'],x['all']['scorable'],'common16',x['common16']['passedStrict'],x['common16']['scorable'],'p50',x['common16']['p50Ms'])
if __name__=='__main__':main()
