# Auto WhatsApp: set-up

Settings › **Auto WhatsApp** sends customers coupon reminders, new dishes, your announcements and "we miss you" messages by itself. Messages go out every morning at 10 (with the daily cron), or when you tap **Send today's now** / **Send now**.

Only customers who tick **"Send me offers and new dishes on WhatsApp"** in the QR cart get messages. They can reply **STOP** at any time (and **START** to come back).

Messages are sent through Meta's WhatsApp Cloud API. Meta charges per marketing message, about ₹0.80–1 each in India; there's no middleman fee.

## 1. Meta business number

1. Go to [business.facebook.com](https://business.facebook.com) and create (or open) your business.
2. In [developers.facebook.com](https://developers.facebook.com/apps) create an app of type **Business**, then add **WhatsApp**.
3. Under WhatsApp › API Setup, add your shop's phone number and verify it. This number can't also be used in the normal WhatsApp app.
4. Add a payment method in WhatsApp Manager, because marketing messages are paid.
5. Create a **permanent token**:
   - Business settings › System users › Add, with the Admin role.
   - Assign your app and WhatsApp account to that user.
   - Generate a token with the `whatsapp_business_messaging` and `whatsapp_business_management` permissions.

## 2. Message templates

In WhatsApp Manager › Message templates, create these four:
- Category: **Marketing**
- Language: **English** (`en`)
- Footer on each: `Reply STOP to stop these messages`

The body text must match exactly. Meta asks for sample values for each `{{n}}`.

| Name | Body |
|---|---|
| `offer_reminder` | Hi {{1}}! 🎁 {{2}} has an offer for you: {{3}}. {{4}} Order here: {{5}} See you soon! |
| `new_dishes` | Hi {{1}}! 🍽️ New on the menu at {{2}}: {{3}}. Try them on your next visit: {{4}} Enjoy! |
| `shop_news` | Hi {{1}}! 📣 News from {{2}}: {{3}} See the menu: {{4}} Thank you! |
| `we_miss_you` | Hi {{1}}, we miss you at {{2}}! 😊 {{3}} Order here: {{4}} Hope to see you soon. |

Approval usually takes a few minutes to a day.

## 3. Vercel environment variables

Project › Settings › Environment Variables (Production), then **redeploy**:

| Name | Value |
|---|---|
| `WHATSAPP_TOKEN` | the permanent token from step 1.5 |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp › API Setup › *Phone number ID* (not the phone number) |
| `WHATSAPP_APP_SECRET` | App settings › Basic › *App secret* |
| `WHATSAPP_VERIFY_TOKEN` | any long random text you choose (used once in step 4) |
| `WHATSAPP_SHOPS` | the shop id shown in Settings › Auto WhatsApp (comma-separate several) |

`/api/health` (as admin) shows `WHATSAPP` and `WHATSAPP_WEBHOOK` as true once they're set. It never shows the values.

## 4. Webhook (for STOP replies)

In the app's WhatsApp › Configuration:
- **Callback URL:** `https://<your-app>/api/whatsapp/webhook`
- **Verify token:** the same text as `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the **messages** field.

## 5. Turn it on

Settings › Auto WhatsApp:
1. Tick **Turn on**, choose the kinds, and **Save**.
2. Tap **Preview today** to see who would get what.

Rules the app follows:
- at most one message per customer every 3 days (announcements can come sooner)
- nothing between 9 pm and 10 am
- each message only once

## Testing locally

Set `WHATSAPP_FAKE=1` when running the dev API. Messages are then logged instead of sent, and every shop counts as connected. This never works on Vercel.
