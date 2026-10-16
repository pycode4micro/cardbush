"""Run against web-progressive-browser.mjs serving a production browser build.

Uses only synthetic accounts and images; no production credentials or model calls.
The fixture copies the gateway CSP so blob-fetch regressions cannot pass unnoticed.
"""
import argparse
import hashlib
import json
import pathlib
import zipfile

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--base', default='http://127.0.0.1:5212')
parser.add_argument('--output', default='tmp/web-download-browser')
parser.add_argument('--large', action='store_true')
args = parser.parse_args()
output = pathlib.Path(args.output)
output.mkdir(parents=True, exist_ok=True)
evidence = {}

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    try:
        for scenario in (['large'] if args.large else ['cached', 'retry']):
            context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
            page = context.new_page()
            errors, reads = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: reads.append(request.url) if '/files/view?' in request.url else None)
            page.add_init_script("window.downloadPolicyViolations=[];document.addEventListener('securitypolicyviolation',event=>{if(event.effectiveDirective==='connect-src')window.downloadPolicyViolations.push({blocked:event.blockedURI,directive:event.effectiveDirective});});")

            def control(**data):
                return context.request.post(args.base + '/__test/control', data=data).json()

            def login(name):
                page.get_by_role('textbox', name='用户名', exact=True).fill(name)
                page.get_by_label('密码', exact=True).fill('fixture-password')
                page.locator('.auth-submit').click()

            def open_menu():
                page.get_by_role('button', name='本轮产物 (2)', exact=True).last.click()
                button = page.get_by_role('menuitem', name='下载全部', exact=True)
                expect(button).to_be_enabled()
                expect(page.locator('.turn-artifacts-download-file')).to_have_count(32 if args.large else 3)
                return button

            def download_zip(button, label):
                with page.expect_download() as download:
                    button.click()
                target = output / (label + '.zip')
                download.value.save_as(target)
                with zipfile.ZipFile(target) as archive:
                    names = archive.namelist()
                    assert len(names) == len(set(names)) == (32 if args.large else 3), names
                    assert archive.testzip() is None
                    expected_hashes = sorted(hashlib.sha256(bytes([i]) * (5 * 1024 * 1024)).hexdigest() for i in range(32)) if args.large else [expected_hash] * 3
                    assert sorted(hashlib.sha256(archive.read(name)).hexdigest() for name in names) == expected_hashes
                if args.large:
                    assert target.stat().st_size > 128 * 1024 * 1024
                expect(button).to_be_enabled()
                return names

            initial = control(delay=0, failImage=scenario == 'retry')
            expected_hash = initial['pictureHash']
            response = page.goto(args.base)
            policy = response.headers['content-security-policy']
            assert "connect-src 'self';" in policy and "img-src 'self' data: blob:;" in policy
            login('alice')
            expect(page.locator('.conversation-title')).to_have_count(30)
            page.get_by_role('button', name='测试会话 000', exact=True).click()
            button = open_menu()
            if scenario == 'retry':
                button.click()
                expect(page.get_by_role('alert').filter(has_text='产物暂时无法读取')).to_be_visible()
                expect(button).to_be_enabled()
                control(failImage=False)
            names = download_zip(button, scenario)
            expect(page.get_by_role('alert')).to_have_count(0)
            page.screenshot(path=str(output / (scenario + '.png')))

            if scenario == 'cached':
                original_reads = list(reads)
                download_zip(button, 'repeat')
                assert reads == original_reads, 'ZIP downloads must not fetch individual images in the browser'
                with page.expect_download() as single:
                    page.locator('.turn-artifacts-download').first.click()
                single.value.save_as(output / 'single.png')
                assert hashlib.sha256((output / 'single.png').read_bytes()).hexdigest() == expected_hash
                assert reads == original_reads
                # Reopening the page destroys object URLs, while IndexedDB preserves original bytes.
                # Preview/single downloads still use the local cache; batch ZIPs use the server stream.
                control(failImage=True)
                page.reload()
                expect(page.get_by_text('已生成本轮图片，可从产物下载。', exact=True)).to_be_visible()
                open_menu()
                with page.expect_download() as cached_single:
                    page.locator('.turn-artifacts-download').first.click()
                cached_single.value.save_as(output / 'disk-cache.png')
                assert hashlib.sha256((output / 'disk-cache.png').read_bytes()).hexdigest() == expected_hash
                control(failImage=False)
                evidence['individual_and_disk_cache'] = 'passed'
            assert not errors, errors
            violations = page.evaluate('window.downloadPolicyViolations')
            assert not violations, violations
            page.keyboard.press('Escape')
            page.get_by_role('button', name='退出登录', exact=True).click()
            login('bob')
            expect(page.locator('.conversation-title')).to_have_count(0)
            expect(page.locator('.turn-artifacts-trigger')).to_have_count(0)
            evidence[scenario] = {'files': names, 'connect_policy_violations': violations, 'browser_errors': errors, 'server_stream': control()['archiveReads']}
            context.close()
        (output / 'browser-evidence.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf8')
        print(json.dumps({'passed': True, **evidence}, ensure_ascii=False))
    finally:
        browser.close()
