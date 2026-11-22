const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const scope = {};
for (const name of ['escapeHtml', 'renderChatMarkdown']) {
  vm.runInNewContext(html.match(new RegExp(`function ${name}\\([^]*?\\n    \\}`))[0], scope);
}
const render = scope.renderChatMarkdown;
assert.equal(render(null), '');
assert.equal(render(undefined), '');
assert.equal(render('  \n\t\n'), '');
assert.equal(render('First line\r\nSecond line\r\n\r\nNext paragraph'), '<p>First line<br>Second line</p><p>Next paragraph</p>');
assert.equal(render('# One\n## Two\n### Three'), '<h1>One</h1><h2>Two</h2><h3>Three</h3>');
assert.equal(render('**bold** and *italic* and `**literal** <img>`'), '<p><strong>bold</strong> and <em>italic</em> and <code>**literal** &lt;img&gt;</code></p>');
assert.equal(render('**bold with *italic***'), '<p><strong>bold with <em>italic</em></strong></p>');
assert.equal(render('- Parent\n  * Child **bold**\n    1. Grandchild\n    2. Another\n  * Child two\n- Parent two'), '<ul><li>Parent<ul><li>Child <strong>bold</strong><ol><li>Grandchild</li><li>Another</li></ol></li><li>Child two</li></ul></li><li>Parent two</li></ul>');
assert.equal(render('1. One\n2. Two\n\nParagraph\n* Star\n- Dash'), '<ol><li>One</li><li>Two</li></ol><p>Paragraph</p><ul><li>Star</li><li>Dash</li></ul>');
assert.equal(render('- One\n  continuation\n\n  - Child\n\n- Two'), '<ul><li>One<br>continuation<ul><li>Child</li></ul></li><li>Two</li></ul>');
assert.equal(render('3. Third\n4. Fourth'), '<ol start="3"><li>Third</li><li>Fourth</li></ol>');
const sample = '**Chủ đề hôm nay:** Cập nhật ...\n\n- **Phân nhóm PE cấp AHA/ACC 2026 + hợp nhất PAD‑ĐMC (ESC 2024):**\n  - AHA/ACC 2026 đưa ra 4 mức độ ...\n  - ESC 2024 hợp nhất ...\n- **Sotatercept (STELLAR) – trụ cột thứ tư cho PAH:**\n  - Trial STELLAR ...\n\nNhững cập nhật này giúp ...';
const sampleHtml = render(sample);
assert.match(sampleHtml, /^<p><strong>Chủ đề hôm nay:<\/strong>/);
assert.equal((sampleHtml.match(/<ul>/g) || []).length, 3);
assert.equal((sampleHtml.match(/<li>/g) || []).length, 5);
assert.ok(sampleHtml.endsWith('<p>Những cập nhật này giúp ...</p>'));
// No upstream newline loss was found: do not reinterpret prose hyphens as lists.
const flat = sample.replace(/\s*\n\s*/g, ' ');
assert.ok(!render(flat).includes('<ul>'));
assert.match(render('Risk - benefit: 5 - 2'), /Risk - benefit: 5 - 2/);
const table = render('| Name | Result |\n| --- | --- |\n| Trial | **Benefit** |');
assert.equal(table, '<div class="chat-table-scroll"><table><thead><tr><th style="text-align:left">Name</th><th style="text-align:left">Result</th></tr></thead><tbody><tr><td style="text-align:left">Trial</td><td style="text-align:left"><strong>Benefit</strong></td></tr></tbody></table></div>');
assert.equal(render('Name | Result\n--- | ---\nTrial | **Benefit**'), table);
const aligned = render('A | B | C | D\n:-- | --: | :-: | ---\na | b | c | d');
assert.equal((aligned.match(/text-align:left/g) || []).length, 4);
assert.equal((aligned.match(/text-align:right/g) || []).length, 2);
assert.equal((aligned.match(/text-align:center/g) || []).length, 2);
assert.match(render('| A\\|B | C |\n| --- | --- |\n| `x\\|y` | *yes* |'), /<th style="text-align:left">A\|B<\/th>/);
assert.match(render('| A | B |\n| --- | --- |\n| `x\\|y` | *yes* |'), /<code>x\|y<\/code><\/td><td style="text-align:left"><em>yes<\/em>/);
const ragged = render('A | B\n--- | ---\none |\na | b | extra');
assert.match(ragged, /<td style="text-align:left">one<\/td><td style="text-align:left"><\/td>/);
assert.ok(!ragged.includes('extra'));
assert.equal(render('Before\nName | Result\n--- | ---\nTrial | **Benefit**\n\nAfter'), '<p>Before</p>' + table + '<p>After</p>');
assert.equal(render('- List\nName | Result\n--- | ---\nTrial | **Benefit**'), '<ul><li>List</li></ul>' + table);
assert.match(render('| Only |\n---'), /<thead><tr><th style="text-align:left">Only<\/th><\/tr><\/thead><tbody><\/tbody>/);
for (const text of ['a | b', 'a | b\n-- | ---', 'a | b\n--- | invalid', 'a | b\n---', 'a\\|b\n---']) {
  assert.ok(!render(text).includes('<table>'), text);
}
const clinical = render('| Thuốc | Bằng chứng | Khuyến cáo |\n| :-- | :-: | --: |\n| **Sotatercept** | STELLAR | *PAH* |\n| Điều trị nền | `HR 0.84` | Theo dõi |');
assert.match(clinical, /<strong>Sotatercept<\/strong>/);
assert.match(clinical, /<em>PAH<\/em>/);
assert.match(clinical, /<code>HR 0.84<\/code>/);
assert.match(clinical, /Theo dõi<\/td>/);
for (const payload of ['<script>alert(1)</script>', '<img src=x onerror="alert(1)">', '[click](javascript:alert(1))', '![image](javascript:alert(1))', '&lt;script&gt;', '<a href="javascript:alert(1)">x</a>']) {
  for (const input of [payload, `**${payload}**`, `- ${payload}\n  - *${payload}*`, `# ${payload}`, '`' + payload + '`', `| ${payload} | Safe |\n| --- | --: |\n| ${payload} | **safe** |`]) {
    const output = render(input);
    assert.ok(!/<(?:script|img|a)\b/i.test(output), output);
    const tags = output.match(/<[^>]*>/g) || [];
    assert.ok(tags.every(tag => /^<\/?(?:p|br|ul|ol|li|strong|em|code|h[123]|table|thead|tbody|tr|th|td|div)>$/.test(tag) ||
      /^<(?:th|td) style="text-align:(?:left|right|center)">$/.test(tag) || tag === '<div class="chat-table-scroll">'), output);
    assert.ok(output.includes(scope.escapeHtml(payload)), output);
  }
}

