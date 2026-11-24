# FEMS on Firebase (Nexora)

Live at **https://fems-nexora.web.app** · Firebase project `fems-nexora` (owner account nexorasystems725@gmail.com).

Owners (full access, Administrator page): `rogadogerick@gmail.com`, `nexorasystems725@gmail.com` — set in `public/fems-config.js` **and** `firestore.rules`.

## How it works
- `source/fems-claude.html` is the FEMS Company Edition page from Claude, unchanged.
- `build.py` adds `public/fems-firebase.js`, which gives the page the same database, sign-in and download functions it had inside Claude, backed by Firebase Auth and Cloud Firestore. Output: `public/index.html`.
- Every push to the `fems` branch builds and deploys (GitHub Actions, keyless sign-in to Google Cloud, no secrets).

## Access
1. People open the web address and sign in with Google or email.
2. An owner clicks **Access** (bottom-left) and sets each person to *Can view* or *Can view and save*, plus which company codes they may open (`*` = all).
3. Inside a company, people still sign in with their FEMS username and password as before.

## Moving records from the Claude version
In the Claude version open **Administrator page › Export all data**. In this site click **Access › Choose export file…** and pick the file.

## Updating FEMS
Save the new Claude `index.html` over `source/fems-claude.html`, commit and push to the `fems` branch.
