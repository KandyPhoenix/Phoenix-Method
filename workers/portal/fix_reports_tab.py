"""Move Reports out of its own tab and into the Messages tab as a sub-section."""
import re

OLD_REPORTS_TAB = '            <button class="tab" data-tab="reports">Reports</button>\n'

OLD_REPORTS_THEN_MESSAGES = '''        <!-- REPORTS -->
        <div class="section" id="sec-reports">
            <div class="sec-header">
                <span class="sec-title">Reports &amp; Documents</span>
                <span class="sec-sub">Audits, monthly reports &amp; deliverable files</span>
            </div>
            <div class="reports-grid">${reportCards}</div>
        </div>

        <!-- MESSAGES -->
        <div class="section" id="sec-messages">
            <div class="sec-header">
                <span class="sec-title">Messages from Your Team</span>
            </div>
            ${messageCards || '<p style="color:#9A95A8;font-size:13px;padding:16px 0">No messages yet.</p>'}
            <a href="mailto:kandy@phoenixmethodseo.com?subject=Portal%20Message%20%E2%80%94%20${encodeURIComponent(d.client)}" class="reply-btn">Reply to Your Team</a>
        </div>'''

NEW_MESSAGES_WITH_REPORTS = '''        <!-- MESSAGES -->
        <div class="section" id="sec-messages">
            <div class="sec-header">
                <span class="sec-title">Messages from Your Team</span>
            </div>
            ${messageCards || '<p style="color:#9A95A8;font-size:13px;padding:16px 0">No messages yet.</p>'}
            <a href="mailto:kandy@phoenixmethodseo.com?subject=Portal%20Message%20%E2%80%94%20${encodeURIComponent(d.client)}" class="reply-btn">Reply to Your Team</a>

            <div class="sec-header" style="margin-top:32px">
                <span class="sec-title">Reports &amp; Documents</span>
                <span class="sec-sub">Audits, monthly reports &amp; deliverable files</span>
            </div>
            <div class="reports-grid">${reportCards}</div>
        </div>'''

for slug in ['lori', 'phw', 'pm', 'sunbright']:
    path = f'workers/portal/public/{slug}/index.html'
    with open(path, encoding='utf-8') as f:
        html = f.read()

    assert OLD_REPORTS_TAB in html, f'{slug}: reports tab button not found'
    assert OLD_REPORTS_THEN_MESSAGES in html, f'{slug}: messages+reports block not found'

    html = html.replace(OLD_REPORTS_TAB, '')
    html = html.replace(OLD_REPORTS_THEN_MESSAGES, NEW_MESSAGES_WITH_REPORTS)

    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)

    # verify
    assert 'data-tab="reports"' not in html, f'{slug}: reports tab still present'
    assert 'sec-reports' not in html, f'{slug}: standalone reports section still present'
    assert 'Reports &amp; Documents' in html, f'{slug}: reports content missing'
    assert html.count('id="sec-messages"') == 1, f'{slug}: messages section count wrong'
    print(f'{slug}: OK')

print('All 4 portals updated.')
