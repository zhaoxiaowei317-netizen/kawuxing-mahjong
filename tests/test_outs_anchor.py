import sys, unittest, importlib.util
from pathlib import Path
import torch
module=importlib.util.spec_from_file_location('anchor_training',Path(__file__).resolve().parents[1]/'ai/outs-anchor/train.py')
anchor=importlib.util.module_from_spec(module); module.loader.exec_module(anchor)

class AnchorTests(unittest.TestCase):
    def inputs(self):
        mask=torch.tensor([[True,True,False],[True,True,False]])
        raw=torch.tensor([[.4,-.4,-torch.inf],[-.2,.2,-torch.inf]])
        logp=raw.log_softmax(1).masked_fill(~mask,0)
        return mask,raw,logp

    def test_original_policy_has_zero_anchor_and_illegal_logits_have_zero_gradient(self):
        mask,raw,logp=self.inputs(); q=(raw+3).clone().requires_grad_()
        total,bc,kl=anchor.objective_from_q(q,torch.tensor([0,1]),mask,logp,torch.tensor([True,True]),1,1)
        self.assertLess(abs(kl.item()),1e-6);total.backward()
        self.assertTrue(torch.isfinite(q.grad).all());self.assertTrue((q.grad[:,2]==0).all())

    def test_corrected_rows_are_not_pulled_back_to_original(self):
        mask,raw,logp=self.inputs(); labels=torch.tensor([1,0]); base=torch.tensor([[-1.,1.,-torch.inf],[1.,-1.,-torch.inf]])
        a=base.clone().requires_grad_();b=base.clone().requires_grad_()
        x,_,penalty=anchor.objective_from_q(a,labels,mask,logp,torch.tensor([False,False]),1,1)
        y,_,_=anchor.objective_from_q(b,labels,mask,logp,torch.tensor([False,False]),0,1)
        x.backward();y.backward();self.assertEqual(penalty.item(),0);torch.testing.assert_close(a.grad,b.grad)

    def test_unchanged_policy_deviation_is_penalized_and_gradient_restores_preferences(self):
        mask,raw,logp=self.inputs();q=torch.tensor([[-1.,1.,-torch.inf],[1.,-1.,-torch.inf]],requires_grad=True)
        _,_,penalty=anchor.objective_from_q(q,torch.tensor([0,1]),mask,logp,torch.tensor([True,False]),1,1)
        self.assertGreater(penalty.item(),0);penalty.backward()
        self.assertLess(q.grad[0,0].item(),0);self.assertGreater(q.grad[0,1].item(),0);self.assertEqual(q.grad[1].abs().sum().item(),0)

if __name__=='__main__':unittest.main()
