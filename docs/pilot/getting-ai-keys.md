# Get your AI keys

Relationship Inbox OS uses an AI model to write the **summaries**, the **"what
they want"** action items, and the **reply suggestions**. Without a key, those
features stay off and you just see the raw messages, so it is worth setting
this up before your first scan.

You use **your own** key. That keeps your usage separate from everyone else's,
and the key stays private on your Mac (it is never uploaded, and never included
in feedback or bug reports).

You need **one** key. The free Google Gemini one is the easiest. Getting both
(Gemini and OpenAI) gives you a backup if one is ever busy.

This page is written for non-technical pilots. Take it slowly; none of it needs
coding.

## Option 1: Google Gemini key (free, easiest)

No card needed for the free tier.

1. Go to **https://aistudio.google.com/apikey** and sign in with a Google
   account.
2. Click **Create API key**. If it asks you to pick or allow a project, accept
   the default.
3. **Copy the key** and keep it somewhere safe for a minute. Treat it like a
   password.

## Option 2: OpenAI key (optional, needs a card)

Slightly more capable, but the OpenAI API needs a small amount of credit.

1. Go to **https://platform.openai.com/api-keys** and sign in (or sign up).
2. Click **Create new secret key**, give it a name, and create it.
3. **Copy it straight away.** OpenAI shows the full key only once. It starts
   with `sk-`.
4. Add a little credit so the key works: under **Settings > Billing**, add a
   small amount (around 5 dollars). The app uses a low-cost model, so that
   lasts a long time.

## Paste your key into your settings

1. Open the app folder the installer created at **`~/RelationshipInboxOS`**
   (in Finder: **Go > Home**, then open **RelationshipInboxOS**).
2. Open the file called **`.env`** in a text editor (TextEdit is fine).
3. Fill in the line for the key (or keys) you made:

   ```
   OPENAI_API_KEY=sk-your-openai-key-here
   GEMINI_API_KEY=your-gemini-key-here
   ```

4. Tell the app which key to use with the `AI_PROVIDER` line:

   ```
   AI_PROVIDER=openai
   ```

   - If you made an **OpenAI** key (or both), leave it as `openai`.
   - If you only made the free **Gemini** key, change it to `AI_PROVIDER=gemini`.

   This makes your preference explicit. If the selected provider has no key,
   the current runner can select another configured provider, but relying on
   that fallback makes setup harder to understand and diagnose. The complete
   selection order is in the [AI reference](../developer/ai.md#effective-provider-selection).

5. **Save** the file.

## Restart and check it worked

1. Quit Relationship Inbox OS.
2. Open it again from Applications or Launchpad.

If the app icon was not created, use the Terminal fallback:

   ```bash
   cd ~/RelationshipInboxOS
   npm run start:student
   ```

3. Check the setup: in a Terminal, run:

   ```bash
   cd ~/RelationshipInboxOS
   npm run doctor
   ```

   The **AI key** line should say **PASS**.
4. Run a scan (press **Cmd + K**, type `scan`, choose **Run scan now**). The
   summaries and action items should now appear on Today and Inbox.

## Keep your keys safe

- Treat each key like a password. Do not share it, and do not post it anywhere.
- Anyone with your key can use your quota, and (if you added billing) run up
  charges on your account.
- Your keys live only in your `.env` on your Mac.
- If a key ever leaks, delete it on the provider's website and create a new one.

If the **AI key** check still does not pass, see
[student-install-troubleshooting.md](./student-install-troubleshooting.md), or
message me.
