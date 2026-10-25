"""Post-hoc validation diagnostics only; never selects or updates a model."""
import sys, json, gzip, hashlib
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ai' / 'tile-q'))
from train import load_dataset, checksum, check_sources
from network import TileQ
import torch

def kind(action):
    return 'discard' if action < 42 else 'an' if action < 63 else 'bu' if action < 84 else {84: 'hu', 85: 'peng', 86: 'ming', 87: 'pass'}[action]

def run(out):
    out = Path(out).resolve()
    destination = out / 'validation-diagnostics.json'
    if destination.exists():
        raise ValueError('Diagnostics exist')
    plan = json.loads((out / 'plan.json').read_text(encoding='utf-8'))
    models = json.loads((out / 'models.json').read_text(encoding='utf-8'))
    check_sources(plan['sources']['core'])
    data, meta = load_dataset(out / 'validation', 'validation', plan['schema'], plan['sources']['core'])
    roles = []
    with gzip.open(out / 'validation' / 'episodes.jsonl.gz', 'rt', encoding='utf-8') as source:
        for line in source:
            if line.strip():
                episode = json.loads(line)
                roles.extend(episode['roles'][row['seat']]['id'] for row in episode['rows'])
    teacher = data[4].tolist()
    assert len(teacher) == len(roles)
    results, decisions = {}, {}
    for arm in ['bc', 'offline']:
        entry = models[arm]
        assert checksum(entry['path']) == entry['sha256']
        exported = json.loads(Path(entry['path']).read_text(encoding='utf-8'))
        assert checksum(entry['state']) == exported['metadata']['optimizerStateSha256']
        state = torch.load(entry['state'], map_location='cpu', weights_only=True)
        assert state['sources'] == plan['sources']['core'] and state['schema'] == plan['schema'] and state['network'] == plan['network']
        assert state['validationHash'] == meta['sha256']
        model = TileQ(plan['schema'], plan['network'])
        model.load_state_dict(state['model'])
        model.eval()
        chosen = []
        with torch.inference_mode():
            for start in range(0, len(teacher), 512):
                q, _ = model(data[0][start:start+512], data[1][start:start+512], data[2][start:start+512], data[7][start:start+512])
                chosen.extend(q.argmax(1).tolist())
        decisions[arm] = chosen
        counts = dict(rows=len(teacher), exact=0, teacherDiscards=0, sameDiscardTile=0, differentDiscardTile=0,
                      onlyRevealDifference=0, teacherHu=0, teacherHuDeclined=0, huOffered=0, huDeclined=0,
                      modelReveals=0, teacherReveals=0)
        matrix, by_role = {}, {}
        for i, (a, t, role) in enumerate(zip(chosen, teacher, roles)):
            assert data[2][i, a]
            counts['exact'] += a == t
            counts['modelReveals'] += 21 <= a < 42
            counts['teacherReveals'] += 21 <= t < 42
            counts['teacherHu'] += t == 84
            counts['teacherHuDeclined'] += t == 84 and a != 84
            counts['huOffered'] += bool(data[2][i, 84])
            counts['huDeclined'] += bool(data[2][i, 84]) and a != 84
            if t < 42:
                counts['teacherDiscards'] += 1
                counts['sameDiscardTile'] += a < 42 and a % 21 == t % 21
                counts['differentDiscardTile'] += a < 42 and a % 21 != t % 21
                counts['onlyRevealDifference'] += a < 42 and a % 21 == t % 21 and a != t
            key = kind(t) + ' -> ' + kind(a)
            matrix[key] = matrix.get(key, 0) + 1
            r = by_role.setdefault(role, dict(rows=0, exact=0))
            r['rows'] += 1
            r['exact'] += a == t
        results[arm] = dict(counts=counts, teacherToChosenType=matrix, byTeacherRole=by_role, checkpointSha256=entry['sha256'])
    transitions = dict(rows=len(teacher), changed=0, discardTileChanged=0, onlyRevealChanged=0)
    for a, b in zip(decisions['bc'], decisions['offline']):
        transitions['changed'] += a != b
        transitions['discardTileChanged'] += a < 42 and b < 42 and a % 21 != b % 21
        transitions['onlyRevealChanged'] += a < 42 and b < 42 and a % 21 == b % 21 and a != b
    result = dict(postHoc=True, use='Validation behavior diagnosis only, no selection or training', validationSha256=meta['sha256'],
                  sourceSha256=checksum(__file__), models=results, bcToOffline=transitions)
    destination.write_text(json.dumps(result, indent=2, allow_nan=False)+'\n', encoding='utf-8')
    print(json.dumps(result), flush=True)

if __name__ == '__main__':
    run(sys.argv[1])
