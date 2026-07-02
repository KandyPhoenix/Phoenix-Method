import subprocess
import time
import json
import base64
import urllib.request
import websocket
import os

HTML_PATH = r"C:\Users\kandy\PHOENIX METHOD\audits\lori-blog-topics-2026-05.html"
PDF_PATH  = r"C:\Users\kandy\PHOENIX METHOD\audits\lori-blog-topics-2026-05.pdf"
FILE_URL  = "file:///C:/Users/kandy/PHOENIX%20METHOD/audits/lori-blog-topics-2026-05.html"
CHROME    = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT      = 9222

# Kill any Chrome already using the debug port
subprocess.run(["taskkill", "/F", "/IM", "chrome.exe"], capture_output=True)
time.sleep(2)

proc = subprocess.Popen([
    CHROME,
    f"--remote-debugging-port={PORT}",
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
    "--remote-allow-origins=*",
    FILE_URL,
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

print("Chrome started, waiting for page to load...")
time.sleep(5)

# Get WebSocket debugger URL
try:
    req = urllib.request.urlopen(f"http://localhost:{PORT}/json/list", timeout=10)
    targets = json.loads(req.read())
except Exception as e:
    print(f"Could not connect to Chrome DevTools: {e}")
    proc.terminate()
    exit(1)

page_target = next((t for t in targets if t.get("type") == "page"), None)
if not page_target:
    print("No page target found")
    proc.terminate()
    exit(1)

ws_url = page_target["webSocketDebuggerUrl"]
print(f"Connecting to: {ws_url}")

ws = websocket.create_connection(ws_url, timeout=30)

def send_cmd(ws, method, params=None, cmd_id=1):
    msg = {"id": cmd_id, "method": method, "params": params or {}}
    ws.send(json.dumps(msg))
    while True:
        resp = json.loads(ws.recv())
        if resp.get("id") == cmd_id:
            return resp

# Wait for load
print("Waiting for page to fully render...")
time.sleep(3)

# Print to PDF
print("Generating PDF...")
result = send_cmd(ws, "Page.printToPDF", {
    "printBackground": True,
    "displayHeaderFooter": True,
    "headerTemplate": "<div></div>",
    "footerTemplate": (
        '<div style="font-family:Arial,sans-serif;font-size:9px;'
        'text-align:center;width:100%;color:#aaa;padding-bottom:4px;">'
        '<span class="pageNumber"></span>'
        '</div>'
    ),
    "marginTop": 0.5,
    "marginBottom": 0.6,
    "marginLeft": 0.4,
    "marginRight": 0.4,
    "paperWidth": 8.5,
    "paperHeight": 11,
    "scale": 0.9,
}, cmd_id=2)

ws.close()
proc.terminate()

if "error" in result:
    print(f"PDF generation error: {result['error']}")
    exit(1)

pdf_data = base64.b64decode(result["result"]["data"])
with open(PDF_PATH, "wb") as f:
    f.write(pdf_data)

size_kb = os.path.getsize(PDF_PATH) / 1024
print(f"PDF saved: {PDF_PATH}")
print(f"Size: {size_kb:.0f} KB")
