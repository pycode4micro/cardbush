"""Opt-in HTTP exposure of explicit read-only MCP handlers; loopback by default."""
from __future__ import annotations
import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib
import ipaddress
import json
from pathlib import Path
import threading

def make_handler(routes, networks):
    slots = threading.BoundedSemaphore(8)
    class Handler(BaseHTTPRequestHandler):
        server_version = 'CardBushReadOnlyGateway/1'
        def setup(self):
            super().setup()
            self.connection.settimeout(15)
        def log_message(self, *args): pass  # Do not log tokens, arguments, or business data.
        def send_json(self, status, value):
            body = json.dumps(value, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers(); self.wfile.write(body)
        def do_POST(self):
            self.connection.settimeout(15)
            peer = ipaddress.ip_address(self.client_address[0])
            if not any(peer in network for network in networks):
                return self.send_json(403, {'error': 'client_not_allowed'})
            route = routes.get(self.path)
            if not route: return self.send_json(404, {'error': 'unknown_route'})
            if self.headers.get('Origin') or self.headers.get('Transfer-Encoding'):
                return self.send_json(403, {'error': 'unsupported_request'})
            actual = self.headers.get('Authorization', '').encode('utf-8')
            if not hmac.compare_digest(actual, ('Bearer ' + route['token']).encode('utf-8')):
                return self.send_json(401, {'error': 'unauthorized'})
            try: length = int(self.headers.get('Content-Length', '0'))
            except ValueError: length = 0
            if not 0 < length <= 1_048_576: return self.send_json(413, {'error': 'invalid_body_size'})
            if not slots.acquire(blocking=False): return self.send_json(429, {'error': 'busy'})
            try:
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict) or request.get('jsonrpc') != '2.0' or 'id' not in request:
                    return self.send_json(400, {'error': 'invalid_rpc'})
                if request.get('method') != 'tools/call' or not isinstance(request.get('params'), dict):
                    return self.send_json(403, {'error': 'method_not_allowed'})
                if request['params'].get('name') not in route['allowed_tools']:
                    return self.send_json(403, {'error': 'tool_not_allowed'})
                return self.send_json(200, route['handler'](request))
            except Exception:
                return self.send_json(503, {'error': 'service_unavailable'})
            finally: slots.release()
    return Handler

def load_routes(config):
    routes = {}
    for route in config['routes']:
        if len(route.get('token', '')) < 32: raise ValueError('Each route needs a separate strong token')
        module = importlib.import_module(route['module'])
        declared = {t['name'] for t in module.TOOLS if t.get('annotations', {}).get('readOnlyHint') is True}
        allowed = set(route['allowed_tools'])
        if not allowed or not allowed <= declared: raise ValueError('Invalid tool allowlist')
        # The administrator chooses the audited query-only modules and exact tool names.
        handler = (module.create_handler(route.get('settings', {}))
                   if hasattr(module, 'create_handler') else module.handle)
        routes[route['path']] = {**route, 'handler': handler, 'allowed_tools': allowed}
    return routes

class BoundedServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, *args):
        self.connections = threading.BoundedSemaphore(16)
        super().__init__(*args)
    def process_request(self, request, address):
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try: super().process_request(request, address)
        except BaseException:
            self.connections.release()
            raise
    def process_request_thread(self, request, address):
        try: super().process_request_thread(request, address)
        finally: self.connections.release()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=18765)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding='utf-8-sig'))
    routes = load_routes(config)
    networks = [ipaddress.ip_network(x) for x in config.get('allowed_clients', ['127.0.0.0/8'])]
    if args.host not in {'127.0.0.1', '::1'} and not config.get('lan_enabled', False):
        raise ValueError('LAN binding requires explicit administrator enablement')
    server = BoundedServer((args.host, args.port), make_handler(routes, networks))
    print(f'Read-only gateway listening on {args.host}:{args.port}; {len(routes)} routes', flush=True)
    try: server.serve_forever()
    finally: server.server_close()

if __name__ == '__main__': main()
