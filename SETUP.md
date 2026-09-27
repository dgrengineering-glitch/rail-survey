# Rail Survey – Google Sheet sync setup

Sync is **optional**. Without it, every record stays on your phone (and in your exports and backups).
With it, each location is copied to **your own** Google Sheet, and photos go to **your own** Google Drive.
Nothing goes through any third-party server: the phone talks straight to a small Google Apps Script that you own.

Allow about 10 minutes. It's easiest on a computer.

## 1. Create the Sheet and paste in the script

1. Signed in to your Google account, open **https://sheets.new** and name the spreadsheet, e.g. *Rail Survey*.
2. In the Sheet choose **Extensions › Apps Script**.
3. Delete the sample `function myFunction() {}` and paste in the whole of
   [`apps-script/Code.gs`](apps-script/Code.gs) from this repository.
4. Click **💾 Save** and name the project, e.g. *Rail Survey sync*.

## 2. Run setup once

1. In the Apps Script toolbar, pick the function **`setup`** from the drop-down and click **Run**.
2. Google asks for permission. Click **Review permissions**, choose your account, then **Advanced › Go to Rail Survey sync (unsafe)** › **Allow**.
   (The “unsafe” wording is Google's standard warning for scripts you've written yourself. The script only touches this spreadsheet and a Drive folder it creates.)
3. This creates a **Locations** sheet with the column headings, and a Drive folder called **Rail Survey Photos**.

## 3. Choose your secret token

Pick a long secret phrase of **at least 12 characters** (16+ is better), e.g. four random words and a number. Then either:

- **Reload the Sheet tab.** A **Rail Survey** menu appears. Choose **Rail Survey › Set sync token…** and enter it. *(Recommended: the token isn't stored in the code.)*
- **Or** type it into the line `var SYNC_TOKEN = '';` near the top of Code.gs and save.

The script refuses every request that doesn't carry this token.

## 4. Deploy as a web app

1. In Apps Script click **Deploy › New deployment**.
2. Click the ⚙︎ cog next to *Select type* and choose **Web app**.
3. Set **Execute as: Me** and **Who has access: Anyone**.
   *“Anyone” is needed because the phone app can't sign in to Google. The URL is long and unguessable, and the token protects it.*
4. Click **Deploy**, then copy the **Web app URL**. It looks like `https://script.google.com/macros/s/AKfy…/exec`.

## 5. Connect the app

1. In Rail Survey open **Settings › Google Sheet sync**.
2. Tick **Sync to my Google Sheet**.
3. Paste the **Web app URL** and type your **token**.
4. Tap **Test connection**. You should see *✓ Connected to “Rail Survey” (0 rows so far)*.
5. Tap **Sync now**.

From then on, records sync automatically whenever there's signal: when the app opens, when signal returns, after each save, edit or delete, and every minute while anything is waiting.
Unsynced records show an orange **Not synced** badge, and the header shows how many changes are waiting (⟳ 3). If a sync fails, the app keeps the changes and retries with a back-off (15 s up to 10 min). The last problem is shown under Settings.

## What goes into the Sheet

One row per location, matched by the record's unique id, so edits update the same row and deletes remove it:

`id, location name, notes, lat, long, accuracy, distance from running edge mm, other measurements, ELR, track ID, miles, chains, yards, timestamp, photo link, surveyor, mileage, google maps link, location source, updated at, synced at`

- **Photos** are saved in the *Rail Survey Photos* Drive folder and shared as *anyone with the link can view*, so the link in the **photo link** column works. If your Google Workspace domain blocks link sharing, the links work only for you.
- Photos are **not** deleted from Drive when you delete a location. That's deliberate, to be safe.

## Changing the script later

If you edit Code.gs, choose **Deploy › Manage deployments › ✎ Edit › Version: New version › Deploy**.
This keeps the same URL. (A *New deployment* gives you a new URL, which you would then need to paste into the app again.)

## Troubleshooting

| Message in the app | Fix |
|---|---|
| *Wrong token* | The token in the app must exactly match the one set in the Sheet (it's case-sensitive). |
| *No sync token has been set* | Do step 3. |
| *Google returned a web page instead of data* | The deployment's access isn't **Anyone**, or you copied the editor URL instead of the `/exec` web app URL. |
| *Couldn't reach Google* | No signal, or a typo in the URL. The changes stay queued and retry automatically. |
