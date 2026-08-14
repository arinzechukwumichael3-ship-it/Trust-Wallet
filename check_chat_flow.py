import json, uuid, urllib.request

base='http://127.0.0.1:5500'
reg_req = urllib.request.Request(
    base + '/api/register-client',
    data=json.dumps({'helpry_id': 8484, 'country': 'US'}).encode(),
    headers={'Content-Type': 'application/json'},
    method='POST'
)
reg = json.loads(urllib.request.urlopen(reg_req).read().decode())
cache = reg['client']['cache_lock']
print('REGISTERED', json.dumps(reg, separators=(',', ':')))

boundary = '----WebKitFormBoundary' + uuid.uuid4().hex
body = [
    f'--{boundary}\r\nContent-Disposition: form-data; name="cache_lock"\r\n\r\n{cache}\r\n'.encode(),
    f'--{boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\nHello admin from browser test\r\n'.encode(),
    f'--{boundary}--\r\n'.encode(),
]
payload = b''.join(body)
req = urllib.request.Request(
    base + '/api/messages/send',
    data=payload,
    headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
    method='POST'
)
with urllib.request.urlopen(req) as resp:
    print('SEND', resp.status, resp.read().decode())

with urllib.request.urlopen(base + '/api/admin/clients') as resp:
    print('CLIENTS', resp.status)
    print(resp.read().decode())
