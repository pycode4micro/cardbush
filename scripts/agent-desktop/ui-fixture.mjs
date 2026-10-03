// Explicit live-UI test fixture, inside the disposable desktop container only.
import { createServer } from 'node:http';
let input = '';
createServer(async (request, response) => {
  if (request.url === '/status') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input }));
  } else if (request.method === 'POST' && request.url === '/input') {
    const chunks = []; let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 16000) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    input = Buffer.concat(chunks).toString('utf8'); response.end('ok');
  } else {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><body style="background:#edf2f8;color:#26344b;font:24px sans-serif">
    <h1 style="text-align:center;margin-top:80px">Linux Personal Agent</h1><p style="text-align:center">Real desktop verification · isolated test page</p>
    <input autofocus aria-label="Live desktop test" style="position:fixed;left:calc(50% - 260px);top:calc(50% - 120px);width:520px;height:240px;box-sizing:border-box;font:28px sans-serif;padding:24px;border:2px solid #557ab5;border-radius:16px">
    <script>const field=document.querySelector('input');field.value=localStorage.getItem('cardbush-ui-test')||'';field.oninput=()=>{localStorage.setItem('cardbush-ui-test',field.value);fetch('/input',{method:'POST',body:field.value});};</script></body></html>`);
  }
}).listen(7890, '127.0.0.1', () => console.log('Isolated UI fixture listening on loopback port 7890.'));
