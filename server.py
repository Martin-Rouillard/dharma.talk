#!/usr/bin/env python3
"""
Local development server with proxy for Dharmaseed
Serves static files and proxies /feeds/* and /api/* requests to dharmaseed.org
"""

import http.server
import socketserver
import urllib.request
import urllib.parse
import json
import os
from pathlib import Path

PORT = 8080
DHARMASEED_BASE = "https://www.dharmaseed.org"

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # Serve from current directory
        super().__init__(*args, directory=str(Path(__file__).parent), **kwargs)
    
    def do_GET(self):
        # Proxy RSS feed requests
        if self.path.startswith('/feeds/'):
            self.proxy_request(DHARMASEED_BASE + self.path)
        # Proxy API requests
        elif self.path.startswith('/api/'):
            api_path = self.path[5:]  # Remove '/api/' prefix
            self.proxy_request(DHARMASEED_BASE + '/api/1/' + api_path)
        else:
            # Serve static files
            super().do_GET()
    
    def do_POST(self):
        # Proxy API requests
        if self.path.startswith('/api/'):
            api_path = self.path[5:]  # Remove '/api/' prefix
            self.proxy_request(DHARMASEED_BASE + '/api/1/' + api_path)
        else:
            self.send_error(404, "Not Found")
    
    def proxy_request(self, target_url):
        try:
            # Read POST body if present
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length) if content_length > 0 else None
            
            # Create request
            req = urllib.request.Request(target_url, data=body)
            
            # Copy relevant headers
            if body:
                content_type = self.headers.get('Content-Type', 'application/x-www-form-urlencoded')
                req.add_header('Content-Type', content_type)
            
            # Make request to Dharmaseed
            with urllib.request.urlopen(req, timeout=30) as response:
                data = response.read()
                content_type = response.headers.get('Content-Type', 'application/octet-stream')
                
                # Send response
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', len(data))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(data)
                
        except urllib.error.HTTPError as e:
            self.send_error(e.code, str(e.reason))
        except Exception as e:
            print(f"Proxy error: {e}")
            self.send_error(500, str(e))
    
    def do_OPTIONS(self):
        # Handle CORS preflight
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
    
    def log_message(self, format, *args):
        # Cleaner logging
        path = str(args[0])
        if '/feeds/' in path:
            print(f"[RSS] {path}")
        elif '/api/' in path:
            print(f"[API] {path}")
        elif not any(x in path for x in ['.js', '.css', '.json', '.svg', '.png', '.ico']):
            print(f"[Static] {path}")

def main():
    os.chdir(Path(__file__).parent)
    
    with socketserver.TCPServer(("", PORT), ProxyHandler) as httpd:
        print(f"\n🧘 Dharmaseed Player Server")
        print(f"   http://localhost:{PORT}")
        print(f"\n   Static files: ./")
        print(f"   RSS proxy:    /feeds/* → dharmaseed.org/feeds/*")
        print(f"   API proxy:    /api/* → dharmaseed.org/api/1/*")
        print(f"\n   Press Ctrl+C to stop\n")
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down...")

if __name__ == "__main__":
    main()
