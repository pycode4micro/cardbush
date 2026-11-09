const assert = require('node:assert/strict');
const {writeFile} = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({run, until, window, root}) => {
  const labels = ['羊绒', '羊毛', '产业带', '服饰达人', '桑蚕丝春夏'];
  const url = 'https://www.douyin.com/user/MS4wLjABAAAAmMbFIOdzbtDfpfF_GDvwjUTU8Qve0tSsJ8Lj-MDG9aM?enter_from=general_search&extra_params=%7B%22search_keyword%22%3A%22%E6%BA%B6%E6%BA%B6%22%7D&from_tab_name=main';
  const widths = [98, 96, 16, 614, 16];
  const row = cells => '| ' + cells.map((cell, i) => cell.padEnd(widths[i])).join(' | ') + ' |';
  const data = [
    ['[瓦莎路亚旗舰店](https://www.douyin.com/user/fixture)','阿姿莲羊绒-悦悦','「姐弟」高奢羊绒','贵姐Nicole','川禾织衣CILHOUETTE'],
    ['润帛羊绒女装上新号','阿姿莲羊绒-鲤鱼','喜宝羊绒【高定女装】','日禾芮依（私服号','<br>琳姐真丝羊绒奢品女装'],
    ['<br>鹿王羊绒KING DEER','阿姿莲羊绒-居妮','梦梦-梦汝金','yy的小喜欢','刘纯<br>'],
    ['兔皇官方旗舰店','北方鹿·好料服饰<br><br>','「泉依池」10.2 国庆专场','chic白',''],
    ['东黎','春竹官方旗舰店','小璐羊绒（部分现货，很紧俏）','<br>阿楠anan（枫竺品牌主理人）',''],
    ['杰娜洋','三彩','梦梦THE MENG','我是摩羯♑️周三周六下午2点上新',''],
    ['润帛羊绒女装','百家好','大静羊绒-超奢原创','<br>之柔官方旗舰店',''],
    ['DEEP BREATH官方旗舰店','哥弟','百牧羊「高奢线纯山羊绒」','H姐曼辰（Manchenh）',''],
    ['帕罗PALUOPO官方旗舰店','阿玛施','','W.Diva官方旗舰店',''],
    ['善绒羊绒旗舰店','欧莎','','美洋',''], ['','','','笑涵阁官方旗舰店',''],
    ['','','','[溶溶RONGRONG](' + url.replaceAll('&', '\\&') + ')',''], ['','','','浪清',''],
  ];
  const source = [row(labels.map(label => '**' + label + '**')),
    row(widths.map(width => ':' + '-'.repeat(width - 2) + ':')),
    ...data.map(row)].join('\n');
  assert.ok(source.length > 8000);
  await run('pasteRemote=false;pasteLanguage="zh";pasteSession="table";pasteDrafts.table="";pasteMount()');
  await until('document.querySelector("textarea[data-composer-input]")?.value === ""', 'table draft');
  const paste = async (formats, bitmap = false) => run('(' + ((formats, bitmap) => {
    const input = document.querySelector('[data-composer-input]');
    input.focus();
    const data = new DataTransfer();
    for (const [type, value] of Object.entries(formats)) data.setData(type, value);
    if (bitmap) data.items.add(new File(['bitmap'], 'image.png', {type:'image/png'}));
    const event = new ClipboardEvent('paste', {clipboardData:data, bubbles:true, cancelable:true});
    input.dispatchEvent(event); return event.defaultPrevented;
  }).toString() + ')(' + JSON.stringify(formats) + ',' + bitmap + ')');
  const clear = async () => {
    await run('pasteDrafts.table="";pasteMount()');
    await until('document.querySelector("textarea[data-composer-input]")?.value === ""', 'empty table draft');
  };
  assert.equal(await paste({'text/plain':source}), true);
  await until('document.querySelectorAll(".composer-markdown-preview tbody tr").length===13', 'padded Markdown previews inline');
  assert.deepEqual(await run('Array.from(document.querySelectorAll(".composer-markdown-preview th strong"),n=>n.textContent)'), labels);
  assert.ok(await run('[...document.querySelectorAll(".composer-markdown-preview tbody tr")].every(row=>row.cells.length===5)'));
  assert.equal(await run('getComputedStyle(document.querySelector(".composer-markdown-preview td")).textAlign'),'center');
  assert.equal(await run('document.querySelector(".composer-markdown-preview tbody tr:nth-child(4) td:nth-child(2)").querySelectorAll("br").length'), 2);
  assert.equal(await run('document.querySelector(".composer-markdown-preview tbody tr:nth-child(12) a").href'), url);
  assert.ok(await run('pasteDrafts.table.length < 8000 && !document.querySelector("[data-pasted-text]")'));
  const normalized = await run('pasteDrafts.table');
  const rect = await run('document.querySelector(".composer-surface").getBoundingClientRect().toJSON()');
  await writeFile(path.join(root, 'tmp/composer-markdown-table.png'), (await window.webContents.capturePage({
    x:Math.ceil(rect.left), y:Math.ceil(rect.top), width:Math.floor(rect.width), height:Math.floor(rect.height),
  })).toPNG());
  const narrow = await window.webContents.insertCSS('.composer-stack {max-width:280px !important}');
  try {
    const bounds = await run(`(() => {
      const surface = document.querySelector('.composer-surface'), preview = surface.querySelector('.composer-markdown-preview');
      return {width:surface.clientWidth, scrollWidth:surface.scrollWidth, height:preview.clientHeight,
        scrollHeight:preview.scrollHeight, previewRight:preview.getBoundingClientRect().right, right:surface.getBoundingClientRect().right};
    })()`);
    assert.ok(bounds.scrollHeight > bounds.height && bounds.scrollWidth <= bounds.width+1 && bounds.previewRight <= bounds.right,
      'narrow previews scroll inside the input: '+JSON.stringify(bounds));
  } finally { await window.webContents.removeInsertedCSS(narrow); }
  await run('document.querySelector(".composer-table-tools button").click()');
  await until('!document.querySelector(".composer-markdown-preview") && document.activeElement === document.querySelector("textarea")', 'editing Markdown keeps native input focused');
  assert.equal(await run('document.querySelector("textarea").value'),normalized);
  await run('document.querySelector(".composer-table-tools button").click()');
  await until('!!document.querySelector(".composer-markdown-preview table")', 'return to preview');
  await run('pasteSend()');
  await until('pasteSent.at(-1) === '+JSON.stringify(normalized), 'sending uses Markdown source');
  await clear();
  const escaped = '<table><tr><th>名称</th><th>备注</th></tr><tr><td><a href="' + url.replaceAll('&','&amp;') + '"><b>溶溶</b></a></td><td>x|y<br>柞蚕丝<img src="https://fixture.invalid/must-not-load"><script>throw 1</script></td></tr></table>';
  assert.equal(await paste({'text/plain':'名称\t备注\n溶溶\tx|y 柞蚕丝','text/html':'<div><p>以下是名单</p>'+escaped+'<p>请核对来源</p></div>'},true),true);
  await until('!!document.querySelector(".composer-markdown-preview td a strong")','HTML clipboard preserves the link and formatting');
  assert.equal(await run('document.querySelector(".composer-markdown-preview td a").href'),url);
  assert.equal(await run('document.querySelector(".composer-markdown-preview td + td").textContent'),'x|y\n柞蚕丝');
  assert.equal(await run('document.querySelectorAll(".composer-markdown-preview tbody br").length'),1);
  assert.doesNotMatch(await run('pasteDrafts.table'), /script|fixture\.invalid/);
  assert.match(await run('pasteDrafts.table'), /^以下是名单\n\n\|[\s\S]+\n\n请核对来源$/);
  await clear();
  await paste({'text/plain':'名称\t品类\t备注\r\n"羊绒\r\n羊毛"\t\t"含""引号"""\r\n'});
  await until('document.querySelectorAll(".composer-markdown-preview td").length===3','TSV preserves quoted cells and blanks');
  assert.deepEqual(await run('Array.from(document.querySelectorAll(".composer-markdown-preview td"),n=>n.textContent)'),['羊绒\n羊毛','','含"引号"']);
  assert.equal(await run('document.querySelectorAll(".composer-markdown-preview td br").length'),1);
  await clear();
  await run('pasteDrafts.table="整理后交付";pasteMount()');
  await until('document.querySelector("textarea").value==="整理后交付"','surrounding draft');
  await run('document.querySelector("textarea").setSelectionRange(2,3)');
  await paste({'text/markdown':'| A | B |\n| --- | --- |\n| 一 | 二 |','text/plain':'A B 一 二'});
  await until('!!document.querySelector(".composer-markdown-preview table")','explicit Markdown replaces selection');
  assert.equal(await run('pasteDrafts.table'), '整理\n\n| A | B |\n| --- | --- |\n| 一 | 二 |\n\n交付');
  await run('document.execCommand("undo")');
  await until('pasteDrafts.table==="整理后交付"', 'table paste undoes in a single step');
  await run('pasteDrafts.table="~~~md\\n\\n~~~";pasteMount()');
  await until('document.querySelector("textarea").value.startsWith("~~~md")','literal Markdown example');
  await run('document.querySelector("textarea").setSelectionRange(6,6)');
  assert.equal(await paste({'text/plain':'| A | B |\n| --- | --- |\n| 1 | 2 |'}), false, 'pasting into fenced code keeps native literal insertion');
  const skill = '[fixture](<D:/skills/fixture/SKILL.md>)';
  await run('pasteDrafts.table='+JSON.stringify(skill+' remain')+';pasteMount()');
  await until('!!document.querySelector(".composer-prompt-editor .composer-skill-token")','rich input with reference');
  await run('(()=>{const n=document.querySelector(".composer-prompt-editor");n.focus();const r=document.createRange();r.selectNodeContents(n);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r)})()');
  await paste({'text/plain':'| A | B |\n| --- | --- |\n| 1 | 2 |'});
  await until('!!document.querySelector(".composer-markdown-preview table")','inline table in token editor');
  assert.ok((await run('pasteDrafts.table')).startsWith(skill+' remain\n\n'), 'rich table paste preserves the existing reference and text');
  await run('updateChat({language:"zh",loading:false,historyLoading:false,activeConversationId:"table-turn",draft:"",messages:[{id:"table-user",role:"user",content:'+JSON.stringify(normalized)+'}]})');
  await until('document.querySelectorAll(".user-message-body tbody tr").length===13', 'sent Markdown renders in the conversation');
  assert.equal(await run('document.querySelectorAll(".user-message-body tbody tr:nth-child(4) td:nth-child(2) br").length'),2);
  assert.equal(await run('document.querySelector(".user-message-body tbody tr:nth-child(12) a").getAttribute("href")'),url);
  console.log('Composer tables passed: five columns, 13 rows, alignment padding, HTML/TSV, URLs, line breaks, source editing, selection, undo and send.');
};
