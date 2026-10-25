"""Fixed small readout on public teacher-confidence features; no torch update."""
import os
os.environ.setdefault('OMP_NUM_THREADS','2')
os.environ.setdefault('MKL_NUM_THREADS','2')
os.environ.setdefault('OPENBLAS_NUM_THREADS','2')
import sys,json,gzip,hashlib
from pathlib import Path
import numpy as np
VERSION='kwx-ridge-public-gain-gate-1'
LAMBDAS=[.001,.01,.1,1.,10.,100.]
ROOT=Path(__file__).resolve().parents[2]
def checksum(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(path,value):Path(path).write_text(json.dumps(value,indent=2,allow_nan=False)+'\n',encoding='utf8')
def load(path,split,spec):
    p=Path(path);m=json.loads((p/'manifest.json').read_text(encoding='utf8'));assert m['split']==split and m['schema']==spec['schema'] and m['sources']==spec['sources'];assert m['sha256']==checksum(p/'rows.jsonl.gz')
    with gzip.open(p/'rows.jsonl.gz','rt',encoding='utf8') as f:rows=[json.loads(line) for line in f if line.strip()]
    assert len(rows)==m['roots'] and rows;x=np.array([r['features'] for r in rows],np.float64);y=np.array([r['gain'] for r in rows],np.float64)
    assert x.shape==(len(rows),len(spec['schema']['names'])) and np.isfinite(x).all() and np.isfinite(y).all();return x,y,m
def metrics(pred,target):return {'mse':float(np.mean((pred-target)**2)),'zeroMse':float(np.mean(target**2)),'accepts':int((pred>0).sum()),'min':float(pred.min()),'max':float(pred.max())}
def run(spec):
    out=Path(spec['out']);audit=spec.get('verify',False);assert out.exists()==audit
    for name,expected in spec['sources'].items():assert checksum(ROOT/name)==expected
    assert spec['lambdas']==LAMBDAS and spec['tieTolerance']==1e-12
    x,y,tm=load(spec['trainingData'],'training',spec);vx,vy,vm=load(spec['validationData'],'validation',spec);assert tm['sha256']!=vm['sha256']
    mean=x.mean(0);scale=np.sqrt(np.mean((x-mean)**2,axis=0));scale=np.where(scale>1e-12,scale,1.);z=(x-mean)/scale;vz=(vx-mean)/scale;ym=float(y.mean());n,d=z.shape
    gram=z.T@z/n;rhs=z.T@(y-ym)/n;history=[];selected=None;models=[]
    candidates=[('zero',None,np.zeros(d),0.),('constant',None,np.zeros(d),ym)]+[('ridge-'+format(lam,'g'),lam,np.linalg.solve(gram+lam*np.eye(d),rhs),ym) for lam in LAMBDAS]
    if not audit:out.mkdir(parents=True)
    for name,lam,w,intercept in candidates:
        row={'name':name,'lambda':lam,'training':metrics(z@w+intercept,y),'validation':metrics(vz@w+intercept,vy)};history.append(row)
        path=out/(name+'.json');model={'version':VERSION,'schema':spec['schema'],'mean':mean.tolist(),'scale':scale.tolist(),'weights':w.tolist(),'intercept':intercept,
          'metadata':{'candidate':name,'lambda':lam,'sources':spec['sources'],'trainingHash':tm['sha256'],'validationHash':vm['sha256']}}
        if audit:assert json.loads(path.read_text(encoding='utf8'))==model
        else:save(path,model)
        if selected is None or row['validation']['mse']<selected['validationMse']-spec['tieTolerance']:selected={'name':name,'path':str(path),'validationMse':row['validation']['mse']}
        models.append((name,w,intercept));print(json.dumps({'candidate':name,'audit':audit,**row['validation']}),flush=True)
    summary={'selected':selected,'history':history,'trainingRoots':n,'validationRoots':len(vy),'features':d,'fittedReadoutParameters':d+1,'closedFormFits':len(LAMBDAS),'gradientUpdates':0,
      'trainingHash':tm['sha256'],'validationHash':vm['sha256'],'lambdas':LAMBDAS,'tieTolerance':spec['tieTolerance']}
    if audit:assert json.loads((out/'summary.json').read_text(encoding='utf8'))==summary
    else:
        save(out/'summary.json',summary);chosen=next(m for m in models if m[0]==selected['name']);pred=vz@chosen[1]+chosen[2]
        save(out/'parity.json',{'model':selected['path'],'fixtures':[{'features':vx[i].tolist(),'prediction':float(pred[i])} for i in range(min(24,len(vy)))]})
    for name,expected in spec['sources'].items():assert checksum(ROOT/name)==expected
    return summary
if __name__=='__main__':run(json.loads(Path(sys.argv[1]).read_text(encoding='utf8')))
