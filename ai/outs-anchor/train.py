"""Matched corrected-label training, optionally anchoring unchanged public decisions."""
import sys, json, gzip, hashlib, base64
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tile-q'))
import train as base
import numpy as np
import torch
from network import TileQ, VERSION

def frozen_targets(model, data, canonical, schema, sources, temperature):
    meta = json.loads((Path(canonical)/'manifest.json').read_text(encoding='utf-8'))
    assert meta['schema'] == schema and meta['sources'] == sources
    assert base.checksum(Path(canonical)/'episodes.jsonl.gz') == meta['sha256']
    n, index = len(data[0]), 0
    unchanged = torch.zeros(n, dtype=torch.bool)
    raw_ids = torch.empty(n, dtype=torch.int64)
    with gzip.open(Path(canonical)/'episodes.jsonl.gz', 'rt', encoding='utf-8') as f:
        for line in f:
            if not line.strip(): continue
            for row in json.loads(line)['rows']:
                assert index < n and data[4][index].item() == row['teachers']['corrected']
                assert row['changed'] == (row['teachers']['self'] != row['teachers']['corrected'])
                raw_ids[index] = row['teachers']['self']
                unchanged[index] = not row['changed']
                index += 1
    assert index == n == meta['samples']
    logp = torch.empty(n, 88)
    model.eval(); backend_argmax_differences=0; max_difference_gap=0.
    with torch.inference_mode():
        for start in range(0, n, 512):
            q, _ = model(data[0][start:start+512], data[1][start:start+512], data[2][start:start+512], data[7][start:start+512])
            ids=raw_ids[start:start+512]; different=q.argmax(1)!=ids
            gap=q.max(1).values-q.gather(1,ids[:,None]).squeeze(1)
            assert torch.all(gap<1e-5), 'Frozen Python teacher must match canonical JS scores within export tolerance'
            backend_argmax_differences+=different.sum().item(); max_difference_gap=max(max_difference_gap,gap.max().item())
            logp[start:start+512] = (q/temperature).log_softmax(1).masked_fill(~data[2][start:start+512], 0)
    return (*data, logp, unchanged), meta['sha256'], {'argmaxDifferences':backend_argmax_differences,'maxScoreGap':max_difference_gap,'tolerance':1e-5}

def objective_from_q(q, labels, mask, raw_logp, unchanged, weight, temperature):
    bc = torch.nn.functional.cross_entropy(q, labels)
    logp = (q/temperature).log_softmax(1).masked_fill(~mask, 0)
    probability = raw_logp.exp().masked_fill(~mask, 0)
    kl = (probability * (raw_logp-logp)).sum(1).clamp_min(0) * temperature**2
    anchor = (kl*unchanged).mean()
    return bc+weight*anchor, bc, anchor

def loss(model, batch, config):
    x, ctx, mask, action, teacher, target, rank, candidates, raw_logp, unchanged = batch
    q, rank_logits = model(x, ctx, mask, candidates)
    _, bc, anchor = objective_from_q(q, teacher, mask, raw_logp, unchanged, config['anchorWeight'], config['temperature'])
    # Preserve the frozen trainer's zero-weight auxiliary graph exactly. A zero
    # anchor branch must not introduce extra gradient accumulation into Q.
    aux = -(rank * rank_logits.log_softmax(1)).sum(1).mean()
    baseline = bc + config['auxWeight'] * aux
    total = baseline if config['anchorWeight']==0 else baseline+config['anchorWeight']*anchor
    predicted=q.argmax(1)
    return total, {'objective':total.item(), 'bc':bc.item(), 'anchor':anchor.item(), 'teacherAgreement':(predicted==teacher).float().mean().item()}

def measure(model, data, config):
    model.eval(); totals={}
    with torch.inference_mode():
        for start in range(0, len(data[0]), 512):
            batch=tuple(x[start:start+512] for x in data)
            _, metrics=loss(model,batch,config)
            for k,v in metrics.items(): totals[k]=totals.get(k,0.)+v*len(batch[0])/len(data[0])
    return totals

