---
name: check-web-app
description: Check that a web app you built actually works, by starting it and using it in ArcFlare's headless browser
---
# Checking a web app in the browser

A build that exits 0 says nothing about whether the page works. Start it and use it.

Needs ArcFlare's machine tools (`start`, `logs`, `stop`) and browser (`browser_open`, `browser_click`, `browser_type`, `browser_screenshot`).

## Steps
1. **Find the run command** with the `project` tool, or the manifest's scripts. Use the project's own command.
2. **Start it** with `start`, and read `logs` until it says which address it is listening on. Use that port, not the one you expected.
3. **Open it**: `browser_open` with the local address. You get the page's text and a numbered list of what can be clicked or typed into.
4. **Check what should be there**: the heading, the data, the form. If the page is blank or shows an error, read `logs` for the server side and say what you see.
5. **Use it** the way a person would, one action at a time: `browser_click` a link or button by number, `browser_type` into a field, submit. After each, read what came back. Numbers belong to the page you were last shown.
6. **Take a screenshot** with `browser_screenshot` when layout matters, and look at it.
7. **Try one thing that should fail**: empty input, a wrong value. Does the app say something sensible?
8. **Stop the server** with `stop`. Leave nothing running.

## Report
What you started and where it listened, each thing you did and what happened, what works, what does not (with the text or error you saw), and anything you could not check. "It works" means you saw it work.
