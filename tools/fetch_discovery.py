from pathlib import Path
import json
import ssl
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from core.discovery import Discovery
from core.home_art import FILE_NAME

directory = root / 'web/art/discovery'
store = Discovery(directory, directory, ssl.create_default_context(cafile=str(root / 'certs/cacert.pem')))
result = store.refresh()
keep = {item['file'] for item in result['items']}
for file in directory.iterdir():
    if file.is_file() and FILE_NAME.fullmatch(file.name) and file.name not in keep and file.resolve().parent == directory.resolve():
        file.unlink()
print(json.dumps({'count': len(result['items']), 'titles': [x['title'] for x in result['items']]}, ensure_ascii=True))
