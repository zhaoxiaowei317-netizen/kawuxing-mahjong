"""Paired terminal-gain regression on a frozen short-policy public representation schema."""
import sys,json,gzip,hashlib,base64,math
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tile-q'))
import train as base
import numpy as np
import torch
from network import TileQ,VERSION

def load(path,split,spec):
    path=Path(path);m=json.loads((path/'manifest.json').read_text(encoding='utf8'))
    assert m['split']==split and m['sourceMap']==spec['experimentSources'] and m['schema']==spec['schema']
    assert base.checksum(path/'episodes.jsonl.gz')==m['sha256']
    rows=[];hands=0
    with gzip.open(path/'episodes.jsonl.gz','rt',encoding='utf8') as f:
        for line in f:
            e=json.loads(line);hands+=1
            if e['root'] is not None: rows.append(e['root'])
    assert hands==m['hands'] and len(rows)==m['roots'] and rows
    s=spec['schema'];n=len(rows);x=np.zeros((n,s['channels'],s['length']),np.float32);ctx=np.empty((n,s['contextSize']),np.float32)
    mask=np.zeros((n,88),bool);cand=np.zeros((n,88,s['candidateSize']),np.float32);bid=np.empty(n,np.int64);aid=bid.copy();gain=np.empty(n,np.float32)
    scale=np.array([p['scale'] for p in s['planes']],np.float32)[:,None]
    for i,r in enumerate(rows):
        raw=np.frombuffer(base64.b64decode(r['encoded']['tiles']),np.uint8).reshape(s['channels'],s['length']);x[i]=raw/scale;ctx[i]=r['encoded']['context']
        ids=r['legalIds'];assert len(ids)>1 and r['baselineId'] in ids and r['alternativeId'] in ids and r['baselineId']!=r['alternativeId']
        assert r['gain']==(r['alternativeScore']-r['baselineScore'])/16;mask[i,ids]=True
        assert sorted(c['id'] for c in r['encoded']['candidates'])==ids
        for c in r['encoded']['candidates']:cand[i,c['id']]=c['values']
        bid[i]=r['baselineId'];aid[i]=r['alternativeId'];gain[i]=r['gain']
    assert all(np.isfinite(a).all() for a in [x,ctx,cand,gain])
    return tuple(torch.from_numpy(a) for a in [x,ctx,mask,cand,bid,aid,gain]),m

def predict(model,batch):
    x,ctx,mask,cand,bid,aid,gain=batch;q,_=model(x,ctx,mask,cand)
    return q.gather(1,aid[:,None]).squeeze(1)-q.gather(1,bid[:,None]).squeeze(1)

def measure(model,data,hands):
    model.eval();total=0.;zero=0.;positive=0;realized=0.;lo=float('inf');hi=-lo
    with torch.inference_mode():
        for start in range(0,len(data[0]),512):
            batch=tuple(x[start:start+512] for x in data);pred=predict(model,batch);target=batch[-1]
            total+=(pred-target).square().sum().item();zero+=target.square().sum().item();positive+=(pred>0).sum().item();realized+=target[pred>0].sum().item()
            lo=min(lo,pred.min().item());hi=max(hi,pred.max().item())
    return {'mse':total/len(data[0]),'zeroMse':zero/len(data[0]),'accepts':positive,'predictionMin':lo,'predictionMax':hi,'oneStepDiagnosticGainPer100Hands':realized*1600/hands}

def same(a,b):
    if isinstance(a,torch.Tensor):assert torch.equal(a,b)
    elif isinstance(a,dict):
        assert a.keys()==b.keys()
        for k in a:same(a[k],b[k])
    elif isinstance(a,(list,tuple)):
        assert len(a)==len(b)
        for x,y in zip(a,b):same(x,y)
    else:assert a==b,(a,b)

