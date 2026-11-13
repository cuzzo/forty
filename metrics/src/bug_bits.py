"""Bug bits of forty's production code (every .js except test.js) at one or more revisions, per directory
(root, v0..v3), measured with min-giga: each directory's files at REV copied into a fresh Git repository and run
through `decomplex-rust facts . --bug-surface --no-semantic-index`, reading corpus_totals.bug_surface.structural.
Usage: python3 metrics/src/bug_bits.py REV [REV...]
Writes metrics/data/bug_bits/REV.json for each revision and prints one line each."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIN_GIGA = Path(os.path.expanduser('~/dev/min-giga'))
DECOMPLEX = MIN_GIGA / 'decomplex/target/release/decomplex-rust'
MFM = MIN_GIGA / 'rs/target/release/mfm'
KEYS = ('total_bits', 'path_bits', 'state_bits', 'ordering_bits')
DIRS = ('.', 'v0', 'v1', 'v2', 'v3')


def git(*args, cwd=ROOT):
    return subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True).stdout


def measure_dir(rev, path):
    names = git('ls-tree', '--name-only', f'{rev}:{path}' if path != '.' else rev).decode().split()
    files = [n for n in names if n.endswith('.js') and n != 'test.js']
    with tempfile.TemporaryDirectory() as directory:
        for name in files:
            Path(directory, name).write_bytes(git('show', f'{rev}:{name if path == "." else f"{path}/{name}"}'))
        for command in (['init', '-q'], ['add', '.'], ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 's']):
            subprocess.run(['git', *command], cwd=directory, check=True)
        out = subprocess.run([str(DECOMPLEX), 'facts', '.', '--bug-surface', '--no-semantic-index'], cwd=directory,
                             check=True, capture_output=True, env={**os.environ, 'MFM': str(MFM)}).stdout
    structural = json.loads(out)['corpus_totals']['bug_surface']['structural']
    return {key: round(structural[key], 1) for key in KEYS}


def measure(rev):
    full = git('rev-parse', rev).decode().strip()
    dirs = {path: measure_dir(full, path) for path in DIRS}
    out = {'rev': full[:8], 'dirs': dirs, 'total': {key: round(sum(d[key] for d in dirs.values()), 1) for key in KEYS}}
    target = ROOT / 'metrics/data/bug_bits' / f'{full[:8]}.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out, indent=1) + '\n')
    return out


for rev in sys.argv[1:]:
    print(json.dumps(measure(rev)))
