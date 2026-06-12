# iMessage chats show phone numbers instead of names

If some (or all) of your iMessage conversations show a phone number or email
address instead of the person's name, this page explains why and how to fix it.

## Why it happens

Relationship Inbox OS reads your messages from the Messages app's local
database. That database only stores the **handle** a message came from (the raw
phone number or email), never the contact's name. To turn `+44 7538...` into
"Marianne", the app looks the handle up in **your Mac's Contacts app**.

So names only appear for people who are saved in **Contacts on this Mac**.

There are two common reasons you'd see numbers:

1. **This Mac's Contacts app is empty.** Your contacts live on your iPhone but
   were never synced to the Mac. This is the most common cause. You can confirm
   it in seconds: open the **Messages** app on your Mac (not Relationship Inbox
   OS). If Messages *also* shows numbers instead of names, the Mac itself has no
   contacts, and the fix is below. The app can't show a name that isn't on the
   Mac.
2. **A specific person isn't saved** in Contacts at all (on any device). Save
   them once and their name appears everywhere.

The app shows a small dismissible hint at the top of the Inbox and Platforms
pages when it detects case 1.

## The fix: get your contacts onto this Mac (recommended, via iCloud)

This syncs your iPhone contacts to the Mac automatically, and keeps them in
sync going forward.

1. On the **iPhone**: open **Settings, [your name], iCloud, Contacts** and make
   sure it's **on**.
2. On the **Mac**: open the Apple menu, then **System Settings, [your name],
   iCloud**, and turn on **Contacts**.
   - On older macOS the path is **System Settings, Internet Accounts, iCloud,
     Contacts**.
3. Open the **Contacts** app on the Mac and wait a minute for your contacts to
   appear.
4. Back in Relationship Inbox OS, run a scan (or just wait, it refreshes
   automatically within a few minutes). The numbers are replaced with names,
   including for chats you'd already imported.

You do **not** need to export anything. Once the contacts are on the Mac, the
app picks them up on its own.

## Alternative: import a vCard (no iCloud)

If you'd rather not use iCloud Contacts:

1. On the iPhone, share the contacts you want as a **.vcf** file. For example,
   open a contact, tap **Share Contact**, and Mail or AirDrop it to yourself,
   or export from [iCloud.com Contacts](https://www.icloud.com/contacts) via the
   gear menu, **Export vCard**.
2. On the Mac, open the **Contacts** app and drag the `.vcf` file into it (or
   use **File, Import**).
3. Run a scan in Relationship Inbox OS, and names replace the numbers.

### Power-user override

If you keep a curated export, you can drop a vCard 3.0 file at
`~/RelationshipInboxOS/data/contacts.vcf`. Names in that file **override** the
Mac Contacts entry for the same handle. This is optional. The live Contacts app
is read automatically without it.

## Repairing chats that already show numbers

You don't need to re-import anything. The app runs a name sync at startup and
once a day that rewrites already-imported chats from a number to the contact
name as soon as the contact exists on the Mac. To force it immediately, restart
the app (or run a scan) after your contacts have synced.

A manual one-shot is also available from the app folder:

```bash
cd ~/RelationshipInboxOS
npm run imessage:backfill-names --workspace @inbox-os/runner            # preview (dry run)
npm run imessage:backfill-names --workspace @inbox-os/runner -- --apply # apply
```

## Still seeing numbers?

- Make sure the contacts actually show in the Mac's **Contacts** app.
- Make sure the saved number matches the one the message came from. The app
  matches on the last 10 digits, so country-code formatting differences are
  fine.
- Confirm Relationship Inbox OS has Full Disk Access. Messages already works, so
  this is usually fine, because Contacts is read with the same permission.
