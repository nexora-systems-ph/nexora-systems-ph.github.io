#!/usr/bin/env python3
"""Builds public/index.html from the Claude version of FEMS (source/fems-claude.html).
To pick up a newer Claude version: save its index.html over source/fems-claude.html and run  python3 build.py"""
import pathlib
ROOT = pathlib.Path(__file__).parent
src = (ROOT / 'source' / 'fems-claude.html').read_text(encoding='utf-8')
V = '10.14.1'
inject = f'''<head>
<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#0f3b37">
<link rel="icon" href="/icons/icon-192.png"><link rel="apple-touch-icon" href="/icons/icon-192.png">
<link rel="stylesheet" href="/fems-firebase.css">
<script src="https://www.gstatic.com/firebasejs/{V}/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/{V}/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/{V}/firebase-firestore-compat.js"></script>
<script src="/fems-config.js"></script>
<script src="/fems-firebase.js"></script>
<script>if('serviceWorker' in navigator&&location.hostname!=='localhost')addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{{}}));</script>
'''
i = src.find('<head>')
assert i >= 0, 'no <head> in source'
out = src[:i] + inject + src[i + len('<head>'):]
(ROOT / 'public' / 'index.html').write_text(out, encoding='utf-8')
print('public/index.html written,', len(out), 'bytes')
