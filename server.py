import json
import mimetypes
import os
import uuid
from email.parser import BytesParser
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, 'data')
STATE_FILE = os.path.join(DATA_DIR, 'state.json')
PORT = int(os.environ.get('PORT', '5500'))


def ensure_data_dir():
    os.makedirs(DATA_DIR, exist_ok=True)


def default_state():
    return {
        'next_client_id': 1,
        'next_message_id': 1,
        'clients': []
    }


def load_state():
    ensure_data_dir()
    if not os.path.exists(STATE_FILE):
        with open(STATE_FILE, 'w', encoding='utf-8') as fh:
            json.dump(default_state(), fh, indent=2)
        return default_state()

    try:
        with open(STATE_FILE, 'r', encoding='utf-8') as fh:
            raw = fh.read().strip()
        if not raw:
            state = default_state()
            with open(STATE_FILE, 'w', encoding='utf-8') as fh:
                json.dump(state, fh, indent=2)
            return state
        data = json.loads(raw)
        return {
            'next_client_id': int(data.get('next_client_id', 1)),
            'next_message_id': int(data.get('next_message_id', 1)),
            'clients': data.get('clients', [])
        }
    except Exception:
        state = default_state()
        with open(STATE_FILE, 'w', encoding='utf-8') as fh:
            json.dump(state, fh, indent=2)
        return state


STATE = load_state()


def save_state():
    ensure_data_dir()
    with open(STATE_FILE, 'w', encoding='utf-8') as fh:
        json.dump(STATE, fh, indent=2)


def get_client_by_cache_lock(cache_lock):
    for client in STATE['clients']:
        if client.get('cache_lock') == cache_lock:
            return client
    return None


def get_client_by_id(client_id):
    try:
        target = int(client_id)
    except (TypeError, ValueError):
        return None

    for client in STATE['clients']:
        if int(client.get('id')) == target:
            return client
    return None


def sanitize_message(msg):
    return {
        'id': msg.get('id'),
        'sender_type': msg.get('sender_type'),
        'message': msg.get('message', ''),
        'image_urls': msg.get('image_urls', []),
        'created_at': msg.get('created_at')
    }


def list_messages(client):
    messages = client.get('messages', [])
    return [sanitize_message(message) for message in sorted(messages, key=lambda m: m.get('created_at', ''))]


def parse_body(handler):
    length = int(handler.headers.get('Content-Length', '0') or '0')
    raw = handler.rfile.read(length) if length else b''
    ctype = handler.headers.get('Content-Type', '').lower()

    if not raw:
        return {}

    if 'application/json' in ctype:
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            return {}

    if 'application/x-www-form-urlencoded' in ctype:
        parsed = parse_qs(raw.decode('utf-8'))
        return {k: v[0] if isinstance(v, list) and v else '' for k, v in parsed.items()}

    if 'multipart/form-data' in ctype:
        boundary = ctype.split('boundary=')[-1].strip('"')
        if not boundary:
            return {}

        boundary_bytes = b'--' + boundary.encode('utf-8')
        result = {}
        for part in raw.split(boundary_bytes):
            if not part or part in (b'--', b'--\r\n', b'--\n'):
                continue

            candidate = part.strip()
            if candidate.startswith(b'--'):
                candidate = candidate[2:]
            if b'\r\n\r\n' not in candidate:
                continue

            headers_block, value = candidate.split(b'\r\n\r\n', 1)
            header_text = headers_block.decode('utf-8', 'replace')
            field_name = None
            for line in header_text.splitlines():
                if line.lower().startswith('content-disposition:'):
                    remaining = line.split(';', 1)[1:]
                    for item in remaining:
                        item = item.strip()
                        if item.lower().startswith('name='):
                            field_name = item.split('=', 1)[1].strip('"')
                            break
                    break

            if field_name is None:
                continue

            cleaned = value.strip()
            if cleaned.endswith(b'--'):
                cleaned = cleaned[:-2]
            cleaned = cleaned.rstrip(b'\r\n')
            result[field_name] = cleaned.decode('utf-8', 'replace')

        return result

    return {}


class HelpryHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/health':
            self.send_json(200, {'ok': True, 'status': 'running', 'port': PORT})
            return

        if path in ('/admin', '/admin.html'):
            target = os.path.join(ROOT, 'admin.html')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            with open(target, 'rb') as fh:
                self.wfile.write(fh.read())
            return

        if path == '/api/admin/clients':
            clients_payload = []
            for client in STATE['clients']:
                clients_payload.append({
                    'id': client['id'],
                    'ref_id': client['ref_id'],
                    'helpry_id': client['helpry_id'],
                    'country': client['country'],
                    'cache_lock': client['cache_lock'],
                    'created_at': client['created_at'],
                    'messages': list_messages(client)
                })
            self.send_json(200, {'success': True, 'clients': clients_payload})
            return

        if path == '/api/admin/seed-demo':
            if STATE['clients']:
                self.send_json(200, {'success': True, 'message': 'Demo already created', 'clients': len(STATE['clients'])})
                return

            demo_client = {
                'id': STATE['next_client_id'],
                'ref_id': 'TW-00001',
                'helpry_id': 8484,
                'country': 'United States',
                'cache_lock': 'demo-cache-lock-helpry-0001',
                'created_at': '2026-08-13T00:00:00Z',
                'messages': [
                    {
                        'id': STATE['next_message_id'],
                        'sender_type': 'client',
                        'message': 'Hi, I need help with my wallet.',
                        'image_urls': [],
                        'created_at': '2026-08-13T00:00:01Z'
                    }
                ]
            }
            STATE['next_client_id'] += 1
            STATE['next_message_id'] += 1
            STATE['clients'].append(demo_client)
            save_state()
            self.send_json(200, {'success': True, 'client': demo_client})
            return

        if path.startswith('/api/'):
            self.send_json(404, {'success': False, 'error': 'API endpoint not found'})
            return

        rel = path.lstrip('/')
        requested = os.path.join(ROOT, rel)
        if os.path.isfile(requested):
            self.send_response(200)
            content_type, _ = mimetypes.guess_type(requested)
            if content_type is None:
                content_type = 'application/octet-stream'
            self.send_header('Content-Type', content_type)
            self.end_headers()
            with open(requested, 'rb') as fh:
                self.wfile.write(fh.read())
            return

        if rel == '':
            self.send_json(404, {'success': False, 'error': 'No default page on root'})
            return

        self.send_json(404, {'success': False, 'error': 'Not found'})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        body = parse_body(self)

        if path == '/api/register-client':
            helpry_id = body.get('helpry_id')
            if not helpry_id:
                self.send_json(400, {'success': False, 'error': 'Missing helpry_id'})
                return

            client = {
                'id': STATE['next_client_id'],
                'ref_id': f"TW-{str(STATE['next_client_id']).zfill(5)}",
                'helpry_id': int(helpry_id),
                'country': body.get('country', 'Unknown'),
                'cache_lock': str(uuid.uuid4()),
                'created_at': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
                'messages': []
            }
            STATE['next_client_id'] += 1
            STATE['clients'].append(client)
            save_state()
            self.send_json(200, {
                'success': True,
                'client': {
                    'id': client['id'],
                    'ref_id': client['ref_id'],
                    'helpry_id': client['helpry_id'],
                    'country': client['country'],
                    'cache_lock': client['cache_lock']
                }
            })
            return

        if path == '/api/verify-cache-lock':
            cache_lock = body.get('cache_lock')
            if not cache_lock:
                self.send_json(400, {'valid': False, 'reason': 'Missing cache_lock'})
                return

            client = get_client_by_cache_lock(cache_lock)
            if not client:
                self.send_json(200, {'valid': False, 'reason': 'invalid cache lock'})
                return

            self.send_json(200, {
                'valid': True,
                'client': {
                    'id': client['id'],
                    'ref_id': client['ref_id'],
                    'helpry_id': client['helpry_id'],
                    'country': client['country'],
                    'cache_lock': client['cache_lock']
                }
            })
            return

        if path == '/api/messages/fetch':
            cache_lock = body.get('cache_lock')
            if not cache_lock:
                self.send_json(400, {'success': False, 'error': 'Missing cache_lock'})
                return

            client = get_client_by_cache_lock(cache_lock)
            if not client:
                self.send_json(404, {'success': False, 'error': 'Session not found'})
                return

            self.send_json(200, {'success': True, 'messages': list_messages(client)})
            return

        if path == '/api/messages/send':
            cache_lock = body.get('cache_lock')
            if not cache_lock:
                self.send_json(400, {'success': False, 'error': 'Missing cache_lock'})
                return

            client = get_client_by_cache_lock(cache_lock)
            if not client:
                self.send_json(404, {'success': False, 'error': 'Session not found'})
                return

            message = (body.get('message') or '').strip()
            if not message:
                self.send_json(400, {'success': False, 'error': 'Empty message'})
                return

            record = {
                'id': STATE['next_message_id'],
                'sender_type': 'client',
                'message': message,
                'image_urls': [],
                'created_at': __import__('datetime').datetime.utcnow().isoformat() + 'Z'
            }
            STATE['next_message_id'] += 1
            client.setdefault('messages', []).append(record)
            save_state()
            self.send_json(200, {'success': True, 'message': sanitize_message(record)})
            return

        if path == '/api/admin/reply':
            client_id = body.get('client_id')
            message = (body.get('message') or '').strip()
            if not client_id:
                self.send_json(400, {'success': False, 'error': 'Missing client_id'})
                return
            if not message:
                self.send_json(400, {'success': False, 'error': 'Message is empty'})
                return

            client = get_client_by_id(client_id)
            if not client:
                self.send_json(404, {'success': False, 'error': 'Client not found'})
                return

            reply = {
                'id': STATE['next_message_id'],
                'sender_type': 'admin',
                'message': message,
                'image_urls': [],
                'created_at': __import__('datetime').datetime.utcnow().isoformat() + 'Z'
            }
            STATE['next_message_id'] += 1
            client.setdefault('messages', []).append(reply)
            save_state()
            self.send_json(200, {'success': True, 'message': sanitize_message(reply)})
            return

        self.send_json(405, {'success': False, 'error': 'Method not allowed for this endpoint'})

    def send_json(self, status, payload):
        data = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        return


if __name__ == '__main__':
    ensure_data_dir()
    print(f'Helpry local chat server started on http://127.0.0.1:{PORT}')
    print(f'Widget URL: http://127.0.0.1:{PORT}/helpry.jp/cmupnn-trustwallet-xostfj-helpry-eohlok-trustwallet-gkqtyx.html')
    print(f'Admin URL: http://127.0.0.1:{PORT}/admin')
    ThreadingHTTPServer(('127.0.0.1', PORT), HelpryHandler).serve_forever()
