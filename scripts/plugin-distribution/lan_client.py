"""Small stdio MCP client for an administrator-configured, bounded HTTP gateway."""
import ipaddress
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Gateway redirects are not permitted')

def connection(plugin):
    directory = Path(os.environ.get('CARDBUSH_PLUGIN_CONNECTIONS') or
                     Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'CardBushPluginConnections')
    config = json.loads((directory / (plugin + '.json')).read_text(encoding='utf-8-sig'))
    endpoint = urllib.parse.urlsplit(config['url'])
    if endpoint.scheme not in {'http', 'https'} or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise ValueError('Invalid gateway URL')
    if endpoint.scheme == 'http':
        address = ipaddress.ip_address(endpoint.hostname)
        if not (address.is_private or address.is_loopback) or address.is_unspecified:
            raise ValueError('Plain HTTP requires a concrete private or loopback IP address')
    if not isinstance(config.get('token'), str) or len(config['token']) < 32:
        raise ValueError('A gateway access token is required')
    return config

def handle(request, descriptor):
    if not isinstance(request, dict) or request.get('jsonrpc') != '2.0' or not isinstance(request.get('method'), str):
        return {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Invalid Request'}}
    if 'id' not in request:
        return None
    reply = {'jsonrpc': '2.0', 'id': request['id']}
    method = request['method']
    if method == 'initialize':
        reply['result'] = {'protocolVersion': '2025-03-26', 'capabilities': {'tools': {}},
                           'serverInfo': {'name': descriptor['id'], 'version': descriptor['version']}}
    elif method == 'tools/list': reply['result'] = {'tools': descriptor['tools']}
    elif method == 'ping': reply['result'] = {}
    elif method == 'tools/call':
        params = request.get('params', {})
        if not isinstance(params, dict) or params.get('name') not in {t['name'] for t in descriptor['tools']}:
            reply['error'] = {'code': -32602, 'message': 'Unknown tool'}
        else:
            try:
                config = connection(descriptor['id'])
                body = json.dumps(request, ensure_ascii=False).encode('utf-8')
                if len(body) > 1_048_576: raise ValueError('Request too large')
                transport = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
                outgoing = urllib.request.Request(config['url'], data=body,
                    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['token']})
                with transport.open(outgoing, timeout=30) as response:
                    data = response.read(8_388_609)
                if len(data) > 8_388_608: raise ValueError('Response too large')
                incoming = json.loads(data)
                if incoming.get('jsonrpc') != '2.0' or incoming.get('id') != request['id']:
                    raise ValueError('Invalid gateway response')
                return incoming
            except (OSError, ValueError, KeyError, urllib.error.URLError):
                reply['result'] = {'isError': True, 'content': [{'type': 'text', 'text':
                    '公司数据服务连接未配置或不可用。请联系管理员配置 CardBushPluginConnections 中对应插件的地址与访问凭据。'}]}
    else: reply['error'] = {'code': -32601, 'message': 'Method not found'}
    return reply

def main():
    sys.stdin.reconfigure(encoding='utf-8'); sys.stdout.reconfigure(encoding='utf-8')
    descriptor = json.loads((ROOT / 'lan-tools.json').read_text(encoding='utf-8'))
    while True:
        line = sys.stdin.buffer.readline(1_048_577)
        if not line: break
        if len(line) > 1_048_576: return 1
        try: response = handle(json.loads(line), descriptor)
        except (ValueError, TypeError): response = {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Parse error'}}
        if response is not None: print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0

if __name__ == '__main__': raise SystemExit(main())
