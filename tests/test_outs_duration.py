import importlib.util
from pathlib import Path
import unittest
import torch

spec=importlib.util.spec_from_file_location('prefix',Path(__file__).resolve().parents[1]/'ai/outs-duration/check_prefix.py')
prefix=importlib.util.module_from_spec(spec);spec.loader.exec_module(prefix)

class PrefixChecks(unittest.TestCase):
    def test_adam_reset_is_rejected_even_when_model_is_identical(self):
        old={'model':{'w':torch.tensor([1.])},'optimizer':{'step':torch.tensor(8.),'exp_avg':torch.tensor([.5])}}
        reset={'model':{'w':torch.tensor([1.])},'optimizer':{'step':torch.tensor(0.),'exp_avg':torch.tensor([0.])}}
        with self.assertRaises(AssertionError): prefix.equal(old,reset)

    def test_small_parameter_change_is_rejected_without_tolerance(self):
        a=torch.tensor([1.],dtype=torch.float64);b=a+1e-12
        with self.assertRaises(AssertionError): prefix.equal(a,b)
        prefix.equal({'w':a,'step':[8]}, {'w':a.clone(),'step':[8]})

if __name__=='__main__': unittest.main()
