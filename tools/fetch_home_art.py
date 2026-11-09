"""Build the offline seed from the current public bangumi ranking."""
import json
from pathlib import Path
import ssl
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from core.home_art import HomeArt

directory = root / 'web/art/bangumi'
store = HomeArt(directory, directory, ssl.create_default_context(cafile=str(root / 'certs/cacert.pem')))
result = store.refresh()
print(json.dumps({'count': len(result['items']), 'items': [
    {key: item[key] for key in ('title', 'rank', 'width', 'height', 'kind')} for item in result['items']]}, ensure_ascii=True))
