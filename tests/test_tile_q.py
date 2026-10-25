import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ai' / 'tile-q'))
import torch
from network import TileQ

class TileQTests(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(2)
        torch.manual_seed(24)
        self.schema={'channels':3,'length':29,'positions':[0,1,2,3,4,5,6,7,8,11,12,13,14,15,16,17,18,19,22,25,28],
                     'contextSize':2,'candidateSize':2}
        self.config={'channels':4,'blocks':1,'globalSize':8,'localSize':8,'useTiles':True}

    def test_mc_gradients_learn_a_known_action_order_and_mask(self):
        model=TileQ(self.schema,self.config)
        x=torch.ones(8,3,29)*.2;context=torch.zeros(8,2)
        mask=torch.zeros(8,88,dtype=torch.bool);mask[:,[0,1]]=True
        features=torch.zeros(8,88,2);features[:,0,0]=1;features[:,1,1]=1
        action=torch.tensor([0,1]*4);target=torch.tensor([1.,-1.]*4)
        opt=torch.optim.Adam(model.parameters(),lr=.02)
        initial=None
        for step in range(100):
            q,_=model(x,context,mask,features)
            error=(q[torch.arange(8),action]-target).square().mean()
            if initial is None:initial=error.item()
            opt.zero_grad();error.backward()
            if step==0:
                self.assertTrue(torch.isfinite(model.stem.weight.grad).all())
                self.assertGreater(model.stem.weight.grad.abs().sum().item(),0)
            opt.step()
        q,_=model(x,context,mask,features)
        self.assertLess(error.item(),initial*.01)
        self.assertTrue((q.argmax(1)==0).all())
        self.assertTrue(torch.isneginf(q[:,2:]).all())

    def test_suit_swap_equivariance_and_honor_separation(self):
        model=TileQ(self.schema,self.config).eval()
        x=torch.rand(1,3,29)*model.position_mask;context=torch.rand(1,2)
        features=torch.rand(1,88,2);mask=torch.ones(1,88,dtype=torch.bool)
        swap=list(range(29))
        for i in range(9):swap[i],swap[11+i]=11+i,i
        permutation=list(range(88))
        for kind in range(4):
            for i in range(9):permutation[kind*21+i],permutation[kind*21+9+i]=kind*21+9+i,kind*21+i
        a,_=model(x,context,mask,features)
        b,_=model(x[:,:,swap],context,mask[:,permutation],features[:,permutation])
        torch.testing.assert_close(a[:,permutation],b,atol=1e-6,rtol=1e-6)
        stem=torch.relu(model.stem(x))*model.position_mask
        self.assertTrue((stem[:,:,[9,10,20,21,23,24,26,27]]==0).all())

if __name__=='__main__':unittest.main()
