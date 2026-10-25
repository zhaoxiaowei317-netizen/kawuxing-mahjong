"""Independent compact adaptation of residual tile encoding + masked dueling Q.
Method references are recorded in docs; no Mortal source or weights are copied.
"""
import torch
from torch import nn

VERSION = 'kwx-tile-dueling-q-1'

class Block(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.a = nn.Conv1d(channels, channels, 3, padding=1)
        self.b = nn.Conv1d(channels, channels, 3, padding=1)

    def forward(self, x, mask):
        a = torch.relu(self.a(x)) * mask
        return torch.relu(x + self.b(a) * mask) * mask

class TileQ(nn.Module):
    def __init__(self, schema, config):
        super().__init__()
        self.schema, self.config = schema, config
        channels, glob, local = config['channels'], config['globalSize'], config['localSize']
        self.stem = nn.Conv1d(schema['channels'], channels, 3, padding=1)
        self.blocks = nn.ModuleList([Block(channels) for _ in range(config['blocks'])])
        self.globalLayer = nn.Linear(2 * channels + schema['contextSize'], glob)
        self.localLayer = nn.Linear(channels + glob + schema['candidateSize'], local)
        self.actionHead = nn.Linear(local, 1)
        self.valueHead = nn.Linear(glob, 1)
        self.rankHead = nn.Linear(glob, 3)
        mask = torch.zeros(1, 1, schema['length'])
        mask[:, :, schema['positions']] = 1
        self.register_buffer('position_mask', mask)

    def forward(self, tiles, context, legal, candidates):
        x = torch.relu(self.stem(tiles)) * self.position_mask if self.config['useTiles'] else tiles.new_zeros((len(tiles), self.config['channels'], self.schema['length']))
        if self.config['useTiles']:
            for block in self.blocks:
                x = block(x, self.position_mask)
        local = x[:, :, self.schema['positions']].transpose(1, 2)
        pooled = torch.cat((local.mean(1), local.amax(1), context), dim=1)
        glob = torch.relu(self.globalLayer(pooled))
        local_actions = torch.cat((local.repeat(1, 4, 1), local.new_zeros((len(tiles), 4, self.config['channels']))), dim=1)
        combined = torch.cat((local_actions, glob[:, None, :].expand(-1, 88, -1), candidates), dim=2)
        a = self.actionHead(torch.relu(self.localLayer(combined))).squeeze(-1)
        v = self.valueHead(glob)
        mean = a.masked_fill(~legal, 0).sum(1, keepdim=True) / legal.sum(1, keepdim=True)
        q = (v + a - mean).masked_fill(~legal, -torch.inf)
        return q, self.rankHead(glob)

    def export(self):
        return {name: {'shape': list(p.shape), 'values': p.detach().cpu().flatten().tolist()}
                for name, p in self.named_parameters()}
