# Invitation Runbook

This is the short memory file for creating rlm-wiki beta invite links later.

## Mental Model

Cloudflare Access is only the identity proof. It should be broad enough to let an invited person request an email OTP. rlm-wiki is the real beta gate: it checks a signed, email-bound invite token after Cloudflare has verified the user's email.

The right question before changing anything is:

- Can this person prove they control the email address we invited?
- Did we give that exact email a signed invite link?
- Are we avoiding a permanent Cloudflare policy patch for every friend?

If the answer is yes, create an invite link. Do not add each friend to the Cloudflare policy.

## Current Production Shape

- App URL: `https://rlmwiki.deepascii.com`
- Cloudflare Access application URL: `rlmwiki.deepascii.com`
- Cloudflare reusable policy: `Allow invite email OTP`
- Cloudflare reusable policy ID: `e714ab47-e13d-4c05-a1ac-733ffe466f5c`
- Cloudflare policy rule should be: `Include -> Everyone`
- Railway invite gate should be enabled with `RLM_WIKI_REQUIRE_INVITE=true`
- Admin emails should include `sjng94@gmail.com`
- Owner/admin bypass should remain in `RLM_WIKI_ALLOWED_EMAILS`

The Cloudflare policy being `Everyone` does not make the app open. It only lets anyone reach the Cloudflare email-code step. rlm-wiki still rejects users without a valid invite token.

## Required Railway Env Vars

These should already be set in production:

```bash
AUTH_MODE=cloudflare_access
RLM_WIKI_REQUIRE_INVITE=true
RLM_WIKI_INVITE_SECRET=<set, do not print or commit>
RLM_WIKI_ADMIN_EMAILS=sjng94@gmail.com
RLM_WIKI_ALLOWED_EMAILS=sjng94@gmail.com
RLM_WIKI_PUBLIC_URL=https://rlmwiki.deepascii.com
```

If checking from the CLI, redact the secret:

```bash
railway run node -e "for (const k of ['AUTH_MODE','RLM_WIKI_REQUIRE_INVITE','RLM_WIKI_ADMIN_EMAILS','RLM_WIKI_ALLOWED_EMAILS','RLM_WIKI_PUBLIC_URL','RLM_WIKI_INVITE_SECRET']) console.log(k, k.includes('SECRET') ? (process.env[k] ? 'set' : 'missing') : (process.env[k] || 'missing'))"
```

## Create An Invite Link

Preferred path: use the production admin API while logged in through Cloudflare Access as an admin. This keeps `RLM_WIKI_INVITE_SECRET` on the server.

1. Open `https://rlmwiki.deepascii.com/code`.
2. Log in through Cloudflare Access as `sjng94@gmail.com`.
3. In the browser devtools console, run:

```js
await fetch("/api/admin/invites", {
  method: "POST",
  headers: { "content-type": "application/json" },
  credentials: "include",
  body: JSON.stringify({
    emails: ["friend@example.com"],
    days: 14,
    redirectPath: "/code"
  })
}).then((r) => r.json())
```

The response shape is:

```json
{
  "inviteOnly": true,
  "links": [
    {
      "email": "friend@example.com",
      "url": "https://rlmwiki.deepascii.com/invite/...",
      "expiresAt": "2026-05-15T00:00:00.000Z"
    }
  ]
}
```

Send the `url` only to the matching email owner. The invite is email-bound, so the friend must enter the same email at the Cloudflare Access login screen.

## Invite Multiple Friends

Use one request with multiple emails:

```js
await fetch("/api/admin/invites", {
  method: "POST",
  headers: { "content-type": "application/json" },
  credentials: "include",
  body: JSON.stringify({
    emails: [
      "friend1@example.com",
      "friend2@example.com",
      "friend3@example.com"
    ],
    days: 14,
    redirectPath: "/code"
  })
}).then((r) => r.json())
```

`days` is clamped by the server to 1 through 90. `redirectPath` must be a same-site path and defaults to `/code`.

## Curl Option

Use this only if you already have the authenticated Cloudflare Access browser cookie. The browser-console method is usually easier.

```bash
curl -X POST https://rlmwiki.deepascii.com/api/admin/invites \
  -H 'content-type: application/json' \
  -H 'cookie: CF_Authorization=<browser access cookie>' \
  -d '{"emails":["friend@example.com"],"days":14,"redirectPath":"/code"}'
```

## Verification

Ask the friend to:

1. Open their invite link.
2. Enter the exact invited email address in Cloudflare Access.
3. Use the email OTP from Cloudflare.
4. Confirm they land on `/code`.

Good signs:

- Cloudflare sends the OTP.
- The app redirects from `/invite/<token>` to `/code`.
- The friend can see their own empty or personal history, not the owner's history.

## Troubleshooting

If the friend never receives a Cloudflare OTP:

- Check the Cloudflare Access policy still says `Include -> Everyone`.
- Check Cloudflare service status if the dashboard shows an Access degradation banner.
- Have the friend retry after a minute and check spam.

If the friend gets `Invite required` after OTP:

- They may have opened the app directly instead of the invite link.
- They may have used a different email than the one embedded in the invite.
- The invite may have expired.

If the admin API returns `403`:

- Confirm the current Cloudflare user is in `RLM_WIKI_ADMIN_EMAILS` or `RLM_WIKI_ALLOWED_EMAILS`.
- Confirm `AUTH_MODE=cloudflare_access` is deriving the expected email at `/api/me`.

If the admin API returns an invite secret error:

- `RLM_WIKI_INVITE_SECRET` is missing in Railway.
- Set it once with a random value and redeploy/restart if needed.

## Revocation Notes

Invite links are stateless signed tokens. There is no per-link revoke list yet.

To invalidate all outstanding invite links, rotate `RLM_WIKI_INVITE_SECRET`. That will also invalidate invite cookies already set from old links. For now, use shorter `days` values when inviting people you are unsure about.

## What Not To Do

- Do not add every friend to the Cloudflare reusable policy.
- Do not expose or commit `RLM_WIKI_INVITE_SECRET`.
- Do not make `RLM_WIKI_ALLOWED_EMAILS` a friend allow-list unless intentionally bypassing invite links.
- Do not send one person's invite link to another email address. The token will not verify for the wrong Cloudflare identity.
