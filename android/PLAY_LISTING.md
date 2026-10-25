# Play Console: what to fill in

## App details
- **App name** (30 max): Billing – Shop POS
- **Default language:** English (India), en-IN
- **App or game:** App · **Free or paid:** Free (shops subscribe inside the app)
- **Category:** Business
- **Contact email:** your support email (required by Play; shown on the store page)
- **Website:** https://billing-app-chi-five.vercel.app
- **Privacy policy:** https://billing-app-chi-five.vercel.app/privacy.html

## Short description (80 max)
Billing, KOT, QR table orders, kitchen stock & staff salary for restaurants.

## Full description (4000 max)
Billing is a fast, simple POS for restaurants, dhabas, cafés and shops.

BILLING THAT KEEPS UP
• Make a bill in seconds and print it on a Bluetooth thermal printer
• Cash, UPI, card or udhar (shop credit), with GST and discounts
• Works offline: keep billing when the internet drops, it syncs later
• Edit or delete bills with a reason; deleted bills wait 30 days in a bin

QR TABLE ORDERING
• Customers scan the table QR, see the menu and order from their phone
• Pay now by UPI or at the end, as you choose in Settings
• New orders ring on every screen; bills print as soon as a payment is confirmed

KITCHEN
• Order tickets for the kitchen, with To cook → Ready → Served
• Stock of ingredients, recipes, waste and low-stock alerts
• Kitchen Brain learns your sales to suggest tomorrow's prep and when to reorder

STAFF & SALARY
• Staff log in with their own PIN; cooks see only the kitchen
• Attendance for the whole month, advances, loans, bonus and pay slips on WhatsApp

REPORTS
• Today's sales, best sellers, expenses and profit
• Udhar list with dues and reminders

Your shop's data is private to your shop and the staff you allow.

## Graphics
- **App icon:** 512 × 512 px. Use `android/store_icon.png`.
- **Feature graphic:** 1024 × 500 px. Teal (#0f766e) background with the receipt icon and "Billing – Shop POS". I can make this.
- **Phone screenshots:** 2–8 images, 1080 × 1920 recommended. I can capture these:
  1. Billing screen
  2. A printed bill
  3. QR order on a phone
  4. Kitchen tickets
  5. Dashboard
  6. Staff salary

## App content (Policy section)
- **Ads:** No ads.
- **App access:** login is required. Give reviewers a demo shop login: make a test shop with sample data, and don't use your real shop.
- **Target audience:** 18+ (business app). Not designed for children.
- **Content rating:** fill the questionnaire as a Business/Utility app. No violence, sexual content, gambling or user-to-user chat.
- **News app:** No. **Government app:** No. **Financial features:** none. It records sales; it does not hold or move money.
- **Health:** No.

## Data safety form
**Does the app collect or share user data?** Yes, it collects data. Nothing is shared with third parties for their own use. The companies that host the app (Vercel, MongoDB Atlas) and send email (Gmail) count as service providers, not sharing.

| Data type | Collected | Purpose | Optional? |
|---|---|---|---|
| Name | Yes | App functionality, account management | Required for the owner; optional for customers on bills |
| Email address | Yes | Account management, app functionality (sign-in codes) | Required for the owner |
| Phone number | Yes | App functionality (customer contact, udhar) | Required for QR orders |
| Purchase history (bills, orders) | Yes | App functionality, analytics shown to the shop | Required |
| Other financial info (UPI reference numbers, staff salary records) | Yes | App functionality | Optional |

- **Encrypted in transit:** Yes (HTTPS).
- **Users can request deletion:** Yes, from Help in the app. The account-deletion URL can be the privacy page, which explains how.
- **Not collected:** location, contacts, photos (except menu photos the shop uploads), device IDs, ads or tracking data.

## Release
1. **Testing › Internal testing:** create a release and upload `android/out/billing.aab`. Add your own Gmail as a tester.
2. **Setup › App signing:** copy the **SHA-256** of the *App signing key*, and send it to me to add to `assetlinks.json`.
3. Install from the internal testing link and check there's no browser bar at the top.
4. Then promote to **Production**.
   - New personal developer accounts must first run a **closed test with 12+ testers for 14 days** before Production is allowed.
