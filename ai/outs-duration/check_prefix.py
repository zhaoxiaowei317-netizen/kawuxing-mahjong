"""Compare complete model and Adam states across the reused training prefix."""
import sys, json
from pathlib import Path
import torch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tile-q'))
from network import TileQ

def equal(a,b,path='root'):
    assert type(a) is type(b),path
    if isinstance(a,torch.Tensor):
        assert a.dtype==b.dtype and a.shape==b.shape and torch.equal(a,b),path
    elif isinstance(a,dict):
        assert a.keys()==b.keys(),path
        for k in a: equal(a[k],b[k],path+'.'+str(k))
    elif isinstance(a,(tuple,list)):
        assert len(a)==len(b),path
        for i,(x,y) in enumerate(zip(a,b)): equal(x,y,path+'.'+str(i))
    else: assert a==b,path

def run(spec):
    rows=[]
    for epoch in range(spec['epochs']+1):
        name='epoch-%03d.pt'%epoch
        old=torch.load(Path(spec['previous'])/name,map_location='cpu',weights_only=True)
        new=torch.load(Path(spec['current'])/name,map_location='cpu',weights_only=True)
        for key in ['version','schema','network','sources','seed','model','optimizer','config','mode','epoch','history','trainingHash','validationHash']:
            equal(old[key],new[key],str(epoch)+'.'+key)
        rows.append(epoch)
    training=json.loads(Path(spec['trainingSpec']).read_text(encoding='utf-8'))
    verified=[]
    for epoch in range(training['epochs']+1):
        stem=Path(spec['current'])/('epoch-%03d'%epoch)
        state=torch.load(str(stem)+'.pt',map_location='cpu',weights_only=True)
        exported=json.loads(Path(str(stem)+'.json').read_text(encoding='utf-8'))
        for key in ['sources','schema','network','seed','config','mode','experimentSources']:
            equal(state[key],training[key],str(epoch)+'.'+key)
        assert state['epoch']==epoch
        model=TileQ(state['schema'],state['network']);model.load_state_dict(state['model'])
        assert model.export()==exported['weights'], 'PT/export mismatch at '+str(epoch)
        verified.append(epoch)
    result={'epochs':rows,'exactModelAndAdamAndHistory':True,'allSnapshotPtExportsVerified':verified}
    Path(spec['result']).write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result),flush=True)

if __name__=='__main__': run(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
