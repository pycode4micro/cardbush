import sys,json,subprocess,tempfile,pathlib,urllib.parse,socket,ipaddress,re,html,xml.etree.ElementTree as ET
from html.parser import HTMLParser
from datetime import datetime,timezone
class TextExtractor(HTMLParser):
 def __init__(self):super().__init__();self.parts=[];self.links=[];self.feeds=[];self.skip=0;self.title=[];self.in_title=False
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if tag in ['script','style','noscript','svg']:self.skip+=1
  if tag=='title':self.in_title=True
  if tag=='a' and a.get('href'):self.links.append({'url':a['href']})
  if tag=='link' and a.get('href') and ('rss' in a.get('type','') or 'atom' in a.get('type','')):self.feeds.append(a['href'])
 def handle_endtag(self,tag):
  if tag in ['script','style','noscript','svg']:self.skip=max(0,self.skip-1)
  if tag=='title':self.in_title=False
 def handle_data(self,d):
  if not self.skip and d.strip():
   self.parts.append(d.strip())
   if self.in_title:self.title.append(d.strip())
def plain(x):
 p=TextExtractor()
 try:p.feed(x)
 except Exception:return re.sub('<[^>]+>',' ',x)
 return ' '.join(p.parts)
def safe_url(url):
 u=urllib.parse.urlsplit(url)
 if u.scheme not in ['https','http'] or not u.hostname or u.username or u.password or u.port not in [None,80,443]:raise ValueError('PUBLIC_HTTP_URL_REQUIRED')
 port=u.port or (443 if u.scheme=='https' else 80)
 addresses=socket.getaddrinfo(u.hostname,port,type=socket.SOCK_STREAM)
 ips=list(dict.fromkeys(x[4][0] for x in addresses))
 if not ips or any(not ipaddress.ip_address(x).is_global for x in ips):raise ValueError('NON_PUBLIC_ADDRESS_REJECTED')
 ip=next((x for x in ips if ':' not in x),ips[0])
 return u,port,ip
def fetch(url):
 for redirect in range(4):
  u,port,ip=safe_url(url)
  with tempfile.TemporaryDirectory(prefix='friends-web-') as tmp:
   body=pathlib.Path(tmp)/'body';headers=pathlib.Path(tmp)/'headers'
   pinned='['+ip+']' if ':' in ip else ip
   args=['curl','--silent','--show-error','--noproxy','*','--connect-timeout','5','--max-time','15','--max-filesize','2500000','--compressed','--resolve',u.hostname+':'+str(port)+':'+pinned,'--user-agent','FriendsReadOnlyDemo/1.0','--dump-header',str(headers),'--output',str(body),'--write-out','%{http_code}',url]
   p=subprocess.run(args,capture_output=True,text=True,timeout=18)
   if p.returncode:raise RuntimeError('HTTP_FETCH_FAILED: '+p.stderr[-180:])
   status=int(p.stdout);raw=body.read_bytes()
   hs={}
   for l in headers.read_text(errors='replace').splitlines():
    if ':' in l:
     k,v=l.split(':',1);hs[k.lower()]=v.strip()
   if status in [301,302,303,307,308]:
    url=urllib.parse.urljoin(url,hs.get('location',''));continue
   if status<200 or status>=300:raise RuntimeError('HTTP_STATUS_'+str(status))
   return url,raw,hs
 raise RuntimeError('TOO_MANY_REDIRECTS')
def parse(url,raw,headers):
 text=raw.decode('utf-8','replace')
 items=[]
 try:
  root=ET.fromstring(text)
  nodes=root.findall('.//item') or root.findall('.//{http://www.w3.org/2005/Atom}entry')
  for node in nodes[:25]:
   fields={}
   for e in node:
    tag=e.tag.split('}')[-1]
    if tag in ['title','description','summary','content','encoded','pubDate','published','updated','guid','link']:
     value=e.attrib.get('href') if tag=='link' and e.attrib.get('href') else ''.join(e.itertext())
     fields[tag]=value or ''
   items.append({'title':plain(fields.get('title',''))[:500],'url':urllib.parse.urljoin(url,fields.get('link','')),'published':fields.get('pubDate') or fields.get('published') or fields.get('updated'),'summary':plain(fields.get('description') or fields.get('summary') or fields.get('encoded') or fields.get('content') or '')[:900]})
 except ET.ParseError:pass
 if items:
  return {'format':'feed','title':'Public feed','items':items,'links':[{'url':x['url'],'title':x['title']} for x in items],'text':'\n'.join(json.dumps(x,ensure_ascii=False) for x in items)}
 p=TextExtractor();p.feed(text)
 links=[];seen=set()
 for link in p.links:
  dest=urllib.parse.urljoin(url,link['url'])
  if dest.startswith(('https://','http://')) and dest not in seen:
   seen.add(dest);links.append({'url':dest})
 return {'format':'page','title':' '.join(p.title)[:400],'text':'\n'.join(p.parts)[:18000],'links':links[:80],'feed_links':[urllib.parse.urljoin(url,x) for x in p.feeds]}
try:
 req=json.loads(sys.stdin.read())
 url=req['url']
 final,raw,headers=fetch(url)
 result=parse(final,raw,headers)
 result.update({'status':'ok','requested_url':url,'url':final,'retrieved_at':datetime.now(timezone.utc).isoformat(),'content_type':headers.get('content-type',''),'bytes':len(raw)})
 print(json.dumps(result,ensure_ascii=False))
except Exception as e:
 print(json.dumps({'status':'unavailable','code':str(e)[:500]}))
