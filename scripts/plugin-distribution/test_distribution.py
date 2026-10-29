import http.client
import ipaddress
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import lan_client
from lan_gateway import BoundedServer, make_handler, load_routes
from build_plugins import private_file, copy_source, build
from portable_python import distributions

class DistributionTests(unittest.TestCase):
    def test_stdlib_plugin_does_not_inspect_unrelated_package_metadata(self):
        with patch('portable_python.metadata.distributions', side_effect=AssertionError('unrelated packages')):
            self.assertEqual(distributions(Path('unused-site-packages'), []), {})

    def test_private_files_not_distributed(self):
        for name in ['.env', '.env.production', 'credentials.json', 'oauth.key', 'database.sqlite3', 'settings.local.json', '.mcp.json.bak2-20261010']:
            self.assertTrue(private_file(Path(name)), name)
        for name in ['config.example.env', 'server.py', 'LICENSE.txt', '.mcp.json']:
            self.assertFalse(private_file(Path(name)), name)

    def test_source_copy_excludes_state_and_dependencies(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name); source=root/'source'; source.mkdir()
            (source/'.env').write_text('secret')
            (source/'server.py').write_text('pass')
            (source/'.venv').mkdir(); (source/'.venv'/'private').write_text('skip')
            copy_source(source, root/'output')
            self.assertEqual([p.name for p in (root/'output').iterdir()], ['server.py'])

    def test_source_links_cannot_copy_files_from_outside_the_plugin(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name); outside=root/'outside'; outside.mkdir()
            (outside/'private.txt').write_text('not part of the plugin')
            source=root/'source';source.mkdir()
            os.symlink(outside,source/'linked',target_is_directory=True)
            with self.assertRaises(ValueError): copy_source(source,root/'output')
            self.assertFalse((root/'output/linked/private.txt').exists())

    def test_portable_manifest_preserves_host_protocol_and_existing_runtime(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name); source=root/'source'; source.mkdir()
            (source/'runtime').mkdir();(source/'runtime/app.py').write_text('application source')
            schema='https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
            (source/'mcp.json').write_text(json.dumps({'$schema':schema,'mcpServers':{'example':{'type':'stdio','command':'node'}}}))
            executable=root/'fixture.exe';executable.write_bytes(b'fixture; never executed')
            build({'output':str(root/'plugins'),'launcher':str(executable),'node':str(executable),
                   'plugins':[{'id':'example','source':str(source),'kind':'node','server':'example','args':['server.cjs']}]})
            target=root/'plugins/example'
            portable=json.loads((target/'mcp.json').read_text())
            codex=json.loads((target/'.mcp.json').read_text())
            self.assertEqual(portable['$schema'],schema)
            self.assertEqual(portable['mcpServers'],codex['mcpServers'])
            self.assertEqual(portable['mcpServers']['example']['type'],'stdio')
            self.assertEqual(portable['mcpServers']['example']['command'],'${PLUGIN_ROOT}/example.exe')
            self.assertEqual((target/'runtime/app.py').read_text(),'application source')
            self.assertTrue((target/'portable-runtime/node.exe').is_file())

    def test_http_client_rejects_public_plaintext_and_redirects(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'fixture.json'
            with patch.dict('os.environ', {'CARDBUSH_PLUGIN_CONNECTIONS': directory}):
                for url in ['http://8.8.8.8/mcp', 'http://0.0.0.0/mcp', 'file:///tmp/secret', 'http://user:pass@127.0.0.1/mcp']:
                    target.write_text(json.dumps({'url':url,'token':'x'*40}))
                    with self.assertRaises(ValueError): lan_client.connection('fixture')
                target.write_text(json.dumps({'url':'http://127.0.0.1:18765/mcp/fixture','token':'x'*40}))
                self.assertEqual(lan_client.connection('fixture')['token'], 'x'*40)
        with self.assertRaises(ValueError): lan_client.NoRedirect().redirect_request(None,None,None,None,None,None)

    def test_gateway_auth_method_tool_and_source_boundaries(self):
        calls=[]
        def handler(request): calls.append(request); return {'jsonrpc':'2.0','id':request['id'],'result':{'content':[]}}
        server=BoundedServer(('127.0.0.1',0),make_handler({'/mcp/fixture':{'token':'x'*40,'allowed_tools':{'read'},'handler':handler}},[ipaddress.ip_network('127.0.0.0/8')]))
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        def request(body, token='x'*40, path='/mcp/fixture', extra=None):
            client=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
            try:
                client.request('POST',path,json.dumps(body),{'Authorization':'Bearer '+token,**(extra or {})})
                response=client.getresponse();response.read();return response.status
            finally: client.close()
        valid={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'read','arguments':{}}}
        try:
            self.assertEqual(request(valid,token='wrong'),401)
            self.assertEqual(request(valid,path='/admin'),404)
            self.assertEqual(request(valid,extra={'Origin':'https://untrusted.example'}),403)
            self.assertEqual(request({**valid,'method':'execute'}),403)
            self.assertEqual(request({**valid,'params':{'name':'delete'}}),403)
            self.assertEqual(calls,[])
            self.assertEqual(request(valid),200)
            self.assertEqual(calls,[valid])
        finally: server.shutdown();server.server_close();worker.join()

    def test_gateway_refuses_write_tool_even_in_admin_allowlist(self):
        class Module:
            TOOLS=[{'name':'write','annotations':{'readOnlyHint':False}}]
        with patch('lan_gateway.importlib.import_module',return_value=Module):
            with self.assertRaises(ValueError): load_routes({'routes':[{'path':'/mcp','module':'fixture','token':'x'*40,'allowed_tools':['write']}]})

    def test_route_factory_receives_administrator_settings_and_preserves_allowlist(self):
        from types import SimpleNamespace
        configured = []
        def create_handler(settings):
            configured.append(settings)
            return lambda request: {'jsonrpc': '2.0', 'id': request['id'], 'result': settings}
        module = SimpleNamespace(TOOLS=[{'name': 'read', 'annotations': {'readOnlyHint': True}}],
                                 create_handler=create_handler)
        with patch('lan_gateway.importlib.import_module', return_value=module):
            routes = load_routes({'routes': [{'path': '/mcp/fixture', 'module': 'fixture', 'token': 'x'*40,
                'allowed_tools': ['read'], 'settings': {'dataset': 'fixture'}}]})
        self.assertEqual(configured, [{'dataset': 'fixture'}])
        route = routes['/mcp/fixture']
        self.assertEqual(route['allowed_tools'], {'read'})
        self.assertEqual(route['handler']({'id': 1})['result'], {'dataset': 'fixture'})

    def test_client_lists_tools_offline_and_blocks_unknown(self):
        descriptor={'id':'fixture','version':'1','tools':[{'name':'read'}]}
        base={'jsonrpc':'2.0','id':1}
        self.assertEqual(lan_client.handle({**base,'method':'tools/list'},descriptor)['result']['tools'],descriptor['tools'])
        with patch('lan_client.connection',side_effect=AssertionError('must not access network')):
            self.assertEqual(lan_client.handle({**base,'method':'tools/call','params':{'name':'delete'}},descriptor)['error']['code'],-32602)

if __name__ == '__main__': unittest.main()
