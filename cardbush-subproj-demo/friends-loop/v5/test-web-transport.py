from pathlib import Path
import unittest
namespace={}
source=(Path(__file__).parent/'web-transport.py').read_text().split('\ntry:\n req=')[0]
exec(compile(source,'web-transport-definitions','exec'),namespace)
class PageContract(unittest.TestCase):
 def test_article_link_has_matching_title_and_resolves_base(self):
  body=b'<html><head><base href="https://example.com/news/"><meta property="article:published_time" content="2026-11-04T09:00:00Z"></head><body><nav><a href="/navigation">A very long navigation section label here</a></nav><article><a href="story">A factual headline with a precise article link</a><p>Verified article text.</p></article></body></html>'
  result=namespace['parse']('https://example.com/',body,{})
  self.assertEqual(result['links'][0]['url'],'https://example.com/news/story')
  self.assertEqual(result['links'][0]['title'],'A factual headline with a precise article link')
  self.assertEqual(result['published_metadata'],['2026-11-04T09:00:00Z'])
 def test_feed_keeps_publisher_link_and_publication_date(self):
  raw=b'<rss><channel><item><title>A headline</title><link>https://example.com/a</link><pubDate>Wed, 04 Nov 2026 09:00:00 GMT</pubDate><description>A factual description.</description></item></channel></rss>'
  item=namespace['parse']('https://example.com/feed',raw,{})['items'][0]
  self.assertEqual(item['url'],'https://example.com/a')
  self.assertEqual(item['published'],'Wed, 04 Nov 2026 09:00:00 GMT')
 def test_private_targets_and_credentials_are_rejected(self):
  for url in ['http://127.0.0.1/','http://localhost/','https://user:password@example.com/','https://example.com:8443/']:
   with self.assertRaises(ValueError):namespace['safe_url'](url)
unittest.main()