def run(spec):
    out=Path(spec['out']);audit=spec.get('verify',False)
    assert out.exists()==audit;base.check_sources(spec['sources']);base.check_sources(spec['experimentSources'])
    train,tm=load(spec['trainingData'],'training',spec);val,vm=load(spec['validationData'],'validation',spec);assert tm['sha256']!=vm['sha256']
    ck=torch.load(spec['initialize'],map_location='cpu',weights_only=True);assert ck['schema']==spec['schema'] and ck['network']==spec['network'] and ck['sources']==spec['sources']
    seed=int(hashlib.sha256(spec['seed'].encode()).hexdigest()[:8],16);torch.manual_seed(seed)
    model=TileQ(spec['schema'],spec['network']);model.load_state_dict(ck['model'])
    with torch.no_grad():
        model.actionHead.weight.zero_();model.actionHead.bias.zero_();model.valueHead.weight.zero_();model.valueHead.bias.zero_()
    model.valueHead.requires_grad_(False);model.rankHead.requires_grad_(False);model.actionHead.bias.requires_grad_(False)
    optimizer=torch.optim.Adam([x for x in model.parameters() if x.requires_grad],lr=spec['config']['learningRate'])
    if not audit:out.mkdir(parents=True)
    history=[];selected=None;updates=0
    for epoch in range(spec['epochs']+1):
        if epoch:
            model.train();order=np.random.default_rng(np.random.SeedSequence([seed,epoch])).permutation(len(train[0]))
            for start in range(0,len(order),spec['config']['batchSize']):
                ix=torch.from_numpy(order[start:start+spec['config']['batchSize']]);batch=tuple(x[ix] for x in train)
                optimizer.zero_grad(set_to_none=True);loss=.5*(predict(model,batch)-batch[-1]).square().mean();assert torch.isfinite(loss)
                loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),spec['config']['maxGradNorm'],error_if_nonfinite=True);optimizer.step();updates+=1
        row={'epoch':epoch,'training':measure(model,train,tm['hands']),'validation':measure(model,val,vm['hands'])};history.append(row)
        if selected is None or row['validation']['mse']<selected['validationLoss']-1e-12:selected={'epoch':epoch,'path':str(out/('epoch-%03d.json'%epoch)),'state':str(out/('epoch-%03d.pt'%epoch)),'validationLoss':row['validation']['mse']}
        path=out/('epoch-%03d'%epoch)
        if audit:
            original=torch.load(str(path)+'.pt',map_location='cpu',weights_only=True);same(original['model'],model.state_dict());same(original['optimizer'],optimizer.state_dict());same(original['history'],history);same(original['selected'],selected)
            exported=json.loads(Path(str(path)+'.json').read_text(encoding='utf8'));assert exported['weights']==model.export();assert exported['metadata']['optimizerStateSha256']==base.checksum(str(path)+'.pt')
        else:
            state={'version':VERSION,'schema':spec['schema'],'network':spec['network'],'sources':spec['sources'],'experimentSources':spec['experimentSources'],
                'model':model.state_dict(),'optimizer':optimizer.state_dict(),'epoch':epoch,'history':history,'selected':selected,'seed':spec['seed'],'trainingHash':tm['sha256'],'validationHash':vm['sha256']}
            torch.save(state,str(path)+'.pt')
            exported={'version':VERSION,'schema':spec['schema'],'config':spec['network'],'sources':spec['sources'],'weights':model.export(),
                'metadata':{'epoch':epoch,'objective':'paired-terminal-gain','seed':spec['seed'],'experimentSources':spec['experimentSources'],'trainingHash':tm['sha256'],'validationHash':vm['sha256'],'optimizerStateSha256':base.checksum(str(path)+'.pt')}}
            Path(str(path)+'.json').write_text(json.dumps(exported,separators=(',',':'),allow_nan=False)+'\n',encoding='utf8')
        print(json.dumps({'epoch':epoch,'audit':audit,'selected':selected['epoch'],**row['validation']}),flush=True)
    summary={'selected':selected,'history':history,'trainingSamples':len(train[0]),'validationSamples':len(val[0]),'trainingHash':tm['sha256'],'validationHash':vm['sha256'],
        'parameters':sum(x.numel() for x in model.parameters()),'trainableParameters':sum(x.numel() for x in model.parameters() if x.requires_grad),'optimizationUpdates':updates,'config':spec['config'],'network':spec['network'],'seed':spec['seed']}
    if audit:same(json.loads((out/'summary.json').read_text(encoding='utf8')),summary)
    else:
        (out/'summary.json').write_text(json.dumps(summary,indent=2,allow_nan=False)+'\n',encoding='utf8')
        chosen=torch.load(selected['state'],map_location='cpu',weights_only=True);model.load_state_dict(chosen['model']);fixtures=[]
        with torch.inference_mode():
            for i in range(min(24,len(val[0]))):
                batch=tuple(x[i:i+1] for x in val);q,_=model(batch[0],batch[1],batch[2],batch[3]);raw=(val[0][i].numpy()*np.array([p['scale'] for p in spec['schema']['planes']],np.float32)[:,None]).round().astype(np.uint8);ids=val[2][i].nonzero().flatten().tolist()
                fixtures.append({'encoded':{'tiles':base64.b64encode(raw.tobytes()).decode(),'context':val[1][i].tolist(),'candidates':[{'id':a,'values':val[3][i,a].tolist()} for a in ids]},'legalIds':ids,'q':{str(a):q[0,a].item() for a in ids},'baselineId':val[4][i].item(),'alternativeId':val[5][i].item()})
        (out/'parity.json').write_text(json.dumps({'checkpoint':selected['path'],'fixtures':fixtures},allow_nan=False)+'\n',encoding='utf8')
    base.check_sources(spec['sources']);base.check_sources(spec['experimentSources']);return summary

if __name__=='__main__':run(json.loads(Path(sys.argv[1]).read_text(encoding='utf8')))
