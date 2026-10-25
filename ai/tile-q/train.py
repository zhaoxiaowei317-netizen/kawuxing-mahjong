import os
os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('MKL_NUM_THREADS', '2')
import sys, json, gzip, hashlib, base64
from pathlib import Path
import numpy as np
import torch
from network import TileQ, VERSION

torch.set_num_threads(2)
torch.set_num_interop_threads(1)
torch.use_deterministic_algorithms(True)
ROOT = Path(__file__).resolve().parents[2]

def checksum(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def check_sources(sources):
    for path, expected in sources.items():
        if checksum(ROOT / path) != expected:
            raise ValueError('Training source changed: ' + path)

def load_dataset(path, split, schema, sources):
    path = Path(path)
    meta = json.loads((path / 'manifest.json').read_text(encoding='utf-8'))
    assert meta['split'] == split and meta['schema'] == schema and meta['sources'] == sources
    assert checksum(path / 'episodes.jsonl.gz') == meta['sha256']
    n = meta['samples']
    x = np.empty((n, schema['channels'], schema['length']), np.float32)
    context = np.empty((n, schema['contextSize']), np.float32)
    mask = np.zeros((n, 88), bool)
    action, teacher = np.empty(n, np.int64), np.empty(n, np.int64)
    target, rank = np.empty(n, np.float32), np.empty((n, 3), np.float32)
    candidates = np.zeros((n, 88, schema['candidateSize']), np.float32)
    scale = np.array([p['scale'] for p in schema['planes']], np.float32)[:, None]
    gaps = [i for i in range(schema['length']) if i not in schema['positions']]
    row_count = hands = 0
    with gzip.open(path / 'episodes.jsonl.gz', 'rt', encoding='utf-8') as f:
        for line in f:
            if not line.strip():
                continue
            episode = json.loads(line)
            hands += 1
            for row in episode['rows']:
                raw = np.frombuffer(base64.b64decode(row['encoded']['tiles']), np.uint8).reshape(schema['channels'], schema['length'])
                assert not raw[:, gaps].any()
                x[row_count] = raw / scale
                context[row_count] = row['encoded']['context']
                ids = row['legalIds']
                assert len(ids) > 1 and len(set(ids)) == len(ids) and all(0 <= a < 88 for a in ids)
                assert row['actionId'] in ids and row['teacherId'] in ids
                mask[row_count, ids] = True
                assert sorted(c['id'] for c in row['encoded']['candidates']) == ids
                for c in row['encoded']['candidates']:
                    candidates[row_count,c['id']] = c['values']
                action[row_count], teacher[row_count] = row['actionId'], row['teacherId']
                target[row_count], rank[row_count] = row['target'], row['rank']
                row_count += 1
    assert row_count == n and hands == meta['hands'] and n > 0
    assert all(np.isfinite(a).all() for a in [x, context, target, rank, candidates])
    assert np.allclose(rank.sum(1), 1)
    return tuple(torch.from_numpy(a) for a in [x, context, mask, action, teacher, target, rank, candidates]), meta

def loss(model, batch, mode, config):
    x, ctx, mask, action, teacher, target, rank, candidates = batch
    q, rank_logits = model(x, ctx, mask, candidates)
    selected = q.gather(1, action[:, None]).squeeze(1)
    mse = .5 * (selected - target).square().mean()
    cql = (q.logsumexp(1) - selected).mean()
    bc = torch.nn.functional.cross_entropy(q, teacher)
    aux = -(rank * rank_logits.log_softmax(1)).sum(1).mean()
    total = bc + config['auxWeight'] * aux if mode == 'bc' else mse + config['cqlWeight'] * cql + config['bcWeight'] * bc + config['auxWeight'] * aux
    return total, {'loss': total.item(), 'mcHalfMse': mse.item(), 'cql': cql.item(), 'bc': bc.item(), 'rank': aux.item(),
                   'teacherAgreement': (q.argmax(1) == teacher).float().mean().item()}

def measure(model, data, mode, config):
    model.eval()
    totals = {}
    with torch.inference_mode():
        for start in range(0, len(data[0]), 512):
            batch = tuple(x[start:start+512] for x in data)
            _, metrics = loss(model, batch, mode, config)
            for k, v in metrics.items():
                totals[k] = totals.get(k, 0.) + v * len(batch[0]) / len(data[0])
    return totals

def run(spec):
    out = Path(spec['out'])
    if out.exists():
        raise ValueError('Training output exists')
    check_sources(spec['sources'])
    schema, config = spec['schema'], spec['config']
    train, train_meta = load_dataset(spec['trainingData'], 'training', schema, spec['sources'])
    val, val_meta = load_dataset(spec['validationData'], 'validation', schema, spec['sources'])
    assert train_meta['sha256'] != val_meta['sha256']
    seed = int(hashlib.sha256(spec['seed'].encode()).hexdigest()[:8], 16)
    torch.manual_seed(seed)
    model = TileQ(schema, spec['network'])
    optimizer = torch.optim.Adam(model.parameters(), lr=config['learningRate'])
    start_epoch, history = 0, []
    if spec.get('initialize') or spec.get('resume'):
        checkpoint = torch.load(spec.get('resume') or spec['initialize'], map_location='cpu', weights_only=True)
        assert checkpoint['sources'] == spec['sources'] and checkpoint['schema'] == schema and checkpoint['network'] == spec['network']
        model.load_state_dict(checkpoint['model'])
        if spec.get('resume'):
            assert checkpoint['seed'] == spec['seed'] and checkpoint['config'] == config and checkpoint['mode'] == spec['mode']
            assert checkpoint['trainingHash'] == train_meta['sha256'] and checkpoint['validationHash'] == val_meta['sha256']
            optimizer.load_state_dict(checkpoint['optimizer'])
            start_epoch, history = checkpoint['epoch'], checkpoint['history']
    assert spec['epochs'] >= start_epoch
    out.mkdir(parents=True)
    selected = None
    if spec.get('resume'):
        selected = checkpoint['selected']
    for epoch in range(start_epoch, spec['epochs'] + 1):
        if spec.get('resume') and epoch == start_epoch:
            continue
        if epoch:
            model.train()
            rng = np.random.default_rng(np.random.SeedSequence([seed, epoch]))
            order = rng.permutation(len(train[0]))
            for begin in range(0, len(order), config['batchSize']):
                indices = torch.from_numpy(order[begin:begin+config['batchSize']])
                batch = tuple(x[indices] for x in train)
                optimizer.zero_grad(set_to_none=True)
                objective, _ = loss(model, batch, spec['mode'], config)
                assert torch.isfinite(objective)
                objective.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), config['maxGradNorm'], error_if_nonfinite=True)
                optimizer.step()
        row = {'epoch': epoch, 'training': measure(model, train, spec['mode'], config), 'validation': measure(model, val, spec['mode'], config)}
        history.append(row)
        base = out / ('epoch-%03d' % epoch)
        if selected is None or (spec.get('select', 'validation') == 'last') or row['validation']['loss'] < selected['validationLoss'] - 1e-12:
            selected = {'epoch': epoch, 'path': str(base) + '.json', 'state': str(base) + '.pt', 'validationLoss': row['validation']['loss']}
        state = {'version': VERSION, 'schema': schema, 'network': spec['network'], 'sources': spec['sources'], 'seed': spec['seed'],
                 'model': model.state_dict(), 'optimizer': optimizer.state_dict(), 'config': config, 'mode': spec['mode'],
                 'epoch': epoch, 'history': history, 'selected': selected, 'trainingHash': train_meta['sha256'], 'validationHash': val_meta['sha256']}
        torch.save(state, str(base) + '.pt')
        exported = {'version': VERSION, 'schema': schema, 'config': spec['network'], 'sources': spec['sources'], 'weights': model.export(),
                    'metadata': {'epoch': epoch, 'mode': spec['mode'], 'seed': spec['seed'], 'trainingHash': train_meta['sha256'],
                                 'validationHash': val_meta['sha256'], 'torch': torch.__version__, 'optimizerStateSha256': checksum(str(base)+'.pt')}}
        (Path(str(base)+'.json')).write_text(json.dumps(exported, separators=(',', ':'), allow_nan=False)+'\n', encoding='utf-8')
        print(json.dumps({'epoch': epoch, 'mode': spec['mode'], 'selected': selected['epoch'], **row['validation']}), flush=True)
    check_sources(spec['sources'])
    summary = {'selected': selected, 'history': history, 'trainingSamples': len(train[0]), 'validationSamples': len(val[0]),
               'trainingHash': train_meta['sha256'], 'validationHash': val_meta['sha256'], 'config': config, 'network': spec['network'],
               'mode': spec['mode'], 'seed': spec['seed'], 'torch': torch.__version__, 'parameters': sum(p.numel() for p in model.parameters())}
    (out/'summary.json').write_text(json.dumps(summary, indent=2, allow_nan=False)+'\n', encoding='utf-8')
    # Public-input parity fixtures test the JS export against the training backend.
    model.eval()
    indices = list(range(min(12, len(val[0]))))
    q, rank = model(val[0][indices], val[1][indices], val[2][indices], val[7][indices])
    parity = []
    for i, index in enumerate(indices):
        raw = (val[0][index].numpy() * np.array([p['scale'] for p in schema['planes']], np.float32)[:, None]).round().astype(np.uint8)
        ids = val[2][index].nonzero().flatten().tolist()
        parity.append({'encoded': {'tiles': base64.b64encode(raw.tobytes()).decode(), 'context': val[1][index].tolist(),
                                  'candidates': [{'id': a, 'values': val[7][index,a].tolist()} for a in ids]},
                       'legalIds': ids, 'q': {str(a): q[i,a].item() for a in ids}, 'rankLogits': rank[i].tolist()})
    (out/'parity.json').write_text(json.dumps({'checkpoint': str(out/('epoch-%03d.json'%spec['epochs'])), 'fixtures': parity}, allow_nan=False)+'\n', encoding='utf-8')
    return summary

if __name__ == '__main__':
    run(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