const object = html.slice(html.indexOf('    const EbmChat = {') + '    const EbmChat = '.length, html.indexOf('    window.EbmChat = EbmChat;')).trim().replace(/;$/, '');
const container = {children: [], appendChild(child) { this.children.push(child); }};
const stored = JSON.stringify([{id: 'saved', messages: [{role: 'assistant', markdownText: sample}]}]);
Object.assign(scope, {
  document: {createElement() { return {children: [], appendChild(child) {this.children.push(child);}, addEventListener() {}}; }},
  Dom: {chatMessagesList: container}, App: {currentLang: 'vi'},
  CHAT_SESSIONS_KEY: 'sessions', safeStorageGet: () => stored
});
const chat = vm.runInNewContext(`(${object})`, scope);
chat.saveSessions = chat.renderHistoryDrawer = () => {};
chat.appendMessage('assistant', sample);
assert.equal(container.children[0].children[0].innerHTML, sampleHtml);
container.children = [];
chat.loadSessions();
assert.equal(chat.currentSessionId, 'saved');
assert.equal(container.children[0].children[0].innerHTML, sampleHtml);
console.log('Chat Markdown checks passed (paragraphs, lists, formatting, pipe tables, alignment, escaped pipes, ragged rows, Vietnamese, XSS, live and restored history).');