def run(spec):
    out=Path(spec['out'])
    if out.exists(): raise ValueError('Training output exists')
    base.check_sources(spec['sources']); base.check_sources(spec['experimentSources'])
    schema, config=spec['schema'],spec['config']
    assert spec['mode'] in ['anchor','plain'] and config['anchorWeight']==int(spec['mode']=='anchor') and config['temperature']==1
    checkpoint=torch.load(spec['initialize'],map_location='cpu',weights_only=True)
    assert checkpoint['sources']==spec['sources'] and checkpoint['schema']==schema and checkpoint['network']==spec['network']
    frozen=TileQ(schema,spec['network']); frozen.load_state_dict(checkpoint['model']); frozen.requires_grad_(False)
    train, tm=base.load_dataset(spec['trainingData'],'training',schema,spec['sources'])
    val, vm=base.load_dataset(spec['validationData'],'validation',schema,spec['sources'])
    assert tm['sha256']!=vm['sha256']
    train, tch, tba=frozen_targets(frozen,train,spec['trainingCanonical'],schema,spec['sources'],config['temperature'])
    val, vch, vba=frozen_targets(frozen,val,spec['validationCanonical'],schema,spec['sources'],config['temperature'])
    seed=int(hashlib.sha256(spec['seed'].encode()).hexdigest()[:8],16); torch.manual_seed(seed)
    model=TileQ(schema,spec['network']); model.load_state_dict(checkpoint['model'])
    optimizer=torch.optim.Adam(model.parameters(),lr=config['learningRate'])
    out.mkdir(parents=True); selected=None; history=[]
    for epoch in range(spec['epochs']+1):
        if epoch:
            model.train(); order=np.random.default_rng(np.random.SeedSequence([seed,epoch])).permutation(len(train[0]))
            for begin in range(0,len(order),config['batchSize']):
                indices=torch.from_numpy(order[begin:begin+config['batchSize']]); batch=tuple(x[indices] for x in train)
                optimizer.zero_grad(set_to_none=True); total,_=loss(model,batch,config); assert torch.isfinite(total)
                total.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(),config['maxGradNorm'],error_if_nonfinite=True); optimizer.step()
        row={'epoch':epoch,'training':measure(model,train,config),'validation':measure(model,val,config)}; history.append(row)
        path=out/('epoch-%03d'%epoch)
        if selected is None or row['validation']['bc']<selected['validationLoss']-1e-12:
            selected={'epoch':epoch,'path':str(path)+'.json','state':str(path)+'.pt','validationLoss':row['validation']['bc']}
        state={'version':VERSION,'schema':schema,'network':spec['network'],'sources':spec['sources'],'experimentSources':spec['experimentSources'],
               'seed':spec['seed'],'model':model.state_dict(),'optimizer':optimizer.state_dict(),'config':config,'mode':spec['mode'],
               'epoch':epoch,'history':history,'selected':selected,'trainingHash':tm['sha256'],'validationHash':vm['sha256']}
        torch.save(state,str(path)+'.pt')
        exported={'version':VERSION,'schema':schema,'config':spec['network'],'sources':spec['sources'],'weights':model.export(),
                  'metadata':{'epoch':epoch,'mode':spec['mode'],'seed':spec['seed'],'trainingHash':tm['sha256'],'validationHash':vm['sha256'],
                              'experimentSources':spec['experimentSources'],'torch':torch.__version__,'optimizerStateSha256':base.checksum(str(path)+'.pt')}}
        Path(str(path)+'.json').write_text(json.dumps(exported,separators=(',',':'),allow_nan=False)+'\n',encoding='utf-8')
        print(json.dumps({'epoch':epoch,'mode':spec['mode'],'selected':selected['epoch'],**row['validation']}),flush=True)
    summary={'selected':selected,'history':history,'trainingSamples':len(train[0]),'validationSamples':len(val[0]),'trainingHash':tm['sha256'],'validationHash':vm['sha256'],
             'trainingCanonicalHash':tch,'validationCanonicalHash':vch,'teacherBackendAudit':{'training':tba,'validation':vba},'config':config,'network':spec['network'],'mode':spec['mode'],'seed':spec['seed'],
             'experimentSources':spec['experimentSources'],'torch':torch.__version__,'parameters':sum(p.numel() for p in model.parameters())}
    (out/'summary.json').write_text(json.dumps(summary,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    model.eval(); indices=list(range(min(12,len(val[0])))); fixtures=[]
    with torch.inference_mode(): q,rank=model(val[0][indices],val[1][indices],val[2][indices],val[7][indices])
    for i,index in enumerate(indices):
        raw=(val[0][index].numpy()*np.array([p['scale'] for p in schema['planes']],np.float32)[:,None]).round().astype(np.uint8)
        ids=val[2][index].nonzero().flatten().tolist()
        fixtures.append({'encoded':{'tiles':base64.b64encode(raw.tobytes()).decode(),'context':val[1][index].tolist(),
                          'candidates':[{'id':a,'values':val[7][index,a].tolist()} for a in ids]},'legalIds':ids,
                         'q':{str(a):q[i,a].item() for a in ids},'rankLogits':rank[i].tolist()})
    (out/'parity.json').write_text(json.dumps({'checkpoint':str(out/('epoch-%03d.json'%spec['epochs'])),'fixtures':fixtures},allow_nan=False)+'\n',encoding='utf-8')
    base.check_sources(spec['sources']); base.check_sources(spec['experimentSources']); return summary

if __name__=='__main__': run(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
